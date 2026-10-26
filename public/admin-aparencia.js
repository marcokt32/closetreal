// Página "Aparência" do painel: banners (computador e celular), logo, cores e fontes.
// Usa $, api e toast do admin-comum.js e TemaCores do tema-cores.js.

const MAX_BANNERS = 8;

const FAMILIAS = {
    padrao: "'Segoe UI', sans-serif",
    poppins: "'Poppins', sans-serif",
    montserrat: "'Montserrat', sans-serif",
    nunito: "'Nunito', sans-serif",
    playfair: "'Playfair Display', serif",
    lora: "'Lora', serif"
};

const LOGO_PADRAO = "/img/Logo CR fundo transparente.png";

let cfg = null;
let padrao = null;
let totalDestaques = 0;
let salvoJson = "";

const clonar = o => JSON.parse(JSON.stringify(o));

// Só há "alterações não salvas" depois que a aparência carregou de verdade
const temAlteracoes = () => cfg !== null && JSON.stringify(cfg) !== salvoJson;

// Enquanto não carregou (ou se a sessão venceu), nada na página pode ser mexido
function habilitarPagina(sim) {
    document
        .querySelectorAll(".ap-pagina input, .ap-pagina select, .ap-pagina button")
        .forEach(campo => { campo.disabled = !sim; });
}

function atualizarEstado() {

    if (cfg === null) return;

    const sujo = temAlteracoes();

    $("btnSalvar").disabled = !sujo;

    const estado = $("estadoSalvar");
    estado.textContent = sujo ? "Há alterações não salvas" : "Nenhuma alteração";
    estado.classList.toggle("sujo", sujo);
}

window.addEventListener("beforeunload", e => {
    if (temAlteracoes()) {
        e.preventDefault();
        e.returnValue = "";
    }
});

// ---------- imagens ----------

// Reduz a imagem antes de enviar. Logo mantém a transparência (PNG); banner vira JPEG.
async function prepararImagem(arquivo, { maxLado, formato }) {

    const bitmap = await createImageBitmap(arquivo);

    const escala = Math.min(1, maxLado / Math.max(bitmap.width, bitmap.height));

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * escala);
    canvas.height = Math.round(bitmap.height * escala);

    const ctx = canvas.getContext("2d");

    if (formato === "jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    return {
        dados: formato === "jpeg" ? canvas.toDataURL("image/jpeg", 0.85) : canvas.toDataURL("image/png"),
        largura: bitmap.width,
        altura: bitmap.height
    };
}

async function enviarBanners(arquivos, chave) {

    if (cfg === null) return;

    const vertical = chave === "banners_celular";
    const ideal = vertical ? 9 / 16 : 16 / 9;
    const lista = cfg[chave];

    for (const arquivo of arquivos) {

        if (lista.length >= MAX_BANNERS) {
            toast(`No máximo ${MAX_BANNERS} imagens por banner`, true);
            break;
        }

        try {

            const medidas = await createImageBitmap(arquivo);

            const proporcao = medidas.width / medidas.height;

            // fora do formato: avisa que será cortada nas bordas
            if (Math.abs(proporcao / ideal - 1) > 0.12) {

                const aprovado = confirm(
                    `A imagem "${arquivo.name}" tem ${medidas.width} × ${medidas.height} px, ` +
                    `e o banner ${vertical ? "do celular" : "do computador"} é ${vertical ? "vertical (9:16)" : "horizontal (16:9)"}.\\n\\n` +
                    "Ela será cortada nas bordas para caber. Usar mesmo assim?"
                );

                if (!aprovado) continue;
            }

            const { dados } = await prepararImagem(arquivo, { maxLado: 1920, formato: "jpeg" });

            const { url } = await api("POST", "/api/admin/upload", { dados });

            lista.push({ url, alt: "" });

            renderizarBanners();
            atualizarEstado();

        } catch (erro) {
            toast(erro.message || "Não foi possível enviar a imagem", true);
        }
    }
}

function renderizarLista(chave, areaId) {

    const area = $(areaId);
    const lista = cfg[chave];
    area.replaceChildren();

    if (lista.length === 0) {
        area.appendChild(el("p", "ap-vazio", "Nenhuma imagem enviada."));
        return;
    }

    lista.forEach((item, i) => {

        const cartao = el("div", "ap-item");

        const foto = el("div", "ap-item-foto");
        const img = document.createElement("img");
        img.src = item.url;
        img.alt = item.alt || `Imagem ${i + 1} do banner`;
        foto.append(img, el("span", "ap-ordem", String(i + 1)));

        const alt = document.createElement("input");
        alt.type = "text";
        alt.maxLength = 160;
        alt.value = item.alt;
        alt.placeholder = "Descreva a imagem (leitores de tela)";
        alt.setAttribute("aria-label", `Descrição da imagem ${i + 1}`);
        alt.addEventListener("input", () => { item.alt = alt.value; atualizarEstado(); });

        const acoes = el("div", "ap-item-acoes");

        const botao = (rotulo, simbolo, desativado, acao, classe) => {
            const b = el("button", classe, simbolo);
            b.type = "button";
            b.setAttribute("aria-label", `${rotulo} a imagem ${i + 1}`);
            b.disabled = desativado;
            b.addEventListener("click", acao);
            return b;
        };

        const mover = delta => () => {
            [lista[i], lista[i + delta]] = [lista[i + delta], lista[i]];
            renderizarBanners();
            atualizarEstado();
        };

        acoes.append(
            botao("Mover para antes", "◀", i === 0, mover(-1)),
            botao("Mover para depois", "▶", i === lista.length - 1, mover(1)),
            botao("Remover", "✕", false, () => {
                lista.splice(i, 1);
                renderizarBanners();
                atualizarEstado();
            }, "excluir")
        );

        cartao.append(foto, alt, acoes);
        area.appendChild(cartao);
    });
}

function renderizarBanners() {

    renderizarLista("banners_pc", "listaBannerPc");
    renderizarLista("banners_celular", "listaBannerCelular");

    const pc = cfg.banners_pc.length;
    const cel = cfg.banners_celular.length;

    $("blocoIntervalo").hidden = Math.max(pc, cel) < 2;

    const dica = $("dicaBanner");
    dica.classList.remove("aviso");

    if (pc + cel === 0) {
        dica.textContent =
            "Sem imagens de banner, a loja usa as capas dos produtos marcados como ⭐ Destaque " +
            `(${totalDestaques} agora). Sem destaques também, aparece o banner padrão.`;
    } else if (pc === 0) {
        dica.textContent = "Só há imagens para o celular: o computador vai usar as mesmas (cortadas nas bordas). Envie imagens 16:9 para ficar perfeito.";
        dica.classList.add("aviso");
    } else if (cel === 0) {
        dica.textContent = "Só há imagens para o computador: o celular vai usar as mesmas (cortadas nas bordas). Envie imagens 9:16 para ficar perfeito.";
        dica.classList.add("aviso");
    } else {
        dica.textContent = "";
    }
}

// ---------- logo ----------

function renderizarLogo() {

    const previa = $("previaLogo");
    previa.replaceChildren();

    const img = document.createElement("img");
    img.src = cfg.logo || LOGO_PADRAO;
    img.alt = cfg.logo ? "Logo atual da loja" : "Logo padrão da loja";
    previa.appendChild(img);

    $("btnRemoverLogo").hidden = !cfg.logo;
    $("mostrarNome").checked = cfg.mostrar_nome_logo;
}

async function enviarLogo(arquivo) {

    if (cfg === null) return;

    try {

        const { dados } = await prepararImagem(arquivo, {
            maxLado: 600,
            formato: arquivo.type === "image/jpeg" ? "jpeg" : "png"
        });

        const { url } = await api("POST", "/api/admin/upload", { dados });

        cfg.logo = url;
        renderizarLogo();
        atualizarEstado();

    } catch (erro) {
        toast(erro.message || "Não foi possível enviar o logo", true);
    }
}

// ---------- cores ----------

function renderizarCores() {

    const atual = TemaCores.normalizar(cfg.cor_primaria) || TemaCores.PADRAO;

    const area = $("presetsCores");
    area.replaceChildren();

    TemaCores.PRESETS.forEach(p => {

        const pal = TemaCores.paleta(p.cor);

        const botao = el("button", "ap-preset");
        botao.type = "button";
        botao.setAttribute("aria-pressed", String(TemaCores.normalizar(p.cor) === atual));

        const bolinhas = el("span", "ap-bolinhas");
        bolinhas.setAttribute("aria-hidden", "true");

        [pal.primaria, pal.suave, pal.texto].forEach(cor => {
            const i = document.createElement("i");
            i.style.background = cor;
            bolinhas.appendChild(i);
        });

        botao.append(bolinhas, document.createTextNode(p.nome));

        botao.addEventListener("click", () => {
            cfg.cor_primaria = p.cor;
            renderizarCores();
            atualizarEstado();
        });

        area.appendChild(botao);
    });

    // campos livres
    if (document.activeElement !== $("corTexto")) $("corTexto").value = atual.toUpperCase();
    $("corPrimaria").value = atual;

    // prévia
    const pal = TemaCores.paleta(atual);
    const previa = $("previaTema");
    previa.style.setProperty("--p", pal.primaria);
    previa.style.setProperty("--pe", pal.escura);
    previa.style.setProperty("--pt", pal.texto);
    previa.style.setProperty("--ps", pal.suave);
    previa.style.setProperty("--pf", pal.fundo);

    const aviso = $("avisoCor");
    const ajuste = TemaCores.ajustarPrimaria(atual);

    aviso.classList.toggle("aviso", ajuste.ajustada);
    aviso.textContent = ajuste.ajustada
        ? `Essa cor foi ajustada para ${ajuste.hex.toUpperCase()} para o texto branco dos botões continuar legível. É essa que a loja vai usar.`
        : "";
}

// ---------- fontes ----------

function aplicarAmostras() {
    $("amostraTitulo").style.fontFamily = FAMILIAS[cfg.fonte_titulos] || FAMILIAS.padrao;
    $("amostraTexto").style.fontFamily = FAMILIAS[cfg.fonte_texto] || FAMILIAS.padrao;
}

function preencherFontes(lista) {

    [["fonteTitulos", "fonte_titulos"], ["fonteTexto", "fonte_texto"]].forEach(([id, chave]) => {

        const select = $(id);
        select.replaceChildren();

        lista.forEach(f => {
            const op = el("option", null, f.nome);
            op.value = f.id;
            select.appendChild(op);
        });

        select.value = cfg[chave];

        select.addEventListener("change", () => {
            cfg[chave] = select.value;
            aplicarAmostras();
            atualizarEstado();
        });
    });

    aplicarAmostras();
}

// ---------- salvar ----------

async function salvar() {

    if (cfg === null) return;

    const botao = $("btnSalvar");
    botao.disabled = true;
    botao.textContent = "Salvando...";

    try {

        const resposta = await api("PUT", "/api/admin/aparencia", cfg);

        cfg = clonar(resposta.config);
        salvoJson = JSON.stringify(cfg);

        renderizarTudo();

        toast(
            resposta.corAjustada?.ajustada
                ? "Aparência salva ✓ (a cor foi ajustada para ficar legível)"
                : "Aparência salva ✓ Já está valendo na loja"
        );

    } catch (erro) {
        toast(erro.message === "Sessão expirada"
            ? "Sua sessão expirou. Entre de novo no painel (em outra aba, se quiser manter esta) e clique em Salvar."
            : erro.message, true);
    } finally {
        botao.textContent = "Salvar aparência";
        atualizarEstado();
    }
}

function renderizarTudo() {
    renderizarBanners();
    renderizarLogo();
    renderizarCores();
    $("intervalo").value = String(cfg.intervalo);
    $("fonteTitulos").value = cfg.fonte_titulos;
    $("fonteTexto").value = cfg.fonte_texto;
    aplicarAmostras();
    atualizarEstado();
}

async function iniciar() {

    habilitarPagina(false);
    $("estadoSalvar").textContent = "Carregando...";

    try {

        const dados = await api("GET", "/api/admin/aparencia");

        cfg = clonar(dados.config);
        padrao = dados.padrao;
        totalDestaques = dados.destaques;
        salvoJson = JSON.stringify(cfg);

        // se o tempo salvo não estiver na lista, acrescenta
        if (![...$("intervalo").options].some(o => o.value === String(cfg.intervalo))) {
            const op = el("option", null, `${cfg.intervalo} segundos`);
            op.value = String(cfg.intervalo);
            $("intervalo").appendChild(op);
        }

        preencherFontes(dados.fontes);

        habilitarPagina(true);
        renderizarTudo();

    } catch (erro) {

        // 401: o admin-comum.js já está levando para o login; sem aviso e sem alerta de "sair da página"
        if (erro.message === "Sessão expirada") return;

        $("estadoSalvar").textContent = "Não foi possível carregar a aparência. Recarregue a página.";
        toast(erro.message, true);
    }
}

// ---------- eventos ----------

$("arqBannerPc").addEventListener("change", e => {
    enviarBanners([...e.target.files], "banners_pc");
    e.target.value = "";
});

$("arqBannerCelular").addEventListener("change", e => {
    enviarBanners([...e.target.files], "banners_celular");
    e.target.value = "";
});

$("arqLogo").addEventListener("change", e => {
    if (e.target.files[0]) enviarLogo(e.target.files[0]);
    e.target.value = "";
});

$("btnRemoverLogo").addEventListener("click", () => {
    if (cfg === null) return;

    cfg.logo = "";
    renderizarLogo();
    atualizarEstado();
});

$("mostrarNome").addEventListener("change", e => {
    if (cfg === null) return;

    cfg.mostrar_nome_logo = e.target.checked;
    atualizarEstado();
});

$("intervalo").addEventListener("change", e => {
    if (cfg === null) return;

    cfg.intervalo = Number(e.target.value);
    atualizarEstado();
});

$("corPrimaria").addEventListener("input", e => {
    if (cfg === null) return;

    cfg.cor_primaria = e.target.value;
    renderizarCores();
    atualizarEstado();
});

$("corTexto").addEventListener("input", e => {
    if (cfg === null) return;


    const cor = TemaCores.normalizar(e.target.value);

    $("corTexto").setAttribute("aria-invalid", String(!cor && e.target.value.length >= 6));

    if (!cor) return;

    cfg.cor_primaria = cor;
    renderizarCores();
    atualizarEstado();
});

$("corTexto").addEventListener("blur", () => { if (cfg !== null) renderizarCores(); });

$("btnPadrao").addEventListener("click", () => {

    if (cfg === null) return;

    if (!confirm("Voltar as cores e as fontes para o padrão da loja? Os banners e o logo não mudam.")) return;

    cfg.cor_primaria = padrao.cor_primaria;
    cfg.fonte_titulos = padrao.fonte_titulos;
    cfg.fonte_texto = padrao.fonte_texto;

    $("fonteTitulos").value = cfg.fonte_titulos;
    $("fonteTexto").value = cfg.fonte_texto;

    renderizarCores();
    aplicarAmostras();
    atualizarEstado();
});

$("btnSalvar").addEventListener("click", salvar);

iniciar();
