let produtos = [];

async function carregarCarrinho() {

    try {
        const resposta = await fetch("/api/produtos");
        produtos = await resposta.json();
    } catch {
        produtos = [];
    }

    // Sem catálogo não dá para montar o carrinho — e não podemos apagá-lo por engano
    if (!Array.isArray(produtos) || produtos.length === 0) {
        document.getElementById("erroCarrinho").textContent =
            "Não foi possível carregar o carrinho agora. Atualize a página em instantes.";
        atualizarContador();
        return;
    }

    renderizar();
}

function renderizar() {

    const { carrinho, removidos } = normalizarCarrinho(produtos);

    document.getElementById("erroCarrinho").textContent =
        removidos > 0
            ? "Alguns itens esgotaram ou saíram da loja e foram retirados do carrinho."
            : "";

    atualizarContador();

    const vazio = carrinho.length === 0;

    document.getElementById("vazio").hidden = !vazio;
    document.getElementById("cheio").hidden = vazio;
    document.getElementById("btnLimpar").hidden = vazio;

    if (vazio) return;

    const lista = document.getElementById("listaCarrinho");
    lista.replaceChildren();

    let totalCent = 0;
    let unidades = 0;

    carrinho.forEach(item => {

        const produto = produtos.find(p => p.id === item.id);
        const variacao = produto.variacoes.find(v => v.id === item.variacao);

        const maximo = Math.min(MAX_QTD, variacao.estoque);

        const subtotalCent = Math.round(produto.preco * 100) * item.qtd;

        totalCent += subtotalCent;
        unidades += item.qtd;

        const linha = el("article", "fx-item");

        const img = document.createElement("img");
        img.src = produto.imagem;
        img.alt = produto.nome;
        img.loading = "lazy";

        const info = el("div");

        info.append(el("h2", "fx-item-nome", produto.nome));

        if (corDe(variacao)) {
            info.append(el("p", "fx-item-tam", `Cor: ${corDe(variacao)}`));
        }

        if (tamanhoDe(variacao)) {
            info.append(el("p", "fx-item-tam", `Tamanho: ${tamanhoDe(variacao)}`));
        }

        info.append(el("p", "fx-item-unit", `${brl(produto.preco)} cada`));

        const qtd = el("div", "fx-qtd");
        qtd.setAttribute("role", "group");
        qtd.setAttribute("aria-label", "Quantidade");

        const menos = el("button", null, "−");
        menos.type = "button";
        menos.setAttribute("aria-label", "Diminuir quantidade");
        menos.disabled = item.qtd <= 1;
        menos.addEventListener("click", () => alterarQtd(item.variacao, -1));

        const valor = el("output", null, String(item.qtd));

        const mais = el("button", null, "+");
        mais.type = "button";
        mais.setAttribute("aria-label", "Aumentar quantidade");
        mais.disabled = item.qtd >= maximo;
        mais.addEventListener("click", () => alterarQtd(item.variacao, 1));

        qtd.append(menos, valor, mais);

        const remover = el("button", "fx-remover", "Remover");
        remover.type = "button";
        remover.addEventListener("click", () => removerItem(item.variacao));

        info.append(qtd, remover);

        linha.append(img, info, el("div", "fx-item-sub", brl(subtotalCent / 100)));

        lista.appendChild(linha);
    });

    document.getElementById("rotuloSubtotal").textContent =
        `Subtotal (${unidades} ${unidades === 1 ? "item" : "itens"})`;

    document.getElementById("subtotal").textContent = brl(totalCent / 100);
}

function alterarQtd(variacaoId, delta) {

    const carrinho = lerCarrinho();
    const item = carrinho.find(i => i.variacao === variacaoId);

    if (!item) return;

    item.qtd = Math.max(1, Math.min(MAX_QTD, item.qtd + delta));

    salvarCarrinho(carrinho);
    renderizar();
}

function removerItem(variacaoId) {
    salvarCarrinho(lerCarrinho().filter(item => item.variacao !== variacaoId));
    renderizar();
}

function limparCarrinho() {

    if (!confirm("Remover todos os itens do carrinho?")) return;

    localStorage.removeItem("carrinho");
    renderizar();
}

carregarCarrinho();
