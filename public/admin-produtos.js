const $ = id => document.getElementById(id);

const VARIACAO_UNICA = "Único";
const MAX_FOTOS = 9;

const brl = valor =>
    Number(valor).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL"
    });

// Para a busca ignorar acentos e maiúsculas
const normalizar = texto =>
    String(texto || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto;
    return e;
}

let produtos = [];
let categorias = [];

// Estado do produto aberto no editor
let editando = null; // { id, fotos, tipo, idUnico, tamanhos: [{ id, cor, nome, estoque }] }

// ---------------------------------------------------------------
// Comunicação com o servidor
// ---------------------------------------------------------------

async function api(metodo, caminho, corpo) {

    const resposta = await fetch(caminho, {
        method: metodo,
        headers: corpo !== undefined ? { "Content-Type": "application/json" } : {},
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined
    });

    if (resposta.status === 401) {
        window.location.href = "/admin.html?expirou=1";
        throw new Error("Sessão expirada");
    }

    let dados = null;

    try {
        dados = await resposta.json();
    } catch {
        dados = null;
    }

    if (!resposta.ok) {
        throw new Error(dados?.erro || "Erro inesperado. Tente novamente.");
    }

    return dados;
}

let temporizadorToast = null;

function toast(texto, erro = false) {

    let aviso = $("toastAdmin");

    if (!aviso) {
        aviso = el("div", "fx-toast");
        aviso.id = "toastAdmin";
        aviso.setAttribute("role", "status");
        aviso.setAttribute("aria-live", "polite");
        document.body.appendChild(aviso);
    }

    aviso.textContent = texto;
    aviso.classList.toggle("erro", erro);
    aviso.classList.add("visivel");

    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => aviso.classList.remove("visivel"), 2800);
}

// ---------------------------------------------------------------
// Lista
// ---------------------------------------------------------------

async function carregarLista() {

    try {
        produtos = await api("GET", "/api/admin/produtos");
        $("erroLista").textContent = "";
    } catch (erro) {
        $("erroLista").textContent = erro.message;
        return;
    }

    atualizarCategorias();
    renderizarLista();
}

async function carregarCategorias() {

    try {
        categorias = await api("GET", "/api/categorias");
    } catch {
        categorias = [];
    }
}

function resumoEstoque(p) {

    const unico =
        p.variacoes.length === 1 && p.variacoes[0].nome === VARIACAO_UNICA && !p.variacoes[0].cor;

    if (unico) return `Estoque: ${p.variacoes[0].estoque}`;

    // "Preto: P 3, M 5 · Branco: P 2" (ou só "P 3, M 5" quando não há cores)
    const grupos = new Map();

    p.variacoes.forEach(v => {

        const cor = v.cor || "";
        const parte = v.nome === VARIACAO_UNICA ? String(v.estoque) : `${v.nome} ${v.estoque}`;

        if (!grupos.has(cor)) grupos.set(cor, []);
        grupos.get(cor).push(parte);
    });

    return [...grupos]
        .map(([cor, partes]) => (cor ? `${cor}: ` : "") + partes.join(", "))
        .join(" · ");
}

const nomeCategoria = id => (categorias.find(c => c.id === id) || {}).nome || "";

function passaNoFiltro(p) {

    const categoria = $("filtroCategoria").value;

    if (categoria === "_sem" && p.categoria) return false;
    if (categoria !== "todas" && categoria !== "_sem" && p.categoria !== categoria) return false;

    switch ($("filtro").value) {
        case "ativos": return p.ativo;
        case "ocultos": return !p.ativo;
        case "esgotados": return p.estoque < 1;
        case "estoquebaixo": return p.estoque > 0 && p.estoque <= 3;
        case "sempreco": return !(p.preco > 0);
        case "semfoto": return !p.imagem;
        default: return true;
    }
}

function ordenar(lista) {

    const ordem = $("ordem").value;

    if (ordem === "padrao") return lista;

    const copia = [...lista];

    // produtos sem preço ficam no fim ao ordenar por preço
    const preco = p => (p.preco > 0 ? p.preco : Infinity);

    switch (ordem) {
        case "nome": return copia.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
        case "menor-preco": return copia.sort((a, b) => preco(a) - preco(b));
        case "maior-preco": return copia.sort((a, b) => (b.preco || 0) - (a.preco || 0));
        case "menor-estoque": return copia.sort((a, b) => a.estoque - b.estoque);
        default: return lista;
    }
}

function filtrosAtivos() {
    return (
        $("busca").value.trim() !== "" ||
        $("filtroCategoria").value !== "todas" ||
        $("filtro").value !== "todos" ||
        $("ordem").value !== "padrao"
    );
}

function limparFiltros() {
    $("busca").value = "";
    $("filtroCategoria").value = "todas";
    $("filtro").value = "todos";
    $("ordem").value = "padrao";
    renderizarLista();
}

// Preenche os seletores de categoria (com a contagem de produtos em cada uma)
function atualizarCategorias() {

    const atual = $("filtroCategoria").value;
    const filtro = $("filtroCategoria");

    filtro.replaceChildren();

    const opcao = (valor, texto) => {
        const o = el("option", null, texto);
        o.value = valor;
        return o;
    };

    filtro.appendChild(opcao("todas", `Todas as categorias (${produtos.length})`));

    categorias.forEach(c => {
        const total = produtos.filter(p => p.categoria === c.id).length;
        filtro.appendChild(opcao(c.id, `${c.nome} (${total})`));
    });

    filtro.appendChild(opcao("_sem", `Sem categoria (${produtos.filter(p => !p.categoria).length})`));

    filtro.value = [...filtro.options].some(o => o.value === atual) ? atual : "todas";

    const editor = $("categoria");
    const escolhida = editor.value;

    editor.replaceChildren(opcao("", "Sem categoria"));
    categorias.forEach(c => editor.appendChild(opcao(c.id, c.nome)));
    editor.value = escolhida;
}

function renderizarLista() {

    const busca = normalizar($("busca").value.trim());

    const visiveis = ordenar(
        produtos.filter(p =>
            passaNoFiltro(p) &&
            (normalizar(p.nome).includes(busca) || String(p.id).includes(busca))
        )
    );

    $("contagem").textContent =
        `${visiveis.length} de ${produtos.length} produtos`;

    $("btnLimparFiltros").hidden = !filtrosAtivos();

    const lista = $("lista");
    lista.replaceChildren();

    if (visiveis.length === 0) {
        lista.appendChild(el("p", "adm-vazio", "Nenhum produto encontrado."));
        return;
    }

    visiveis.forEach(p => lista.appendChild(criarLinha(p)));
}

function criarLinha(p) {

    const linha = el("article", "adm-linha" + (p.ativo ? "" : " oculto"));

    if (p.imagem) {
        const img = document.createElement("img");
        img.src = p.imagem;
        img.alt = "";
        img.loading = "lazy";
        linha.appendChild(img);
    } else {
        linha.appendChild(el("div", "adm-sem-foto"));
    }

    const info = el("div");
    info.appendChild(el("h2", "adm-nome", p.nome));

    const meta = el("p", "adm-meta");

    meta.appendChild(el("span", "adm-id", `ID ${p.id}`));

    if (!p.ativo) meta.appendChild(el("span", "adm-tag", "Oculto"));
    if (!(p.preco > 0)) meta.appendChild(el("span", "adm-tag erro", "Sem preço"));
    if (p.preco_antigo) meta.appendChild(el("span", "adm-tag cat", "Promoção"));
    if (p.destaque) meta.appendChild(el("span", "adm-tag cat", "⭐ Destaque"));
    if (p.estoque < 1) meta.appendChild(el("span", "adm-tag erro", "Esgotado"));

    if (p.categoria) meta.appendChild(el("span", "adm-tag cat", nomeCategoria(p.categoria)));

    meta.appendChild(document.createTextNode(resumoEstoque(p)));
    info.appendChild(meta);

    linha.appendChild(info);

    linha.appendChild(el("div", "adm-preco", p.preco > 0 ? brl(p.preco) : "—"));

    const rotulo = el("label", "adm-switch");
    const marcador = document.createElement("input");
    marcador.type = "checkbox";
    marcador.checked = p.ativo;
    marcador.setAttribute("aria-label", `Mostrar "${p.nome}" na loja`);
    marcador.title = "Mostrar na loja";

    marcador.addEventListener("change", async () => {

        const novo = marcador.checked;

        try {
            await api("PATCH", `/api/admin/produtos/${p.id}/ativo`, { ativo: novo });
            p.ativo = novo;
            toast(novo ? "Produto visível na loja" : "Produto oculto da loja");
            renderizarLista();
        } catch (erro) {
            marcador.checked = !novo;
            toast(erro.message, true);
        }
    });

    rotulo.append(marcador, el("span", "adm-slider"));
    linha.appendChild(rotulo);

    const editar = el("button", "fx-btn fx-btn-sec adm-editar", "Editar");
    editar.type = "button";
    editar.addEventListener("click", () => abrirEditor(p));
    linha.appendChild(editar);

    return linha;
}

// ---------------------------------------------------------------
// Editor
// ---------------------------------------------------------------

function numeroParaCampo(valor) {
    return valor === null || valor === undefined ? "" : String(valor).replace(".", ",");
}

function abrirEditor(p) {

    const novo = !p;

    const unico =
        novo ||
        (p.variacoes.length === 1 && p.variacoes[0].nome === VARIACAO_UNICA && !p.variacoes[0].cor);

    editando = {
        id: novo ? null : p.id,
        fotos: novo ? [] : [...p.imagens],
        tipo: unico ? "unico" : "tamanhos",
        idUnico: !novo && unico ? p.variacoes[0].id : null,
        tamanhos: novo || unico
            ? []
            : p.variacoes.map(v => ({
                id: v.id,
                cor: v.cor || "",
                nome: v.nome === VARIACAO_UNICA ? "" : v.nome,
                estoque: v.estoque
            }))
    };

    $("editorTitulo").textContent = novo ? "Novo produto" : "Editar produto";

    const rotuloId = $("editorId");
    rotuloId.replaceChildren();

    if (novo) {
        rotuloId.textContent = "O ID é gerado ao salvar";
    } else {
        rotuloId.append(document.createTextNode("ID do produto: "), el("span", "adm-id", String(p.id)));
    }
    $("btnExcluir").hidden = novo;

    $("nome").value = novo ? "" : p.nome;
    $("descricao").value = novo ? "" : p.descricao;
    $("preco").value = novo || !(p.preco > 0) ? "" : numeroParaCampo(p.preco.toFixed(2));
    $("precoAntigo").value = novo || !(p.preco_antigo > 0) ? "" : numeroParaCampo(p.preco_antigo.toFixed(2));
    $("ativo").checked = novo ? true : p.ativo;
    $("destaque").checked = novo ? false : Boolean(p.destaque);
    $("categoria").value = novo ? "" : p.categoria || "";

    $("peso").value = novo ? "" : numeroParaCampo(p.peso);
    $("largura").value = novo ? "" : numeroParaCampo(p.largura);
    $("altura").value = novo ? "" : numeroParaCampo(p.altura);
    $("comprimento").value = novo ? "" : numeroParaCampo(p.comprimento);

    $("estoqueUnico").value = unico && !novo ? p.variacoes[0].estoque : 0;

    document.querySelector(`input[name="tipo"][value="${editando.tipo}"]`).checked = true;

    $("erroForm").textContent = "";
    $("statusFoto").textContent = "";

    $("gerarCores").value = "";
    $("gerarOutrosTam").value = "";
    document.querySelectorAll(".adm-preset").forEach(b => b.setAttribute("aria-pressed", "false"));

    document
        .querySelectorAll("#formProduto .invalido")
        .forEach(c => c.classList.remove("invalido"));

    renderizarFotos();
    renderizarTamanhos();
    atualizarTipo();

    $("editor").showModal();
    $("nome").focus();
}

function fecharEditor() {
    $("editor").close();
    editando = null;
}

// ---------- fotos ----------

function renderizarFotos() {

    const area = $("fotos");
    area.replaceChildren();

    editando.fotos.forEach((url, i) => {

        const quadro = el("div", "adm-foto");

        const img = document.createElement("img");
        img.src = url;
        img.alt = `Foto ${i + 1}`;
        quadro.appendChild(img);

        const acoes = el("div", "adm-foto-acoes");

        if (i === 0) {
            acoes.appendChild(el("span", "adm-capa", "Capa"));
        } else {
            const capa = el("button", null, "Tornar capa");
            capa.type = "button";
            capa.addEventListener("click", () => {
                editando.fotos.unshift(editando.fotos.splice(i, 1)[0]);
                renderizarFotos();
            });
            acoes.appendChild(capa);
        }

        const remover = el("button", null, "Remover");
        remover.type = "button";
        remover.addEventListener("click", () => {
            editando.fotos.splice(i, 1);
            renderizarFotos();
        });
        acoes.appendChild(remover);

        quadro.appendChild(acoes);
        area.appendChild(quadro);
    });

    $("rotuloFoto").hidden = editando.fotos.length >= MAX_FOTOS;
}

// Reduz a foto (máx. 1200 px) antes de enviar: carrega mais rápido na loja
async function prepararImagem(arquivo) {

    const bitmap = await createImageBitmap(arquivo);

    const escala = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * escala);
    canvas.height = Math.round(bitmap.height * escala);

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // fundo branco para PNG com transparência
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL("image/jpeg", 0.85);
}

async function enviarFotos(arquivos) {

    const livres = MAX_FOTOS - editando.fotos.length;
    const lista = [...arquivos].slice(0, livres);
    const status = $("statusFoto");
    const erros = [];

    if (arquivos.length > livres) {
        erros.push(`Só cabem mais ${livres} foto(s); as demais foram ignoradas.`);
    }

    for (let i = 0; i < lista.length; i++) {

        status.textContent = `Enviando foto ${i + 1} de ${lista.length}...`;

        try {

            if (!/^image\/(jpeg|png|webp)$/.test(lista[i].type)) {
                throw new Error(`"${lista[i].name}" não é JPG, PNG ou WebP.`);
            }

            const dados = await prepararImagem(lista[i]);
            const { url } = await api("POST", "/api/admin/upload", { dados });

            editando.fotos.push(url);
            renderizarFotos();

        } catch (erro) {
            erros.push(erro.message);
        }
    }

    status.textContent = erros.join(" ");
}

// ---------- estoque / tamanhos ----------

function atualizarTipo() {
    const comTamanhos = editando.tipo === "tamanhos";
    $("blocoUnico").hidden = comTamanhos;
    $("blocoTamanhos").hidden = !comTamanhos;
}

function renderizarTamanhos() {

    const area = $("linhasTamanho");
    area.replaceChildren();

    if (editando.tamanhos.length === 0) {
        area.appendChild(el("p", "fx-sub", "Nenhuma variação ainda. Use “Criar combinações” abaixo."));
        return;
    }

    const cab = el("div", "adm-tam-cab");
    cab.append(el("span", null, "Cor"), el("span", null, "Tamanho"), el("span", null, "Estoque"), el("span"));
    area.appendChild(cab);

    editando.tamanhos.forEach((t, i) => {

        const linha = el("div", "adm-tam-linha");

        const cor = document.createElement("input");
        cor.value = t.cor;
        cor.maxLength = 30;
        cor.placeholder = "Ex.: Preto";
        cor.setAttribute("aria-label", "Cor");
        cor.addEventListener("input", () => { t.cor = cor.value; });

        const nome = document.createElement("input");
        nome.value = t.nome;
        nome.maxLength = 20;
        nome.placeholder = "Ex.: M";
        nome.setAttribute("aria-label", "Tamanho");
        nome.addEventListener("input", () => { t.nome = nome.value; });

        const estoque = document.createElement("input");
        estoque.type = "number";
        estoque.min = "0";
        estoque.max = "9999";
        estoque.value = t.estoque;
        estoque.setAttribute("aria-label", "Estoque");
        estoque.addEventListener("input", () => { t.estoque = estoque.value; });

        const remover = el("button", null, "✕");
        remover.type = "button";
        remover.setAttribute("aria-label", "Remover esta variação");
        remover.addEventListener("click", () => {
            editando.tamanhos.splice(i, 1);
            renderizarTamanhos();
        });

        linha.append(cor, nome, estoque, remover);
        area.appendChild(linha);
    });
}

const mesmaVariacao = (a, b) =>
    String(a.cor).trim().toLowerCase() === String(b.cor).trim().toLowerCase() &&
    String(a.nome).trim().toLowerCase() === String(b.nome).trim().toLowerCase();

const listaDoCampo = texto =>
    [...new Set(
        String(texto || "")
            .split(/[,;\n]/)
            .map(p => p.trim())
            .filter(Boolean)
    )];

// Tamanhos de letra ficam em maiúsculas (p -> P, gg -> GG)
const tamanhoLimpo = t => (/^[a-z]{1,3}$/i.test(t) ? t.toUpperCase() : t);

function gerarCombinacoes() {

    const cores = listaDoCampo($("gerarCores").value);

    const tamanhos = [...new Set([
        ...[...document.querySelectorAll('.adm-preset[aria-pressed="true"]')].map(b => b.dataset.tam),
        ...listaDoCampo($("gerarOutrosTam").value).map(tamanhoLimpo)
    ])];

    if (cores.length === 0 && tamanhos.length === 0) {
        toast("Digite ao menos uma cor ou escolha um tamanho", true);
        $("gerarCores").focus();
        return;
    }

    let criadas = 0;

    for (const cor of cores.length ? cores : [""]) {
        for (const nome of tamanhos.length ? tamanhos : [""]) {

            const nova = { id: undefined, cor, nome, estoque: 0 };

            if (editando.tamanhos.some(t => mesmaVariacao(t, nova))) continue;

            editando.tamanhos.push(nova);
            criadas++;
        }
    }

    renderizarTamanhos();

    if (criadas === 0) {
        toast("Essas combinações já estão na lista", true);
        return;
    }

    $("gerarCores").value = "";
    $("gerarOutrosTam").value = "";
    document.querySelectorAll(".adm-preset").forEach(b => b.setAttribute("aria-pressed", "false"));

    toast(`${criadas} ${criadas === 1 ? "variação criada" : "variações criadas"}. Preencha o estoque de cada uma.`);

    // leva o foco para o estoque da primeira variação nova
    const linhas = document.querySelectorAll("#linhasTamanho .adm-tam-linha");
    const primeira = linhas[linhas.length - criadas];
    if (primeira) primeira.querySelectorAll("input")[2].focus();
}

function adicionarLinha() {

    editando.tamanhos.push({ id: undefined, cor: "", nome: "", estoque: 0 });
    renderizarTamanhos();

    const linhas = document.querySelectorAll("#linhasTamanho .adm-tam-linha");
    linhas[linhas.length - 1].querySelector("input").focus();
}

// ---------- salvar / excluir ----------

function coletar() {

    const texto = id => $(id).value.trim();

    const variacoes =
        editando.tipo === "unico"
            ? [{
                id: editando.idUnico || undefined,
                nome: VARIACAO_UNICA,
                estoque: Number($("estoqueUnico").value || 0)
            }]
            : editando.tamanhos.map(t => ({
                id: t.id,
                cor: String(t.cor).trim(),
                nome: String(t.nome).trim(),
                estoque: Number(t.estoque || 0)
            }));

    return {
        nome: texto("nome"),
        descricao: texto("descricao"),
        preco: texto("preco"),
        preco_antigo: texto("precoAntigo"),
        categoria: $("categoria").value,
        ativo: $("ativo").checked,
        destaque: $("destaque").checked,
        peso: texto("peso"),
        largura: texto("largura"),
        altura: texto("altura"),
        comprimento: texto("comprimento"),
        imagens: editando.fotos,
        variacoes
    };
}

async function salvar(evento) {

    evento.preventDefault();

    $("erroForm").textContent = "";

    document
        .querySelectorAll("#formProduto .invalido")
        .forEach(c => c.classList.remove("invalido"));

    const dados = coletar();

    if (dados.nome.length < 3) {
        $("nome").classList.add("invalido");
        $("nome").focus();
        $("erroForm").textContent = "Informe o nome do produto (mínimo 3 letras).";
        return;
    }

    if (editando.tipo === "tamanhos" && dados.variacoes.length === 0) {
        $("erroForm").textContent = "Adicione ao menos uma variação ou escolha \"Sem variação\".";
        return;
    }

    if (editando.tipo === "tamanhos" && dados.variacoes.some(v => !v.cor && !v.nome)) {
        $("erroForm").textContent = "Preencha a cor ou o tamanho de cada linha (ou remova a linha vazia).";
        return;
    }

    const botao = $("btnSalvar");
    botao.disabled = true;
    botao.textContent = "Salvando...";

    try {

        if (editando.id) {
            await api("PUT", `/api/admin/produtos/${editando.id}`, dados);
        } else {
            await api("POST", "/api/admin/produtos", dados);
        }

        const eraNovo = !editando.id;

        fecharEditor();
        await carregarLista();

        toast(eraNovo ? "Produto cadastrado ✓" : "Alterações salvas ✓");

    } catch (erro) {
        $("erroForm").textContent = erro.message;
    } finally {
        botao.disabled = false;
        botao.textContent = "Salvar";
    }
}

async function excluir() {

    if (!editando || !editando.id) return;

    if (!confirm("Excluir este produto definitivamente?")) return;

    try {

        await api("DELETE", `/api/admin/produtos/${editando.id}`);

        fecharEditor();
        await carregarLista();

        toast("Produto excluído");

    } catch (erro) {
        $("erroForm").textContent = erro.message;
    }
}

// ---------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------

$("btnNovo").addEventListener("click", () => abrirEditor(null));
$("btnFechar").addEventListener("click", fecharEditor);
$("btnCancelar").addEventListener("click", fecharEditor);
$("btnExcluir").addEventListener("click", excluir);
$("formProduto").addEventListener("submit", salvar);

// Clicar fora da janela fecha
$("editor").addEventListener("click", e => {
    if (e.target === $("editor")) fecharEditor();
});

$("busca").addEventListener("input", renderizarLista);
$("filtro").addEventListener("change", renderizarLista);
$("filtroCategoria").addEventListener("change", renderizarLista);
$("ordem").addEventListener("change", renderizarLista);
$("btnLimparFiltros").addEventListener("click", limparFiltros);

$("arquivoFoto").addEventListener("change", async e => {
    const arquivos = e.target.files;
    if (arquivos.length > 0) await enviarFotos(arquivos);
    e.target.value = "";
});

document.querySelectorAll('input[name="tipo"]').forEach(radio =>
    radio.addEventListener("change", () => {
        editando.tipo = radio.value;
        atualizarTipo();
    })
);

document.querySelectorAll(".adm-preset").forEach(botao =>
    botao.addEventListener("click", () =>
        botao.setAttribute("aria-pressed", String(botao.getAttribute("aria-pressed") !== "true"))
    )
);

$("btnGerar").addEventListener("click", gerarCombinacoes);
$("btnAddLinha").addEventListener("click", adicionarLinha);

// Enter no campo de cores cria as combinações (em vez de tentar salvar o produto)
[$("gerarCores"), $("gerarOutrosTam")].forEach(campo =>
    campo.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            e.preventDefault();
            gerarCombinacoes();
        }
    })
);

$("btnSair").addEventListener("click", async () => {
    await fetch("/api/admin-logout", { method: "POST", cache: "no-store" }).catch(() => {});
    window.location.href = "/admin.html?saiu=1";
});

// ---------------------------------------------------------------
// Importação de planilha (modelo padrão da loja ou planilha da Shopee)
// ---------------------------------------------------------------

let planilhaPayload = null; // { csv } ou { xlsx } (base64)
let previa = null;
let abaImport = "novo";
let importou = false;
let temporizadorPrevia = null;

const ABAS_IMPORT = [
    ["novo", "Novos", "novos"],
    ["atualizar", "Atualizar", "atualizar"],
    ["conferir", "Conferir", "conferir"],
    ["igual", "Sem mudanças", "iguais"],
    ["ignorar", "Ignorados", "ignorados"]
];

const ROTULO_ACAO = {
    novo: "Novo",
    atualizar: "Atualizar",
    conferir: "Conferir",
    igual: "Sem mudanças",
    ignorar: "Ignorado"
};

const modoImport = () =>
    document.querySelector('input[name="modoImport"]:checked')?.value || "modelo";

function opcoesImport() {
    return {
        preco: $("opPreco").checked,
        estoque: $("opEstoque").checked,
        criarTamanhos: $("opTamanhos").checked,
        cadastrarNovos: $("opCadastrar").checked,
        incluirConferir: $("opConferir").checked
    };
}

// Mostra a ajuda e as opções do tipo de planilha escolhido
function atualizarModoImport() {

    const shopee = modoImport() === "shopee";

    $("ajudaModelo").hidden = shopee;
    $("ajudaShopee").hidden = !shopee;
    $("opcoesShopee").hidden = !shopee;
}

// Corpo da requisição de importação
const corpoImport = aplicar => ({
    ...planilhaPayload,
    modo: modoImport(),
    aplicar,
    opcoes: opcoesImport()
});

function reiniciarImportador() {

    planilhaPayload = null;
    previa = null;
    importou = false;

    document.querySelector('input[name="modoImport"][value="modelo"]').checked = true;
    atualizarModoImport();

    $("arquivoPlanilha").value = "";
    $("nomeArquivo").textContent = "";
    $("erroImport").textContent = "";

    $("importEtapa1").hidden = false;
    $("importPrevia").hidden = true;
    $("importResultado").hidden = true;

    $("btnAplicarImport").hidden = false;
    $("btnAplicarImport").disabled = true;
    $("btnAplicarImport").textContent = "Importar";
    $("btnCancelarImport").textContent = "Cancelar";
}

function abrirImportador() {
    reiniciarImportador();
    $("importador").showModal();
}

function paraBase64(buffer) {

    const bytes = new Uint8Array(buffer);
    const passo = 0x8000;
    let texto = "";

    for (let i = 0; i < bytes.length; i += passo) {
        texto += String.fromCharCode.apply(null, bytes.subarray(i, i + passo));
    }

    return btoa(texto);
}

// Lê o arquivo escolhido: .xlsx vai em base64; .csv vai como texto
async function lerArquivoPlanilha(arquivo) {

    if (arquivo.size > 8 * 1024 * 1024) {
        throw new Error("O arquivo é grande demais (máximo 8 MB).");
    }

    const buffer = await arquivo.arrayBuffer();
    const b = new Uint8Array(buffer.slice(0, 4));

    // "PK" = zip, que é como o Excel (.xlsx) guarda os dados; D0 CF = Excel antigo (.xls)
    const ehZip = b[0] === 0x50 && b[1] === 0x4b;
    const ehXlsAntigo = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

    if (ehZip || ehXlsAntigo || /\.xlsx?$/i.test(arquivo.name)) {
        return { xlsx: paraBase64(buffer) };
    }

    try {
        return { csv: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
    } catch {
        // CSV salvo pelo Excel em português costuma vir em Windows-1252
        return { csv: new TextDecoder("windows-1252").decode(buffer) };
    }
}

async function analisarPlanilha() {

    if (!planilhaPayload) return;

    $("erroImport").textContent = "";
    $("btnAplicarImport").disabled = true;

    try {

        previa = await api("POST", "/api/admin/importar", corpoImport(false));

    } catch (erro) {
        previa = null;
        $("importPrevia").hidden = true;
        $("erroImport").textContent = erro.message;
        $("erroImport").scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
    }

    // abre na aba "Conferir" quando há algo suspeito; senão, na primeira aba com itens
    abaImport = previa.resumo.conferir > 0
        ? "conferir"
        : (ABAS_IMPORT.find(([, , chave]) => previa.resumo[chave] > 0) || ABAS_IMPORT[0])[0];

    renderizarPrevia();

    // a ajuda do passo 1 é longa: leva a janela até a prévia
    $("importPrevia").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderizarPrevia() {

    $("importPrevia").hidden = false;

    const avisos = $("avisosImport");
    avisos.replaceChildren();

    previa.avisos.forEach(texto => avisos.appendChild(el("p", "adm-aviso-info", "ℹ " + texto)));

    const abas = $("abasImport");
    abas.replaceChildren();

    ABAS_IMPORT.forEach(([acao, nome, chave]) => {

        const botao = el("button", "adm-chip");
        botao.type = "button";
        botao.setAttribute("aria-pressed", String(acao === abaImport));
        botao.append(document.createTextNode(nome + " "), el("b", null, String(previa.resumo[chave])));

        botao.addEventListener("click", () => {
            abaImport = acao;
            renderizarPrevia();
        });

        abas.appendChild(botao);
    });

    const itens = previa.itens.filter(i => i.acao === abaImport);
    const LIMITE = 300;

    const area = $("tabelaImport");
    area.replaceChildren();

    if (itens.length === 0) {
        area.appendChild(el("p", "adm-vazio", "Nenhum produto nesta situação."));
    } else {

        const tabela = el("table");
        const cabecalho = el("tr");

        ["Linha", "ID", "Produto (planilha)", "Situação", "O que acontece"].forEach(t => cabecalho.appendChild(el("th", null, t)));
        tabela.appendChild(el("thead")).appendChild(cabecalho);

        const corpo = el("tbody");

        itens.slice(0, LIMITE).forEach(i => {

            const linha = el("tr");

            let detalhe = "";

            if (i.acao === "novo") {
                detalhe = "Será cadastrado" + (i.categoria ? ` em ${nomeCategoria(i.categoria)}` : "");
            } else if (i.acao === "conferir") {
                detalhe = "Não será alterado. Na loja este ID é: " + i.nomeAtual;
            } else if (i.acao === "atualizar") {
                detalhe = "Muda: " + i.mudancas.join(", ") + (i.nomeAtual ? `. Na loja: ${i.nomeAtual}` : "");
            } else if (i.acao === "ignorar") {
                detalhe = i.motivo || "";
            } else {
                detalhe = "Já está igual";
            }

            const celulaDetalhe = el("td", null, detalhe);

            (i.notas || []).forEach(nota => celulaDetalhe.appendChild(el("span", "fx-sub adm-nota", "⚠ " + nota)));

            const situacao = el("td");
            const classeTag = i.acao === "ignorar" ? "erro" : i.acao === "conferir" ? "alerta" : "";
            situacao.appendChild(el("span", `adm-tag ${classeTag}`.trim(), ROTULO_ACAO[i.acao]));

            const celulaId = el("td");
            celulaId.appendChild(i.id ? el("span", "adm-id", String(i.id)) : document.createTextNode("-"));

            linha.append(
                el("td", null, String(i.linha)),
                celulaId,
                el("td", "adm-col-nome", i.nome || "-"),
                situacao,
                celulaDetalhe
            );

            corpo.appendChild(linha);
        });

        tabela.appendChild(corpo);
        area.appendChild(tabela);

        if (itens.length > LIMITE) {
            area.appendChild(el("p", "fx-sub", `Mostrando os primeiros ${LIMITE} de ${itens.length}.`));
        }
    }

    const total = previa.resumo.novos + previa.resumo.atualizar;
    const botao = $("btnAplicarImport");

    botao.disabled = total === 0;
    botao.textContent = total === 0
        ? "Nada para importar"
        : `Importar ${total} ${total === 1 ? "produto" : "produtos"}`;
}

async function aplicarImportacao() {

    const botao = $("btnAplicarImport");

    botao.disabled = true;
    botao.textContent = "Importando...";
    $("erroImport").textContent = "";

    try {

        const resultado = await api("POST", "/api/admin/importar", corpoImport(true));

        importou = true;
        mostrarResultado(resultado);

    } catch (erro) {
        $("erroImport").textContent = erro.message;
        renderizarPrevia();
    }
}

function mostrarResultado(r) {

    $("importEtapa1").hidden = true;
    $("importPrevia").hidden = true;
    $("btnAplicarImport").hidden = true;
    $("btnCancelarImport").textContent = "Fechar";

    const area = $("importResultado");
    area.hidden = false;
    area.replaceChildren();

    area.appendChild(el("h3", null, "Importação concluída ✓"));

    area.appendChild(el("p", null, `${r.criados} ${r.criados === 1 ? "produto cadastrado" : "produtos cadastrados"}`));
    area.appendChild(el("p", null, `${r.atualizados} ${r.atualizados === 1 ? "produto atualizado" : "produtos atualizados"}`));

    if (r.ocultos > 0) {
        area.appendChild(el(
            "p",
            "adm-aviso-info",
            `ℹ ${r.ocultos} ${r.ocultos === 1 ? "produto novo ficou oculto" : "produtos novos ficaram ocultos"} ` +
            "porque faltam dados (foto ou preço). Complete o cadastro de cada um na lista e ative para mostrar na loja."
        ));
    } else if (r.ocultos === undefined && r.criados > 0 && !previa.colunas.preco) {
        area.appendChild(el(
            "p",
            "adm-aviso-info",
            'ℹ Os produtos novos ficaram ocultos porque a planilha não tem preço. ' +
            'Na lista, use o filtro "Sem preço" para definir o preço e mostrar cada um na loja.'
        ));
    }

    if (r.falhas.length > 0) {

        area.appendChild(el("p", "adm-tag erro", `${r.falhas.length} com erro`));

        r.falhas.slice(0, 20).forEach(f =>
            area.appendChild(el("p", "fx-sub", `${f.nome || f.id}: ${f.motivo}`))
        );
    }
}

function fecharImportador() {
    $("importador").close();
}

$("btnImportar").addEventListener("click", abrirImportador);
$("btnFecharImport").addEventListener("click", fecharImportador);
$("btnCancelarImport").addEventListener("click", fecharImportador);
$("btnAplicarImport").addEventListener("click", aplicarImportacao);

$("importador").addEventListener("close", () => {
    if (importou) {
        importou = false;
        carregarLista();
        toast("Importação concluída ✓");
    }
});

$("importador").addEventListener("click", e => {
    if (e.target === $("importador")) fecharImportador();
});

$("arquivoPlanilha").addEventListener("change", async e => {

    const arquivo = e.target.files[0];

    if (!arquivo) return;

    $("erroImport").textContent = "";
    $("nomeArquivo").textContent = arquivo.name;
    $("importPrevia").hidden = true;

    try {
        planilhaPayload = await lerArquivoPlanilha(arquivo);
    } catch (erro) {
        planilhaPayload = null;
        $("nomeArquivo").textContent = "";
        $("erroImport").textContent = erro.message;
        $("btnAplicarImport").disabled = true;
        e.target.value = "";
        return;
    }

    await analisarPlanilha();
});

// Mudou o tipo de planilha: troca a ajuda e refaz a prévia com o mesmo arquivo
document.querySelectorAll('input[name="modoImport"]').forEach(r =>
    r.addEventListener("change", () => {
        atualizarModoImport();
        $("importPrevia").hidden = true;
        $("btnAplicarImport").disabled = true;
        clearTimeout(temporizadorPrevia);
        if (planilhaPayload) temporizadorPrevia = setTimeout(analisarPlanilha, 250);
    })
);

// Mudou uma opção: refaz a prévia com a mesma planilha
["opPreco", "opEstoque", "opTamanhos", "opCadastrar", "opConferir"].forEach(id =>
    $(id).addEventListener("change", () => {
        clearTimeout(temporizadorPrevia);
        temporizadorPrevia = setTimeout(analisarPlanilha, 250);
    })
);

// ---------------------------------------------------------------
// Gerenciador de categorias (criar, renomear, ordenar e excluir)
// ---------------------------------------------------------------

let categoriasAdmin = []; // [{ id, nome, produtos }]

async function carregarCategoriasAdmin() {

    try {
        categoriasAdmin = await api("GET", "/api/admin/categorias");
        $("erroCats").textContent = "";
    } catch (erro) {
        $("erroCats").textContent = erro.message;
        return;
    }

    renderizarCategoriasAdmin();
}

// Depois de qualquer mudança: atualiza os seletores e a lista de produtos
async function atualizarAposCategorias() {
    await carregarCategorias();
    await carregarLista();
    await carregarCategoriasAdmin();
}

function renderizarCategoriasAdmin() {

    const area = $("listaCats");
    area.replaceChildren();

    if (categoriasAdmin.length === 0) {
        area.appendChild(el("p", "adm-vazio", "Nenhuma categoria ainda. Crie a primeira acima."));
        return;
    }

    categoriasAdmin.forEach((c, i) => {

        const linha = el("div", "adm-cat-linha");

        const nome = document.createElement("input");
        nome.className = "adm-cat-nome";
        nome.value = c.nome;
        nome.maxLength = 40;
        nome.setAttribute("aria-label", `Nome da categoria ${c.nome}`);

        // Salva ao sair do campo ou apertar Enter
        const salvarNome = async () => {

            const novo = nome.value.trim();

            if (novo === c.nome) return;

            if (novo.length < 2) {
                nome.value = c.nome;
                toast("O nome precisa ter ao menos 2 letras", true);
                return;
            }

            try {
                await api("PUT", `/api/admin/categorias/${encodeURIComponent(c.id)}`, { nome: novo });
                toast("Categoria renomeada ✓");
                await atualizarAposCategorias();
            } catch (erro) {
                nome.value = c.nome;
                toast(erro.message, true);
            }
        };

        nome.addEventListener("change", salvarNome);
        nome.addEventListener("keydown", e => {
            if (e.key === "Enter") {
                e.preventDefault();
                nome.blur();
            }
            if (e.key === "Escape") {
                nome.value = c.nome;
            }
        });

        const qtd = el(
            "span",
            "fx-sub adm-cat-qtd",
            c.produtos === 1 ? "1 produto" : `${c.produtos} produtos`
        );

        const mover = (rotulo, simbolo, delta) => {

            const b = el("button", null, simbolo);
            b.type = "button";
            b.setAttribute("aria-label", `${rotulo} a categoria ${c.nome}`);
            b.disabled = i + delta < 0 || i + delta >= categoriasAdmin.length;

            b.addEventListener("click", async () => {

                const ids = categoriasAdmin.map(x => x.id);
                [ids[i], ids[i + delta]] = [ids[i + delta], ids[i]];

                try {
                    await api("PUT", "/api/admin/categorias/ordem", { ids });
                    await atualizarAposCategorias();
                } catch (erro) {
                    toast(erro.message, true);
                }
            });

            return b;
        };

        const excluir = el("button", "excluir", "✕");
        excluir.type = "button";
        excluir.setAttribute("aria-label", `Excluir a categoria ${c.nome}`);

        excluir.addEventListener("click", async () => {

            const aviso = c.produtos > 0
                ? `Excluir a categoria "${c.nome}"?\n\n` +
                  `Os ${c.produtos} ${c.produtos === 1 ? "produto continua" : "produtos continuam"} na loja, ` +
                  "mas ficam sem categoria."
                : `Excluir a categoria "${c.nome}"?`;

            if (!confirm(aviso)) return;

            try {
                await api("DELETE", `/api/admin/categorias/${encodeURIComponent(c.id)}`);
                toast("Categoria excluída");
                await atualizarAposCategorias();
            } catch (erro) {
                toast(erro.message, true);
            }
        });

        linha.append(nome, qtd, mover("Subir", "▲", -1), mover("Descer", "▼", 1), excluir);
        area.appendChild(linha);
    });
}

async function abrirCategorias() {

    $("erroCats").textContent = "";
    $("novaCategoria").value = "";

    await carregarCategoriasAdmin();

    $("gerCategorias").showModal();
    $("novaCategoria").focus();
}

$("btnCategorias").addEventListener("click", abrirCategorias);
$("btnGerirCatEditor").addEventListener("click", abrirCategorias);
$("btnFecharCats").addEventListener("click", () => $("gerCategorias").close());
$("btnConcluirCats").addEventListener("click", () => $("gerCategorias").close());

$("gerCategorias").addEventListener("click", e => {
    if (e.target === $("gerCategorias")) $("gerCategorias").close();
});

$("formNovaCategoria").addEventListener("submit", async e => {

    e.preventDefault();

    const nome = $("novaCategoria").value.trim();

    if (nome.length < 2) {
        $("erroCats").textContent = "Informe o nome da categoria (mínimo 2 letras).";
        $("novaCategoria").focus();
        return;
    }

    $("erroCats").textContent = "";

    const botao = $("btnAddCategoria");
    botao.disabled = true;

    try {
        await api("POST", "/api/admin/categorias", { nome });
        $("novaCategoria").value = "";
        toast("Categoria criada ✓");
        await atualizarAposCategorias();
        $("novaCategoria").focus();
    } catch (erro) {
        $("erroCats").textContent = erro.message;
    } finally {
        botao.disabled = false;
    }
});

carregarCategorias().then(carregarLista);
