// Estilos dos tamanhos e dos avisos (carregados aqui para a home não precisar mudar)
if (!document.querySelector('link[href^="fluxo.css"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "fluxo.css";
    document.head.appendChild(link);
}

const MAX_QTD = 10; // mesmo limite por item que o servidor aplica

const brl = valor =>
    Number(valor).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL"
    });

function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto;
    return e;
}

function lerCarrinho() {
    try {
        return JSON.parse(localStorage.getItem("carrinho")) || [];
    } catch {
        return [];
    }
}

let temporizadorAviso = null;

function mostrarAviso(texto, erro = false) {

    let aviso = document.getElementById("avisoLoja");

    if (!aviso) {
        aviso = el("div", "fx-toast");
        aviso.id = "avisoLoja";
        aviso.setAttribute("role", "status");
        aviso.setAttribute("aria-live", "polite");
        document.body.appendChild(aviso);
    }

    aviso.textContent = texto;
    aviso.classList.toggle("erro", erro);
    aviso.classList.add("visivel");

    clearTimeout(temporizadorAviso);
    temporizadorAviso = setTimeout(() => aviso.classList.remove("visivel"), 2600);
}

function resumo(texto, limite = 90) {
    const limpo = String(texto || "").trim();
    return limpo.length > limite ? limpo.slice(0, limite).trim() + "…" : limpo;
}

function criarCard(produto) {

    const variacoes = produto.variacoes || [];
    const disponiveis = variacoes.filter(v => v.estoque > 0);

    // Mais de uma cor/tamanho: a escolha é feita no card de detalhes
    const comOpcoes = variacoes.length > 1;

    const card = el("div", "produto");

    const abrir = (conteudo, rotulo) => {

        const link = el("a", "pm-abrir");
        link.href = `#produto-${produto.id}`;

        if (rotulo) link.setAttribute("aria-label", rotulo);

        link.addEventListener("click", evento => {

            // Ctrl/Cmd+clique e botão do meio continuam abrindo em outra aba
            if (evento.ctrlKey || evento.metaKey || evento.shiftKey || evento.button !== 0) return;

            evento.preventDefault();
            abrirProduto(produto);
        });

        link.append(...conteudo);
        return link;
    };

    const imagemBox = el("div", "produto-imagem");
    const img = document.createElement("img");
    img.src = produto.imagem;
    img.alt = produto.nome;
    img.loading = "lazy";
    imagemBox.appendChild(abrir([img], `Ver detalhes de ${produto.nome}`));

    const info = el("div", "produto-info");

    const titulo = el("h3");
    titulo.appendChild(abrir([document.createTextNode(produto.nome)]));

    const preco = el("p", "preco");

    if (emPromocao(produto)) {

        preco.append(
            el("span", "pm-sr", "De "),
            el("s", "preco-antigo", brl(produto.preco_antigo)),
            el("span", "pm-sr", " por "),
            document.createTextNode(` ${brl(produto.preco)}`)
        );

    } else {
        preco.textContent = brl(produto.preco);
    }

    info.append(
        ...(emPromocao(produto)
            ? [el("span", "badge promo", `🏷 ${descontoDe(produto)}% OFF`)]
            : produto.destaque ? [el("span", "badge", "⭐ Destaque")] : []),
        titulo,
        el("p", "descricao", resumo(produto.descricao) || "Produto selecionado com qualidade premium."),
        preco,
        el("p", "parcelamento", "ou 3x sem juros")
    );

    const botaoAdd = el("button", "fx-add");
    botaoAdd.type = "button";

    if (disponiveis.length === 0) {
        botaoAdd.textContent = "Esgotado";
        botaoAdd.disabled = true;
    } else if (comOpcoes) {
        botaoAdd.textContent = "Escolher opções";
    } else {
        botaoAdd.textContent = "🛒 Adicionar ao Carrinho";
    }

    botaoAdd.addEventListener("click", evento => {

        evento.stopPropagation();

        if (comOpcoes) {
            abrirProduto(produto);
            return;
        }

        adicionarCarrinho(produto, disponiveis[0]);
    });

    info.appendChild(botaoAdd);

    // Clicar em qualquer parte do produto abre o card de detalhes
    card.addEventListener("click", evento => {
        if (evento.target.closest("a, button")) return;
        abrirProduto(produto);
    });

    card.append(imagemBox, info);

    return card;
}

// ---------------------------------------------------------------
// Pesquisa e categorias
// ---------------------------------------------------------------

let todosProdutos = [];
let categorias = [];
let filtro = { texto: "", categoria: "todas", colecao: "todas" };

// Coleções do menu: "Novidades" (as peças cadastradas mais recentemente) e "Promoções" (com preço antigo maior que o atual)
const COLECOES = [
    ["destaques", "⭐ Destaques"],
    ["novidades", "✨ Novidades"],
    ["promocoes", "🏷 Promoções"]
];

const QTD_NOVIDADES = 12;

const emPromocao = p => Boolean(p.preco_antigo) && p.preco_antigo > p.preco;
const descontoDe = p => Math.round((1 - p.preco / p.preco_antigo) * 100);

let idsNovidades = new Set();

function calcularNovidades() {

    idsNovidades = new Set(
        [...todosProdutos]
            .sort((a, b) =>
                String(b.criado_em || "").localeCompare(String(a.criado_em || "")) || b.id - a.id
            )
            .slice(0, QTD_NOVIDADES)
            .map(p => p.id)
    );
}

const daColecao = (p, colecao) =>
    colecao === "destaques" ? Boolean(p.destaque)
        : colecao === "novidades" ? idsNovidades.has(p.id)
        : colecao === "promocoes" ? emPromocao(p)
            : true;
let temporizadorBusca = null;

const semAcento = texto =>
    String(texto || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

const nomeCategoria = id => (categorias.find(c => c.id === id) || {}).nome || "";

// Todas as palavras digitadas precisam aparecer no nome, na descrição ou na categoria
function combinaComTexto(produto, palavras) {

    if (palavras.length === 0) return true;

    const alvo = semAcento(`${produto.nome} ${produto.descricao} ${nomeCategoria(produto.categoria)}`);

    return palavras.every(p => alvo.includes(p));
}

function criarBarraDeBusca(catalogo) {

    const barra = el("section", "fx-busca");
    barra.setAttribute("aria-label", "Pesquisar produtos");

    const campo = el("div", "fx-busca-campo");

    const icone = el("span", "fx-busca-icone", "🔍");
    icone.setAttribute("aria-hidden", "true");

    const entrada = document.createElement("input");
    entrada.type = "search";
    entrada.id = "campoBusca";
    entrada.placeholder = "Pesquisar produtos...";
    entrada.autocomplete = "off";
    entrada.enterKeyHint = "search";
    entrada.setAttribute("aria-label", "Pesquisar produtos");
    entrada.value = filtro.texto;

    const limpar = el("button", "fx-busca-limpar", "✕");
    limpar.type = "button";
    limpar.id = "limparBusca";
    limpar.hidden = !filtro.texto;
    limpar.setAttribute("aria-label", "Limpar pesquisa");

    campo.append(icone, entrada, limpar);

    const chips = el("div", "fx-categorias");
    chips.id = "chipsCategorias";
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Categorias");

    const resultado = el("p", "fx-busca-resultado");
    resultado.id = "resultadoBusca";
    resultado.setAttribute("role", "status");
    resultado.setAttribute("aria-live", "polite");

    barra.append(campo, chips, resultado);

    catalogo.before(barra);

    entrada.addEventListener("input", () => {

        limpar.hidden = !entrada.value;

        clearTimeout(temporizadorBusca);

        temporizadorBusca = setTimeout(() => {
            filtro.texto = entrada.value.trim();
            aplicarFiltro();
        }, 150);
    });

    limpar.addEventListener("click", () => {
        entrada.value = "";
        limpar.hidden = true;
        filtro.texto = "";
        aplicarFiltro();
        entrada.focus();
    });
}

function guardarFiltroNaUrl() {

    const params = new URLSearchParams();

    if (filtro.texto) params.set("q", filtro.texto);
    if (filtro.categoria !== "todas") params.set("categoria", filtro.categoria);
    if (filtro.colecao !== "todas") params.set("colecao", filtro.colecao);

    const texto = params.toString();

    history.replaceState(null, "", location.pathname + (texto ? "?" + texto : "") + location.hash);
}

function desenharCategorias(palavras) {

    const area = document.getElementById("chipsCategorias");
    area.replaceChildren();

    // Os números respeitam o que foi digitado na pesquisa
    const doTexto = todosProdutos.filter(p => combinaComTexto(p, palavras));

    const colecoes = COLECOES
        .map(([id, nome]) => [id, nome, doTexto.filter(p => daColecao(p, id)).length, "colecao"])
        .filter(([id, , total]) => total > 0 || filtro.colecao === id);

    const temCategorias = todosProdutos.some(p => p.categoria);

    // Nada para filtrar: não mostra a linha de chips
    if (!temCategorias && colecoes.length === 0) {
        area.hidden = true;
        return;
    }

    area.hidden = false;

    const opcoes = [["todas", "Todas", doTexto.length, "todas"], ...colecoes];

    categorias.forEach(c => {
        const total = doTexto.filter(p => p.categoria === c.id).length;
        const noTotal = todosProdutos.some(p => p.categoria === c.id);
        if (noTotal || filtro.categoria === c.id) opcoes.push([c.id, c.nome, total, "categoria"]);
    });

    opcoes.forEach(([id, nome, total, tipo]) => {

        const ativo =
            tipo === "todas" ? filtro.categoria === "todas" && filtro.colecao === "todas"
                : tipo === "colecao" ? filtro.colecao === id
                    : filtro.categoria === id && filtro.colecao === "todas";

        const botao = el("button", "fx-cat");
        botao.type = "button";
        botao.setAttribute("aria-pressed", String(ativo));
        botao.append(document.createTextNode(nome), el("b", null, String(total)));

        // coleção e categoria não se misturam: escolher uma limpa a outra
        botao.addEventListener("click", () => {
            filtro.categoria = tipo === "categoria" ? id : "todas";
            filtro.colecao = tipo === "colecao" ? id : "todas";
            aplicarFiltro();
        });

        area.appendChild(botao);
    });
}

function aplicarFiltro() {

    const catalogo = document.getElementById("catalogo");

    const palavras = semAcento(filtro.texto).split(/\s+/).filter(Boolean);

    desenharCategorias(palavras);

    const visiveis = todosProdutos.filter(p =>
        combinaComTexto(p, palavras) &&
        (filtro.categoria === "todas" || p.categoria === filtro.categoria) &&
        daColecao(p, filtro.colecao)
    );

    catalogo.replaceChildren();

    const filtrando = palavras.length > 0 || filtro.categoria !== "todas" || filtro.colecao !== "todas";

    // título da vitrine acompanha a coleção escolhida
    const titulo = document.getElementById("tituloCatalogo");
    const subtitulo = document.getElementById("subtituloCatalogo");

    if (titulo && subtitulo) {
        titulo.textContent = filtro.colecao === "destaques" ? "Destaques"
            : filtro.colecao === "novidades" ? "Novidades"
                : filtro.colecao === "promocoes" ? "Promoções" : "Nossos Produtos";
        subtitulo.textContent = filtro.colecao === "destaques" ? "As peças que a gente mais ama"
            : filtro.colecao === "novidades" ? "As últimas peças que chegaram"
                : filtro.colecao === "promocoes" ? "Peças com preço especial" : "Escolha seu modelo favorito";
    }

    document.getElementById("resultadoBusca").textContent = filtrando
        ? `${visiveis.length} ${visiveis.length === 1 ? "produto encontrado" : "produtos encontrados"}`
        : "";

    guardarFiltroNaUrl();

    if (visiveis.length === 0) {

        const vazio = el("div", "fx-sem-resultado");

        if (filtrando) {

            vazio.appendChild(el(
                "p",
                null,
                filtro.texto
                    ? `Nenhum produto encontrado para "${filtro.texto}".`
                    : filtro.colecao === "promocoes"
                        ? "Nenhuma promoção no momento. Volte em breve!"
                        : "Nenhum produto nesta categoria."
            ));

            const limpar = el("button", null, "Ver todos os produtos");
            limpar.type = "button";

            limpar.addEventListener("click", () => {
                filtro = { texto: "", categoria: "todas", colecao: "todas" };
                const entrada = document.getElementById("campoBusca");
                entrada.value = "";
                document.getElementById("limparBusca").hidden = true;
                aplicarFiltro();
            });

            vazio.appendChild(limpar);

        } else {
            vazio.appendChild(el("p", null, "Em breve novidades por aqui."));
        }

        catalogo.appendChild(vazio);
        return;
    }

    desenharPagina(catalogo, visiveis);
}

// ---------------------------------------------------------------
// Paginação: mostra POR_PAGINA produtos e o botão "Ver mais"
// ---------------------------------------------------------------

const POR_PAGINA = 24;

function desenharPagina(catalogo, visiveis) {

    let mostrados = 0;

    const rodape = el("div", "fx-mais");
    const contagem = el("p");
    contagem.setAttribute("role", "status");
    contagem.setAttribute("aria-live", "polite");

    const botao = el("button", null, "Ver mais produtos");
    botao.type = "button";

    rodape.append(contagem, botao);

    const mostrarMais = (moverFoco) => {

        const fim = Math.min(mostrados + POR_PAGINA, visiveis.length);
        const novos = visiveis.slice(mostrados, fim).map(criarCard);

        novos.forEach(card => catalogo.insertBefore(card, rodape));

        mostrados = fim;

        // Quando já está tudo na tela, o botão some e o foco vai para o 1º produto novo
        if (mostrados >= visiveis.length) {
            rodape.remove();
        } else {
            contagem.textContent = `Mostrando ${mostrados} de ${visiveis.length} produtos`;
        }

        if (moverFoco && novos[0]) {
            const alvo = novos[0].querySelector("a, button");
            if (alvo) alvo.focus({ preventScroll: true });
        }
    };

    catalogo.appendChild(rodape);

    botao.addEventListener("click", () => mostrarMais(true));

    mostrarMais(false);
}

async function carregarProdutos() {

    const catalogo = document.getElementById("catalogo");

    try {

        const [respostaProdutos, respostaCategorias] = await Promise.all([
            fetch("/api/produtos"),
            fetch("/api/categorias").catch(() => null)
        ]);

        todosProdutos = await respostaProdutos.json();

        categorias = respostaCategorias && respostaCategorias.ok
            ? await respostaCategorias.json()
            : [];

    } catch {
        todosProdutos = [];
    }

    if (!Array.isArray(todosProdutos)) todosProdutos = [];

    // Pesquisa e categoria podem vir no endereço (ex.: /?q=vestido&categoria=vestidos)
    const params = new URLSearchParams(location.search);

    calcularNovidades();

    filtro = {
        texto: (params.get("q") || "").slice(0, 80),
        categoria: categorias.some(c => c.id === params.get("categoria"))
            ? params.get("categoria")
            : "todas",
        colecao: COLECOES.some(([id]) => id === params.get("colecao"))
            ? params.get("colecao")
            : "todas"
    };

    if (!document.getElementById("campoBusca")) {
        criarBarraDeBusca(catalogo);
    }

    aplicarFiltro();

    if (typeof abrirProdutoDoEndereco === "function") abrirProdutoDoEndereco();
}

// Devolve true quando algo foi adicionado
function adicionarCarrinho(produto, variacao, qtd = 1) {

    const carrinho = lerCarrinho();

    const item = carrinho.find(i => i.variacao === variacao.id);

    const maximo = Math.min(MAX_QTD, variacao.estoque);
    const atual = item ? item.qtd : 0;

    if (atual >= maximo) {
        mostrarAviso("Você já tem a quantidade máxima disponível no carrinho", true);
        return false;
    }

    const nova = Math.min(atual + qtd, maximo);

    if (item) {
        item.qtd = nova;
    } else {
        carrinho.push({ id: produto.id, variacao: variacao.id, qtd: nova });
    }

    localStorage.setItem("carrinho", JSON.stringify(carrinho));

    atualizarContadorCarrinho();

    mostrarAviso(
        nova < atual + qtd
            ? "Adicionamos o máximo disponível em estoque"
            : "Adicionado ao carrinho ✓"
    );

    return true;
}

function verCarrinho() {
    window.location.href = "/carrinho.html";
}

function atualizarContadorCarrinho() {

    const total = lerCarrinho().reduce((soma, item) => soma + item.qtd, 0);

    const contador = document.getElementById("contadorCarrinho");

    if (contador) {
        contador.textContent = total;
    }
}

carregarProdutos();
atualizarContadorCarrinho();