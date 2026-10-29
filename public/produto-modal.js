// ===============================================================
// Card de detalhes do produto: abre ao clicar no produto da vitrine.
// Fotos, descrição, cor e tamanho (com estoque de cada combinação)
// e botão de compra. Usa funções do produtos.js (el, brl, ...).
// ===============================================================

if (!document.querySelector('link[href^="produto-modal.css"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "produto-modal.css";
    document.head.appendChild(link);
}

const VARIACAO_UNICA_LOJA = "Único";

// Nome da cor -> cor do bolinha (só enfeite; o que vale é o nome escrito)
const CORES_CSS = [
    ["azul marinho", "#1f2a52"], ["azul jeans", "#4a6fa5"], ["azul bebe", "#a9cdee"], ["azul claro", "#a9cdee"],
    ["azul royal", "#2146c7"], ["azul turquesa", "#1fb5c4"], ["azul", "#3b6fc9"], ["jeans", "#4a6fa5"],
    ["verde esmeralda", "#0b8a5b"], ["verde militar", "#5b6b3a"], ["verde oliva", "#6b7a3a"],
    ["verde agua", "#9fdcc8"], ["verde menta", "#a8e0c1"], ["verde", "#3f9a5a"],
    ["off white", "#f3ede0"], ["off-white", "#f3ede0"], ["branco", "#ffffff"], ["gelo", "#f1f1ef"], ["cru", "#efe6d2"],
    ["preto", "#1a1a1a"], ["grafite", "#454545"], ["chumbo", "#5a5d63"], ["cinza", "#9a9a9a"], ["prata", "#c4c7cc"],
    ["vermelho", "#c62828"], ["vinho", "#6d1a2e"], ["bordo", "#6d1a2e"], ["marsala", "#7b2d3b"],
    ["coral", "#f2705f"], ["goiaba", "#e8697a"], ["salmao", "#f4a08a"],
    ["rosa choque", "#e8307f"], ["rosa bebe", "#f6c9d6"], ["rosa", "#ee9db5"], ["pink", "#e8307f"], ["rose", "#d99a9f"],
    ["laranja", "#f08a24"], ["terracota", "#c0623a"], ["amarelo", "#f4d03f"], ["mostarda", "#c9981f"], ["dourado", "#c9a227"],
    ["bege", "#d9c3a3"], ["nude", "#e3c3ad"], ["areia", "#dcc9a8"], ["caramelo", "#b5742f"],
    ["marrom", "#6b4a35"], ["chocolate", "#4a2e22"], ["cafe", "#6b4a35"],
    ["roxo", "#6b3fa0"], ["lilas", "#b79ad6"], ["lavanda", "#c7b5e3"], ["violeta", "#7a46b5"], ["uva", "#5b2b6e"]
];

// Em nomes compostos ("Preto / Branco") vale a primeira cor citada
function corCss(nome) {

    const n = semAcento(nome);
    let melhor = null;

    for (const [chave, cor] of CORES_CSS) {

        const pos = n.indexOf(chave);

        if (pos < 0) continue;

        if (!melhor || pos < melhor.pos || (pos === melhor.pos && chave.length > melhor.tam)) {
            melhor = { pos, tam: chave.length, cor };
        }
    }

    return melhor ? melhor.cor : null;
}

let modalAberto = null;

function fecharProduto() {
    if (modalAberto) modalAberto.close();
}

function abrirProduto(produto, { atualizarEndereco = true } = {}) {

    if (!produto) return;

    fecharProduto();

    // ---------- dados ----------
    const todas = produto.variacoes || [];
    const temCor = todas.some(v => v.cor);

    // Sobras de cadastros antigos (sem cor e esgotadas) não aparecem ao lado das cores
    const vars = temCor ? todas.filter(v => v.cor || v.estoque > 0) : todas;

    const cores = [...new Set(vars.map(v => v.cor))];
    const tamanhos = [...new Set(vars.map(v => v.nome))].filter(t => t !== VARIACAO_UNICA_LOJA);
    const temTam = tamanhos.length > 0;

    const fotos = (produto.imagens && produto.imagens.length ? produto.imagens : [produto.imagem]).filter(Boolean);
    const nomeCat = nomeCategoria(produto.categoria);
    const esgotado = !vars.some(v => v.estoque > 0);

    const sel = { cor: null, tam: null, qtd: 1, foto: 0 };

    // Cor e tamanho que sobram quando só existe uma opção: já vêm escolhidos
    const coresComEstoque = cores.filter(c => vars.some(v => v.cor === c && v.estoque > 0));
    const tamsComEstoque = tamanhos.filter(t => vars.some(v => v.nome === t && v.estoque > 0));

    if (temCor && coresComEstoque.length === 1) sel.cor = coresComEstoque[0];
    if (temTam && tamsComEstoque.length === 1) sel.tam = tamsComEstoque[0];

    const achar = () => {

        if (temCor && sel.cor === null) return null;
        if (temTam && sel.tam === null) return null;

        return vars.find(v =>
            (!temCor || v.cor === sel.cor) &&
            (!temTam || v.nome === sel.tam)
        ) || null;
    };

    // ---------- montagem ----------
    const dialogo = document.createElement("dialog");
    dialogo.className = "pm";
    dialogo.setAttribute("aria-labelledby", "pmTitulo");

    const corpo = el("div", "pm-corpo");

    // galeria
    const galeria = el("div", "pm-galeria");
    const areaFoto = el("div", "pm-foto");
    const imgGrande = document.createElement("img");
    imgGrande.alt = produto.nome;
    areaFoto.appendChild(imgGrande);

    const contagem = el("span", "pm-contagem");
    contagem.hidden = fotos.length < 2;

    const botoesMini = [];

    const mostrarFoto = indice => {

        sel.foto = (indice + fotos.length) % fotos.length;
        imgGrande.src = fotos[sel.foto] || "";
        contagem.textContent = `${sel.foto + 1} / ${fotos.length}`;

        botoesMini.forEach((b, i) => {
            if (i === sel.foto) b.setAttribute("aria-current", "true");
            else b.removeAttribute("aria-current");
        });
    };

    if (fotos.length > 1) {

        const ant = el("button", "pm-seta ant", "‹");
        ant.type = "button";
        ant.setAttribute("aria-label", "Foto anterior");
        ant.addEventListener("click", () => mostrarFoto(sel.foto - 1));

        const prox = el("button", "pm-seta prox", "›");
        prox.type = "button";
        prox.setAttribute("aria-label", "Próxima foto");
        prox.addEventListener("click", () => mostrarFoto(sel.foto + 1));

        areaFoto.append(ant, prox);

        // deslizar o dedo para trocar de foto
        let inicioX = null;

        areaFoto.addEventListener("touchstart", e => { inicioX = e.touches[0].clientX; }, { passive: true });

        areaFoto.addEventListener("touchend", e => {

            if (inicioX === null) return;

            const dx = e.changedTouches[0].clientX - inicioX;
            inicioX = null;

            if (Math.abs(dx) > 50) mostrarFoto(sel.foto + (dx < 0 ? 1 : -1));
        }, { passive: true });
    }

    areaFoto.appendChild(contagem);
    galeria.appendChild(areaFoto);

    if (fotos.length > 1) {

        const minis = el("div", "pm-miniaturas");

        fotos.forEach((url, i) => {

            const b = el("button", "pm-mini");
            b.type = "button";
            b.setAttribute("aria-label", `Ver foto ${i + 1}`);

            const mi = document.createElement("img");
            mi.src = url;
            mi.alt = "";
            mi.loading = "lazy";
            b.appendChild(mi);

            b.addEventListener("click", () => mostrarFoto(i));

            botoesMini.push(b);
            minis.appendChild(b);
        });

        galeria.appendChild(minis);
    }

    // informações
    const info = el("div", "pm-info");
    const rolagem = el("div", "pm-rolagem");

    const titulo = el("h2", "pm-titulo", produto.nome);
    titulo.id = "pmTitulo";

    const preco = el("p", "pm-preco");

    if (emPromocao(produto)) {

        const antigo = el("span", "pm-preco-antigo");
        antigo.append(
            el("span", "pm-sr", "De "),
            el("s", null, brl(produto.preco_antigo)),
            el("span", "pm-sr", " por ")
        );

        preco.append(
            antigo,
            document.createTextNode(brl(produto.preco)),
            el("span", "pm-desconto", `${descontoDe(produto)}% OFF`)
        );

    } else {
        preco.textContent = brl(produto.preco);
    }

    preco.appendChild(el("span", "pm-parcela", `ou 3x de ${brl(produto.preco / 3)} sem juros`));

    if (nomeCat) rolagem.appendChild(el("span", "pm-categoria", nomeCat));
    rolagem.append(titulo, preco);

    // opções: cor e tamanho
    const dica = el("p", "pm-dica");
    dica.setAttribute("role", "alert");

    const estoqueMsg = el("p", "pm-estoque");
    estoqueMsg.setAttribute("aria-live", "polite");

    const botoesCor = [];
    const botoesTam = [];

    const criarGrupo = (rotulo, lista, tipo) => {

        const grupo = document.createElement("fieldset");
        grupo.className = "pm-grupo";

        const legenda = document.createElement("legend");
        legenda.className = "pm-rotulo";
        legenda.append(document.createTextNode(rotulo), el("span"));
        grupo.appendChild(legenda);

        const caixa = el("div", "pm-opcoes");
        caixa.setAttribute("role", "radiogroup");
        caixa.setAttribute("aria-label", rotulo);

        lista.forEach(valor => {

            const b = el("button", "pm-opcao");
            b.type = "button";
            b.setAttribute("role", "radio");
            b.setAttribute("aria-checked", "false");
            b.dataset.valor = valor;

            if (tipo === "cor") {

                const ponto = el("span", "pm-ponto");
                const css = valor ? corCss(valor) : null;

                if (css) ponto.style.setProperty("--cor", css);
                else ponto.classList.add("sem");

                ponto.setAttribute("aria-hidden", "true");
                b.append(ponto, document.createTextNode(valor || "Padrão"));

            } else {
                b.textContent = valor;
            }

            b.addEventListener("click", () => {

                dica.textContent = "";

                if (tipo === "cor") sel.cor = sel.cor === valor ? null : valor;
                else sel.tam = sel.tam === valor ? null : valor;

                // a combinação escolhida acabou: solta a outra escolha
                if (sel.cor !== null && sel.tam !== null && !vars.some(v => v.cor === sel.cor && v.nome === sel.tam && v.estoque > 0)) {
                    if (tipo === "cor") sel.tam = null;
                    else sel.cor = null;
                }

                sel.qtd = 1;
                atualizar();
            });

            (tipo === "cor" ? botoesCor : botoesTam).push(b);
            caixa.appendChild(b);
        });

        grupo.appendChild(caixa);
        return grupo;
    };

    if (temCor) rolagem.appendChild(criarGrupo("Cor:", cores, "cor"));
    if (temTam) rolagem.appendChild(criarGrupo("Tamanho:", tamanhos, "tam"));

    rolagem.append(estoqueMsg, dica);

    // descrição em caixa de texto
    const blocoDesc = el("div", "pm-descricao");
    const rotuloDesc = el("p", "pm-rotulo", "Descrição");
    rotuloDesc.id = "pmDescRotulo";

    const caixaDesc = el("div", "pm-desc", (produto.descricao || "").trim() || "Este produto ainda não tem descrição.");
    caixaDesc.tabIndex = 0;
    caixaDesc.setAttribute("role", "region");
    caixaDesc.setAttribute("aria-labelledby", "pmDescRotulo");

    blocoDesc.append(rotuloDesc, caixaDesc);
    rolagem.appendChild(blocoDesc);

    // compra
    const compra = el("div", "pm-compra");

    const qtd = el("div", "pm-qtd");
    const menos = el("button", null, "−");
    menos.type = "button";
    menos.setAttribute("aria-label", "Diminuir quantidade");
    const saida = document.createElement("output");
    saida.setAttribute("aria-live", "polite");
    const mais = el("button", null, "+");
    mais.type = "button";
    mais.setAttribute("aria-label", "Aumentar quantidade");
    qtd.append(menos, saida, mais);

    const botaoAdd = el("button", "pm-add", "🛒 Adicionar ao carrinho");
    botaoAdd.type = "button";

    const irCarrinho = el("a", "pm-carrinho", "Ver meu carrinho →");
    irCarrinho.href = "/carrinho.html";
    irCarrinho.hidden = true;

    compra.append(qtd, botaoAdd, irCarrinho);
    info.append(rolagem, compra);

    const fechar = el("button", "pm-fechar", "✕");
    fechar.type = "button";
    fechar.setAttribute("aria-label", "Fechar");
    fechar.addEventListener("click", fecharProduto);

    corpo.append(galeria, info);
    dialogo.append(fechar, corpo);

    // ---------- estado ----------
    const maximoDe = v => Math.min(MAX_QTD, v ? v.estoque : MAX_QTD);

    function atualizar() {

        const v = achar();

        botoesCor.forEach(b => {

            const cor = b.dataset.valor;
            const tem = vars.some(x => x.cor === cor && x.estoque > 0);

            b.disabled = !tem;
            b.title = tem ? "" : "Esgotado";
            b.setAttribute("aria-checked", String(sel.cor === cor));
        });

        botoesTam.forEach(b => {

            const t = b.dataset.valor;

            const tem = vars.some(x =>
                x.nome === t && x.estoque > 0 && (sel.cor === null || !temCor || x.cor === sel.cor)
            );

            b.disabled = !tem;
            b.title = tem ? "" : (sel.cor !== null && temCor ? "Esgotado nesta cor" : "Esgotado");
            b.setAttribute("aria-checked", String(sel.tam === t));
        });

        const rotulos = dialogo.querySelectorAll(".pm-rotulo span");
        let i = 0;

        if (temCor) rotulos[i++].textContent = sel.cor !== null ? (sel.cor || "Padrão") : "";
        if (temTam) rotulos[i++].textContent = sel.tam !== null ? sel.tam : "";

        // disponibilidade
        estoqueMsg.className = "pm-estoque";

        if (esgotado) {
            estoqueMsg.textContent = "Produto esgotado";
            estoqueMsg.classList.add("fim");
        } else if (v) {
            if (v.estoque <= 3) {
                estoqueMsg.textContent = v.estoque === 1 ? "Última unidade!" : `Últimas ${v.estoque} unidades`;
                estoqueMsg.classList.add("pouco");
            } else {
                estoqueMsg.textContent = "Disponível em estoque";
            }
        } else {
            estoqueMsg.textContent = "";
        }

        // quantidade
        const max = maximoDe(v);
        sel.qtd = Math.max(1, Math.min(sel.qtd, max));
        saida.textContent = sel.qtd;
        menos.disabled = sel.qtd <= 1;
        mais.disabled = !v || sel.qtd >= max;
        qtd.hidden = esgotado;

        botaoAdd.disabled = esgotado;
        botaoAdd.classList.remove("ok");
        botaoAdd.textContent = esgotado ? "Esgotado" : "🛒 Adicionar ao carrinho";
    }

    menos.addEventListener("click", () => { sel.qtd--; atualizar(); });
    mais.addEventListener("click", () => { sel.qtd++; atualizar(); });

    let temporizadorOk = null;

    botaoAdd.addEventListener("click", () => {

        const v = achar();

        if (!v) {

            if (temCor && sel.cor === null && temTam && sel.tam === null) dica.textContent = "Escolha a cor e o tamanho.";
            else if (temCor && sel.cor === null) dica.textContent = "Escolha a cor.";
            else dica.textContent = "Escolha o tamanho.";

            const primeiroVazio = temCor && sel.cor === null ? botoesCor : botoesTam;
            const alvo = primeiroVazio.find(b => !b.disabled);
            if (alvo) alvo.focus();

            return;
        }

        dica.textContent = "";

        if (!adicionarCarrinho(produto, v, sel.qtd)) return;

        botaoAdd.classList.add("ok");
        botaoAdd.textContent = "✓ Adicionado";
        irCarrinho.hidden = false;

        clearTimeout(temporizadorOk);
        temporizadorOk = setTimeout(() => {
            botaoAdd.classList.remove("ok");
            botaoAdd.textContent = "🛒 Adicionar ao carrinho";
        }, 1800);
    });

    // ---------- abrir / fechar ----------
    dialogo.addEventListener("click", e => {
        if (e.target === dialogo) fecharProduto();
    });

    dialogo.addEventListener("keydown", e => {

        if (fotos.length < 2) return;
        if (e.key === "ArrowLeft") { mostrarFoto(sel.foto - 1); e.preventDefault(); }
        if (e.key === "ArrowRight") { mostrarFoto(sel.foto + 1); e.preventDefault(); }
    });

    dialogo.addEventListener("close", () => {

        clearTimeout(temporizadorOk);
        dialogo.remove();
        if (modalAberto === dialogo) modalAberto = null;

        // Só mexe na página se não foi trocado por outro produto
        if (modalAberto !== null) return;

        document.documentElement.style.overflow = "";

        if (/^#produto-\d+$/.test(location.hash)) {
            history.replaceState(null, "", location.pathname + location.search);
        } else if (/^\/produto\/\d+\/?$/.test(location.pathname)) {
            history.replaceState(null, "", "/" + location.search);
        }
    });

    dialogo.dataset.produto = String(produto.id);

    document.body.appendChild(dialogo);
    modalAberto = dialogo;

    document.documentElement.style.overflow = "hidden";

    if (atualizarEndereco && location.hash !== `#produto-${produto.id}`) {
        history.pushState(null, "", `#produto-${produto.id}`);
    }

    mostrarFoto(0);
    atualizar();
    dialogo.showModal();

    // o foco começa na própria janela (sem anel); o primeiro Tab já cai nas opções
    dialogo.tabIndex = -1;
    dialogo.focus();
}

// Endereço da página: /#produto-123 abre direto o produto (e o botão "voltar" fecha o card)
function abrirProdutoDoEndereco() {

    const m = /^#produto-(\d+)$/.exec(location.hash) || /^\/produto\/(\d+)\/?$/.exec(location.pathname);

    if (!m) {
        fecharProduto();
        return;
    }

    const produto = (typeof todosProdutos !== "undefined" ? todosProdutos : []).find(p => p.id === Number(m[1]));

    if (produto && (!modalAberto || modalAberto.dataset.produto !== m[1])) {
        abrirProduto(produto, { atualizarEndereco: false });
    }
}

window.addEventListener("popstate", abrirProdutoDoEndereco);
window.addEventListener("hashchange", abrirProdutoDoEndereco);
