require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { parseCsv, lerXlsx, gerarXlsx } = require("./planilha");

const app = express();

// ======================================================
// CONFIGURAÇÃO (vem do arquivo .env — nunca no código)
// ======================================================
const {
    MP_ACCESS_TOKEN,
    MELHOR_ENVIO_TOKEN,
    MELHOR_ENVIO_URL = "https://sandbox.melhorenvio.com.br",
    MP_API_URL = "https://api.mercadopago.com",
    MP_WEBHOOK_SECRET,
    MP_CONFERE_MINUTOS = "10",
    LOJA_WHATSAPP,
    LOJA_INSTAGRAM,
    LOJA_HORARIO,
    LOJA_ENDERECO_PUBLICO,
    LOJA_EXIBIR_DOCUMENTO,
    BACKUP_DIR,
    BACKUP_DIAS = "14",
    BACKUP_HORA = "3",
    TRUST_PROXY = "1",
    ME_USER_AGENT = "Closet Real (contato@seudominio.com.br)",
    ME_AGENCIA_ID,
    ME_SYNC_MINUTOS = "60",
    LOJA_NOME,
    LOJA_EMAIL,
    LOJA_TELEFONE,
    LOJA_DOCUMENTO,
    LOJA_INSCRICAO_ESTADUAL,
    LOJA_ENDERECO,
    LOJA_NUMERO,
    LOJA_COMPLEMENTO,
    LOJA_BAIRRO,
    LOJA_CIDADE,
    LOJA_UF,
    CEP_ORIGEM = "25500000",
    BASE_URL,
    ADMIN_PASSWORD,
    SESSION_SECRET,
    DB_PATH = "loja.db",
    UPLOADS_DIR = path.join(__dirname, "public", "uploads"),
    PORT = 3000,
    NODE_ENV
} = process.env;

const obrigatorias = [
    "MP_ACCESS_TOKEN",
    "MELHOR_ENVIO_TOKEN",
    "BASE_URL",
    "ADMIN_PASSWORD",
    "SESSION_SECRET"
];

const faltando = obrigatorias.filter(nome => !process.env[nome]);

if (faltando.length > 0) {
    console.error("❌ Variáveis faltando no .env:", faltando.join(", "));
    console.error("   Copie .env.example para .env e preencha.");
    process.exit(1);
}

if (ADMIN_PASSWORD.length < 10) {
    console.error("❌ ADMIN_PASSWORD precisa ter pelo menos 10 caracteres.");
    process.exit(1);
}

if (SESSION_SECRET.length < 32) {
    console.error("❌ SESSION_SECRET precisa ter pelo menos 32 caracteres.");
    process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);

db.configure("busyTimeout", 5000);

// (as tabelas são criadas em prepararBanco(), mais abaixo)

// ======================================================
// AUTENTICAÇÃO DO ADMIN (sessão em cookie assinado)
// ======================================================
const COOKIE_ADMIN = "admin_sessao";
const SESSAO_DURACAO_MS = 8 * 60 * 60 * 1000; // 8 horas
const STATUS_VALIDOS = [
    "pendente",
    "aguardando_pagamento",
    "pago",
    "em_separacao",
    "em_transito",
    "entregue",
    "cancelado"
];

function assinar(valor) {
    return crypto
        .createHmac("sha256", SESSION_SECRET)
        .update(valor)
        .digest("base64url");
}

function criarToken() {
    const expira = String(Date.now() + SESSAO_DURACAO_MS);
    return `${expira}.${assinar(expira)}`;
}

function tokenValido(token) {
    if (!token) return false;

    const [expira, assinatura] = token.split(".");
    if (!expira || !assinatura) return false;

    const esperado = Buffer.from(assinar(expira));
    const recebido = Buffer.from(assinatura);

    if (
        esperado.length !== recebido.length ||
        !crypto.timingSafeEqual(esperado, recebido)
    ) {
        return false;
    }

    return Number(expira) > Date.now();
}

// Todos os cookies com esse nome. O navegador pode guardar mais de um (ex.: de uma versão antiga
// da loja, com outro "Path", ou de outra porta do localhost) e manda os dois no mesmo pedido.
function lerCookies(req, nome) {
    const header = req.headers.cookie || "";
    const valores = [];

    for (const parte of header.split(";")) {
        const i = parte.indexOf("=");
        if (i < 0) continue;

        if (parte.slice(0, i).trim() === nome) {
            try {
                valores.push(decodeURIComponent(parte.slice(i + 1).trim()));
            } catch {
                // cookie malformado: ignora
            }
        }
    }

    return valores;
}

// A sessão vale se QUALQUER um dos cookies for válido (um cookie velho na frente não derruba a sessão)
const sessaoAdminValida = req => lerCookies(req, COOKIE_ADMIN).some(tokenValido);

// Apaga o cookie de sessão em todos os caminhos em que uma versão antiga pode tê-lo gravado
const CAMINHOS_DO_COOKIE = ["/", "/api", "/api/admin", "/admin", "/api/admin-sessao", "/api/admin-login", "/api/admin-logout"];

function apagarCookiesDeSessao(req, res) {

    for (const path of CAMINHOS_DO_COOKIE) {
        res.clearCookie(COOKIE_ADMIN, { path });

        // versões que gravaram com "Domain" (só faz sentido para nomes de domínio, não para IP)
        if (req.hostname && !/^[\d.:]+$/.test(req.hostname)) {
            res.clearCookie(COOKIE_ADMIN, { path, domain: req.hostname });
        }
    }
}

function senhaCorreta(tentativa) {
    const hash = texto =>
        crypto.createHash("sha256").update(String(texto)).digest();

    return crypto.timingSafeEqual(hash(tentativa), hash(ADMIN_PASSWORD));
}

// Respostas do painel e da sessão nunca ficam guardadas no navegador
app.use(["/api/admin", "/api/admin-sessao", "/api/admin-login", "/api/admin-logout"], (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
});

function exigirAdmin(req, res, next) {
    if (sessaoAdminValida(req)) {
        return next();
    }

    res.status(401).json({ erro: "Não autorizado" });
}

// Limite de tentativas de login (proteção contra força bruta)
const tentativasLogin = new Map();
const MAX_FALHAS = 5;
const BLOQUEIO_MS = 15 * 60 * 1000;

function loginBloqueado(ip) {
    const registro = tentativasLogin.get(ip);
    if (!registro || !registro.ate) return false;

    if (registro.ate > Date.now()) return true;

    tentativasLogin.delete(ip);
    return false;
}

function registrarFalha(ip) {
    const registro = tentativasLogin.get(ip) || { falhas: 0 };
    registro.falhas++;

    if (registro.falhas >= MAX_FALHAS) {
        registro.ate = Date.now() + BLOQUEIO_MS;
        registro.falhas = 0;
    }

    tentativasLogin.set(ip, registro);
}

// Necessário atrás de proxy (Render, Railway, nginx) para o cookie "secure" e o IP real funcionarem.
// TRUST_PROXY = quantos proxies existem na frente do app (nginx sozinho = 1; Cloudflare + nginx = 2).
app.set("trust proxy", Number.isInteger(Number(TRUST_PROXY)) ? Number(TRUST_PROXY) : 1);

// Cabeçalhos de segurança básicos em todas as respostas
app.use((req, res, next) => {

    res.set({
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
    });

    // HSTS só em produção e só quando a visita chegou por HTTPS (senão trancaria o acesso por http)
    if (NODE_ENV === "production" && req.secure) {
        res.set("Strict-Transport-Security", "max-age=15552000");
    }

    next();
});

// Verificação de saúde para a hospedagem e para monitores (UptimeRobot etc.)
app.get("/healthz", async (req, res) => {

    res.set("Cache-Control", "no-store");

    try {
        await dbGet("SELECT 1 AS ok");
        res.json({ ok: true });
    } catch {
        res.status(503).json({ ok: false });
    }
});

// Fotos enviadas pelo painel ficam em UPLOADS_DIR (em produção, use um disco persistente)
app.use("/uploads", express.static(UPLOADS_DIR, {
    maxAge: "30d",
    immutable: true,
    setHeaders: res => res.setHeader("X-Content-Type-Options", "nosniff")
}));

// Precisa vir ANTES do express.json() global, porque aceita corpo maior (fotos)
app.post(
    "/api/admin/upload",
    exigirAdmin,
    (req, res, next) =>
        express.json({ limit: "8mb" })(req, res, erro =>
            erro ? res.status(413).json({ erro: "Imagem muito grande" }) : next()
        ),
    async (req, res) => {

        try {

            const encontrado = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
                String(req.body?.dados || "")
            );

            if (!encontrado) {
                return res.status(400).json({ erro: "Envie uma imagem JPG, PNG ou WebP" });
            }

            const arquivo = Buffer.from(encontrado[1], "base64");

            if (arquivo.length < 100 || arquivo.length > 6 * 1024 * 1024) {
                return res.status(400).json({ erro: "A imagem deve ter até 6 MB" });
            }

            // O tipo vem do CONTEÚDO do arquivo, não do que o navegador declarou
            let extensao = null;

            if (arquivo[0] === 0xff && arquivo[1] === 0xd8 && arquivo[2] === 0xff) {
                extensao = "jpg";
            } else if (arquivo.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
                extensao = "png";
            } else if (
                arquivo.subarray(0, 4).toString("latin1") === "RIFF" &&
                arquivo.subarray(8, 12).toString("latin1") === "WEBP"
            ) {
                extensao = "webp";
            }

            if (!extensao) {
                return res.status(400).json({ erro: "Arquivo de imagem inválido" });
            }

            const nome = `${crypto.randomBytes(12).toString("hex")}.${extensao}`;

            await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
            await fs.promises.writeFile(path.join(UPLOADS_DIR, nome), arquivo);

            res.json({ url: `/uploads/${nome}` });

        } catch (erro) {
            console.log("ERRO UPLOAD:", erro);
            res.status(500).json({ erro: "Erro ao salvar a imagem" });
        }
    }
);

let importacaoEmAndamento = false;

// Importação em massa: lê a planilha (.xlsx ou .csv), mostra a prévia e (com aplicar=true) grava.
//   modo "modelo": modelo padrão da loja (cadastra e altera produtos)
//   modo "shopee": planilha de alteração em massa da Shopee (informações de venda: preço e estoque)
app.post(
    "/api/admin/importar",
    exigirAdmin,
    (req, res, next) =>
        express.json({ limit: "15mb" })(req, res, erro =>
            erro ? res.status(413).json({ erro: "Arquivo muito grande" }) : next()
        ),
    async (req, res) => {

        try {

            const { aplicar, opcoes } = req.body || {};
            const modo = req.body?.modo === "shopee" ? "shopee" : "modelo";

            const dados = carregarPlanilha(req.body || {});
            const tipo = tipoDaPlanilha(dados.cabecalhos);

            let analise;
            let gravar = aplicarGravacoes;

            if (modo === "modelo") {

                if (tipo === "vendas" || tipo === "produtos-shopee") {
                    throw erroValidacao(
                        "Essa planilha é da Shopee. Volte e escolha a opção “Planilha da Shopee”, " +
                        "ou use o modelo padrão da loja."
                    );
                }

                if (tipo !== "modelo") {
                    throw erroValidacao(
                        "Não reconheci as colunas dessa planilha. Baixe o modelo padrão, preencha e envie de novo."
                    );
                }

                analise = await analisarModelo(dados);

            } else if (tipo === "vendas") {

                analise = await analisarVendasShopee(dados, {
                    preco: opcoes?.preco !== false,
                    estoque: opcoes?.estoque !== false,
                    criarTamanhos: opcoes?.criarTamanhos !== false,
                    cadastrarNovos: opcoes?.cadastrarNovos === true,
                    incluirConferir: opcoes?.incluirConferir === true
                });

            } else if (tipo === "produtos-shopee") {

                // Planilha antiga de "informações básicas": continua funcionando (nomes e descrições)
                const escolhasBasicas = {
                    nome: true,
                    descricao: true,
                    fotos: false,
                    precoEstoque: false,
                    incluirConferir: opcoes?.incluirConferir === true
                };

                analise = await analisarPlanilha(dados, escolhasBasicas);
                gravar = registros => aplicarPlanilha(registros, escolhasBasicas);

                analise.avisos.unshift(
                    "Essa é a planilha de informações básicas da Shopee: só nomes e descrições são atualizados. " +
                    "Para alterar preço e estoque, use a de alteração em massa (informações de venda)."
                );

            } else if (tipo === "modelo") {

                throw erroValidacao(
                    "Essa planilha parece ser do modelo padrão da loja. Volte e escolha a opção “Modelo padrão da loja”."
                );

            } else {

                throw erroValidacao(
                    "Não reconheci essa planilha. Use a de alteração em massa da Shopee (informações de venda) " +
                    "ou o modelo padrão da loja."
                );
            }

            // A prévia mostra o resumo e uma linha por produto (sem os dados internos)
            const itens = analise.registros.map(r => ({
                linha: r.linha,
                id: r.id,
                nome: r.nome,
                acao: r.acao,
                motivo: r.motivo || null,
                mudancas: r.mudancas || [],
                notas: r.notas || [],
                nomeAtual: r.nomeAtual || null,
                categoria: r.categoria || null
            }));

            if (aplicar !== true) {
                return res.json({
                    aplicado: false,
                    resumo: analise.resumo,
                    avisos: analise.avisos,
                    colunas: analise.colunas,
                    itens
                });
            }

            if (importacaoEmAndamento) {
                return res.status(409).json({ erro: "Já existe uma importação em andamento. Aguarde." });
            }

            importacaoEmAndamento = true;

            try {

                const resultado = await gravar(analise.registros);

                res.json({
                    aplicado: true,
                    resumo: analise.resumo,
                    ...resultado
                });

            } finally {
                importacaoEmAndamento = false;
            }

        } catch (erro) {
            responderErro(res, erro, "Erro ao importar a planilha");
        }
    }
);

// Arquivos .xlsx para baixar: o modelo em branco e os produtos atuais (para editar em massa)
app.get("/api/admin/planilha/modelo.xlsx", exigirAdmin, (req, res) => {
    enviarXlsx(res, "modelo-cadastro-produtos.xlsx", gerarModeloPadrao());
});

app.get("/api/admin/planilha/produtos.xlsx", exigirAdmin, async (req, res) => {

    try {
        enviarXlsx(res, "produtos-atuais.xlsx", await gerarPlanilhaProdutosAtuais());
    } catch (erro) {
        responderErro(res, erro, "Erro ao gerar a planilha");
    }
});

app.use(express.json());
app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
});
// ======================================================
// APARÊNCIA DA LOJA: banners, logo, cores e fontes
// ======================================================

const TemaCores = require("./public/tema-cores.js");

// Fontes hospedadas na própria loja (public/fonts): nada é carregado de sites de terceiros
const FONTES = {
    padrao: { nome: "Padrão do sistema (Segoe UI)", familia: null },
    poppins: { nome: "Poppins (moderna)", familia: "Poppins", arquivo: "poppins" },
    montserrat: { nome: "Montserrat (limpa)", familia: "Montserrat", arquivo: "montserrat" },
    nunito: { nome: "Nunito (suave e arredondada)", familia: "Nunito", arquivo: "nunito" },
    playfair: { nome: "Playfair Display (elegante, serifada)", familia: "Playfair Display", arquivo: "playfair-display" },
    lora: { nome: "Lora (clássica, serifada)", familia: "Lora", arquivo: "lora" },
    parisienne: { nome: "Parisienne (cursiva, manuscrita)", familia: "Parisienne", arquivo: "parisienne", pesos: [400], ajusteLogo: "font-size: 2.4rem; line-height: 1.1;" }
};

const APARENCIA_PADRAO = {
    banners_pc: [],
    banners_celular: [],
    logo: "",
    mostrar_nome_logo: true,
    intervalo: 6,
    cor_primaria: TemaCores.PADRAO,
    fonte_titulos: "padrao",
    fonte_texto: "padrao",
    fonte_logo: "padrao"
};

let aparencia = { ...APARENCIA_PADRAO };

const URL_DE_UPLOAD = /^\/uploads\/[a-f0-9]{24}\.(jpg|png|webp)$/;

function validarAparencia(b) {

    const corpo = b && typeof b === "object" ? b : {};

    const banners = (lista, rotulo) => {

        if (lista === undefined) return [];

        if (!Array.isArray(lista) || lista.length > 8) {
            throw erroValidacao(`${rotulo}: no máximo 8 imagens`);
        }

        return lista.map(item => {

            const url = String(item?.url || "");

            if (!URL_DE_UPLOAD.test(url)) throw erroValidacao(`${rotulo}: imagem inválida`);

            return { url, alt: texto(item?.alt, 160) };
        });
    };

    const logo = String(corpo.logo || "");

    if (logo && !URL_DE_UPLOAD.test(logo)) throw erroValidacao("Logo inválido");

    const intervalo = Number(corpo.intervalo ?? 6);

    if (!Number.isInteger(intervalo) || intervalo < 3 || intervalo > 20) {
        throw erroValidacao("O tempo do carrossel deve ficar entre 3 e 20 segundos");
    }

    const cor = TemaCores.normalizar(corpo.cor_primaria ?? TemaCores.PADRAO);

    if (!cor) throw erroValidacao("Cor inválida");

    const fonteTitulos = String(corpo.fonte_titulos || "padrao");
    const fonteTexto = String(corpo.fonte_texto || "padrao");
    const fonteLogo = String(corpo.fonte_logo || "padrao");

    if (!FONTES[fonteTitulos] || !FONTES[fonteTexto] || !FONTES[fonteLogo]) throw erroValidacao("Fonte inválida");

    return {
        banners_pc: banners(corpo.banners_pc, "Banner do computador"),
        banners_celular: banners(corpo.banners_celular, "Banner do celular"),
        logo,
        mostrar_nome_logo: corpo.mostrar_nome_logo !== false,
        intervalo,
        cor_primaria: cor,
        fonte_titulos: fonteTitulos,
        fonte_texto: fonteTexto,
        fonte_logo: fonteLogo
    };
}

async function carregarAparencia() {

    const linha = await dbGet("SELECT valor FROM config WHERE chave = 'aparencia'");

    try {
        aparencia = linha ? validarAparencia({ ...APARENCIA_PADRAO, ...JSON.parse(linha.valor) }) : { ...APARENCIA_PADRAO };
    } catch {
        // configuração corrompida ou de outra versão: volta ao padrão em vez de derrubar a loja
        aparencia = { ...APARENCIA_PADRAO };
    }
}

const urlsDaAparencia = () => new Set([
    ...aparencia.banners_pc.map(b => b.url),
    ...aparencia.banners_celular.map(b => b.url),
    aparencia.logo
].filter(Boolean));

// ---------- CSS com as cores e fontes escolhidas ----------
// Os arquivos CSS continuam com o tema original; ao servi-los, a cor principal e a fonte são trocadas.
// (O padrão sai idêntico ao arquivo.)

const CSS_COM_TEMA = new Set([
    "style", "fluxo", "produto-modal", "menu-mobile", "consultar", "paginas",
    "rodape", "andamento", "pedido-recebido", "aparencia"
]);

const cacheDeCss = new Map();

function blocosDeFonte(...ids) {

    const unicos = [...new Set(ids)].filter(id => FONTES[id].familia);

    return unicos.map(id => {

        const f = FONTES[id];

        return (f.pesos || [400, 600, 700]).map(peso =>
            `@font-face{font-family:'${f.familia}';font-style:normal;font-weight:${peso};font-display:swap;` +
            `src:url('/fonts/${f.arquivo}-${peso}.woff2') format('woff2');}`
        ).join("\n");

    }).join("\n");
}

function gerarCssTematico(nome, original) {

    let css = TemaCores.aplicarCores(original, aparencia.cor_primaria);

    const texto = FONTES[aparencia.fonte_texto];
    const titulos = FONTES[aparencia.fonte_titulos];

    if (texto.familia) {
        css = css.replace(/'Segoe UI'/g, `'${texto.familia}', 'Segoe UI'`);
    }

    // As declarações das fontes e a regra dos títulos entram uma única vez, no style.css (todas as páginas usam)
    if (nome === "style") {

        const faces = blocosDeFonte(aparencia.fonte_texto, aparencia.fonte_titulos, aparencia.fonte_logo);

        if (faces) css = `${faces}\n${css}`;

        const regraFonte = (seletor, f, ajuste) => !f.familia ? "" :
            `\n${seletor} { font-family: '${f.familia}', 'Segoe UI', serif;${f.pesos ? ' font-weight: ' + f.pesos[0] + ';' : ''}${ajuste ? ' ' + ajuste : ''} }\n`;

        css += regraFonte("h1, h2, h3, h4, .logo h1, .fx-titulo, .hero h2", titulos);

        // fonte própria do nome da loja (em "padrao", o nome segue a fonte dos títulos)
        if (aparencia.fonte_logo !== "padrao") {
            const fl = FONTES[aparencia.fonte_logo];
            css += regraFonte("header .logo h1", fl, fl.ajusteLogo);
        }
    }

    return css;
}

app.get(/^\/([a-z0-9-]+)\.css$/, async (req, res, next) => {

    const nome = req.params[0];

    if (!CSS_COM_TEMA.has(nome)) return next();

    try {

        const arquivo = path.join(__dirname, "public", `${nome}.css`);
        const { mtimeMs } = await fs.promises.stat(arquivo);

        const chave = [nome, mtimeMs, aparencia.cor_primaria, aparencia.fonte_texto, aparencia.fonte_titulos, aparencia.fonte_logo].join("|");

        let guardado = cacheDeCss.get(chave);

        if (!guardado) {

            const css = gerarCssTematico(nome, await fs.promises.readFile(arquivo, "utf8"));

            guardado = { css, etag: `"${crypto.createHash("sha1").update(css).digest("hex").slice(0, 20)}"` };

            // só guarda a versão atual de cada arquivo
            for (const k of cacheDeCss.keys()) if (k.startsWith(`${nome}|`)) cacheDeCss.delete(k);

            cacheDeCss.set(chave, guardado);
        }

        res.set({
            "Content-Type": "text/css; charset=utf-8",
            "Cache-Control": "no-cache",
            ETag: guardado.etag
        });

        if (req.headers["if-none-match"] === guardado.etag) return res.sendStatus(304);

        res.send(guardado.css);

    } catch (erro) {
        if (erro.code === "ENOENT") return next();
        console.log("ERRO CSS:", erro.message);
        res.status(500).end();
    }
});

app.use(express.static("public"));

// ======================================================
// FUNÇÕES AUXILIARES DA LOJA
// ======================================================

// Medidas padrão de UMA peça embalada (usadas no frete enquanto o produto
// não tiver peso/medidas próprios — isso vem no cadastro de produtos).
const PACOTE_PADRAO = { peso: 0.3, largura: 20, altura: 5, comprimento: 25 };
const MAX_QTD_POR_ITEM = 10;

const dbRun = (sql, params = []) =>
    new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });

const dbGet = (sql, params = []) =>
    new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });

const dbAll = (sql, params = []) =>
    new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

// Dinheiro sempre em centavos (inteiros) para não acumular erro de arredondamento
const centavos = valor => Math.round(Number(valor) * 100);

const soDigitos = valor => String(valor ?? "").replace(/\D/g, "");

const texto = (valor, max) => String(valor ?? "").trim().slice(0, max);

function erroValidacao(mensagem, status = 400) {
    const erro = new Error(mensagem);
    erro.status = status;
    erro.validacao = true; // distingue erro nosso de erro de bibliotecas (ex.: axios também tem .status)
    return erro;
}


// Limite de requisições por IP (janela fixa) — evita abuso das rotas públicas
function limitador(max, janelaMs) {
    const registros = new Map();

    setInterval(() => {
        const agora = Date.now();
        for (const [ip, r] of registros) {
            if (r.reinicia <= agora) registros.delete(ip);
        }
    }, janelaMs).unref();

    return (req, res, next) => {
        const agora = Date.now();
        let r = registros.get(req.ip);

        if (!r || r.reinicia <= agora) {
            r = { n: 0, reinicia: agora + janelaMs };
            registros.set(req.ip, r);
        }

        r.n++;

        if (r.n > max) {
            return res.status(429).json({
                erro: "Muitas requisições. Tente novamente em alguns minutos."
            });
        }

        next();
    };
}

const limiteFrete = limitador(60, 10 * 60 * 1000);
const limitePedido = limitador(20, 15 * 60 * 1000);
const limitePagar = limitador(30, 15 * 60 * 1000);
const limiteConsulta = limitador(30, 15 * 60 * 1000);
// A página "pedido recebido" consulta a cada poucos segundos enquanto espera o pagamento
const limiteAcompanhar = limitador(240, 15 * 60 * 1000);

// ======================================================
// BANCO: tabelas e importação do catálogo
// ======================================================
// Categorias iniciais da loja. Depois da primeira execução elas vivem na tabela "categorias"
// e são gerenciadas pelo painel (criar, renomear, ordenar e excluir). Esta lista só semeia o banco.
const CATEGORIAS_INICIAIS = [
    { id: "t-shirts", nome: "T-shirts" },
    { id: "croppeds", nome: "Croppeds" },
    { id: "shorts-alfaiataria", nome: "Shorts Alfaiataria" },
    { id: "vestidos", nome: "Vestidos" }
];

// Lista em memória, carregada da tabela "categorias" (veja carregarCategorias)
const CATEGORIAS = [];

const semAcento = texto =>
    String(texto ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

async function carregarCategorias() {

    const linhas = await dbAll("SELECT id, nome FROM categorias ORDER BY ordem ASC, nome ASC");

    CATEGORIAS.length = 0;
    CATEGORIAS.push(...linhas);
}

// "Camisas & Polos" -> "camisas-polos"
function idDaCategoria(nome) {
    return semAcento(nome)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
}

// Sugere a categoria pelo nome do produto (null quando não reconhece)
function sugerirCategoria(nome) {

    const n = semAcento(nome);

    let id = null;

    if (/vestido/.test(n)) id = "vestidos";
    else if (/cropp?ed|croped|\bcrop\b/.test(n)) id = "croppeds";
    else if (/\bshorts?\b/.test(n)) id = "shorts-alfaiataria";
    else if (/t-?shirt|camiseta|blusa/.test(n)) id = "t-shirts";

    // se a categoria foi excluída no painel, não sugere
    return id && CATEGORIAS.some(c => c.id === id) ? id : null;
}

const VARIACAO_UNICA = "Único";

// IDs de produtos criados pelo painel ficam abaixo disto; a planilha só mexe em IDs acima
const ID_MAX_PAINEL = 1000000;

async function prepararBanco() {

    await dbRun(`CREATE TABLE IF NOT EXISTS pedidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        cliente TEXT,
        email TEXT,
        telefone TEXT,

        cep TEXT,
        rua TEXT,
        numero TEXT,
        bairro TEXT,
        cidade TEXT,
        estado TEXT,

        status TEXT DEFAULT 'pendente',

        total REAL,

        data_pedido DATETIME DEFAULT CURRENT_TIMESTAMP,

        transportadora TEXT,
        codigo_rastreio TEXT,
        valor_frete REAL,
        etiqueta_url TEXT,
        frete_servico_id INTEGER
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS pedido_itens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pedido_id INTEGER,
        produto_id INTEGER,
        nome TEXT,
        preco REAL,
        quantidade INTEGER
    )`);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS produtos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            descricao TEXT DEFAULT '',
            preco REAL NOT NULL DEFAULT 0,
            ativo INTEGER NOT NULL DEFAULT 1,
            peso REAL,
            largura REAL,
            altura REAL,
            comprimento REAL,
            categoria TEXT,
            posicao INTEGER NOT NULL DEFAULT 0,
            criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS produto_imagens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            produto_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            ordem INTEGER NOT NULL DEFAULT 0
        )
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS produto_variacoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            produto_id INTEGER NOT NULL,
            nome TEXT NOT NULL,
            cor TEXT NOT NULL DEFAULT '',
            estoque INTEGER NOT NULL DEFAULT 0,
            ordem INTEGER NOT NULL DEFAULT 0
        )
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS categorias (
            id TEXT PRIMARY KEY,
            nome TEXT NOT NULL,
            ordem INTEGER NOT NULL DEFAULT 0
        )
    `);

    await dbRun("CREATE INDEX IF NOT EXISTS idx_imagens_produto ON produto_imagens(produto_id)");
    await dbRun("CREATE INDEX IF NOT EXISTS idx_variacoes_produto ON produto_variacoes(produto_id)");

    // Colunas novas em bancos criados por versões anteriores
    const novas = {
        pedidos: {
            transportadora: "TEXT",
            codigo_rastreio: "TEXT",
            valor_frete: "REAL",
            etiqueta_url: "TEXT",
            frete_servico_id: "INTEGER",
            cpf: "TEXT",
            complemento: "TEXT",
            me_pedido_id: "TEXT",
            me_etapa: "TEXT",
            me_status: "TEXT",
            etiqueta_gerada_em: "DATETIME",
            etiqueta_custo: "REAL",
            token_acesso: "TEXT",
            estoque_baixado: "INTEGER NOT NULL DEFAULT 0",
            alerta: "TEXT",
            mp_payment_id: "TEXT"
        },
        pedido_itens: {
            variacao_id: "INTEGER",
            variacao_nome: "TEXT"
        },
        produtos: {
            categoria: "TEXT",
            preco_antigo: "REAL",
            destaque: "INTEGER NOT NULL DEFAULT 0"
        },
        produto_variacoes: {
            cor: "TEXT NOT NULL DEFAULT ''"
        }
    };

    let categoriaCriadaAgora = false;
    let controleDeEstoqueNovo = false;

    for (const [tabela, colunasNovas] of Object.entries(novas)) {

        const existentes = (await dbAll(`PRAGMA table_info(${tabela})`)).map(c => c.name);

        for (const [nome, tipo] of Object.entries(colunasNovas)) {
            if (!existentes.includes(nome)) {
                await dbRun(`ALTER TABLE ${tabela} ADD COLUMN ${nome} ${tipo}`);

                if (tabela === "produtos" && nome === "categoria") {
                    categoriaCriadaAgora = true;
                }

                if (tabela === "pedidos" && nome === "estoque_baixado") {
                    controleDeEstoqueNovo = true;
                }
            }
        }
    }

    // Pedidos de antes do controle de estoque: o estoque do painel já foi ajustado à mão, então NÃO se baixa de novo
    if (controleDeEstoqueNovo) {
        await dbRun("UPDATE pedidos SET estoque_baixado = 1 WHERE status <> 'aguardando_pagamento'");
    }

    // Se já existir uma tabela "pagamentos_mp" de outra versão do projeto, com colunas diferentes,
    // ela é guardada com outro nome (nada é apagado) e a tabela nova é criada do zero.
    const colunasPagamentos = (await dbAll("PRAGMA table_info(pagamentos_mp)")).map(c => c.name);
    const colunasEsperadas = ["payment_id", "pedido_id", "status", "valor", "metodo", "valido", "criado_em", "atualizado_em"];

    if (colunasPagamentos.length > 0 && !colunasEsperadas.every(c => colunasPagamentos.includes(c))) {

        const indices = await dbAll(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pagamentos_mp' AND sql IS NOT NULL"
        );

        for (const indice of indices) {
            await dbRun(`DROP INDEX IF EXISTS "${indice.name.replace(/"/g, "")}"`);
        }

        const novoNome = `pagamentos_mp_antiga_${Date.now()}`;

        await dbRun(`ALTER TABLE pagamentos_mp RENAME TO ${novoNome}`);

        console.log(`Tabela pagamentos_mp de outra versão guardada como ${novoNome}.`);
    }

    // Cada pagamento do Mercado Pago visto pela loja (auditoria e proteção contra notificação repetida)
    await dbRun(`
        CREATE TABLE IF NOT EXISTS pagamentos_mp (
            payment_id TEXT PRIMARY KEY,
            pedido_id INTEGER NOT NULL,
            status TEXT,
            valor REAL,
            metodo TEXT,
            valido INTEGER NOT NULL DEFAULT 1,
            criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await dbRun("CREATE INDEX IF NOT EXISTS idx_pagamentos_mp_pedido ON pagamentos_mp (pedido_id)");

    // Histórico do pedido: cada mudança de situação (e a etiqueta gerada) vira uma linha com data e hora.
    // Gatilhos no banco registram em QUALQUER caminho (webhook, painel, sincronização do rastreio).
    await dbRun(`
        CREATE TABLE IF NOT EXISTS pedido_eventos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pedido_id INTEGER NOT NULL,
            tipo TEXT NOT NULL,
            criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await dbRun("CREATE INDEX IF NOT EXISTS idx_pedido_eventos_pedido ON pedido_eventos (pedido_id)");

    await dbRun(`
        CREATE TRIGGER IF NOT EXISTS trg_pedido_criado AFTER INSERT ON pedidos
        BEGIN
            INSERT INTO pedido_eventos (pedido_id, tipo) VALUES (NEW.id, 'criado');
        END
    `);

    await dbRun(`
        CREATE TRIGGER IF NOT EXISTS trg_pedido_status AFTER UPDATE OF status ON pedidos
        WHEN NEW.status IS NOT OLD.status
        BEGIN
            INSERT INTO pedido_eventos (pedido_id, tipo) VALUES (NEW.id, NEW.status);
        END
    `);

    await dbRun(`
        CREATE TRIGGER IF NOT EXISTS trg_pedido_etiqueta AFTER UPDATE OF me_etapa ON pedidos
        WHEN NEW.me_etapa = 'gerada' AND OLD.me_etapa IS NOT 'gerada'
        BEGIN
            INSERT INTO pedido_eventos (pedido_id, tipo) VALUES (NEW.id, 'etiqueta');
        END
    `);

    await dbRun(`
        CREATE TRIGGER IF NOT EXISTS trg_pedido_apagado AFTER DELETE ON pedidos
        BEGIN
            DELETE FROM pedido_eventos WHERE pedido_id = OLD.id;
        END
    `);

    // Aparência da loja (banners, logo, cores e fontes) fica numa tabela chave/valor simples
    await dbRun(`
        CREATE TABLE IF NOT EXISTS config (
            chave TEXT PRIMARY KEY,
            valor TEXT NOT NULL
        )
    `);

    await carregarAparencia();
    await lerUltimoBackup();

    // Categorias: na primeira execução, semeia com as da loja e com as que os produtos já usam
    const { totalCategorias } = await dbGet("SELECT COUNT(*) AS totalCategorias FROM categorias");

    if (totalCategorias === 0) {

        let ordem = 0;

        for (const c of CATEGORIAS_INICIAIS) {
            await dbRun("INSERT OR IGNORE INTO categorias (id, nome, ordem) VALUES (?, ?, ?)", [c.id, c.nome, ordem++]);
        }

        const usadas = await dbAll(
            "SELECT DISTINCT categoria FROM produtos WHERE categoria IS NOT NULL AND categoria <> ''"
        );

        for (const { categoria } of usadas) {
            await dbRun(
                "INSERT OR IGNORE INTO categorias (id, nome, ordem) VALUES (?, ?, ?)",
                [categoria, categoria, ordem++]
            );
        }
    }

    await carregarCategorias();

    // Primeira execução com o catálogo novo: importa o produtos.json que já existia
    const { total } = await dbGet("SELECT COUNT(*) AS total FROM produtos");

    if (total === 0 && fs.existsSync("./public/produtos.json")) {

        const lista = JSON.parse(fs.readFileSync("./public/produtos.json", "utf-8"));

        await dbRun("BEGIN");

        try {

            let posicao = 1;
            let importados = 0;

            for (const p of lista) {

                const preco = Number(p.preco) || 0;

                const novo = await dbRun(
                    `INSERT OR IGNORE INTO produtos (id, nome, descricao, preco, ativo, posicao, categoria)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        p.id,
                        String(p.nome || "Produto").slice(0, 200),
                        String(p.descricao || "").slice(0, 2000),
                        preco,
                        preco > 0 ? 1 : 0,
                        posicao++,
                        sugerirCategoria(p.nome)
                    ]
                );

                if (novo.changes !== 1) continue;

                const imagens = (Array.isArray(p.imagens) && p.imagens.length ? p.imagens : [p.imagem])
                    .filter(u => typeof u === "string" && /^https:\/\//.test(u))
                    .slice(0, 9);

                for (let i = 0; i < imagens.length; i++) {
                    await dbRun(
                        "INSERT INTO produto_imagens (produto_id, url, ordem) VALUES (?, ?, ?)",
                        [p.id, imagens[i], i]
                    );
                }

                await dbRun(
                    "INSERT INTO produto_variacoes (produto_id, nome, estoque, ordem) VALUES (?, ?, ?, 0)",
                    [p.id, VARIACAO_UNICA, Number.isInteger(p.estoque) ? p.estoque : 10]
                );

                importados++;
            }

            await dbRun("COMMIT");

            console.log(`✅ ${importados} produtos importados do produtos.json`);

        } catch (erro) {
            await dbRun("ROLLBACK").catch(() => {});
            throw erro;
        }
    }

    // Bancos criados antes das categorias: sugere a categoria pelo nome (uma única vez)
    if (categoriaCriadaAgora) {

        const todos = await dbAll("SELECT id, nome FROM produtos");

        for (const p of todos) {
            const categoria = sugerirCategoria(p.nome);
            if (categoria) {
                await dbRun("UPDATE produtos SET categoria = ? WHERE id = ?", [categoria, p.id]);
            }
        }

        console.log("✅ Categorias sugeridas para os produtos existentes");
    }
}

// ======================================================
// CATÁLOGO
// ======================================================

// Texto do tamanho para mostrar ao cliente ("" quando o produto não tem tamanhos)
const rotuloTamanho = nome => (nome && nome !== VARIACAO_UNICA ? nome : "");

// "Azul · M", "M" (sem cor), "Azul" (só cor) ou "" (produto sem variação)
const rotuloVariacao = (cor, nome) =>
    [String(cor || "").trim(), rotuloTamanho(nome)].filter(Boolean).join(" · ");

async function listarProdutos({ admin = false } = {}) {

    const filtro = admin ? "" : "WHERE ativo = 1 AND preco > 0";

    const produtos = await dbAll(
        `SELECT * FROM produtos ${filtro} ORDER BY posicao ASC, id DESC`
    );

    const imagens = await dbAll(
        "SELECT produto_id, url FROM produto_imagens ORDER BY ordem ASC, id ASC"
    );

    const variacoes = await dbAll(
        "SELECT id, produto_id, nome, cor, estoque FROM produto_variacoes ORDER BY ordem ASC, id ASC"
    );

    const imagensPor = new Map();
    const variacoesPor = new Map();

    for (const img of imagens) {
        if (!imagensPor.has(img.produto_id)) imagensPor.set(img.produto_id, []);
        imagensPor.get(img.produto_id).push(img.url);
    }

    for (const v of variacoes) {
        if (!variacoesPor.has(v.produto_id)) variacoesPor.set(v.produto_id, []);
        variacoesPor.get(v.produto_id).push({ id: v.id, nome: v.nome, cor: v.cor || "", estoque: v.estoque });
    }

    return produtos.map(p => {

        const imgs = imagensPor.get(p.id) || [];
        const vars = variacoesPor.get(p.id) || [];

        const publico = {
            id: p.id,
            nome: p.nome,
            descricao: p.descricao || "",
            preco: p.preco,
            // "de R$ X por R$ Y": só vale se o preço antigo for maior que o atual
            preco_antigo: p.preco_antigo > p.preco ? p.preco_antigo : null,
            destaque: p.destaque === 1,
            criado_em: p.criado_em || null,
            categoria: p.categoria || null,
            imagem: imgs[0] || "",
            imagens: imgs,
            variacoes: vars,
            estoque: vars.reduce((soma, v) => soma + v.estoque, 0)
        };

        if (!admin) return publico;

        return {
            ...publico,
            ativo: !!p.ativo,
            peso: p.peso,
            largura: p.largura,
            altura: p.altura,
            comprimento: p.comprimento
        };
    });
}

function numeroOpcional(valor, min, max, rotulo) {

    if (valor === undefined || valor === null || valor === "") return null;

    const n = Number(String(valor).replace(",", "."));

    if (!Number.isFinite(n) || n < min || n > max) {
        throw erroValidacao(`${rotulo} inválido`);
    }

    return n;
}

// Valida e limpa os dados vindos do painel antes de gravar
function validarProduto(body) {

    const b = body || {};

    const nome = texto(b.nome, 200);

    if (nome.length < 3) {
        throw erroValidacao("Informe o nome do produto (mínimo 3 letras)");
    }

    const preco = Number(String(b.preco ?? 0).replace(",", "."));

    if (!Number.isFinite(preco) || preco < 0 || preco > 100000) {
        throw erroValidacao("Preço inválido");
    }

    // Preço antigo (opcional): quando preenchido, o produto aparece em "Promoções" com o valor antigo riscado
    let precoAntigo = null;

    if (b.preco_antigo !== undefined && b.preco_antigo !== null && String(b.preco_antigo).trim() !== "") {

        precoAntigo = Number(String(b.preco_antigo).replace(",", "."));

        if (!Number.isFinite(precoAntigo) || precoAntigo <= 0 || precoAntigo > 100000) {
            throw erroValidacao("Preço antigo inválido");
        }

        if (!(precoAntigo > preco)) {
            throw erroValidacao("O preço antigo precisa ser maior que o preço atual (ou deixe em branco)");
        }
    }

    const destaque = b.destaque === true;

    const ativo = b.ativo === true;

    if (ativo && !(preco > 0)) {
        throw erroValidacao("Defina um preço maior que zero para mostrar o produto na loja");
    }

    const categoria = texto(b.categoria, 40) || null;

    if (categoria && !CATEGORIAS.some(c => c.id === categoria)) {
        throw erroValidacao("Categoria inválida");
    }

    const imagens = [...new Set(
        (Array.isArray(b.imagens) ? b.imagens : [])
            .map(u => String(u).trim())
            .filter(Boolean)
    )];

    if (imagens.length > 9) {
        throw erroValidacao("No máximo 9 imagens por produto");
    }

    for (const url of imagens) {
        const nossa = /^\/uploads\/[a-f0-9]{24}\.(jpg|png|webp)$/.test(url);
        const externa = /^https:\/\/[^\s"'<>]+$/.test(url);
        if (!nossa && !externa) throw erroValidacao("Imagem inválida");
    }

    if (!Array.isArray(b.variacoes) || b.variacoes.length < 1 || b.variacoes.length > 80) {
        throw erroValidacao("Informe o estoque do produto (ou ao menos uma cor/tamanho)");
    }

    const vistos = new Set();

    const variacoes = b.variacoes.map((v, i) => {

        const cor = texto(v?.cor, 30);

        // Só cor (sem tamanho) é válido: o tamanho vira "Único"
        const nomeV = texto(v?.nome, 20) || (cor ? VARIACAO_UNICA : "");

        if (!nomeV) throw erroValidacao("Todos os tamanhos precisam ter um nome");

        const rotulo = [cor, rotuloTamanho(nomeV)].filter(Boolean).join(" · ") || nomeV;
        const chave = `${cor.toLowerCase()}|${nomeV.toLowerCase()}`;

        if (vistos.has(chave)) {
            throw erroValidacao(`Variação repetida: ${rotulo}`);
        }

        vistos.add(chave);

        const estoque = Number(v?.estoque);

        if (!Number.isInteger(estoque) || estoque < 0 || estoque > 9999) {
            throw erroValidacao(`Estoque inválido em "${rotulo}"`);
        }

        const id = Number(v?.id);

        return {
            id: Number.isSafeInteger(id) && id > 0 ? id : null,
            nome: nomeV,
            cor,
            estoque,
            ordem: i
        };
    });

    return {
        nome,
        descricao: texto(b.descricao, 2000),
        preco: Math.round(preco * 100) / 100,
        preco_antigo: precoAntigo === null ? null : Math.round(precoAntigo * 100) / 100,
        destaque,
        ativo,
        categoria,
        peso: numeroOpcional(b.peso, 0.01, 30, "Peso"),
        largura: numeroOpcional(b.largura, 1, 100, "Largura"),
        altura: numeroOpcional(b.altura, 1, 100, "Altura"),
        comprimento: numeroOpcional(b.comprimento, 1, 100, "Comprimento"),
        imagens,
        variacoes
    };
}

// Apaga do disco as fotos enviadas que nenhum produto usa mais
async function removerArquivosOrfaos(urls) {

    for (const url of urls) {

        const m = /^\/uploads\/([a-f0-9]{24}\.(?:jpg|png|webp))$/.exec(url);

        if (!m) continue;

        // banners e logo também usam arquivos enviados
        if (urlsDaAparencia().has(url)) continue;

        const { total } = await dbGet(
            "SELECT COUNT(*) AS total FROM produto_imagens WHERE url = ?",
            [url]
        );

        if (total === 0) {
            await fs.promises.unlink(path.join(UPLOADS_DIR, m[1])).catch(() => {});
        }
    }
}

async function gravarImagens(produtoId, imagens) {

    const antigas = (
        await dbAll("SELECT url FROM produto_imagens WHERE produto_id = ?", [produtoId])
    ).map(r => r.url);

    await dbRun("DELETE FROM produto_imagens WHERE produto_id = ?", [produtoId]);

    for (let i = 0; i < imagens.length; i++) {
        await dbRun(
            "INSERT INTO produto_imagens (produto_id, url, ordem) VALUES (?, ?, ?)",
            [produtoId, imagens[i], i]
        );
    }

    await removerArquivosOrfaos(antigas.filter(u => !imagens.includes(u)));
}

// Mantém o id dos tamanhos que já existiam (pedidos e carrinhos apontam para eles)
async function gravarVariacoes(produtoId, variacoes) {

    const existentes = (
        await dbAll("SELECT id FROM produto_variacoes WHERE produto_id = ?", [produtoId])
    ).map(r => r.id);

    const mantidas = new Set();

    for (const v of variacoes) {

        if (v.id && existentes.includes(v.id)) {

            await dbRun(
                "UPDATE produto_variacoes SET nome = ?, cor = ?, estoque = ?, ordem = ? WHERE id = ?",
                [v.nome, v.cor || "", v.estoque, v.ordem, v.id]
            );

            mantidas.add(v.id);

        } else {

            await dbRun(
                "INSERT INTO produto_variacoes (produto_id, nome, cor, estoque, ordem) VALUES (?, ?, ?, ?, ?)",
                [produtoId, v.nome, v.cor || "", v.estoque, v.ordem]
            );
        }
    }

    for (const id of existentes) {
        if (!mantidas.has(id)) {
            await dbRun("DELETE FROM produto_variacoes WHERE id = ?", [id]);
        }
    }
}

// ======================================================
// IMPORTAÇÃO DA PLANILHA DA SHOPEE (CSV)
// ======================================================

const ALIASES_PLANILHA = {
    id: ["id do produto", "product id", "id"],
    nome: ["nome do produto", "product name", "nome", "titulo"],
    descricao: ["descricao do produto", "product description", "descricao"],
    preco: ["preco", "preco (r$)", "preco de venda", "preco original", "price"],
    estoque: ["estoque", "quantidade em estoque", "quantidade", "stock"]
};

const MAX_LINHAS_PLANILHA = 8000;

// Palavras que aparecem em muitos produtos da loja ("Blusa", "Feminina"...) não ajudam a
// dizer se dois nomes são do mesmo produto; só as palavras distintivas contam.
function palavrasComuns(nomes) {

    if (nomes.length < 20) return new Set();

    const contagem = new Map();

    for (const nome of nomes) {
        for (const w of new Set(semAcento(nome).split(/[^a-z0-9]+/).filter(w => w.length >= 3))) {
            contagem.set(w, (contagem.get(w) || 0) + 1);
        }
    }

    return new Set([...contagem].filter(([, n]) => n / nomes.length > 0.15).map(([w]) => w));
}

// 0 = nomes sem nada em comum, 1 = mesmo produto (ou sem base para comparar)
function similaridadeNomes(a, b, comuns) {

    const palavras = t =>
        new Set(semAcento(t).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !comuns.has(w)));

    const A = palavras(a);
    const B = palavras(b);

    if (A.size === 0 || B.size === 0) return 1;

    let iguais = 0;

    for (const w of A) if (B.has(w)) iguais++;

    return iguais / Math.min(A.size, B.size);
}

const acharColuna = (cabecalhos, nomes) =>
    nomes.map(n => cabecalhos.find(h => h === n)).find(Boolean) || null;

function lerPrecoPlanilha(valor) {

    let t = String(valor ?? "").replace(/[^\d.,]/g, "");

    if (!t) return null;

    // "1.234,50" -> 1234.50 | "34,90" -> 34.90 | "34.90" -> 34.90
    if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");

    const n = Number(t);

    return Number.isFinite(n) && n > 0 && n <= 100000 ? Math.round(n * 100) / 100 : null;
}

function lerEstoquePlanilha(valor) {

    const t = String(valor ?? "").trim();

    if (!/^\d{1,4}$/.test(t)) return null;

    return Number(t);
}

// Planilha de "informações básicas" da Shopee (nome, descrição, fotos)
async function analisarPlanilha({ linhas, cabecalhos }, opcoes) {

    if (linhas.length === 0) {
        throw erroValidacao("A planilha está vazia.");
    }

    const colId = acharColuna(cabecalhos, ALIASES_PLANILHA.id);
    const colNome = acharColuna(cabecalhos, ALIASES_PLANILHA.nome);
    const colDescricao = acharColuna(cabecalhos, ALIASES_PLANILHA.descricao);
    const colPreco = acharColuna(cabecalhos, ALIASES_PLANILHA.preco);
    const colEstoque = acharColuna(cabecalhos, ALIASES_PLANILHA.estoque);

    // Colunas de foto (a capa primeiro). A "Imagem de Tamanhos" é a tabela de medidas, não é foto do produto.
    const colImagens = cabecalhos
        .filter(h => /^(imagem|image)/.test(h) && !/tamanho|medida|size/.test(h))
        .sort((a, b) => Number(b.includes("capa")) - Number(a.includes("capa")));

    if (!colId || !colNome) {
        throw erroValidacao(
            'Não encontrei as colunas "ID do Produto" e "Nome do Produto". ' +
            "Confira se é a planilha de produtos da Shopee salva como CSV."
        );
    }

    // Estado atual da loja
    const existentes = new Map(
        (await dbAll("SELECT id, nome, descricao, preco, categoria FROM produtos")).map(p => [p.id, p])
    );

    const fotosAtuais = new Map();
    for (const f of await dbAll("SELECT produto_id, url FROM produto_imagens ORDER BY ordem ASC, id ASC")) {
        if (!fotosAtuais.has(f.produto_id)) fotosAtuais.set(f.produto_id, []);
        fotosAtuais.get(f.produto_id).push(f.url);
    }

    const variacoesAtuais = new Map();
    for (const v of await dbAll("SELECT produto_id, nome, estoque FROM produto_variacoes ORDER BY ordem ASC, id ASC")) {
        if (!variacoesAtuais.has(v.produto_id)) variacoesAtuais.set(v.produto_id, []);
        variacoesAtuais.get(v.produto_id).push(v);
    }

    const vistos = new Set();
    const registros = [];

    const comuns = palavrasComuns([...existentes.values()].map(p => p.nome));

    linhas.forEach((linha, i) => {

        const numeroLinha = linha.__linha; // linha na planilha original

        const idTexto = String(linha[colId] ?? "").trim();
        const id = /^\d{1,15}$/.test(idTexto) ? Number(idTexto) : null;
        const nome = texto(linha[colNome], 200);

        const base = { linha: numeroLinha, id, nome };

        if (!id || id < 1) {
            return registros.push({ ...base, acao: "ignorar", motivo: "ID do produto inválido ou vazio" });
        }

        if (id < ID_MAX_PAINEL) {
            return registros.push({
                ...base,
                acao: "ignorar",
                motivo: "ID curto demais: parece um produto cadastrado no painel, não da Shopee"
            });
        }

        if (nome.length < 3) {
            return registros.push({ ...base, acao: "ignorar", motivo: "Nome vazio" });
        }

        if (vistos.has(id)) {
            return registros.push({ ...base, acao: "ignorar", motivo: "ID repetido na planilha" });
        }

        vistos.add(id);

        const descricao = String(linha[colDescricao] ?? "")
            .replace(/\r/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim()
            .slice(0, 2000);

        const imagens = [];

        for (const col of colImagens) {

            const url = String(linha[col] ?? "").trim().replace(/^http:\/\//i, "https://");

            if (/^https:\/\/[^\s"'<>]+$/.test(url) && !imagens.includes(url)) {
                imagens.push(url);
            }
        }

        const preco = colPreco ? lerPrecoPlanilha(linha[colPreco]) : null;
        const estoque = colEstoque ? lerEstoquePlanilha(linha[colEstoque]) : null;
        const categoria = sugerirCategoria(nome);

        const dados = {
            ...base,
            descricao,
            imagens: imagens.slice(0, 9),
            preco,
            estoque,
            categoria
        };

        const atual = existentes.get(id);

        if (!atual) {
            return registros.push({ ...dados, acao: "novo", mudancas: [] });
        }

        // Mesmo ID, mas o nome não tem nada a ver: pode ser outro produto. Não mexe sem confirmação.
        const suspeito = similaridadeNomes(nome, atual.nome, comuns) < 0.3;

        if (suspeito && !opcoes.incluirConferir) {
            return registros.push({ ...dados, acao: "conferir", nomeAtual: atual.nome, mudancas: [] });
        }

        const mudancas = [];

        if (opcoes.nome && nome !== atual.nome) mudancas.push("nome");

        if (opcoes.descricao && descricao && descricao !== (atual.descricao || "")) {
            mudancas.push("descrição");
        }

        if (opcoes.fotos && dados.imagens.length > 0) {
            const atuais = fotosAtuais.get(id) || [];
            if (JSON.stringify(atuais) !== JSON.stringify(dados.imagens)) mudancas.push("fotos");
        }

        if (opcoes.precoEstoque) {

            if (preco !== null && preco !== atual.preco) mudancas.push("preço");

            const vars = variacoesAtuais.get(id) || [];
            const semTamanho = vars.length === 1 && vars[0].nome === VARIACAO_UNICA;

            if (estoque !== null && semTamanho && estoque !== vars[0].estoque) {
                mudancas.push("estoque");
            }
        }

        if (categoria && !atual.categoria) mudancas.push("categoria");

        registros.push({
            ...dados,
            acao: mudancas.length > 0 ? "atualizar" : "igual",
            mudancas,
            nomeAtual: nome !== atual.nome ? atual.nome : undefined
        });
    });

    const contar = acao => registros.filter(r => r.acao === acao).length;

    const avisos = [];

    if (contar("conferir") > 0) {
        avisos.push(
            `${contar("conferir")} produto(s) da planilha têm o mesmo ID de um produto da loja, mas um nome bem ` +
            'diferente. Eles NÃO serão alterados. Veja a aba "Conferir"; se o ID estiver certo, marque ' +
            '"Incluir produtos com nome muito diferente".'
        );
    }

    if (!colPreco) {
        avisos.push("Esta planilha não tem coluna de preço: produtos novos entram ocultos até você definir o preço.");
    }

    if (!colEstoque) {
        avisos.push("Esta planilha não tem coluna de estoque: produtos novos entram com estoque 0.");
    }

    return {
        registros,
        resumo: {
            total: registros.length,
            novos: contar("novo"),
            atualizar: contar("atualizar"),
            conferir: contar("conferir"),
            iguais: contar("igual"),
            ignorados: contar("ignorar")
        },
        avisos,
        colunas: { preco: !!colPreco, estoque: !!colEstoque }
    };
}

async function aplicarPlanilha(registros, opcoes) {

    let criados = 0;
    let atualizados = 0;
    const falhas = [];

    for (const r of registros) {

        if (r.acao !== "novo" && r.acao !== "atualizar") continue;

        try {

            if (r.acao === "novo") {

                const preco = r.preco ?? 0;

                await dbRun(
                    `INSERT INTO produtos (id, nome, descricao, preco, ativo, posicao, categoria)
                     VALUES (?, ?, ?, ?, ?, 0, ?)`,
                    [r.id, r.nome, r.descricao, preco, preco > 0 ? 1 : 0, r.categoria]
                );

                await gravarImagens(r.id, r.imagens);

                await gravarVariacoes(r.id, [
                    { id: null, nome: VARIACAO_UNICA, estoque: r.estoque ?? 0, ordem: 0 }
                ]);

                criados++;
                continue;
            }

            // Atualização: só mexe no que foi marcado e mudou
            const campos = [];
            const valores = [];

            if (r.mudancas.includes("nome")) { campos.push("nome = ?"); valores.push(r.nome); }
            if (r.mudancas.includes("descrição")) { campos.push("descricao = ?"); valores.push(r.descricao); }
            if (r.mudancas.includes("preço")) { campos.push("preco = ?"); valores.push(r.preco); }
            if (r.mudancas.includes("categoria")) { campos.push("categoria = ?"); valores.push(r.categoria); }

            if (campos.length > 0) {
                await dbRun(
                    `UPDATE produtos SET ${campos.join(", ")}, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`,
                    [...valores, r.id]
                );
            }

            if (r.mudancas.includes("fotos")) {
                await gravarImagens(r.id, r.imagens);
            }

            if (r.mudancas.includes("estoque")) {
                await dbRun("UPDATE produto_variacoes SET estoque = ? WHERE produto_id = ?", [r.estoque, r.id]);
            }

            atualizados++;

        } catch (erro) {
            console.log("ERRO IMPORTAÇÃO:", r.id, erro.message);
            falhas.push({ id: r.id, nome: r.nome, motivo: "Erro ao gravar no banco" });
        }
    }

    return { criados, atualizados, falhas };
}

// ======================================================
// IMPORTAÇÃO: leitura unificada (CSV ou XLSX), modelo padrão da loja
// e planilha de "informações de venda" da Shopee
// ======================================================

const normCabecalho = t => semAcento(t).replace(/\s+/g, " ").trim();

const CABECALHOS_CHAVE = ["id do produto", "codigo do produto", "nome do produto", "product id"];

// Transforma a matriz (linhas x colunas) em objetos por cabeçalho.
// A planilha da Shopee tem linhas de instrução acima do cabeçalho: ele é localizado pelo nome.
function matrizParaLinhas(matriz) {

    let idx = matriz.slice(0, 30).findIndex(r => r.some(c => CABECALHOS_CHAVE.includes(normCabecalho(c))));
    const reconhecido = idx >= 0;

    if (idx < 0) idx = matriz.findIndex(r => r.some(c => String(c ?? "").trim()));

    if (idx < 0) return null;

    const cabecalhos = matriz[idx].map(normCabecalho);
    const linhas = [];

    for (let i = idx + 1; i < matriz.length; i++) {

        const r = matriz[i];

        if (!r.some(c => String(c ?? "").trim())) continue;

        const o = { __linha: i + 1 }; // número da linha na planilha original

        cabecalhos.forEach((h, c) => {
            if (h && !(h in o)) o[h] = String(r[c] ?? "").trim();
        });

        linhas.push(o);
    }

    return { linhas, cabecalhos: cabecalhos.filter(Boolean), reconhecido };
}

function carregarPlanilha(body) {

    let abas;

    if (typeof body?.xlsx === "string" && body.xlsx.length > 0) {

        const buf = Buffer.from(body.xlsx, "base64");

        if (buf.length > 4 && buf.readUInt32BE(0) === 0xd0cf11e0) {
            throw erroValidacao(
                "Esse é um arquivo Excel antigo (.xls). Abra no Excel e use Salvar como → " +
                "Pasta de Trabalho do Excel (.xlsx), ou salve como CSV."
            );
        }

        try {
            abas = lerXlsx(buf);
        } catch {
            throw erroValidacao(
                "Não consegui ler esse arquivo Excel. Confira se é um .xlsx e se não está protegido por senha."
            );
        }

    } else if (typeof body?.csv === "string" && body.csv.trim().length >= 10) {

        abas = [{ nome: "CSV", linhas: parseCsv(body.csv) }];

    } else {
        throw erroValidacao("Envie a planilha (.xlsx ou .csv)");
    }

    const achados = abas.map(a => matrizParaLinhas(a.linhas)).filter(Boolean);
    const escolhido = achados.find(a => a.reconhecido) || achados[0];

    if (!escolhido) throw erroValidacao("A planilha está vazia.");

    if (escolhido.linhas.length > MAX_LINHAS_PLANILHA) {
        throw erroValidacao(`A planilha tem linhas demais (máximo ${MAX_LINHAS_PLANILHA}).`);
    }

    return escolhido;
}

// Descobre que tipo de planilha é, pelos cabeçalhos
function tipoDaPlanilha(c) {

    const tem = n => c.includes(n);
    const temImagem = c.some(h => /^(imagem|image)/.test(h) && !/tamanho|medida|size/.test(h));

    if (
        tem("id do produto") && tem("preco") && tem("estoque") &&
        (tem("variante identificador") || tem("nome")) && !tem("tamanho") && !tem("categoria")
    ) {
        return "vendas";
    }

    if (tem("descricao do produto") && temImagem && !tem("categoria") && !tem("tamanho")) {
        return "produtos-shopee";
    }

    if (tem("codigo do produto") || tem("categoria") || tem("tamanho") || tem("nome do produto")) {
        return "modelo";
    }

    return null;
}

// ---------- tamanhos ----------

const ORDEM_TAMANHOS = ["PP", "P", "M", "G", "GG", "XG", "XGG", "EG", "EGG", "G1", "G2", "G3"];

function normalizarTamanho(bruto) {

    let t = String(bruto ?? "").replace(/\s+/g, " ").trim().replace(/^tamanho\s+/i, "");

    if (!t) return VARIACAO_UNICA;

    if (/^(u|unico|tam unico)$/.test(semAcento(t))) return VARIACAO_UNICA;

    if (ORDEM_TAMANHOS.includes(t.toUpperCase())) return t.toUpperCase();

    return t.slice(0, 20);
}

const ehTamanhoConhecido = t =>
    t === VARIACAO_UNICA || ORDEM_TAMANHOS.includes(t) || /^\d{2}$/.test(t);

function posicaoTamanho(nome) {

    if (nome === VARIACAO_UNICA) return -1;

    const i = ORDEM_TAMANHOS.indexOf(nome.toUpperCase());

    if (i >= 0) return i;

    if (/^\d+$/.test(nome)) return 100 + Number(nome);

    return 1000;
}

// Agrupa por cor (na ordem em que aparecem) e, dentro de cada cor, ordena os tamanhos (P, M, G...)
function ordenarTamanhos(lista) {

    const ordemCores = new Map();

    lista.forEach(v => {
        const c = String(v.cor || "").toLowerCase();
        if (!ordemCores.has(c)) ordemCores.set(c, ordemCores.size);
    });

    return lista
        .map((v, i) => ({ v, i }))
        .sort((a, b) =>
            ordemCores.get(String(a.v.cor || "").toLowerCase()) - ordemCores.get(String(b.v.cor || "").toLowerCase()) ||
            posicaoTamanho(a.v.nome) - posicaoTamanho(b.v.nome) ||
            a.i - b.i
        )
        .map(({ v }, ordem) => ({ ...v, ordem }));
}

// Na Shopee a variação vem como "Cor,Tamanho" (ex.: "Preto,GG"). Devolve { cor, tamanho }.
// Só cor/estampa (sem tamanho) vira cor + tamanho "Único"; só tamanho (P, M, 38...) fica sem cor.
function variacaoDaShopee(nome) {

    const partes = String(nome ?? "").split(",").map(p => p.trim()).filter(Boolean);

    if (partes.length >= 2) {

        let tamanho = normalizarTamanho(partes[partes.length - 1]);
        let cores = partes.slice(0, -1);

        // Alguns anúncios usam "Tamanho,Cor": inverte quando só o primeiro é um tamanho conhecido
        const primeiro = normalizarTamanho(partes[0]);

        if (!ehTamanhoConhecido(tamanho) && ehTamanhoConhecido(primeiro)) {
            tamanho = primeiro;
            cores = partes.slice(1);
        }

        return { cor: cores.join(" / ").slice(0, 30), tamanho };
    }

    if (partes.length === 1) {

        const t = normalizarTamanho(partes[0]);

        if (ehTamanhoConhecido(t)) return { cor: "", tamanho: t };

        return { cor: partes[0].slice(0, 30), tamanho: VARIACAO_UNICA };
    }

    return { cor: "", tamanho: VARIACAO_UNICA };
}

// Junta os tamanhos que a planilha trouxe com os que a loja já tem.
// Nunca remove tamanho que a planilha não cita (só o "Único", que é um espaço reservado).
function combinarVariacoes(atuais, novas, { criar, estoque }) {

    const lista = atuais.map(v => ({ id: v.id, nome: v.nome, cor: v.cor || "", estoque: v.estoque }));

    const minus = t => String(t || "").toLowerCase();
    const mesma = (v, n) => minus(v.cor) === minus(n.cor) && minus(v.nome) === minus(n.nome);

    const achar = n => lista.find(v => mesma(v, n));

    // Produto cadastrado antes das cores: a linha "M" (sem cor) é adotada pela primeira cor "M" da planilha,
    // mantendo o mesmo id (carrinhos e pedidos continuam apontando para ela)
    const adotaveis = lista.filter(v => !v.cor);
    const adotadas = new Set();

    let mudouEstoque = false;
    let mudouTamanhos = false;
    const naoCriados = [];

    for (const n of novas) {

        n.cor = n.cor || "";

        let v = achar(n);

        if (!v && n.cor && criar) {

            v = adotaveis.find(a => !adotadas.has(a) && minus(a.nome) === minus(n.nome));

            if (v) {
                adotadas.add(v);
                v.cor = n.cor;
                mudouTamanhos = true;
            }
        }

        if (v) {

            if (estoque && n.estoque !== null && v.estoque !== n.estoque) {
                v.estoque = n.estoque;
                mudouEstoque = true;
            }

        } else if (criar && (n.nome !== VARIACAO_UNICA || n.cor)) {

            lista.push({ id: null, nome: n.nome, cor: n.cor, estoque: estoque && n.estoque !== null ? n.estoque : 0 });
            mudouTamanhos = true;

        } else {
            naoCriados.push([n.cor, n.nome].filter(Boolean).join(" · "));
        }
    }

    // "Único" só existe porque o produto ainda não tinha tamanhos; sai quando a planilha traz os reais
    const traxeReais = novas.some(n => n.nome !== VARIACAO_UNICA || n.cor);
    const iUnico = lista.findIndex(v => v.nome === VARIACAO_UNICA && !v.cor);

    if (criar && estoque && traxeReais && iUnico >= 0 && lista.length > 1 && !novas.some(n => n.nome === VARIACAO_UNICA && !n.cor)) {
        lista.splice(iUnico, 1);
        mudouTamanhos = true;
    }

    const final = mudouTamanhos
        ? ordenarTamanhos(lista)
        : lista.map((v, ordem) => ({ ...v, ordem }));

    return { lista: final, mudouEstoque, mudouTamanhos, naoCriados };
}

const COLUNAS_PRODUTO = ["nome", "descricao", "preco", "ativo", "peso", "largura", "altura", "comprimento", "categoria"];

const camposDe = p => ({
    nome: p.nome,
    descricao: p.descricao,
    preco: p.preco,
    ativo: p.ativo ? 1 : 0,
    peso: p.peso,
    largura: p.largura,
    altura: p.altura,
    comprimento: p.comprimento,
    categoria: p.categoria
});

const reais = n => "R$ " + n.toFixed(2).replace(".", ",");

const mesmoNumero = (a, b) => (a ?? null) === (b ?? null);

function resumir(registros) {

    const contar = acao => registros.filter(r => r.acao === acao).length;

    return {
        total: registros.length,
        novos: contar("novo"),
        atualizar: contar("atualizar"),
        conferir: contar("conferir"),
        iguais: contar("igual"),
        ignorados: contar("ignorar")
    };
}

// ---------- planilha da Shopee: alteração em massa (informações de venda) ----------

async function analisarVendasShopee({ linhas, cabecalhos }, opcoes) {

    const colId = acharColuna(cabecalhos, ["id do produto", "product id"]);
    const colProduto = acharColuna(cabecalhos, ["nome do produto", "product name"]);
    const colVariacao = acharColuna(cabecalhos, ["nome", "nome da variacao", "variation name"]);
    const colPreco = acharColuna(cabecalhos, ["preco", "price"]);
    const colEstoque = acharColuna(cabecalhos, ["estoque", "stock"]);

    // Agrupa as variações (uma linha cada) por produto
    const grupos = new Map();

    for (const linha of linhas) {

        const idTexto = String(linha[colId] ?? "").trim();

        // linhas de instrução da Shopee ("Obrigatório", avisos) não têm ID numérico: são puladas
        if (!/^\d{1,15}$/.test(idTexto)) continue;

        const id = Number(idTexto);

        if (!grupos.has(id)) {
            grupos.set(id, { id, linha: linha.__linha, nome: texto(linha[colProduto], 200), itens: [] });
        }

        const { cor, tamanho } = colVariacao
            ? variacaoDaShopee(linha[colVariacao])
            : { cor: "", tamanho: VARIACAO_UNICA };

        grupos.get(id).itens.push({
            cor,
            tamanho,
            preco: lerPrecoPlanilha(linha[colPreco]),
            estoque: lerEstoquePlanilha(linha[colEstoque])
        });
    }

    if (grupos.size === 0) {
        throw erroValidacao(
            "Não encontrei produtos nessa planilha. Confira se é a planilha de alteração em massa " +
            "da Shopee, de “Informações de venda” (o arquivo começa com mass_update_sales_info)."
        );
    }

    const catalogo = new Map((await listarProdutos({ admin: true })).map(p => [p.id, p]));
    const comuns = palavrasComuns([...catalogo.values()].map(p => p.nome));

    const registros = [];
    let comPrecosDiferentes = 0;

    for (const g of grupos.values()) {

        const base = { linha: g.linha, id: g.id, nome: g.nome };

        if (g.id < ID_MAX_PAINEL) {
            registros.push({
                ...base,
                acao: "ignorar",
                motivo: "ID curto demais: parece um produto cadastrado no painel, não da Shopee"
            });
            continue;
        }

        const precos = g.itens.map(i => i.preco).filter(p => p !== null);
        const menorPreco = precos.length ? Math.min(...precos) : null;
        const notas = [];

        if (precos.length && Math.max(...precos) - menorPreco > 0.001) {
            comPrecosDiferentes++;
            notas.push(
                `Preços diferentes entre as variações (${reais(menorPreco)} a ${reais(Math.max(...precos))}). ` +
                "A loja tem um preço só por produto: usei o menor."
            );
        }

        // Estoque por cor + tamanho (linhas repetidas da mesma combinação são somadas)
        const porTamanho = new Map();

        for (const i of g.itens) {

            const chave = `${i.cor.toLowerCase()}|${i.tamanho.toLowerCase()}`;
            const atual = porTamanho.get(chave) || { nome: i.tamanho, cor: i.cor, estoque: null };

            if (i.estoque !== null) atual.estoque = Math.min(9999, (atual.estoque ?? 0) + i.estoque);

            porTamanho.set(chave, atual);
        }

        const novas = [...porTamanho.values()];
        const atual = catalogo.get(g.id);

        // ----- produto que ainda não está na loja -----
        if (!atual) {

            if (!opcoes.cadastrarNovos) {
                registros.push({
                    ...base,
                    acao: "ignorar",
                    motivo: "Não está na loja. Para cadastrá-lo marque “Cadastrar produtos que ainda não existem”."
                });
                continue;
            }

            try {

                const p = validarProduto({
                    nome: g.nome,
                    descricao: "",
                    preco: menorPreco ?? 0,
                    ativo: false,
                    categoria: sugerirCategoria(g.nome),
                    imagens: [],
                    variacoes: ordenarTamanhos(novas).map(v => ({ id: null, nome: v.nome, cor: v.cor, estoque: v.estoque ?? 0 }))
                });

                registros.push({
                    ...base,
                    acao: "novo",
                    mudancas: [],
                    categoria: p.categoria,
                    notas: [...notas, "Entra oculto, sem fotos nem descrição. Complete o cadastro e ative depois."],
                    gravar: { id: g.id, campos: camposDe(p), imagens: [], variacoes: p.variacoes }
                });

            } catch (erro) {

                if (!erro.validacao) throw erro;

                registros.push({ ...base, acao: "ignorar", motivo: erro.message });
            }

            continue;
        }

        // ----- produto que já existe -----
        const suspeito = similaridadeNomes(g.nome, atual.nome, comuns) < 0.3;

        if (suspeito && !opcoes.incluirConferir) {
            registros.push({ ...base, acao: "conferir", nomeAtual: atual.nome, mudancas: [] });
            continue;
        }

        const mudancas = [];
        const campos = {};

        if (opcoes.preco && menorPreco !== null && Math.abs(menorPreco - atual.preco) > 0.001) {
            mudancas.push("preço");
            campos.preco = menorPreco;
        }

        const comb = combinarVariacoes(atual.variacoes, novas, {
            criar: opcoes.criarTamanhos,
            estoque: opcoes.estoque
        });

        if (comb.mudouEstoque) mudancas.push("estoque");
        if (comb.mudouTamanhos) mudancas.push("tamanhos");

        if (comb.naoCriados.length > 0) {
            notas.push(
                `Cores/tamanhos da planilha que a loja não tem e não foram criados: ${comb.naoCriados.join(", ")}.`
            );
        }

        registros.push({
            ...base,
            acao: mudancas.length > 0 ? "atualizar" : "igual",
            mudancas,
            notas,
            nomeAtual: g.nome !== atual.nome ? atual.nome : undefined,
            gravar: { id: g.id, campos, imagens: null, variacoes: comb.lista }
        });
    }

    const avisos = [
        "Nesta planilha só entram preço e estoque. Nomes, descrições e fotos dos produtos não são alterados."
    ];

    const resumo = resumir(registros);

    if (resumo.conferir > 0) {
        avisos.push(
            `${resumo.conferir} produto(s) da planilha têm o mesmo ID de um produto da loja, mas um nome bem ` +
            'diferente. Eles NÃO serão alterados. Veja a aba "Conferir"; se o ID estiver certo, marque ' +
            '"Incluir produtos com nome muito diferente".'
        );
    }

    if (comPrecosDiferentes > 0) {
        avisos.push(
            `${comPrecosDiferentes} produto(s) têm preços diferentes entre as variações na Shopee. ` +
            "A loja usa um preço por produto (o menor)."
        );
    }

    if (!colPreco || !colEstoque) {
        avisos.push("A planilha não tem as colunas de preço e estoque. Confira se é a de “Informações de venda”.");
    }

    return { registros, resumo, avisos, colunas: { preco: true, estoque: true } };
}

// ---------- modelo padrão da loja ----------

const ALIASES_MODELO = {
    id: ["codigo do produto", "id do produto", "codigo", "id"],
    nome: ["nome do produto", "nome", "produto"],
    descricao: ["descricao", "descricao do produto"],
    categoria: ["categoria"],
    preco: ["preco (r$)", "preco", "preco r$"],
    cor: ["cor", "cores"],
    tamanho: ["tamanho", "variacao"],
    estoque: ["estoque", "quantidade"],
    ativo: ["ativo (sim/nao)", "ativo", "mostrar na loja"],
    peso: ["peso (kg)", "peso"],
    largura: ["largura (cm)", "largura"],
    altura: ["altura (cm)", "altura"],
    comprimento: ["comprimento (cm)", "comprimento"]
};

function lerSimNao(valor) {

    const t = semAcento(valor).trim();

    if (!t) return undefined;
    if (["sim", "s", "1", "true", "x", "ativo", "yes"].includes(t)) return true;
    if (["nao", "n", "0", "false", "inativo", "oculto", "no"].includes(t)) return false;

    throw erroValidacao('A coluna Ativo só aceita "Sim" ou "Não"');
}

function lerCategoria(valor) {

    const t = semAcento(valor).trim();

    if (!t) return undefined;

    const achada = CATEGORIAS.find(c => semAcento(c.id) === t || semAcento(c.nome) === t);

    if (!achada) {
        throw erroValidacao(
            `Categoria não reconhecida: "${valor}". Use: ${CATEGORIAS.map(c => c.nome).join(", ")}`
        );
    }

    return achada.id;
}

async function analisarModelo({ linhas, cabecalhos }) {

    const c = Object.fromEntries(
        Object.entries(ALIASES_MODELO).map(([k, nomes]) => [k, acharColuna(cabecalhos, nomes)])
    );

    const colFotos = cabecalhos.filter(h => /^(foto|imagem|image)/.test(h) && !/tamanho|medida|size/.test(h));

    if (!c.nome) {
        throw erroValidacao('Não encontrei a coluna "Nome do produto". Baixe o modelo padrão e preencha nele.');
    }

    if (linhas.length === 0) {
        throw erroValidacao("A planilha não tem nenhum produto preenchido.");
    }

    const catalogo = new Map((await listarProdutos({ admin: true })).map(p => [p.id, p]));

    // Agrupa as linhas por produto: pelo código; sem código, pelo nome; sem nome, continua o produto anterior
    const grupos = [];
    const porChave = new Map();
    const registros = [];
    let corrente = null;

    for (const linha of linhas) {

        const idTexto = c.id ? String(linha[c.id] ?? "").trim() : "";
        const nome = texto(linha[c.nome], 200);

        let chave;

        if (idTexto) chave = "id:" + idTexto;
        else if (nome && corrente && semAcento(corrente.nomeBase) === semAcento(nome)) chave = corrente.chave;
        else if (nome) chave = "nome:" + semAcento(nome);
        else chave = corrente?.chave;

        if (!chave) {
            registros.push({
                linha: linha.__linha, id: null, nome: "", acao: "ignorar",
                motivo: "Linha sem produto: preencha o nome do produto"
            });
            continue;
        }

        let g = porChave.get(chave);

        if (!g) {
            g = { chave, linha: linha.__linha, nomeBase: nome, idTexto, rows: [] };
            porChave.set(chave, g);
            grupos.push(g);
        }

        if (idTexto && !g.idTexto) g.idTexto = idTexto;

        corrente = g;
        g.rows.push(linha);
    }

    for (const g of grupos) {

        const primeiro = coluna => {
            if (!coluna) return "";
            return g.rows.map(r => String(r[coluna] ?? "").trim()).find(Boolean) || "";
        };

        const base = { linha: g.linha, id: null, nome: primeiro(c.nome) || g.nomeBase };

        try {
            registros.push(processarProdutoModelo(g, base, c, colFotos, primeiro, catalogo));
        } catch (erro) {

            if (!erro.validacao) throw erro;

            registros.push({
                ...base,
                id: /^\d{1,15}$/.test(g.idTexto) ? Number(g.idTexto) : null,
                acao: "ignorar",
                motivo: erro.message
            });
        }
    }

    return {
        registros,
        resumo: resumir(registros),
        avisos: [
            "Células em branco não alteram o que já está cadastrado.",
            "Tamanhos que a planilha não cita são mantidos: nada é removido por planilha."
        ],
        colunas: { preco: !!c.preco, estoque: !!c.estoque }
    };
}

function processarProdutoModelo(g, base, c, colFotos, primeiro, catalogo) {

    const notas = [];

    // código
    let id = null;

    if (g.idTexto) {

        if (!/^\d{1,15}$/.test(g.idTexto)) {
            throw erroValidacao("Código do produto inválido (use só números, ou deixe em branco para um produto novo)");
        }

        id = Number(g.idTexto);
    }

    const atual = id ? catalogo.get(id) : null;

    if (id && !atual && id < ID_MAX_PAINEL) {
        throw erroValidacao("Esse código não existe na loja. Deixe o código em branco para cadastrar um produto novo.");
    }

    const nome = primeiro(c.nome);

    const descricao = primeiro(c.descricao)
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .slice(0, 2000);

    const categoria = lerCategoria(primeiro(c.categoria));
    const ativo = lerSimNao(primeiro(c.ativo));

    // preço
    let preco;
    const textoPreco = primeiro(c.preco);

    // "0" ou vazio = sem preço definido (não altera o que já existe)
    if (textoPreco && !/^0+([.,]0+)?$/.test(textoPreco)) {

        preco = lerPrecoPlanilha(textoPreco);

        if (preco === null) throw erroValidacao(`Preço inválido: "${textoPreco}"`);

        const outros = new Set(
            g.rows.map(r => lerPrecoPlanilha(r[c.preco])).filter(p => p !== null && p !== preco)
        );

        if (outros.size > 0) notas.push("Há preços diferentes entre as linhas do produto: usei o da primeira.");
    }

    // medidas (a validação final é feita por validarProduto)
    const medida = coluna => primeiro(coluna) || undefined;

    // fotos
    const fotos = [];

    for (const r of g.rows) {

        for (const col of colFotos) {

            const bruto = String(r[col] ?? "").trim().replace(/^http:\/\//i, "https://");

            if (!bruto) continue;

            const nossa = /^\/uploads\/[a-f0-9]{24}\.(jpg|png|webp)$/.test(bruto);
            const externa = /^https:\/\/[^\s"'<>]+$/.test(bruto);

            if (!nossa && !externa) {
                throw erroValidacao(`Foto inválida na linha ${r.__linha}: use o link completo, começando com https://`);
            }

            if (!fotos.includes(bruto)) fotos.push(bruto);
        }
    }

    // cores, tamanhos e estoque (uma linha por combinação de cor e tamanho)
    const novas = [];

    for (const r of g.rows) {

        const tamTxt = c.tamanho ? String(r[c.tamanho] ?? "").trim() : "";
        const corTxt = c.cor ? texto(r[c.cor], 30) : "";
        const estTxt = c.estoque ? String(r[c.estoque] ?? "").trim() : "";

        if (!tamTxt && !estTxt && !corTxt) continue;

        const tamanho = normalizarTamanho(tamTxt);

        let estoque = null;

        if (estTxt) {

            estoque = lerEstoquePlanilha(estTxt);

            if (estoque === null) {
                throw erroValidacao(`Estoque inválido na linha ${r.__linha}: use um número inteiro de 0 a 9999`);
            }
        }

        if (novas.some(n => n.nome.toLowerCase() === tamanho.toLowerCase() && n.cor.toLowerCase() === corTxt.toLowerCase())) {
            throw erroValidacao(`Variação repetida: ${[corTxt, rotuloTamanho(tamanho)].filter(Boolean).join(" · ") || tamanho}`);
        }

        novas.push({ cor: corTxt, nome: tamanho, estoque });
    }

    // ----- produto novo -----
    if (!atual) {

        const imagens = fotos;
        const precoFinal = preco ?? 0;
        const mostrar = ativo ?? (precoFinal > 0 && imagens.length > 0);

        if (ativo === undefined && !mostrar) {
            notas.push(
                "Entra oculto porque " +
                (precoFinal > 0 ? "não tem foto" : "não tem preço") +
                ". Complete o cadastro e ative depois."
            );
        }

        const p = validarProduto({
            nome,
            descricao,
            preco: precoFinal,
            ativo: mostrar,
            categoria: categoria ?? sugerirCategoria(nome),
            peso: medida(c.peso),
            largura: medida(c.largura),
            altura: medida(c.altura),
            comprimento: medida(c.comprimento),
            imagens,
            variacoes: novas.length
                ? ordenarTamanhos(novas).map(v => ({ id: null, nome: v.nome, cor: v.cor, estoque: v.estoque ?? 0 }))
                : [{ id: null, nome: VARIACAO_UNICA, cor: "", estoque: 0 }]
        });

        return {
            ...base,
            id,
            acao: "novo",
            mudancas: [],
            categoria: p.categoria,
            notas,
            gravar: { id, campos: camposDe(p), imagens: p.imagens, variacoes: p.variacoes }
        };
    }

    // ----- produto que já existe: o que está em branco fica como está -----
    const comb = novas.length
        ? combinarVariacoes(atual.variacoes, novas, { criar: true, estoque: true })
        : { lista: atual.variacoes.map((v, ordem) => ({ ...v, ordem })), mudouEstoque: false, mudouTamanhos: false };

    const p = validarProduto({
        nome: nome || atual.nome,
        descricao: descricao || atual.descricao || "",
        preco: preco ?? atual.preco,
        ativo: ativo ?? atual.ativo,
        categoria: categoria ?? atual.categoria,
        peso: medida(c.peso) ?? atual.peso,
        largura: medida(c.largura) ?? atual.largura,
        altura: medida(c.altura) ?? atual.altura,
        comprimento: medida(c.comprimento) ?? atual.comprimento,
        imagens: fotos.length > 0 ? fotos : atual.imagens,
        variacoes: comb.lista
    });

    const mudancas = [];

    if (p.nome !== atual.nome) mudancas.push("nome");
    if (p.descricao !== (atual.descricao || "")) mudancas.push("descrição");
    if (Math.abs(p.preco - atual.preco) > 0.001) mudancas.push("preço");
    if ((p.categoria || null) !== (atual.categoria || null)) mudancas.push("categoria");
    if (p.ativo !== atual.ativo) mudancas.push(p.ativo ? "mostrar na loja" : "ocultar da loja");

    if (
        !mesmoNumero(p.peso, atual.peso) || !mesmoNumero(p.largura, atual.largura) ||
        !mesmoNumero(p.altura, atual.altura) || !mesmoNumero(p.comprimento, atual.comprimento)
    ) {
        mudancas.push("peso/medidas");
    }

    if (JSON.stringify(p.imagens) !== JSON.stringify(atual.imagens)) mudancas.push("fotos");
    if (comb.mudouEstoque) mudancas.push("estoque");
    if (comb.mudouTamanhos) mudancas.push("tamanhos");

    return {
        ...base,
        id,
        acao: mudancas.length > 0 ? "atualizar" : "igual",
        mudancas,
        notas,
        nomeAtual: p.nome !== atual.nome ? atual.nome : undefined,
        categoria: p.categoria,
        gravar: {
            id,
            campos: camposDe(p),
            imagens: mudancas.includes("fotos") ? p.imagens : null,
            variacoes: comb.mudouEstoque || comb.mudouTamanhos ? p.variacoes : null
        }
    };
}

// Grava o resultado das duas análises acima (modelo padrão e Shopee "informações de venda")
async function aplicarGravacoes(registros) {

    let criados = 0;
    let atualizados = 0;
    let ocultos = 0;
    const falhas = [];

    for (const r of registros) {

        if (r.acao !== "novo" && r.acao !== "atualizar") continue;

        const g = r.gravar;
        let idGravado = null;

        try {

            if (r.acao === "novo") {

                const cols = COLUNAS_PRODUTO.filter(k => k in g.campos);
                const idSql = g.id
                    ? "?"
                    : `(SELECT COALESCE(MAX(id), 0) + 1 FROM produtos WHERE id < ${ID_MAX_PAINEL})`;

                const novo = await dbRun(
                    `INSERT INTO produtos (id, ${cols.join(", ")}, posicao)
                     VALUES (${idSql}, ${cols.map(() => "?").join(", ")}, 0)`,
                    [...(g.id ? [g.id] : []), ...cols.map(k => g.campos[k])]
                );

                idGravado = g.id || novo.lastID;

                await gravarImagens(idGravado, g.imagens || []);
                await gravarVariacoes(idGravado, g.variacoes);

                criados++;
                if (!g.campos.ativo) ocultos++;

                continue;
            }

            const cols = COLUNAS_PRODUTO.filter(k => k in g.campos);

            await dbRun(
                `UPDATE produtos SET ${[...cols.map(k => `${k} = ?`), "atualizado_em = CURRENT_TIMESTAMP"].join(", ")}
                 WHERE id = ?`,
                [...cols.map(k => g.campos[k]), g.id]
            );

            if (g.imagens) await gravarImagens(g.id, g.imagens);
            if (g.variacoes) await gravarVariacoes(g.id, g.variacoes);

            atualizados++;

        } catch (erro) {

            console.log("ERRO IMPORTAÇÃO:", r.id, erro.message);

            // não deixa um produto novo pela metade
            if (r.acao === "novo" && idGravado) {
                await dbRun("DELETE FROM produto_imagens WHERE produto_id = ?", [idGravado]).catch(() => {});
                await dbRun("DELETE FROM produto_variacoes WHERE produto_id = ?", [idGravado]).catch(() => {});
                await dbRun("DELETE FROM produtos WHERE id = ?", [idGravado]).catch(() => {});
            }

            falhas.push({ id: r.id, nome: r.nome, motivo: "Erro ao gravar no banco" });
        }
    }

    return { criados, atualizados, ocultos, falhas };
}

// ---------- arquivos para baixar ----------

const COLUNAS_MODELO = [
    { titulo: "Código do produto", largura: 16 },
    { titulo: "Nome do produto", largura: 38 },
    { titulo: "Descrição", largura: 50 },
    { titulo: "Categoria", largura: 20 },
    { titulo: "Preço (R$)", largura: 12 },
    { titulo: "Tamanho", largura: 12 },
    { titulo: "Cor", largura: 16 },
    { titulo: "Estoque", largura: 10 },
    { titulo: "Ativo (Sim/Não)", largura: 13 },
    { titulo: "Peso (kg)", largura: 10 },
    { titulo: "Largura (cm)", largura: 12 },
    { titulo: "Altura (cm)", largura: 11 },
    { titulo: "Comprimento (cm)", largura: 16 }
];

const colunasComFotos = qtd => [
    ...COLUNAS_MODELO,
    ...Array.from({ length: qtd }, (_, i) => ({ titulo: `Foto ${i + 1}`, largura: 30 }))
];

const listasModelo = () => [
    { coluna: 3, valores: CATEGORIAS.map(c => c.nome) },
    { coluna: 8, valores: ["Sim", "Não"] }
];

function gerarModeloPadrao() {

    const exemplo = (i, nome, desc, cat, preco, tam, cor, est, ativo, peso, l, a, comp, foto) =>
        [i, nome, desc, cat, preco, tam, cor, est, ativo, peso, l, a, comp, foto];

    const instrucoes = [
        [{ v: "Como preencher o modelo de produtos", e: 4 }],
        [""],
        ["1) Preencha a aba “Produtos”, a partir da linha 2. Não apague nem troque de lugar o cabeçalho (linha 1)."],
        ["2) Uma linha por combinação de cor e tamanho, cada uma com o seu estoque. Blusa Preta e Branca em P e M = 4 linhas: repita o nome do produto (ou deixe em branco) e preencha Tamanho, Cor e Estoque em cada linha. Peça sem cor: deixe a Cor vazia. Peça sem tamanho: deixe o Tamanho vazio (ou escreva Único)."],
        ["3) Código do produto: deixe em branco para cadastrar um produto NOVO. Para alterar um produto que já existe, informe o código dele. O jeito mais fácil: use o botão “Baixar meus produtos atuais” no painel, edite essa planilha e envie de volta."],
        ["4) Células em branco NÃO alteram o que já está cadastrado (nunca apagam). Tamanhos que a planilha não cita também são mantidos."],
        ["5) Preço: só o número, ex.: 49,90. Categoria: escolha na lista. Ativo: Sim mostra o produto na loja, Não oculta. Produto novo sem preço ou sem foto entra oculto até você completar."],
        ["6) Peso em kg (ex.: 0,3) e medidas em cm: são usados no cálculo do frete."],
        ["7) Fotos: cole o link completo de cada foto (começando com https://), uma por coluna. A Foto 1 é a capa. Em um produto que já existe, preencher as fotos SUBSTITUI as atuais; deixando em branco, as atuais ficam."],
        [""],
        ["Veja a aba “Exemplo” para um modelo já preenchido. Ela serve só de referência e não é lida na importação."]
    ];

    const exemplos = [
        COLUNAS_MODELO.map(c => ({ v: c.titulo, e: 5 })).concat([{ v: "Foto 1", e: 5 }]),
        exemplo("", "Blusa Canelada Exemplo", "Blusa em malha canelada, caimento macio.", "T-shirts", 39.9, "P", "Preto", 5, "Sim", 0.25, 30, 5, 25, "https://exemplo.com/foto-blusa.jpg"),
        exemplo("", "Blusa Canelada Exemplo", "", "", "", "M", "Preto", 8, "", "", "", "", "", ""),
        exemplo("", "Blusa Canelada Exemplo", "", "", "", "P", "Off White", 2, "", "", "", "", "", ""),
        exemplo("", "Blusa Canelada Exemplo", "", "", "", "M", "Off White", 3, "", "", "", "", "", ""),
        exemplo("", "Macaquinho Exemplo Tamanho Único", "Macaquinho com bojo.", "Vestidos", 59.9, "Único", "", 4, "Sim", 0.3, 30, 5, 25, "")
    ];

    return gerarXlsx([
        {
            nome: "Produtos",
            colunas: colunasComFotos(6),
            linhas: [],
            listas: listasModelo()
        },
        {
            nome: "Instruções",
            semCabecalho: true,
            colunas: [{ largura: 150 }],
            linhas: instrucoes.map(l => (typeof l[0] === "string" ? [{ v: l[0], e: 2 }] : l))
        },
        {
            nome: "Exemplo",
            semCabecalho: true,
            colunas: colunasComFotos(1),
            linhas: exemplos
        }
    ]);
}

async function gerarPlanilhaProdutosAtuais() {

    const produtos = await listarProdutos({ admin: true });
    const qtdFotos = Math.max(6, ...produtos.map(p => p.imagens.length));
    const linhas = [];

    for (const p of produtos) {

        p.variacoes.forEach((v, i) => {

            const primeira = i === 0;

            linhas.push([
                String(p.id),
                p.nome,
                primeira ? p.descricao : "",
                primeira ? (CATEGORIAS.find(c => c.id === p.categoria)?.nome || "") : "",
                primeira && p.preco > 0 ? { v: p.preco, e: 3 } : "",
                v.nome,
                v.cor || "",
                v.estoque,
                primeira ? (p.ativo ? "Sim" : "Não") : "",
                primeira ? (p.peso ?? "") : "",
                primeira ? (p.largura ?? "") : "",
                primeira ? (p.altura ?? "") : "",
                primeira ? (p.comprimento ?? "") : "",
                ...Array.from({ length: qtdFotos }, (_, k) => (primeira ? p.imagens[k] || "" : ""))
            ]);
        });
    }

    return gerarXlsx([
        { nome: "Produtos", colunas: colunasComFotos(qtdFotos), linhas, listas: listasModelo() }
    ]);
}

function enviarXlsx(res, nomeArquivo, buffer) {

    res.set({
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${nomeArquivo}"`,
        "Cache-Control": "no-store"
    });

    res.send(buffer);
}

function responderErro(res, erro, mensagemPadrao) {

    if (erro.validacao) {
        return res.status(erro.status).json({ erro: erro.message });
    }

    console.log(mensagemPadrao, erro);

    res.status(500).json({ erro: mensagemPadrao });
}

// Monta os itens a partir do catálogo do SERVIDOR: o navegador só informa
// "qual tamanho de qual produto" e "quantas unidades". Nome, preço e estoque vêm daqui.
async function montarItens(itensRecebidos) {

    if (
        !Array.isArray(itensRecebidos) ||
        itensRecebidos.length === 0 ||
        itensRecebidos.length > 50
    ) {
        throw erroValidacao("Carrinho inválido");
    }

    // variacaoId -> { produtoId, quantidade }
    const pedidos = new Map();

    for (const bruto of itensRecebidos) {

        const produtoId = Number(bruto?.id);
        const quantidade = Number(bruto?.quantidade ?? bruto?.qtd);
        let variacaoId = Number(bruto?.variacao);

        if (!Number.isInteger(quantidade) || quantidade < 1) {
            throw erroValidacao("Item inválido no carrinho");
        }

        if (!Number.isSafeInteger(variacaoId) || variacaoId < 1) {

            // Carrinho antigo (sem tamanho): só vale se o produto tem uma única opção
            if (!Number.isSafeInteger(produtoId)) {
                throw erroValidacao("Item inválido no carrinho");
            }

            const opcoes = await dbAll(
                "SELECT id FROM produto_variacoes WHERE produto_id = ?",
                [produtoId]
            );

            if (opcoes.length !== 1) {
                throw erroValidacao("Escolha o tamanho de todos os produtos");
            }

            variacaoId = opcoes[0].id;
        }

        const atual = pedidos.get(variacaoId);

        pedidos.set(variacaoId, {
            produtoId: Number.isSafeInteger(produtoId) ? produtoId : null,
            quantidade: (atual?.quantidade || 0) + quantidade
        });
    }

    const itens = [];
    let subtotalCent = 0;

    for (const [variacaoId, { produtoId, quantidade }] of pedidos) {

        const linha = await dbGet(
            `SELECT v.id AS variacao_id, v.nome AS variacao_nome, v.cor AS variacao_cor, v.estoque, p.*
             FROM produto_variacoes v
             JOIN produtos p ON p.id = v.produto_id
             WHERE v.id = ?`,
            [variacaoId]
        );

        if (!linha || !linha.ativo || !(linha.preco > 0)) {
            throw erroValidacao("Um dos produtos do carrinho não está mais disponível");
        }

        if (produtoId !== null && produtoId !== linha.id) {
            throw erroValidacao("Item inválido no carrinho");
        }

        const opcao = rotuloVariacao(linha.variacao_cor, linha.variacao_nome);
        const rotulo = opcao ? `${linha.nome} (${opcao})` : linha.nome;

        if (linha.estoque < 1) {
            throw erroValidacao(`"${rotulo}" está esgotado`);
        }

        if (quantidade > MAX_QTD_POR_ITEM) {
            throw erroValidacao(`Máximo de ${MAX_QTD_POR_ITEM} unidades por item`);
        }

        if (quantidade > linha.estoque) {
            throw erroValidacao(
                `Estoque insuficiente para "${rotulo}" (disponível: ${linha.estoque})`
            );
        }

        itens.push({
            id: linha.id,
            variacaoId,
            variacaoNome: opcao,
            nome: linha.nome,
            preco: linha.preco,
            quantidade,
            produto: linha
        });

        subtotalCent += centavos(linha.preco) * quantidade;
    }

    return { itens, subtotalCent };
}

// Consulta o Melhor Envio e devolve as opções já normalizadas.
// "diagnostico" (opcional) recebe, em texto, o motivo de cada serviço recusado.
async function consultarFrete(cepDestino, itens, diagnostico = []) {

    const payload = {
        from: { postal_code: CEP_ORIGEM },
        to: { postal_code: cepDestino },
        products: itens.map(item => ({
            id: String(item.id),
            width: item.produto.largura || PACOTE_PADRAO.largura,
            height: item.produto.altura || PACOTE_PADRAO.altura,
            length: item.produto.comprimento || PACOTE_PADRAO.comprimento,
            weight: item.produto.peso || PACOTE_PADRAO.peso,
            insurance_value: item.preco,
            quantity: item.quantidade
        }))
    };

    const resposta = await axios.post(
        `${MELHOR_ENVIO_URL}/api/v2/me/shipment/calculate`,
        payload,
        {
            headers: {
                Authorization: `Bearer ${MELHOR_ENVIO_TOKEN}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                "User-Agent": ME_USER_AGENT
            },
            timeout: 15000
        }
    );

    if (!Array.isArray(resposta.data)) {
        throw new Error("Resposta inesperada do Melhor Envio");
    }

    const opcoes = resposta.data
        .filter(f => f && !f.error && Number(f.price) > 0)
        .map(f => ({
            id: f.id,
            nome: [f.company?.name, f.name].filter(Boolean).join(" - "),
            preco: Number(f.price),
            prazo: f.delivery_range?.max ?? f.delivery_time ?? null,
            _pacotes: normalizarPacotes(f.packages)
        }));

    // Diagnóstico: por que nenhum serviço foi aceito
    if (opcoes.length === 0) {

        if (resposta.data.length === 0) {
            diagnostico.push("O Melhor Envio não devolveu nenhum serviço.");
        }

        for (const f of resposta.data) {
            diagnostico.push(
                `${[f?.company?.name, f?.name].filter(Boolean).join(" - ") || "Serviço"}: ` +
                `${f?.error || "sem preço"}`
            );
        }

        console.log(`FRETE: nenhuma opção válida (origem ${CEP_ORIGEM} -> destino ${cepDestino})`);
        console.log("Pacote enviado:", JSON.stringify(payload.products));
        console.log("Resposta:", JSON.stringify(
            resposta.data.map(f => ({
                empresa: f?.company?.name,
                servico: f?.name,
                preco: f?.price,
                erro: f?.error
            })),
            null,
            2
        ));
    }

    return opcoes;
}

app.get("/api/produtos", async (req, res) => {

    try {
        res.json(await listarProdutos());
    } catch (erro) {
        console.log("ERRO PRODUTOS:", erro);
        res.status(500).json({ erro: "Erro ao carregar produtos" });
    }
});

app.get("/api/categorias", (req, res) => {
    res.json(CATEGORIAS);
});

app.post("/api/pedido", limitePedido, async (req, res) => {

    try {

        const body = req.body || {};

        // ---------- dados do cliente / endereço ----------
        const cliente = texto(body.cliente, 120);
        const email = texto(body.email, 120).toLowerCase();
        const telefone = soDigitos(body.telefone);
        const cpf = soDigitos(body.cpf);
        const complemento = texto(body.complemento, 60);
        const cep = soDigitos(body.cep);
        const rua = texto(body.rua, 150);
        const numero = texto(body.numero, 20);
        const bairro = texto(body.bairro, 100);
        const cidade = texto(body.cidade, 100);
        const estado = texto(body.estado, 2).toUpperCase();

        if (cliente.length < 3) {
            throw erroValidacao("Informe seu nome completo");
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            throw erroValidacao("Informe um e-mail válido");
        }
        if (telefone.length < 10 || telefone.length > 11) {
            throw erroValidacao("Informe um telefone com DDD");
        }
        if (!cpfValido(cpf)) {
            throw erroValidacao("Informe um CPF válido (necessário para a etiqueta de envio)");
        }
        if (cep.length !== 8) {
            throw erroValidacao("CEP inválido");
        }
        if (!rua || !numero || !bairro || !cidade || estado.length !== 2) {
            throw erroValidacao("Preencha o endereço completo");
        }

        // ---------- itens e frete: tudo recalculado aqui ----------
        const { itens, subtotalCent } = await montarItens(body.itens);

        let opcoes;

        try {
            opcoes = await consultarFrete(cep, itens);
        } catch (erro) {
            console.log("ERRO FRETE (pedido):", erro.response?.data || erro.message);
            throw erroValidacao(
                "Não foi possível confirmar o frete agora. Tente novamente.",
                502
            );
        }

        const opcao = opcoes.find(
            o => String(o.id) === String(body.frete_servico_id)
        );

        if (!opcao) {
            throw erroValidacao(
                "Opção de frete indisponível. Calcule o frete novamente."
            );
        }

        const freteCent = centavos(opcao.preco);
        const totalCent = subtotalCent + freteCent;

        // Se o preço mudou desde que o cliente viu a tela, avisa antes de criar o pedido
        if (
            body.total_esperado !== undefined &&
            Math.abs(centavos(body.total_esperado) - totalCent) > 1
        ) {
            return res.status(409).json({
                erro: "Os valores do pedido mudaram. Confira o novo total.",
                total: totalCent / 100
            });
        }

        // ---------- grava pedido e itens ----------
        const pedido = await dbRun(
            `INSERT INTO pedidos
                (cliente, email, telefone, cep, rua, numero, bairro, cidade, estado,
                 status, transportadora, valor_frete, frete_servico_id, total, cpf, complemento, token_acesso)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                cliente, email, telefone, cep, rua, numero, bairro, cidade, estado,
                "aguardando_pagamento",
                opcao.nome,
                freteCent / 100,
                opcao.id,
                totalCent / 100,
                cpf,
                complemento || null,
                novoTokenPedido()
            ]
        );

        try {
            for (const item of itens) {
                await dbRun(
                    `INSERT INTO pedido_itens
                        (pedido_id, produto_id, variacao_id, variacao_nome, nome, preco, quantidade)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        pedido.lastID,
                        item.id,
                        item.variacaoId,
                        item.variacaoNome,
                        item.nome,
                        item.preco,
                        item.quantidade
                    ]
                );
            }
        } catch (erro) {
            await dbRun("DELETE FROM pedido_itens WHERE pedido_id = ?", [pedido.lastID]);
            await dbRun("DELETE FROM pedidos WHERE id = ?", [pedido.lastID]);
            throw erro;
        }

        res.json({
            id: pedido.lastID,
            subtotal: subtotalCent / 100,
            frete: freteCent / 100,
            total: totalCent / 100
        });

    } catch (erro) {

        if (erro.validacao) {
            return res.status(erro.status).json({ erro: erro.message });
        }

        console.log("ERRO PEDIDO:", erro);
        res.status(500).json({ erro: "Erro ao criar pedido" });
    }
});

app.post("/api/frete", limiteFrete, async (req, res) => {

    // Detalhes técnicos só aparecem fora de produção (localhost/testes)
    const mostrarDetalhes = NODE_ENV !== "production";

    try {

        const cep = soDigitos(req.body?.cepDestino);

        if (cep.length !== 8) {
            throw erroValidacao("CEP inválido");
        }

        const { itens } = await montarItens(req.body?.itens);

        const diagnostico = [];
        const opcoes = await consultarFrete(cep, itens, diagnostico);

        if (opcoes.length === 0) {
            return res.status(404).json({
                erro: "Nenhum frete disponível para este CEP.",
                detalhes: mostrarDetalhes ? diagnostico.slice(0, 6) : undefined
            });
        }

        // "_pacotes" é de uso interno (etiqueta); o cliente não precisa dele
        res.json(opcoes.map(({ _pacotes, ...opcao }) => opcao));

    } catch (erro) {

        if (erro.validacao) {
            return res.status(erro.status).json({ erro: erro.message });
        }

        const motivo = erro.response?.data || erro.message;

        console.log("ERRO FRETE:", motivo);

        res.status(502).json({
            erro: "Erro no cálculo de frete",
            detalhes: mostrarDetalhes
                ? [`HTTP ${erro.response?.status || "-"}: ${typeof motivo === "string" ? motivo : JSON.stringify(motivo)}`.slice(0, 400)]
                : undefined
        });
    }
});

// ---------- andamento do pedido (o que o cliente vê) ----------

// Posição do passo em andamento, conforme a situação do pedido
const PASSO_ATUAL = {
    pendente: 1,
    aguardando_pagamento: 1,
    pago: 2,
    em_separacao: 2,
    em_transito: 3,
    entregue: 4
};

function montarAndamento(pedido, eventos) {

    // primeira vez que cada situação aconteceu (pedidos antigos não têm histórico: data fica vazia)
    const quando = {};

    for (const e of eventos) {
        if (!quando[e.tipo]) quando[e.tipo] = e.criado_em;
    }

    const cancelado = pedido.status === "cancelado";
    const atual = PASSO_ATUAL[pedido.status] ?? 1;
    const etiquetaGerada = pedido.me_etapa === "gerada" || Boolean(quando.etiqueta);

    const passos = [
        {
            chave: "criado",
            titulo: "Pedido realizado",
            detalhe: "Recebemos o seu pedido.",
            data: quando.criado || pedido.data_pedido || null
        },
        {
            chave: "pago",
            titulo: "Pagamento confirmado",
            detalhe: "O pagamento foi aprovado.",
            tituloAtual: "Aguardando pagamento",
            detalheAtual: "Assim que o pagamento for confirmado, seguimos com o seu pedido.",
            data: quando.pago || null
        },
        {
            chave: "em_separacao",
            titulo: "Pedido embalado",
            tituloAtual: "Preparando o envio",
            detalhe: etiquetaGerada
                ? "Etiqueta de envio gerada. Seu pedido está pronto para ser postado."
                : "Separamos e embalamos as suas peças.",
            detalheAtual: etiquetaGerada
                ? "Etiqueta de envio gerada. Seu pedido está pronto para ser postado."
                : "Estamos separando e embalando as suas peças.",
            data: quando.etiqueta || quando.em_separacao || null
        },
        {
            chave: "em_transito",
            titulo: "Enviado",
            detalhe: "Seu pedido foi postado e está a caminho.",
            detalheFuturo: "Você recebe o código de rastreio para acompanhar a entrega.",
            data: quando.em_transito || null
        },
        {
            chave: "entregue",
            titulo: "Entregue",
            detalhe: "Pedido entregue. Obrigada pela compra!",
            detalheFuturo: "Pedido na sua casa!",
            data: quando.entregue || null
        }
    ];

    const lista = [];

    passos.forEach((passo, i) => {

        // cancelado: mostra só o que já tinha acontecido e fecha com o cancelamento
        if (cancelado) {

            if (i === 0 || passo.data) {
                lista.push({ chave: passo.chave, titulo: passo.titulo, detalhe: passo.detalhe, estado: "feito", data: passo.data });
            }

            return;
        }

        const entregue = pedido.status === "entregue";
        const estado = entregue || i < atual ? "feito" : i === atual ? "atual" : "pendente";

        lista.push({
            chave: passo.chave,
            titulo: estado === "atual" && passo.tituloAtual ? passo.tituloAtual : passo.titulo,
            detalhe:
                estado === "atual"
                    ? (passo.detalheAtual || passo.detalhe)
                    : estado === "pendente"
                        ? (passo.detalheFuturo || passo.detalheAtual || passo.detalhe)
                        : passo.detalhe,
            estado,
            data: estado === "pendente" ? null : passo.data
        });
    });

    if (cancelado) {
        lista.push({
            chave: "cancelado",
            titulo: "Pedido cancelado",
            detalhe: "O pagamento não foi aprovado ou o pedido foi cancelado.",
            estado: "cancelado",
            data: quando.cancelado || null
        });
    }

    return { cancelado, passos: lista };
}

async function andamentoDosPedidos(pedidos) {

    const ids = pedidos.map(p => p.id);

    const eventos = ids.length
        ? await dbAll(
            `SELECT pedido_id, tipo, criado_em FROM pedido_eventos
             WHERE pedido_id IN (${ids.map(() => "?").join(",")})
             ORDER BY id ASC`,
            ids
        )
        : [];

    return new Map(
        pedidos.map(p => [
            p.id,
            montarAndamento(p, eventos.filter(e => e.pedido_id === p.id))
        ])
    );
}

// ======================================================
// BACKUP E CONFERÊNCIA DO SISTEMA
// ======================================================
//
// Todo dia a loja guarda uma cópia consistente do banco em BACKUP_DIR/AAAA-MM-DD/loja.db
// e copia as fotos novas para BACKUP_DIR/uploads (as fotos nunca mudam depois de enviadas).
// As últimas BACKUP_DIAS cópias do banco são mantidas (0 desliga). Isto protege contra erro e
// exclusão sem querer; para proteger contra perda do disco, baixe uma cópia de vez em quando
// pelo painel (Sistema) e guarde fora do servidor.

const PASTA_DE_BACKUP = BACKUP_DIR || path.join(path.dirname(path.resolve(DB_PATH)), "backups");

let ultimoBackup = null; // { em, dia, bancoBytes, fotosNovas, erro }

const diaDeHoje = () => new Date().toLocaleDateString("sv-SE"); // AAAA-MM-DD, no horário do servidor

async function lerUltimoBackup() {

    const linha = await dbGet("SELECT valor FROM config WHERE chave = 'ultimo_backup'");

    try {
        ultimoBackup = linha ? JSON.parse(linha.valor) : null;
    } catch {
        ultimoBackup = null;
    }
}

async function guardarUltimoBackup(resultado) {

    ultimoBackup = resultado;

    await dbRun(
        "INSERT INTO config (chave, valor) VALUES ('ultimo_backup', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor",
        [JSON.stringify(resultado)]
    ).catch(() => {});
}

async function fazerBackup() {

    const dia = diaDeHoje();

    try {

        const pasta = path.join(PASTA_DE_BACKUP, dia);
        await fs.promises.mkdir(pasta, { recursive: true });

        const destino = path.join(pasta, "loja.db");

        // VACUUM INTO exige que o arquivo de destino não exista; refazer no mesmo dia substitui o anterior
        await fs.promises.rm(destino, { force: true });
        await dbRun("VACUUM INTO ?", [destino]);

        const { size } = await fs.promises.stat(destino);

        // fotos novas
        const pastaFotos = path.join(PASTA_DE_BACKUP, "uploads");
        await fs.promises.mkdir(pastaFotos, { recursive: true });

        let fotosNovas = 0;

        const existentes = await fs.promises.readdir(UPLOADS_DIR).catch(() => []);

        for (const nome of existentes) {

            if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(nome)) continue;

            const copia = path.join(pastaFotos, nome);

            try {
                await fs.promises.copyFile(path.join(UPLOADS_DIR, nome), copia, fs.constants.COPYFILE_EXCL);
                fotosNovas++;
            } catch (erro) {
                if (erro.code !== "EEXIST") throw erro;
            }
        }

        // guarda só as últimas N cópias do banco
        const dias = Math.max(1, Number(BACKUP_DIAS) || 14);

        const antigas = (await fs.promises.readdir(PASTA_DE_BACKUP))
            .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
            .sort()
            .reverse()
            .slice(dias);

        for (const antiga of antigas) {
            await fs.promises.rm(path.join(PASTA_DE_BACKUP, antiga), { recursive: true, force: true });
        }

        const resultado = { em: new Date().toISOString(), dia, bancoBytes: size, fotosNovas, erro: null };

        await guardarUltimoBackup(resultado);

        return resultado;

    } catch (erro) {

        console.log("ERRO BACKUP:", erro.message);

        const resultado = { em: new Date().toISOString(), dia, bancoBytes: 0, fotosNovas: 0, erro: erro.message };

        await guardarUltimoBackup(resultado);

        return resultado;
    }
}

// Roda no máximo uma vez por dia: depois da hora configurada, ou logo ao ligar se faz mais de 24h que não roda
async function backupDoDiaSeNecessario() {

    if (Number(BACKUP_DIAS) === 0) return;

    if (ultimoBackup && !ultimoBackup.erro && ultimoBackup.dia === diaDeHoje()) return;

    const passouDaHora = new Date().getHours() >= (Number(BACKUP_HORA) || 0);
    const velho = !ultimoBackup || Date.now() - Date.parse(ultimoBackup.em) > 24 * 60 * 60 * 1000;

    if (passouDaHora || velho) await fazerBackup();
}

// ---------- conferência "pronto para publicar?" ----------

async function montarConferencia(req) {

    const itens = [];
    const item = (id, nivel, titulo, detalhe) => itens.push({ id, nivel, titulo, detalhe });

    const producao = NODE_ENV === "production";

    // ambiente e endereço
    item(
        "ambiente",
        producao ? "ok" : "aviso",
        producao ? "Modo de produção ligado" : "Modo de desenvolvimento",
        producao
            ? "NODE_ENV=production."
            : "Para publicar, defina NODE_ENV=production no .env do servidor (liga o cookie seguro do login e esconde detalhes de erros)."
    );

    const base = String(BASE_URL || "");
    const provisorio = /localhost|127\.0\.0\.1|ngrok|loca\.lt|trycloudflare|serveo/i.test(base);

    item(
        "base_url",
        !/^https:\/\//i.test(base) ? "erro" : provisorio ? "aviso" : "ok",
        "Endereço da loja (BASE_URL)",
        !/^https:\/\//i.test(base)
            ? "Precisa começar com https:// (o Mercado Pago só devolve o cliente e envia avisos para endereços seguros)."
            : provisorio
                ? "Ainda é um endereço provisório (ngrok/localhost). Troque pelo seu domínio quando publicar."
                : `Usando ${base}.`
    );

    item(
        "https",
        req.secure ? "ok" : (producao ? "erro" : "info"),
        "Você está acessando por HTTPS?",
        req.secure
            ? "Sim: a conexão com o painel é segura."
            : producao
                ? "Não. Em produção o login só funciona por HTTPS. Confira o certificado e se o proxy envia X-Forwarded-Proto."
                : "Não (normal em desenvolvimento)."
    );

    // mercado pago
    item(
        "mp_token",
        MP_ACCESS_TOKEN ? "ok" : "erro",
        "Credencial do Mercado Pago",
        MP_ACCESS_TOKEN
            ? "Configurada. Use o botão \"Conferir conta do Mercado Pago\" abaixo para ver se é a conta de teste ou a real."
            : "MP_ACCESS_TOKEN não definido."
    );

    item(
        "mp_webhook",
        MP_WEBHOOK_SECRET ? "ok" : "aviso",
        "Assinatura do webhook do Mercado Pago",
        MP_WEBHOOK_SECRET
            ? "Configurada: as notificações são conferidas."
            : "MP_WEBHOOK_SECRET não definido. Copie a assinatura secreta no painel do Mercado Pago (Webhooks) para o .env."
    );

    // melhor envio
    const sandbox = /sandbox/i.test(String(process.env.MELHOR_ENVIO_URL || ""));

    item(
        "me_ambiente",
        sandbox ? "aviso" : "ok",
        sandbox ? "Melhor Envio em modo de TESTE (sandbox)" : "Melhor Envio em produção",
        sandbox
            ? "As etiquetas geradas agora não valem para envio. Para vender de verdade: MELHOR_ENVIO_URL=https://melhorenvio.com.br e um token gerado na conta real."
            : "As etiquetas são reais e descontam do saldo da sua conta no Melhor Envio."
    );

    // segurança
    item(
        "sessao",
        String(process.env.SESSION_SECRET || "").length >= 32 ? "ok" : "erro",
        "Segredo da sessão do painel",
        String(process.env.SESSION_SECRET || "").length >= 32 ? "Longo o bastante." : "SESSION_SECRET precisa ter pelo menos 32 caracteres."
    );

    const tamSenha = String(process.env.ADMIN_PASSWORD || "").length;

    item(
        "senha",
        tamSenha >= 12 ? "ok" : "aviso",
        "Senha do painel",
        tamSenha >= 12 ? "Tem 12 caracteres ou mais." : "Use uma senha com 12 caracteres ou mais, que não seja usada em nenhum outro lugar."
    );

    // dados da loja
    const loja = dadosDaLoja();

    const faltando = [
        !loja.nome && "LOJA_NOME",
        !loja.email && "LOJA_EMAIL",
        loja.telefone.length < 10 && "LOJA_TELEFONE",
        ![11, 14].includes(loja.documento.length) && "LOJA_DOCUMENTO",
        !loja.endereco && "LOJA_ENDERECO",
        !loja.numero && "LOJA_NUMERO",
        !loja.bairro && "LOJA_BAIRRO",
        !loja.cidade && "LOJA_CIDADE",
        loja.uf.length !== 2 && "LOJA_UF",
        loja.cep.length !== 8 && "CEP_ORIGEM"
    ].filter(Boolean);

    item(
        "loja",
        faltando.length ? "erro" : "ok",
        "Dados da loja (rodapé, políticas e etiqueta)",
        faltando.length ? `Faltando no .env: ${faltando.join(", ")}.` : "Completos."
    );

    // onde ficam os dados
    const dentroDoApp = caminho => path.resolve(caminho).startsWith(path.resolve(__dirname));

    item(
        "banco",
        dentroDoApp(DB_PATH) ? (producao ? "aviso" : "info") : "ok",
        "Onde fica o banco de dados",
        dentroDoApp(DB_PATH)
            ? "Dentro da pasta do aplicativo. Em hospedagens com disco temporário os pedidos somem a cada reinício: use um disco persistente e DB_PATH=/data/loja.db (ou equivalente)."
            : `Fora da pasta do aplicativo (${DB_PATH}). Confirme que é um disco persistente.`
    );

    item(
        "fotos",
        dentroDoApp(UPLOADS_DIR) ? (producao ? "aviso" : "info") : "ok",
        "Onde ficam as fotos enviadas",
        dentroDoApp(UPLOADS_DIR)
            ? "Dentro da pasta do aplicativo. Em hospedagens com disco temporário as fotos somem: use UPLOADS_DIR=/data/uploads em disco persistente."
            : `Fora da pasta do aplicativo (${UPLOADS_DIR}). Confirme que é um disco persistente.`
    );

    // backup
    if (Number(BACKUP_DIAS) === 0) {
        item("backup", "aviso", "Backup automático", "Desligado (BACKUP_DIAS=0).");
    } else if (!ultimoBackup) {
        item("backup", "aviso", "Backup automático", "Ainda não rodou. Clique em \"Fazer backup agora\" para testar.");
    } else if (ultimoBackup.erro) {
        item("backup", "erro", "Backup automático", `Falhou: ${ultimoBackup.erro}`);
    } else {
        const horas = (Date.now() - Date.parse(ultimoBackup.em)) / 3600000;
        item(
            "backup",
            horas > 36 ? "aviso" : "ok",
            "Backup automático",
            `Última cópia: ${new Date(ultimoBackup.em).toLocaleString("pt-BR")} (guardando as últimas ${Number(BACKUP_DIAS) || 14}).` +
            (horas > 36 ? " Faz mais de 36 horas: confira se o servidor ficou ligado." : "")
        );
    }

    // catálogo
    const { ativos } = await dbGet("SELECT COUNT(*) AS ativos FROM produtos WHERE ativo = 1 AND preco > 0");
    const { semMedidas } = await dbGet(
        `SELECT COUNT(*) AS semMedidas FROM produtos
         WHERE ativo = 1 AND preco > 0
           AND (peso IS NULL OR peso <= 0 OR largura IS NULL OR largura <= 0
                OR altura IS NULL OR altura <= 0 OR comprimento IS NULL OR comprimento <= 0)`
    );

    item(
        "produtos",
        ativos > 0 ? "ok" : "erro",
        "Produtos à venda",
        ativos > 0 ? `${ativos} produtos ativos com preço.` : "Nenhum produto ativo com preço."
    );

    item(
        "medidas",
        semMedidas > 0 ? "aviso" : "ok",
        "Peso e medidas para o frete",
        semMedidas > 0
            ? `${semMedidas} produtos ativos usam o pacote padrão (0,3 kg, 20×5×25 cm). Se as peças forem diferentes, o frete sai errado: preencha no cadastro.`
            : "Todos os produtos ativos têm peso e medidas."
    );

    return itens;
}

app.get("/api/admin/sistema", exigirAdmin, async (req, res) => {

    try {

        const itens = await montarConferencia(req);

        res.set("Cache-Control", "no-store");

        res.json({
            itens,
            erros: itens.filter(i => i.nivel === "erro").length,
            avisos: itens.filter(i => i.nivel === "aviso").length,
            backup: ultimoBackup,
            node: process.version,
            ip: req.ip
        });

    } catch (erro) {
        console.log("ERRO SISTEMA:", erro.message);
        res.status(500).json({ erro: "Erro ao conferir o sistema" });
    }
});

// Mostra de qual conta é a credencial do Mercado Pago (as de teste e as reais começam igual)
app.get("/api/admin/sistema/mercadopago", exigirAdmin, async (req, res) => {

    try {

        const resposta = await axios.get(`${MP_API_URL}/users/me`, {
            headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
            timeout: 12000
        });

        const { id, nickname, site_id: site, email } = resposta.data || {};

        res.json({
            id,
            apelido: nickname || "",
            site,
            email: email ? String(email).replace(/^(.).*(@.*)$/, "$1***$2") : "",
            pareceTeste: /^TEST/i.test(String(nickname || ""))
        });

    } catch (erro) {

        console.log("ERRO MP USERS/ME:", erro.response?.status || erro.message);

        res.status(502).json({
            erro: erro.response?.status === 401
                ? "O Mercado Pago recusou a credencial (token inválido ou vencido)."
                : "Não foi possível consultar o Mercado Pago agora."
        });
    }
});

app.post("/api/admin/backup/agora", exigirAdmin, async (req, res) => {

    const resultado = await fazerBackup();

    res.status(resultado.erro ? 500 : 200).json(resultado);
});

// Baixa uma cópia consistente do banco (tem dados de clientes: guarde com cuidado)
app.get("/api/admin/backup/baixar", exigirAdmin, async (req, res) => {

    res.set("Cache-Control", "no-store");

    const pastaTemporaria = path.join(PASTA_DE_BACKUP, "tmp");
    const arquivo = path.join(pastaTemporaria, `download-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.db`);

    try {

        await fs.promises.mkdir(pastaTemporaria, { recursive: true });
        await dbRun("VACUUM INTO ?", [arquivo]);

        res.download(arquivo, `closet-real-${diaDeHoje()}.db`, () => {
            fs.promises.rm(arquivo, { force: true }).catch(() => {});
        });

    } catch (erro) {

        console.log("ERRO DOWNLOAD BACKUP:", erro.message);

        await fs.promises.rm(arquivo, { force: true }).catch(() => {});

        res.status(500).json({ erro: "Não foi possível gerar a cópia agora. Tente novamente." });
    }
});

// ---------- aparência: rotas ----------

// Pública: o que a vitrine precisa para montar o banner e o logo
app.get("/api/aparencia", async (req, res) => {

    try {

        const destaques = await dbAll(
            `SELECT p.id, p.nome, p.preco,
                    (SELECT url FROM produto_imagens WHERE produto_id = p.id ORDER BY ordem ASC, id ASC LIMIT 1) AS imagem
             FROM produtos p
             WHERE p.ativo = 1 AND p.preco > 0 AND p.destaque = 1
             ORDER BY p.posicao ASC, p.id DESC
             LIMIT 8`
        );

        res.set("Cache-Control", "no-cache");

        res.json({
            banners_pc: aparencia.banners_pc,
            banners_celular: aparencia.banners_celular,
            logo: aparencia.logo,
            mostrar_nome_logo: aparencia.mostrar_nome_logo,
            intervalo: aparencia.intervalo,
            destaques: destaques.filter(d => d.imagem)
        });

    } catch (erro) {
        console.log("ERRO APARENCIA:", erro.message);
        res.status(500).json({ erro: "Erro ao carregar a aparência" });
    }
});

app.get("/api/admin/aparencia", exigirAdmin, async (req, res) => {

    try {

        const { total } = await dbGet("SELECT COUNT(*) AS total FROM produtos WHERE ativo = 1 AND preco > 0 AND destaque = 1");

        res.json({
            config: aparencia,
            padrao: APARENCIA_PADRAO,
            fontes: Object.entries(FONTES).map(([id, f]) => ({ id, nome: f.nome })),
            destaques: total
        });

    } catch (erro) {
        console.log("ERRO APARENCIA ADMIN:", erro.message);
        res.status(500).json({ erro: "Erro ao carregar a aparência" });
    }
});

app.put("/api/admin/aparencia", exigirAdmin, async (req, res) => {

    try {

        const nova = validarAparencia(req.body);

        const antes = urlsDaAparencia();

        await dbRun(
            "INSERT INTO config (chave, valor) VALUES ('aparencia', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor",
            [JSON.stringify(nova)]
        );

        aparencia = nova;

        // apaga do disco o que saiu da aparência e nenhum produto usa
        const depois = urlsDaAparencia();
        await removerArquivosOrfaos([...antes].filter(u => !depois.has(u)));

        res.json({
            sucesso: true,
            config: aparencia,
            corAjustada: TemaCores.ajustarPrimaria(aparencia.cor_primaria)
        });

    } catch (erro) {

        if (erro.validacao) return res.status(erro.status).json({ erro: erro.message });

        console.log("ERRO SALVAR APARENCIA:", erro.message);
        res.status(500).json({ erro: "Erro ao salvar a aparência" });
    }
});

// ---------- dados públicos da loja (rodapé, contato e políticas) ----------
// Fonte única: o .env. O CPF/CNPJ e o endereço aparecem porque a lei do e-commerce (Decreto 7.962/2013)
// exige identificação do vendedor; LOJA_EXIBIR_DOCUMENTO=nao e LOJA_ENDERECO_PUBLICO permitem ajustar.

function formatarDocumento(d) {
    if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
    if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
    return d;
}

function formatarTelefone(t) {
    if (t.length === 11) return t.replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3");
    if (t.length === 10) return t.replace(/^(\d{2})(\d{4})(\d{4})$/, "($1) $2-$3");
    return t;
}

app.get("/api/loja", (req, res) => {

    const l = dadosDaLoja();

    let whatsapp = soDigitos(LOJA_WHATSAPP);
    if (whatsapp.length === 10 || whatsapp.length === 11) whatsapp = `55${whatsapp}`;

    const cep = l.cep.length === 8 ? l.cep.replace(/^(\d{5})(\d{3})$/, "$1-$2") : l.cep;

    const enderecoCompleto = [
        [l.endereco, l.numero].filter(Boolean).join(", ") + (l.complemento ? ` - ${l.complemento}` : ""),
        l.bairro,
        [l.cidade, l.uf].filter(Boolean).join("/"),
        cep ? `CEP ${cep}` : ""
    ].filter(Boolean).join(" - ");

    const mostrarDocumento = String(LOJA_EXIBIR_DOCUMENTO || "sim").toLowerCase() !== "nao";

    res.set("Cache-Control", "public, max-age=300");

    res.json({
        nome: l.nome || "Closet Real",
        email: l.email,
        telefone: formatarTelefone(l.telefone.length >= 12 && l.telefone.startsWith("55") ? l.telefone.slice(2) : l.telefone),
        whatsapp,
        instagram: texto(LOJA_INSTAGRAM, 60).replace(/^@/, ""),
        horario: texto(LOJA_HORARIO, 120),
        tipoDocumento: l.documento.length === 14 ? "CNPJ" : l.documento.length === 11 ? "CPF" : "",
        documento: mostrarDocumento ? formatarDocumento(l.documento) : "",
        endereco: texto(LOJA_ENDERECO_PUBLICO, 200) || enderecoCompleto,
        cidade: l.cidade,
        uf: l.uf
    });
});

// ---------- página "pedido recebido" ----------
// O número do pedido é sequencial (qualquer um adivinha o próximo), então a página do cliente
// só abre com o código secreto que vai no link de retorno do Mercado Pago.

function novoTokenPedido() {
    return crypto.randomBytes(16).toString("hex");
}

function tokenConfere(esperado, recebido) {

    if (!esperado || typeof recebido !== "string" || recebido.length > 100) return false;

    const h = valor => crypto.createHash("sha256").update(String(valor)).digest();

    return crypto.timingSafeEqual(h(esperado), h(recebido));
}

const ultimaConferenciaRetorno = new Map();

app.get("/api/pedido-recebido/:id", limiteAcompanhar, async (req, res) => {

    res.set("Cache-Control", "no-store");

    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
        return res.status(404).json({ erro: "Pedido não encontrado" });
    }

    try {

        const buscarPedido = () => dbGet(
            `SELECT id, cliente, status, data_pedido, total, valor_frete, transportadora,
                    codigo_rastreio, cep, rua, numero, complemento, bairro, cidade, estado,
                    token_acesso, me_etapa
             FROM pedidos WHERE id = ?`,
            [id]
        );

        let pedido = await buscarPedido();

        // Mesma resposta para "não existe" e "código errado": não revela quais pedidos existem
        if (!pedido || !tokenConfere(pedido.token_acesso, String(req.query.t || ""))) {
            return res.status(404).json({ erro: "Pedido não encontrado" });
        }

        // Voltou do Mercado Pago com o número do pagamento: confirma na hora, sem esperar a notificação
        // (que pode atrasar ou se perder). Só vale para o próprio pedido e a situação vem da API do MP.
        const paymentId = String(req.query.payment_id || "");

        if (
            /^\d{5,20}$/.test(paymentId) &&
            ["aguardando_pagamento", "cancelado"].includes(pedido.status) &&
            Date.now() - (ultimaConferenciaRetorno.get(id) || 0) > 8000
        ) {
            ultimaConferenciaRetorno.set(id, Date.now());

            try {
                await processarPagamentoMP(paymentId, id);
                pedido = await buscarPedido();
            } catch (erro) {
                console.log("Conferência pelo retorno falhou:", erro.response?.status || erro.message);
            }
        }

        const itens = await dbAll(
            `SELECT nome, variacao_nome, preco, quantidade
             FROM pedido_itens WHERE pedido_id = ? ORDER BY id ASC`,
            [id]
        );

        const andamento = (await andamentoDosPedidos([pedido])).get(pedido.id);

        res.json({
            id: pedido.id,
            status: pedido.status,
            andamento,
            data_pedido: pedido.data_pedido,
            primeiro_nome: String(pedido.cliente || "").trim().split(/\s+/)[0] || "",
            total: pedido.total,
            valor_frete: pedido.valor_frete || 0,
            transportadora: pedido.transportadora || "",
            codigo_rastreio: pedido.codigo_rastreio || "",
            entrega: {
                rua: pedido.rua,
                numero: pedido.numero,
                complemento: pedido.complemento || "",
                bairro: pedido.bairro,
                cidade: pedido.cidade,
                estado: pedido.estado,
                cep: pedido.cep
            },
            itens: itens.map(i => ({
                nome: i.nome,
                variacao: rotuloTamanho(i.variacao_nome),
                preco: i.preco,
                quantidade: i.quantidade
            }))
        });

    } catch (erro) {
        console.log("ERRO PEDIDO RECEBIDO:", erro);
        res.status(500).json({ erro: "Erro ao consultar o pedido" });
    }
});

app.post("/api/pagar", limitePagar, async (req, res) => {

    const pedidoId = Number(req.body?.pedidoId);

    if (!Number.isInteger(pedidoId) || pedidoId < 1) {
        return res.status(400).json({ erro: "Dados inválidos" });
    }

    try {

        const pedido = await dbGet(
            "SELECT * FROM pedidos WHERE id = ?",
            [pedidoId]
        );

        if (!pedido || pedido.status !== "aguardando_pagamento") {
            return res.status(400).json({
                erro: "Pedido não disponível para pagamento"
            });
        }

        const itens = await dbAll(
            "SELECT nome, variacao_nome, preco, quantidade FROM pedido_itens WHERE pedido_id = ?",
            [pedidoId]
        );

        if (itens.length === 0) {
            return res.status(400).json({ erro: "Pedido sem itens" });
        }

        // O valor cobrado vem SEMPRE do banco, nunca do navegador
        const itensMP = itens.map(item => ({
            title: (
                rotuloTamanho(item.variacao_nome)
                    ? `${item.nome} - ${rotuloTamanho(item.variacao_nome)}`
                    : String(item.nome)
            ).slice(0, 250),
            quantity: item.quantidade,
            currency_id: "BRL",
            unit_price: item.preco
        }));

        if (pedido.valor_frete > 0) {
            itensMP.push({
                title: `Frete - ${pedido.transportadora || "Entrega"}`.slice(0, 250),
                quantity: 1,
                currency_id: "BRL",
                unit_price: pedido.valor_frete
            });
        }

        // Pedidos antigos (de antes da página "pedido recebido") ainda não têm código de acesso
        let token = pedido.token_acesso;

        if (!token) {
            token = novoTokenPedido();
            await dbRun("UPDATE pedidos SET token_acesso = ? WHERE id = ?", [token, pedidoId]);
        }

        // Para onde o Mercado Pago devolve o cliente depois do pagamento
        const retorno = situacao =>
            `${BASE_URL}/pedido-recebido.html?pedido=${pedidoId}&t=${token}&retorno=${situacao}`;

        const preferencia = {
            items: itensMP,
            external_reference: String(pedidoId),
            notification_url: `${BASE_URL}/webhook`,
            back_urls: {
                success: retorno("sucesso"),
                pending: retorno("pendente"),
                failure: retorno("falha")
            }
        };

        // O Mercado Pago só aceita o redirecionamento automático com endereço público (https)
        if (/^https:\/\//i.test(BASE_URL)) {
            preferencia.auto_return = "approved";
        }

        const response = await axios.post(
            `${MP_API_URL}/checkout/preferences`,
            preferencia,
            {
                headers: {
                    Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                },
                timeout: 15000
            }
        );

        res.json({
            url: response.data.init_point
        });

    } catch (erro) {
        console.log("ERRO MP:");
        console.log(erro.response?.data || erro.message);

        res.status(500).json({
            erro: "Erro ao gerar pagamento"
        });
    }
});

// ======================================================
// PAGAMENTOS (Mercado Pago)
// ======================================================
//
// Regras:
//  - A situação do pagamento SEMPRE vem da API do Mercado Pago (nunca do que chegou na notificação).
//  - Cada pagamento fica registrado em "pagamentos_mp": notificação repetida não faz nada de novo.
//  - Pedido aprovado dá baixa no estoque UMA vez (cor + tamanho). Estorno devolve o estoque.
//  - Notificação atrasada nunca "rebaixa" um pedido já pago/enviado.
//  - Tudo passa por uma fila: duas notificações do mesmo pagamento nunca rodam ao mesmo tempo.

const STATUS_AVANCADOS = ["pago", "em_separacao", "em_transito", "entregue"];

let filaPagamentos = Promise.resolve();

function naFila(tarefa) {
    const execucao = filaPagamentos.then(() => tarefa());
    filaPagamentos = execucao.catch(() => {});
    return execucao;
}

async function buscarPagamentoMP(paymentId) {

    const resposta = await axios.get(`${MP_API_URL}/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        timeout: 15000
    });

    return resposta.data;
}

function juntarAlerta(atual, novo) {
    return atual ? (atual.includes(novo) ? atual : `${atual} | ${novo}`) : novo;
}

async function avisarPedido(pedidoId, mensagem) {

    const { alerta } = await dbGet("SELECT alerta FROM pedidos WHERE id = ?", [pedidoId]);

    await dbRun("UPDATE pedidos SET alerta = ? WHERE id = ?", [juntarAlerta(alerta, mensagem), pedidoId]);
}

// Guarda o pagamento visto no Mercado Pago. "valido" = o valor e a moeda conferem com o pedido.
async function registrarPagamento(pedido, pagamento) {

    const valor = Number(pagamento.transaction_amount);
    const moedaOk = !pagamento.currency_id || pagamento.currency_id === "BRL";
    const valorOk = Number.isFinite(valor) && Math.abs(valor - Number(pedido.total)) <= 0.01;

    await dbRun(
        `INSERT INTO pagamentos_mp (payment_id, pedido_id, status, valor, metodo, valido)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(payment_id) DO UPDATE SET
            status = excluded.status,
            valor = excluded.valor,
            metodo = excluded.metodo,
            valido = excluded.valido,
            atualizado_em = CURRENT_TIMESTAMP`,
        [
            String(pagamento.id),
            pedido.id,
            String(pagamento.status || ""),
            Number.isFinite(valor) ? valor : null,
            String(pagamento.payment_type_id || ""),
            moedaOk && valorOk ? 1 : 0
        ]
    );

    if (pagamento.status === "approved" && !(moedaOk && valorOk)) {
        await avisarPedido(
            pedido.id,
            `Pagamento #${pagamento.id} aprovado com valor diferente do pedido ` +
            `(pago ${brl(valor)}, pedido ${brl(Number(pedido.total))}). Confira no Mercado Pago antes de enviar.`
        );
    }
}

const brl = valor =>
    Number.isFinite(valor)
        ? valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
        : "valor desconhecido";

// Baixa o estoque dos itens do pedido, uma única vez
async function baixarEstoque(pedidoId) {

    // "reserva" atômica: só quem conseguir mudar 0 -> 1 faz a baixa
    const reserva = await dbRun(
        "UPDATE pedidos SET estoque_baixado = 1 WHERE id = ? AND estoque_baixado = 0",
        [pedidoId]
    );

    if (reserva.changes !== 1) return;

    try {

        const itens = await dbAll(
            "SELECT variacao_id, nome, variacao_nome, quantidade FROM pedido_itens WHERE pedido_id = ?",
            [pedidoId]
        );

        const faltas = [];

        for (const item of itens) {

            if (!item.variacao_id) continue;

            const variacao = await dbGet(
                "SELECT estoque FROM produto_variacoes WHERE id = ?",
                [item.variacao_id]
            );

            if (!variacao) continue; // variação removida do catálogo

            await dbRun(
                "UPDATE produto_variacoes SET estoque = MAX(estoque - ?, 0) WHERE id = ?",
                [item.quantidade, item.variacao_id]
            );

            if (variacao.estoque < item.quantidade) {
                const opcao = rotuloTamanho(item.variacao_nome);
                faltas.push(
                    `${item.nome}${opcao ? ` (${opcao})` : ""}: vendido ${item.quantidade}, ` +
                    `mas havia ${variacao.estoque} em estoque`
                );
            }
        }

        if (faltas.length > 0) {
            await avisarPedido(pedidoId, `Estoque insuficiente: ${faltas.join("; ")}.`);
        }

    } catch (erro) {
        // não deixa o pedido marcado como "baixado" sem ter baixado: a próxima notificação tenta de novo
        await dbRun("UPDATE pedidos SET estoque_baixado = 0 WHERE id = ?", [pedidoId]).catch(() => {});
        throw erro;
    }
}

// Estorno: devolve ao estoque o que foi baixado
async function devolverEstoque(pedidoId) {

    const reserva = await dbRun(
        "UPDATE pedidos SET estoque_baixado = 0 WHERE id = ? AND estoque_baixado = 1",
        [pedidoId]
    );

    if (reserva.changes !== 1) return;

    const itens = await dbAll(
        "SELECT variacao_id, quantidade FROM pedido_itens WHERE pedido_id = ?",
        [pedidoId]
    );

    for (const item of itens) {

        if (!item.variacao_id) continue;

        await dbRun(
            "UPDATE produto_variacoes SET estoque = MIN(estoque + ?, 9999) WHERE id = ?",
            [item.quantidade, item.variacao_id]
        );
    }
}

// Olha todos os pagamentos conhecidos do pedido e decide a situação dele
async function decidirPedido(pedidoId) {

    const pedido = await dbGet("SELECT id, status, me_etapa, estoque_baixado FROM pedidos WHERE id = ?", [pedidoId]);

    if (!pedido) return { ignorado: "pedido inexistente" };

    const pagamentos = await dbAll(
        "SELECT payment_id, status, valido FROM pagamentos_mp WHERE pedido_id = ? ORDER BY atualizado_em ASC",
        [pedidoId]
    );

    const aprovado = pagamentos.find(x => x.status === "approved" && x.valido === 1);
    const estornado = pagamentos.find(x => ["refunded", "charged_back"].includes(x.status));
    const emAnalise = pagamentos.some(x => ["pending", "in_process", "authorized", "in_mediation"].includes(x.status));
    const aprovadoInvalido = pagamentos.some(x => x.status === "approved" && x.valido !== 1);

    // ---------- pagamento aprovado ----------
    if (aprovado) {

        if (!STATUS_AVANCADOS.includes(pedido.status)) {
            await dbRun(
                "UPDATE pedidos SET status = 'pago', mp_payment_id = ? WHERE id = ?",
                [aprovado.payment_id, pedidoId]
            );
        } else {
            await dbRun("UPDATE pedidos SET mp_payment_id = COALESCE(mp_payment_id, ?) WHERE id = ?", [aprovado.payment_id, pedidoId]);
        }

        await baixarEstoque(pedidoId);

        return { situacao: "aprovado" };
    }

    // ---------- estorno / contestação ----------
    if (estornado) {

        if (pedido.status === "em_transito" || pedido.status === "entregue") {
            await avisarPedido(
                pedidoId,
                `Pagamento #${estornado.payment_id} foi ${estornado.status === "charged_back" ? "contestado (chargeback)" : "estornado"}, ` +
                "mas o pedido já foi enviado. Verifique no Mercado Pago."
            );
            return { situacao: "estornado-apos-envio" };
        }

        await devolverEstoque(pedidoId);

        if (pedido.status !== "cancelado") {
            await dbRun("UPDATE pedidos SET status = 'cancelado' WHERE id = ?", [pedidoId]);
        }

        if (pedido.me_etapa === "gerada") {
            await avisarPedido(
                pedidoId,
                "Pagamento estornado, mas a etiqueta de envio já foi gerada: cancele a etiqueta no Melhor Envio."
            );
        }

        return { situacao: "estornado" };
    }

    // ---------- ainda em análise (PIX/boleto aguardando) ----------
    if (emAnalise || aprovadoInvalido) {
        return { situacao: "aguardando" };
    }

    // ---------- tentativas recusadas / canceladas / expiradas ----------
    if (pagamentos.length > 0 && pedido.status === "aguardando_pagamento") {
        await dbRun("UPDATE pedidos SET status = 'cancelado' WHERE id = ?", [pedidoId]);
        return { situacao: "recusado" };
    }

    return { situacao: "sem-mudanca" };
}

// Consulta UM pagamento no Mercado Pago e aplica no pedido a que ele pertence
function processarPagamentoMP(paymentId, pedidoEsperado = null) {

    return naFila(async () => {

        const pagamento = await buscarPagamentoMP(paymentId);

        const referencia = String(pagamento.external_reference || "");

        if (!/^\d{1,12}$/.test(referencia)) return { ignorado: "pagamento sem referência de pedido" };

        // o link de retorno só pode confirmar o PRÓPRIO pedido
        if (pedidoEsperado !== null && String(pedidoEsperado) !== referencia) {
            return { ignorado: "pagamento de outro pedido" };
        }

        const pedido = await dbGet("SELECT id, total FROM pedidos WHERE id = ?", [Number(referencia)]);

        if (!pedido) return { ignorado: "pedido inexistente" };

        await registrarPagamento(pedido, pagamento);

        return decidirPedido(pedido.id);
    });
}

// Procura no Mercado Pago TODOS os pagamentos do pedido (para quando a notificação se perdeu)
async function conferirPedidoNoMP(pedidoId) {

    const resposta = await axios.get(`${MP_API_URL}/v1/payments/search`, {
        params: { external_reference: String(pedidoId), sort: "date_created", criteria: "desc", limit: 10 },
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        timeout: 15000
    });

    const encontrados = (resposta.data?.results || []).filter(
        x => String(x.external_reference) === String(pedidoId)
    );

    return naFila(async () => {

        const pedido = await dbGet("SELECT id, total FROM pedidos WHERE id = ?", [pedidoId]);

        if (!pedido) return { ignorado: "pedido inexistente" };

        for (const pagamento of encontrados) {
            await registrarPagamento(pedido, pagamento);
        }

        return { ...(await decidirPedido(pedidoId)), pagamentos: encontrados.length };
    });
}

// ---------- assinatura da notificação ----------
// Painel do Mercado Pago > Suas integrações > Webhooks > "Assinatura secreta" (vai no .env como MP_WEBHOOK_SECRET)
function assinaturaDoWebhookValida(req) {

    if (!MP_WEBHOOK_SECRET) return true; // sem segredo configurado: a verificação é só pela consulta à API

    const cabecalho = String(req.headers["x-signature"] || "");

    const partes = Object.fromEntries(
        cabecalho
            .split(",")
            .map(p => p.trim().split("="))
            .filter(p => p.length === 2)
    );

    if (!partes.ts || !partes.v1) return false;

    const idDados = String(req.query["data.id"] ?? req.body?.data?.id ?? "");
    const idRequisicao = String(req.headers["x-request-id"] || "");

    let manifesto = "";

    if (idDados) manifesto += `id:${idDados.toLowerCase()};`;
    if (idRequisicao) manifesto += `request-id:${idRequisicao};`;
    manifesto += `ts:${partes.ts};`;

    const esperado = crypto.createHmac("sha256", MP_WEBHOOK_SECRET).update(manifesto).digest("hex");

    const recebido = String(partes.v1);

    return (
        recebido.length === esperado.length &&
        crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado))
    );
}

app.post("/webhook", async (req, res) => {

    try {

        if (!assinaturaDoWebhookValida(req)) {
            console.log("Webhook rejeitado: assinatura inválida");
            return res.sendStatus(401);
        }

        const tipo = String(req.body?.type ?? req.query.type ?? req.query.topic ?? "payment");

        // outros avisos (merchant_order, etc.) não interessam
        if (tipo !== "payment") return res.sendStatus(200);

        const paymentId = String(req.query["data.id"] ?? req.body?.data?.id ?? req.query.id ?? "");

        if (!/^\d{1,20}$/.test(paymentId)) return res.sendStatus(200);

        try {

            const resultado = await processarPagamentoMP(paymentId);

            console.log(`Webhook: pagamento ${paymentId} ->`, JSON.stringify(resultado));

        } catch (erro) {

            const status = erro.response?.status;

            // pagamento que não existe (ex.: "simular notificação" do painel): nada a fazer
            if (status === 404 || status === 400) {
                console.log(`Webhook: pagamento ${paymentId} não encontrado no Mercado Pago`);
                return res.sendStatus(200);
            }

            // erro nosso ou do Mercado Pago: responde 500 para o Mercado Pago tentar de novo depois
            console.log("Webhook: erro ao processar, o Mercado Pago vai tentar de novo:", erro.message);
            return res.sendStatus(500);
        }

        res.sendStatus(200);

    } catch (erro) {
        console.log("Erro no webhook:", erro.message);
        res.sendStatus(500);
    }
});

// Admin: confere agora no Mercado Pago (notificação que não chegou)
app.post("/api/admin/pedidos/:id/verificar-pagamento", exigirAdmin, async (req, res) => {

    try {

        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id < 1) throw erroValidacao("Pedido inválido");

        const resultado = await conferirPedidoNoMP(id);

        const pedido = await dbGet("SELECT status FROM pedidos WHERE id = ?", [id]);

        res.json({ status: pedido?.status, resultado });

    } catch (erro) {

        if (erro.validacao) return res.status(erro.status).json({ erro: erro.message });

        console.log("ERRO VERIFICAR PAGAMENTO:", erro.response?.status || erro.message);
        res.status(502).json({ erro: "Não foi possível consultar o Mercado Pago agora. Tente novamente." });
    }
});

// Admin: dispensa o aviso do pedido depois de resolvido
app.delete("/api/admin/pedidos/:id/alerta", exigirAdmin, async (req, res) => {

    try {
        await dbRun("UPDATE pedidos SET alerta = NULL WHERE id = ?", [Number(req.params.id)]);
        res.json({ sucesso: true });
    } catch (erro) {
        console.log("ERRO ALERTA:", erro.message);
        res.status(500).json({ erro: "Erro ao limpar o aviso" });
    }
});

app.post("/api/admin-login", (req, res) => {

    const ip = req.ip;

    if (loginBloqueado(ip)) {
        return res.status(429).json({
            autorizado: false,
            erro: "Muitas tentativas. Aguarde 15 minutos."
        });
    }

    const { senha } = req.body || {};

    if (typeof senha === "string" && senhaCorreta(senha)) {

        tentativasLogin.delete(ip);

        // limpa cookies velhos de qualquer caminho e só então grava o novo (o último vence)
        apagarCookiesDeSessao(req, res);

        res.cookie(COOKIE_ADMIN, criarToken(), {
            httpOnly: true,
            sameSite: "lax",
            secure: NODE_ENV === "production",
            maxAge: SESSAO_DURACAO_MS,
            path: "/"
        });

        return res.json({ autorizado: true });
    }

    registrarFalha(ip);

    res.status(401).json({ autorizado: false });
});

app.post("/api/admin-logout", (req, res) => {
    apagarCookiesDeSessao(req, res);
    res.json({ sucesso: true });
});

app.get("/api/admin-sessao", exigirAdmin, (req, res) => {
    res.json({ autorizado: true });
});

// ---------- categorias (painel) ----------

// Lista com a quantidade de produtos em cada categoria
app.get("/api/admin/categorias", exigirAdmin, async (req, res) => {

    try {

        const linhas = await dbAll(
            `SELECT c.id, c.nome,
                    (SELECT COUNT(*) FROM produtos p WHERE p.categoria = c.id) AS produtos
             FROM categorias c
             ORDER BY c.ordem ASC, c.nome ASC`
        );

        res.json(linhas);

    } catch (erro) {
        responderErro(res, erro, "Erro ao listar categorias");
    }
});

app.post("/api/admin/categorias", exigirAdmin, async (req, res) => {

    try {

        const nome = texto(req.body?.nome, 40);

        if (nome.length < 2) {
            throw erroValidacao("Informe o nome da categoria (mínimo 2 letras)");
        }

        const id = idDaCategoria(nome);

        if (!id) {
            throw erroValidacao("Use letras ou números no nome da categoria");
        }

        const repetida = CATEGORIAS.some(c => c.id === id || semAcento(c.nome) === semAcento(nome));

        if (repetida) {
            throw erroValidacao("Já existe uma categoria com esse nome");
        }

        const { proxima } = await dbGet("SELECT COALESCE(MAX(ordem), -1) + 1 AS proxima FROM categorias");

        await dbRun("INSERT INTO categorias (id, nome, ordem) VALUES (?, ?, ?)", [id, nome, proxima]);
        await carregarCategorias();

        res.json({ id, nome });

    } catch (erro) {
        responderErro(res, erro, "Erro ao criar a categoria");
    }
});

// Define a ordem de exibição na loja: { ids: ["vestidos", "t-shirts", ...] }
app.put("/api/admin/categorias/ordem", exigirAdmin, async (req, res) => {

    try {

        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];

        if (ids.length !== CATEGORIAS.length || !CATEGORIAS.every(c => ids.includes(c.id))) {
            throw erroValidacao("Lista de categorias desatualizada. Recarregue a página.");
        }

        await dbRun("BEGIN");

        try {

            for (let i = 0; i < ids.length; i++) {
                await dbRun("UPDATE categorias SET ordem = ? WHERE id = ?", [i, ids[i]]);
            }

            await dbRun("COMMIT");

        } catch (erro) {
            await dbRun("ROLLBACK").catch(() => {});
            throw erro;
        }

        await carregarCategorias();

        res.json({ sucesso: true });

    } catch (erro) {
        responderErro(res, erro, "Erro ao ordenar as categorias");
    }
});

// Renomear: o identificador interno não muda, então produtos e links continuam funcionando
app.put("/api/admin/categorias/:id", exigirAdmin, async (req, res) => {

    try {

        const id = String(req.params.id);

        if (!CATEGORIAS.some(c => c.id === id)) {
            return res.status(404).json({ erro: "Categoria não encontrada" });
        }

        const nome = texto(req.body?.nome, 40);

        if (nome.length < 2) {
            throw erroValidacao("Informe o nome da categoria (mínimo 2 letras)");
        }

        if (CATEGORIAS.some(c => c.id !== id && semAcento(c.nome) === semAcento(nome))) {
            throw erroValidacao("Já existe uma categoria com esse nome");
        }

        await dbRun("UPDATE categorias SET nome = ? WHERE id = ?", [nome, id]);
        await carregarCategorias();

        res.json({ id, nome });

    } catch (erro) {
        responderErro(res, erro, "Erro ao renomear a categoria");
    }
});

// Excluir: os produtos NÃO são apagados, apenas ficam "sem categoria"
app.delete("/api/admin/categorias/:id", exigirAdmin, async (req, res) => {

    try {

        const id = String(req.params.id);

        if (!CATEGORIAS.some(c => c.id === id)) {
            return res.status(404).json({ erro: "Categoria não encontrada" });
        }

        const soltos = await dbRun(
            "UPDATE produtos SET categoria = NULL, atualizado_em = CURRENT_TIMESTAMP WHERE categoria = ?",
            [id]
        );

        await dbRun("DELETE FROM categorias WHERE id = ?", [id]);
        await carregarCategorias();

        res.json({ sucesso: true, produtosSemCategoria: soltos.changes });

    } catch (erro) {
        responderErro(res, erro, "Erro ao excluir a categoria");
    }
});

// ---------- produtos (painel) ----------

app.get("/api/admin/produtos", exigirAdmin, async (req, res) => {

    try {
        res.json(await listarProdutos({ admin: true }));
    } catch (erro) {
        responderErro(res, erro, "Erro ao listar produtos");
    }
});

app.post("/api/admin/produtos", exigirAdmin, async (req, res) => {

    try {

        const p = validarProduto(req.body);

        // IDs da Shopee têm 10+ dígitos; os do painel ficam abaixo de 1.000.000 (1, 2, 3...)
        // para uma linha da planilha nunca cair em cima de um produto cadastrado à mão.
        const novo = await dbRun(
            `INSERT INTO produtos
                (id, nome, descricao, preco, preco_antigo, destaque, ativo, peso, largura, altura, comprimento, categoria, posicao)
             VALUES (
                (SELECT COALESCE(MAX(id), 0) + 1 FROM produtos WHERE id < ${ID_MAX_PAINEL}),
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [p.nome, p.descricao, p.preco, p.preco_antigo, p.destaque ? 1 : 0, p.ativo ? 1 : 0, p.peso, p.largura, p.altura, p.comprimento, p.categoria]
        );

        try {
            await gravarImagens(novo.lastID, p.imagens);
            await gravarVariacoes(novo.lastID, p.variacoes);
        } catch (erro) {
            await dbRun("DELETE FROM produto_imagens WHERE produto_id = ?", [novo.lastID]);
            await dbRun("DELETE FROM produto_variacoes WHERE produto_id = ?", [novo.lastID]);
            await dbRun("DELETE FROM produtos WHERE id = ?", [novo.lastID]);
            throw erro;
        }

        res.json({ id: novo.lastID });

    } catch (erro) {
        responderErro(res, erro, "Erro ao salvar produto");
    }
});

app.put("/api/admin/produtos/:id", exigirAdmin, async (req, res) => {

    try {

        const id = Number(req.params.id);

        const existe = await dbGet("SELECT id FROM produtos WHERE id = ?", [id]);

        if (!existe) {
            return res.status(404).json({ erro: "Produto não encontrado" });
        }

        const p = validarProduto(req.body);

        await dbRun(
            `UPDATE produtos
             SET nome = ?, descricao = ?, preco = ?, preco_antigo = ?, destaque = ?, ativo = ?,
                 peso = ?, largura = ?, altura = ?, comprimento = ?, categoria = ?,
                 atualizado_em = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [p.nome, p.descricao, p.preco, p.preco_antigo, p.destaque ? 1 : 0, p.ativo ? 1 : 0, p.peso, p.largura, p.altura, p.comprimento, p.categoria, id]
        );

        await gravarImagens(id, p.imagens);
        await gravarVariacoes(id, p.variacoes);

        res.json({ sucesso: true });

    } catch (erro) {
        responderErro(res, erro, "Erro ao salvar produto");
    }
});

app.patch("/api/admin/produtos/:id/ativo", exigirAdmin, async (req, res) => {

    try {

        const id = Number(req.params.id);

        if (typeof req.body?.ativo !== "boolean") {
            throw erroValidacao("Valor inválido");
        }

        const produto = await dbGet("SELECT preco FROM produtos WHERE id = ?", [id]);

        if (!produto) {
            return res.status(404).json({ erro: "Produto não encontrado" });
        }

        if (req.body.ativo && !(produto.preco > 0)) {
            throw erroValidacao("Defina um preço maior que zero antes de mostrar na loja");
        }

        await dbRun(
            "UPDATE produtos SET ativo = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?",
            [req.body.ativo ? 1 : 0, id]
        );

        res.json({ sucesso: true });

    } catch (erro) {
        responderErro(res, erro, "Erro ao atualizar produto");
    }
});

app.delete("/api/admin/produtos/:id", exigirAdmin, async (req, res) => {

    try {

        const id = Number(req.params.id);

        const existe = await dbGet("SELECT id FROM produtos WHERE id = ?", [id]);

        if (!existe) {
            return res.status(404).json({ erro: "Produto não encontrado" });
        }

        const { total } = await dbGet(
            "SELECT COUNT(*) AS total FROM pedido_itens WHERE produto_id = ?",
            [id]
        );

        if (total > 0) {
            return res.status(409).json({
                erro: "Este produto já tem pedidos. Para tirar da loja, desative-o em vez de excluir."
            });
        }

        const imagens = (
            await dbAll("SELECT url FROM produto_imagens WHERE produto_id = ?", [id])
        ).map(r => r.url);

        await dbRun("DELETE FROM produto_imagens WHERE produto_id = ?", [id]);
        await dbRun("DELETE FROM produto_variacoes WHERE produto_id = ?", [id]);
        await dbRun("DELETE FROM produtos WHERE id = ?", [id]);

        await removerArquivosOrfaos(imagens);

        res.json({ sucesso: true });

    } catch (erro) {
        responderErro(res, erro, "Erro ao excluir produto");
    }
});

// ======================================================
// ETIQUETAS E RASTREIO (Melhor Envio)
// ======================================================

function cpfValido(cpf) {

    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;

    const digito = (base, pesoInicial) => {
        let soma = 0;
        for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
        const resto = (soma * 10) % 11;
        return resto === 10 ? 0 : resto;
    };

    return (
        digito(cpf.slice(0, 9), 10) === Number(cpf[9]) &&
        digito(cpf.slice(0, 10), 11) === Number(cpf[10])
    );
}

function normalizarPacotes(pacotes) {

    if (!Array.isArray(pacotes)) return [];

    return pacotes
        .map(p => ({
            height: Number(p?.dimensions?.height ?? p?.height),
            width: Number(p?.dimensions?.width ?? p?.width),
            length: Number(p?.dimensions?.length ?? p?.length),
            weight: Number(p?.weight)
        }))
        .filter(p => [p.height, p.width, p.length, p.weight].every(n => Number.isFinite(n) && n > 0));
}

// Quando a cotação não devolve o pacote, monta um volume único com os itens empilhados
function volumeDosItens(itens) {

    let peso = 0;
    let largura = 0;
    let comprimento = 0;
    let altura = 0;

    for (const item of itens) {
        const p = item.produto || {};
        peso += (p.peso || PACOTE_PADRAO.peso) * item.quantidade;
        largura = Math.max(largura, p.largura || PACOTE_PADRAO.largura);
        comprimento = Math.max(comprimento, p.comprimento || PACOTE_PADRAO.comprimento);
        altura += (p.altura || PACOTE_PADRAO.altura) * item.quantidade;
    }

    return {
        height: Math.max(2, Math.ceil(altura)),
        width: Math.max(11, Math.ceil(largura)),
        length: Math.max(16, Math.ceil(comprimento)),
        weight: Math.round(peso * 1000) / 1000
    };
}

// Dados da loja (remetente) vindos do .env
function dadosDaLoja() {

    // O Melhor Envio quer DDD + número (10 ou 11 dígitos): tira o +55 se vier no .env
    let telefone = soDigitos(LOJA_TELEFONE);
    if (telefone.length >= 12 && telefone.startsWith("55")) telefone = telefone.slice(2);

    return {
        nome: texto(LOJA_NOME, 100),
        email: texto(LOJA_EMAIL, 100),
        telefone,
        documento: soDigitos(LOJA_DOCUMENTO),
        inscricao: texto(LOJA_INSCRICAO_ESTADUAL, 30),
        endereco: texto(LOJA_ENDERECO, 150),
        numero: texto(LOJA_NUMERO, 20),
        complemento: texto(LOJA_COMPLEMENTO, 60),
        bairro: texto(LOJA_BAIRRO, 100),
        cidade: texto(LOJA_CIDADE, 100),
        uf: texto(LOJA_UF, 2).toUpperCase(),
        cep: soDigitos(CEP_ORIGEM)
    };
}

function dadosDaLojaFaltando() {

    const l = dadosDaLoja();
    const faltando = [];

    if (!l.nome) faltando.push("LOJA_NOME");
    if (!l.email) faltando.push("LOJA_EMAIL");
    if (l.telefone.length < 10) faltando.push("LOJA_TELEFONE");
    if (![11, 14].includes(l.documento.length)) faltando.push("LOJA_DOCUMENTO (CPF ou CNPJ, só números)");
    if (!l.endereco) faltando.push("LOJA_ENDERECO");
    if (!l.numero) faltando.push("LOJA_NUMERO");
    if (!l.bairro) faltando.push("LOJA_BAIRRO");
    if (!l.cidade) faltando.push("LOJA_CIDADE");
    if (l.uf.length !== 2) faltando.push("LOJA_UF");
    if (l.cep.length !== 8) faltando.push("CEP_ORIGEM");

    return faltando;
}

// Transforma a resposta de erro do Melhor Envio em texto legível
function textoErroME(erro) {

    const d = erro.response?.data;

    if (!d) return erro.message;

    const partes = [];

    if (typeof d === "string") partes.push(d.slice(0, 200));
    if (d.message) partes.push(d.message);
    if (d.error) partes.push(typeof d.error === "string" ? d.error : JSON.stringify(d.error));

    if (d.errors && typeof d.errors === "object") {
        for (const [campo, msgs] of Object.entries(d.errors)) {
            partes.push(`${campo}: ${[].concat(msgs).join(", ")}`);
        }
    }

    return (partes.join(" | ") || `HTTP ${erro.response.status}`).slice(0, 700);
}

async function meChamar(metodo, caminho, corpo) {

    try {

        const resposta = await axios({
            method: metodo,
            url: `${MELHOR_ENVIO_URL}/api/v2/me${caminho}`,
            data: corpo,
            headers: {
                Authorization: `Bearer ${MELHOR_ENVIO_TOKEN}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                "User-Agent": ME_USER_AGENT
            },
            timeout: 30000
        });

        return resposta.data;

    } catch (erro) {

        console.log(`ERRO MELHOR ENVIO ${metodo} ${caminho}:`, erro.response?.status, JSON.stringify(erro.response?.data || erro.message));

        const falha = erroValidacao(`Melhor Envio: ${textoErroME(erro)}`, 502);
        throw falha;
    }
}

// Ordem das situações: a sincronização só avança, nunca volta nem mexe em cancelado
const ORDEM_STATUS = ["aguardando_pagamento", "pago", "em_separacao", "em_transito", "entregue"];

function statusPedidoPorRastreio(statusME, statusAtual) {

    const alvo = { posted: "em_transito", delivered: "entregue" }[statusME];

    if (!alvo) return statusAtual;

    const atual = ORDEM_STATUS.indexOf(statusAtual);

    return atual >= 0 && ORDEM_STATUS.indexOf(alvo) > atual ? alvo : statusAtual;
}

async function sincronizarRastreios(pedidoId = null) {

    const alvos = await dbAll(
        `SELECT id, status, me_pedido_id FROM pedidos
         WHERE me_etapa = 'gerada' AND me_pedido_id IS NOT NULL
           AND status NOT IN ('entregue', 'cancelado')
           ${pedidoId ? "AND id = ?" : ""}
         LIMIT 50`,
        pedidoId ? [pedidoId] : []
    );

    if (alvos.length === 0) return { consultados: 0, atualizados: 0 };

    const dados = await meChamar("POST", "/shipment/tracking", {
        orders: alvos.map(a => a.me_pedido_id)
    });

    let atualizados = 0;

    for (const alvo of alvos) {

        const info = dados?.[alvo.me_pedido_id];

        if (!info || typeof info !== "object") continue;

        const codigo = info.tracking || info.melhorenvio_tracking || null;
        const novoStatus = statusPedidoPorRastreio(info.status, alvo.status);

        // etiqueta cancelada no Melhor Envio: libera para gerar outra
        const etapa = info.status === "canceled" ? "cancelada" : "gerada";

        await dbRun(
            `UPDATE pedidos
             SET me_status = ?, me_etapa = ?, status = ?,
                 codigo_rastreio = COALESCE(?, codigo_rastreio)
             WHERE id = ?`,
            [info.status || null, etapa, novoStatus, codigo, alvo.id]
        );

        atualizados++;
    }

    return { consultados: alvos.length, atualizados };
}

async function gerarEtiquetaDoPedido(pedidoId, extras) {

    const pedido = await dbGet("SELECT * FROM pedidos WHERE id = ?", [pedidoId]);

    if (!pedido) {
        throw erroValidacao("Pedido não encontrado", 404);
    }

    if (!["pago", "em_separacao"].includes(pedido.status)) {
        throw erroValidacao("A etiqueta só pode ser gerada depois que o pedido for pago.");
    }

    if (pedido.me_etapa === "gerada") {
        throw erroValidacao("A etiqueta deste pedido já foi gerada.");
    }

    const faltando = dadosDaLojaFaltando();

    if (faltando.length > 0) {
        throw erroValidacao(`Faltam dados da loja no arquivo .env: ${faltando.join(", ")}`);
    }

    const cpf = soDigitos(extras.cpf || pedido.cpf);

    if (!cpfValido(cpf)) {
        throw erroValidacao("Informe um CPF válido do destinatário.");
    }

    const complemento = texto(extras.complemento ?? pedido.complemento, 60);
    const chaveNf = soDigitos(extras.chave_nf);

    if (chaveNf && chaveNf.length !== 44) {
        throw erroValidacao("A chave da nota fiscal deve ter 44 números.");
    }

    await dbRun("UPDATE pedidos SET cpf = ?, complemento = ? WHERE id = ?", [cpf, complemento || null, pedidoId]);

    let meId = pedido.me_etapa !== "cancelada" ? pedido.me_pedido_id : null;
    let etapa = meId ? pedido.me_etapa : null;

    // ---------- 1) carrinho do Melhor Envio ----------
    if (!meId) {

        const linhas = await dbAll(
            `SELECT i.nome, i.variacao_nome, i.preco, i.quantidade, i.produto_id,
                    p.peso, p.largura, p.altura, p.comprimento
             FROM pedido_itens i
             LEFT JOIN produtos p ON p.id = i.produto_id
             WHERE i.pedido_id = ?`,
            [pedidoId]
        );

        if (linhas.length === 0) {
            throw erroValidacao("Este pedido não tem itens.");
        }

        const itens = linhas.map(l => ({
            id: l.produto_id,
            nome: l.nome,
            preco: l.preco,
            quantidade: l.quantidade,
            produto: { peso: l.peso, largura: l.largura, altura: l.altura, comprimento: l.comprimento }
        }));

        // Cota de novo: o serviço escolhido pelo cliente precisa continuar disponível
        let opcoes;

        try {
            opcoes = await consultarFrete(pedido.cep, itens);
        } catch (erro) {
            throw erroValidacao(`Melhor Envio: ${textoErroME(erro)}`, 502);
        }

        const opcao = opcoes.find(o => String(o.id) === String(pedido.frete_servico_id));

        if (!opcao) {
            throw erroValidacao(
                "O serviço de frete escolhido pelo cliente não está mais disponível. " +
                "Gere esta etiqueta pelo site do Melhor Envio."
            );
        }

        if (opcao._pacotes.length > 1) {
            throw erroValidacao(
                "Este pedido precisa de mais de um volume. Gere a etiqueta pelo site do Melhor Envio."
            );
        }

        const volume = opcao._pacotes[0] || volumeDosItens(itens);
        const loja = dadosDaLoja();
        const comNota = chaveNf.length === 44;

        const remetente = {
            name: loja.nome,
            email: loja.email,
            phone: loja.telefone,
            address: loja.endereco,
            complement: loja.complemento,
            number: loja.numero,
            district: loja.bairro,
            city: loja.cidade,
            state_abbr: loja.uf,
            country_id: "BR",
            postal_code: loja.cep
        };

        if (loja.documento.length === 14) {
            remetente.company_document = loja.documento;
            remetente.document = "";
            if (loja.inscricao) remetente.state_register = comNota ? loja.inscricao : "ISENTO";
        } else {
            remetente.document = loja.documento;
        }

        const seguro = Math.round(linhas.reduce((soma, l) => soma + l.preco * l.quantidade, 0) * 100) / 100;

        const corpo = {
            service: Number(pedido.frete_servico_id),
            from: remetente,
            to: {
                name: pedido.cliente,
                email: pedido.email,
                phone: soDigitos(pedido.telefone),
                document: cpf,
                address: pedido.rua,
                complement: complemento,
                number: pedido.numero,
                district: pedido.bairro,
                city: pedido.cidade,
                state_abbr: pedido.estado,
                country_id: "BR",
                postal_code: soDigitos(pedido.cep)
            },
            products: linhas.map(l => ({
                name: rotuloTamanho(l.variacao_nome) ? `${l.nome} - ${rotuloTamanho(l.variacao_nome)}` : l.nome,
                quantity: l.quantidade,
                unitary_value: l.preco
            })),
            volumes: [volume],
            options: {
                platform: loja.nome,
                reminder: `Pedido #${pedidoId}`,
                insurance_value: seguro,
                receipt: false,
                own_hand: false,
                reverse: false,
                tags: [{ tag: `Pedido #${pedidoId}`, url: `${BASE_URL}/pedido.html?id=${pedidoId}` }]
            }
        };

        if (ME_AGENCIA_ID) corpo.agency = Number(ME_AGENCIA_ID);

        if (comNota) {
            corpo.options.invoice = { key: chaveNf };
        } else {
            // sem nota fiscal: envio não comercial, com declaração de conteúdo
            corpo.options.non_commercial = true;
        }

        const criado = await meChamar("POST", "/cart", corpo);

        meId = criado?.id;

        if (!meId) {
            throw erroValidacao("Melhor Envio: resposta inesperada ao criar a etiqueta.", 502);
        }

        etapa = "carrinho";

        await dbRun(
            `UPDATE pedidos SET me_pedido_id = ?, me_etapa = 'carrinho', me_status = NULL, etiqueta_custo = ? WHERE id = ?`,
            [meId, opcao.preco, pedidoId]
        );
    }

    // ---------- 2) pagamento (usa o saldo da carteira) ----------
    if (etapa === "carrinho") {

        await meChamar("POST", "/shipment/checkout", { orders: [meId] });

        etapa = "comprada";

        await dbRun("UPDATE pedidos SET me_etapa = 'comprada' WHERE id = ?", [pedidoId]);
    }

    // ---------- 3) geração da etiqueta ----------
    if (etapa === "comprada") {

        const resultado = await meChamar("POST", "/shipment/generate", { orders: [meId] });

        const item = resultado?.[meId];

        if (item && item.status === false) {
            throw erroValidacao(`Melhor Envio: ${item.message || "não foi possível gerar a etiqueta"}`, 502);
        }

        await dbRun(
            `UPDATE pedidos SET me_etapa = 'gerada', me_status = 'generated',
                    etiqueta_gerada_em = CURRENT_TIMESTAMP WHERE id = ?`,
            [pedidoId]
        );

        // Etiqueta gerada = pedido embalado e pronto para postar: o cliente passa a ver "Preparando o envio"
        await dbRun(
            "UPDATE pedidos SET status = 'em_separacao' WHERE id = ? AND status = 'pago'",
            [pedidoId]
        );
    }

    // tenta já trazer o código de rastreio (pode ainda não existir)
    try {
        await sincronizarRastreios(pedidoId);
    } catch {
        // sem problema: o código aparece na próxima atualização
    }

    return { meId };
}

// ---------- rotas ----------

// Situação do Melhor Envio: dados da loja faltando e saldo da carteira
app.get("/api/admin/melhorenvio/status", exigirAdmin, async (req, res) => {

    let saldo = null;

    try {
        const dados = await meChamar("GET", "/balance");
        const valor = Number(dados?.balance);
        saldo = Number.isFinite(valor) ? valor : null;
    } catch {
        saldo = null;
    }

    res.json({
        ambiente: /sandbox/i.test(MELHOR_ENVIO_URL) ? "teste" : "producao",
        dadosDaLojaFaltando: dadosDaLojaFaltando(),
        saldo
    });
});

app.post("/api/admin/pedidos/:id/etiqueta", exigirAdmin, async (req, res) => {

    try {

        const id = Number(req.params.id);

        await gerarEtiquetaDoPedido(id, req.body || {});

        const pedido = await dbGet(
            "SELECT me_etapa, me_status, codigo_rastreio, etiqueta_custo FROM pedidos WHERE id = ?",
            [id]
        );

        res.json({ sucesso: true, ...pedido });

    } catch (erro) {

        // Se parou no meio (ex.: saldo insuficiente), o pedido guarda a etapa e pode continuar depois
        const parcial = await dbGet("SELECT me_etapa FROM pedidos WHERE id = ?", [Number(req.params.id)]).catch(() => null);

        if (erro.validacao) {
            return res.status(erro.status).json({ erro: erro.message, etapa: parcial?.me_etapa || null });
        }

        console.log("ERRO ETIQUETA:", erro);
        res.status(500).json({ erro: "Erro ao gerar a etiqueta" });
    }
});

app.post("/api/admin/pedidos/:id/etiqueta/imprimir", exigirAdmin, async (req, res) => {

    try {

        const id = Number(req.params.id);

        const pedido = await dbGet("SELECT me_pedido_id, me_etapa FROM pedidos WHERE id = ?", [id]);

        if (!pedido || pedido.me_etapa !== "gerada") {
            throw erroValidacao("Este pedido ainda não tem etiqueta gerada.");
        }

        const dados = await meChamar("POST", "/shipment/print", {
            mode: "private",
            orders: [pedido.me_pedido_id]
        });

        if (!dados?.url) {
            throw erroValidacao("Melhor Envio: não devolveu o link de impressão.", 502);
        }

        await dbRun("UPDATE pedidos SET etiqueta_url = ? WHERE id = ?", [dados.url, id]);

        res.json({ url: dados.url });

    } catch (erro) {
        responderErro(res, erro, "Erro ao preparar a impressão");
    }
});

// Entrega o PDF da etiqueta pelo próprio servidor da loja, para abrir e imprimir dentro do painel
// (sem mandar o admin para o site do Melhor Envio).
const hostDoMelhorEnvio = url => {
    try {
        const u = new URL(url);
        return u.protocol === "https:" && (u.hostname === "melhorenvio.com.br" || u.hostname.endsWith(".melhorenvio.com.br"));
    } catch {
        return false;
    }
};

app.get("/api/admin/pedidos/:id/etiqueta.pdf", exigirAdmin, async (req, res) => {

    res.set("Cache-Control", "no-store");

    try {

        const id = Number(req.params.id);

        const pedido = await dbGet("SELECT me_pedido_id, me_etapa FROM pedidos WHERE id = ?", [id]);

        if (!pedido || pedido.me_etapa !== "gerada") {
            throw erroValidacao("Este pedido ainda não tem etiqueta gerada.");
        }

        const dados = await meChamar("POST", "/shipment/print", {
            mode: "private",
            orders: [pedido.me_pedido_id]
        });

        const link = dados?.url;

        if (!link) {
            throw erroValidacao("Melhor Envio: não devolveu o link de impressão.", 502);
        }

        await dbRun("UPDATE pedidos SET etiqueta_url = ? WHERE id = ?", [link, id]);

        // Segue os redirecionamentos à mão, aceitando só endereços do próprio Melhor Envio
        let destino = link;
        let resposta = null;

        for (let salto = 0; salto < 5; salto++) {

            if (!hostDoMelhorEnvio(destino)) {
                const falha = erroValidacao("A etiqueta não pôde ser aberta aqui. Use o link do Melhor Envio.", 502);
                falha.link = link;
                throw falha;
            }

            resposta = await axios.get(destino, {
                responseType: "arraybuffer",
                maxRedirects: 0,
                maxContentLength: 15 * 1024 * 1024,
                timeout: 30000,
                validateStatus: status => status < 400,
                headers: { "User-Agent": ME_USER_AGENT, Accept: "application/pdf,*/*" }
            });

            if (resposta.status >= 300 && resposta.headers.location) {
                destino = new URL(resposta.headers.location, destino).toString();
                continue;
            }

            break;
        }

        const corpo = Buffer.from(resposta.data);

        // só entrega se for mesmo um PDF
        if (corpo.subarray(0, 5).toString("latin1") !== "%PDF-") {
            const falha = erroValidacao("O Melhor Envio não devolveu o PDF diretamente. Use o link do Melhor Envio.", 502);
            falha.link = link;
            throw falha;
        }

        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="etiqueta-pedido-${id}.pdf"`,
            "Content-Length": corpo.length
        });

        res.send(corpo);

    } catch (erro) {

        if (erro.validacao) {
            return res.status(erro.status).json({ erro: erro.message, url: erro.link || null });
        }

        console.log("ERRO PDF ETIQUETA:", erro.response?.status || erro.message);

        res.status(502).json({ erro: "Não foi possível carregar a etiqueta agora. Tente novamente." });
    }
});

app.post("/api/admin/pedidos/:id/rastreio/atualizar", exigirAdmin, async (req, res) => {

    try {

        const id = Number(req.params.id);

        await sincronizarRastreios(id);

        const pedido = await dbGet(
            "SELECT status, me_etapa, me_status, codigo_rastreio FROM pedidos WHERE id = ?",
            [id]
        );

        res.json({ sucesso: true, ...pedido });

    } catch (erro) {
        responderErro(res, erro, "Erro ao atualizar o rastreio");
    }
});

app.get("/api/pedidos", exigirAdmin, (req, res) => {

    db.all(
        `
        SELECT
            p.*,
            COALESCE(
                SUM(pi.quantidade),
                0
            ) AS quantidade_itens
        FROM pedidos p
        LEFT JOIN pedido_itens pi
            ON p.id = pi.pedido_id
        GROUP BY p.id
        ORDER BY p.id DESC
        `,
        [],
        (err, rows) => {

            if (err) {

                console.log(err);

                return res.status(500).json({
                    erro: "Erro ao consultar pedidos"
                });

            }

            res.json(rows);

        }
    );

});

app.get("/api/pedido/:id", exigirAdmin, (req, res) => {

    const pedidoId = req.params.id;

    db.get(
        `
        SELECT *
        FROM pedidos
        WHERE id = ?
        `,
        [pedidoId],
        (err, pedido) => {

            if (err) {
                return res.status(500).json({
                    erro: "Erro ao consultar pedido"
                });
            }

            if (!pedido) {
                return res.status(404).json({
                    erro: "Pedido não encontrado"
                });
            }

            db.all(
                `
                SELECT *
                FROM pedido_itens
                WHERE pedido_id = ?
                `,
                [pedidoId],
                (err, itens) => {

                    if (err) {
                        return res.status(500).json({
                            erro: "Erro ao consultar itens"
                        });
                    }

                    const itensFormatados = itens.map(item => ({
                        id: item.produto_id,
                        nome: item.nome,
                        variacao: rotuloTamanho(item.variacao_nome),
                        preco: item.preco,
                        quantidade: item.quantidade,
                        subtotal: item.preco * item.quantidade
                    }));

                    res.json({

                        id: pedido.id,

                        status: pedido.status,

                        data_pedido: pedido.data_pedido,

                        alerta: pedido.alerta || "",

                        mp_payment_id: pedido.mp_payment_id || "",

                        cliente: pedido.cliente || "",

                        email: pedido.email || "",

                        telefone: pedido.telefone || "",

                        rua: pedido.rua || "",

                        numero: pedido.numero || "",

                        bairro: pedido.bairro || "",

                        cidade: pedido.cidade || "",

                        estado: pedido.estado || "",

                        cep: pedido.cep || "",

                        transportadora: pedido.transportadora || "",

                        valor_frete: pedido.valor_frete || 0,

                        codigo_rastreio: pedido.codigo_rastreio || "",

                        cpf: pedido.cpf || "",

                        complemento: pedido.complemento || "",

                        me_etapa: pedido.me_etapa || null,

                        me_status: pedido.me_status || null,

                        etiqueta_custo: pedido.etiqueta_custo || null,

                        etiqueta_url: pedido.etiqueta_url || null,

                        total: pedido.total,

                        itens: itensFormatados

                    });

                }
            );
        }
    );
});

// Consulta do cliente ("Meus pedidos").
//  - Só e-mail OU telefone da compra: lista os pedidos dos últimos 3 meses.
//  - Com o número do pedido também: mostra esse pedido (de qualquer data).
// Não devolve endereço, CPF, telefone nem e-mail: só o que o cliente precisa para acompanhar.
app.post("/api/consultar", limiteConsulta, async (req, res) => {

    res.set("Cache-Control", "no-store");

    // "contato" é o campo novo; "email" continua aceito
    const bruto = texto(req.body?.contato ?? req.body?.email, 120);

    let coluna;
    let valor;

    if (bruto.includes("@")) {

        valor = bruto.toLowerCase();

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor)) {
            return res.status(400).json({ erro: "Informe um e-mail válido" });
        }

        coluna = "lower(email)";

    } else {

        let digitos = soDigitos(bruto);

        // aceita +55 / 55 na frente (o pedido guarda só DDD + número)
        if (digitos.length >= 12 && digitos.startsWith("55")) digitos = digitos.slice(2);

        if (digitos.length < 10 || digitos.length > 11) {
            return res.status(400).json({
                erro: "Informe o e-mail ou o telefone com DDD usado na compra"
            });
        }

        valor = digitos;
        coluna = "telefone";
    }

    const numeroTexto = texto(req.body?.pedido, 20);
    const id = numeroTexto ? Number(numeroTexto.replace(/^#/, "")) : null;

    if (numeroTexto && (!Number.isInteger(id) || id < 1)) {
        return res.status(400).json({ erro: "Número do pedido inválido" });
    }

    try {

        const campos = `id, status, data_pedido, total, valor_frete, transportadora, codigo_rastreio, me_etapa`;

        const pedidos = id
            ? await dbAll(
                `SELECT ${campos} FROM pedidos WHERE id = ? AND ${coluna} = ?`,
                [id, valor]
            )
            : await dbAll(
                `SELECT ${campos} FROM pedidos
                 WHERE ${coluna} = ? AND data_pedido >= datetime('now', '-3 months')
                 ORDER BY id DESC
                 LIMIT 30`,
                [valor]
            );

        if (pedidos.length === 0) {
            return res.status(404).json({
                erro: id
                    ? "Pedido não encontrado. Confira o número e o e-mail ou telefone da compra."
                    : "Não encontramos pedidos dos últimos 3 meses com esses dados. " +
                      "Se a compra é mais antiga, informe também o número do pedido."
            });
        }

        const itens = await dbAll(
            `SELECT pedido_id, nome, variacao_nome, preco, quantidade
             FROM pedido_itens
             WHERE pedido_id IN (${pedidos.map(() => "?").join(",")})
             ORDER BY id ASC`,
            pedidos.map(x => x.id)
        );

        const andamentos = await andamentoDosPedidos(pedidos);

        res.json({
            pedidos: pedidos.map(({ me_etapa, ...x }) => ({
                ...x,
                andamento: andamentos.get(x.id),
                itens: itens
                    .filter(i => i.pedido_id === x.id)
                    .map(i => ({
                        nome: i.nome,
                        variacao: rotuloTamanho(i.variacao_nome),
                        preco: i.preco,
                        quantidade: i.quantidade
                    }))
            }))
        });

    } catch (erro) {
        console.log("ERRO CONSULTA:", erro);
        res.status(500).json({ erro: "Erro ao consultar pedidos" });
    }
});

app.put("/api/pedido/:id/rastreio", exigirAdmin, async (req, res) => {

    try {

        const id = Number(req.params.id);

        const transportadora = texto(req.body?.transportadora, 80);
        const codigo = texto(req.body?.codigo_rastreio, 60);

        const resultado = await dbRun(
            "UPDATE pedidos SET transportadora = ?, codigo_rastreio = ? WHERE id = ?",
            [transportadora || null, codigo || null, id]
        );

        if (resultado.changes === 0) {
            return res.status(404).json({ erro: "Pedido não encontrado" });
        }

        res.json({ sucesso: true });

    } catch (erro) {
        responderErro(res, erro, "Erro ao salvar rastreio");
    }
});

// Mudança manual de situação pelo painel. O estoque acompanha: marcar como pago dá baixa (uma vez),
// cancelar devolve o que tinha sido baixado.
app.put("/api/pedido/:id/status", exigirAdmin, async (req, res) => {

    try {

        const { status } = req.body || {};

        if (!STATUS_VALIDOS.includes(status)) {
            return res.status(400).json({ erro: "Status inválido" });
        }

        const id = Number(req.params.id);

        const resultado = await naFila(async () => {

            const pedido = await dbGet("SELECT id FROM pedidos WHERE id = ?", [id]);

            if (!pedido) return null;

            await dbRun("UPDATE pedidos SET status = ? WHERE id = ?", [status, id]);

            if (STATUS_AVANCADOS.includes(status)) {
                await baixarEstoque(id);
            } else if (status === "cancelado") {
                await devolverEstoque(id);
            }

            return true;
        });

        if (!resultado) return res.status(404).json({ erro: "Pedido não encontrado" });

        res.json({ sucesso: true });

    } catch (erro) {
        console.log("ERRO STATUS:", erro.message);
        res.status(500).json({ erro: "Erro ao atualizar status" });
    }
});

prepararBanco()
    .then(() => {
        const servidor = app.listen(PORT, () => {
            console.log(`Servidor rodando em http://localhost:${PORT}`);
        });

        // Desligamento seguro: termina os pedidos em andamento e fecha o banco (deploy, reinício, pm2 stop)
        const encerrar = sinal => {

            console.log(`${sinal}: encerrando com segurança...`);

            servidor.close(() => db.close(() => process.exit(0)));
            servidor.closeIdleConnections?.();

            setTimeout(() => process.exit(1), 10000).unref();
        };

        process.once("SIGTERM", () => encerrar("SIGTERM"));
        process.once("SIGINT", () => encerrar("SIGINT"));

        // Backup diário (confere ao ligar e a cada 30 minutos; só roda uma vez por dia)
        setTimeout(() => backupDoDiaSeNecessario().catch(() => {}), 60 * 1000).unref();
        setInterval(() => backupDoDiaSeNecessario().catch(() => {}), 30 * 60 * 1000).unref();

        if (!MP_WEBHOOK_SECRET) {
            console.log(
                "⚠️  MP_WEBHOOK_SECRET não definido: o webhook não confere a assinatura do Mercado Pago. " +
                "Defina antes de publicar (Mercado Pago > Suas integrações > Webhooks > Assinatura secreta)."
            );
        }

        // Pedidos aguardando pagamento: confere no Mercado Pago de tempos em tempos,
        // para o caso de uma notificação ter se perdido (ex.: túnel/servidor fora do ar) (0 desliga)
        const minutosMP = Number(MP_CONFERE_MINUTOS);

        if (Number.isFinite(minutosMP) && minutosMP > 0) {

            const conferirPendentes = async () => {

                const alvos = await dbAll(
                    `SELECT id FROM pedidos
                     WHERE status = 'aguardando_pagamento' AND data_pedido >= datetime('now', '-2 days')
                     ORDER BY id DESC LIMIT 20`
                );

                for (const alvo of alvos) {
                    try {
                        await conferirPedidoNoMP(alvo.id);
                    } catch (erro) {
                        console.log(`Conferência do pedido ${alvo.id}:`, erro.response?.status || erro.message);
                    }
                }
            };

            setTimeout(() => conferirPendentes().catch(() => {}), 20 * 1000).unref();
            setInterval(() => conferirPendentes().catch(() => {}), minutosMP * 60 * 1000).unref();
        }

        // Atualiza sozinho o rastreio das etiquetas geradas (0 desliga)
        const minutos = Number(ME_SYNC_MINUTOS);

        if (Number.isFinite(minutos) && minutos > 0) {
            setInterval(() => {
                sincronizarRastreios().catch(erro =>
                    console.log("Sincronização de rastreio:", erro.message)
                );
            }, minutos * 60 * 1000).unref();
        }
    })
    .catch(erro => {
        console.error("❌ Erro ao preparar o banco de dados:", erro);
        process.exit(1);
    });