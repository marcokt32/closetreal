// Funções compartilhadas pelo carrinho e pelo checkout.
// Cada item do carrinho é { id: produto, variacao: tamanho, qtd }.

const MAX_QTD = 10; // mesmo limite por item que o servidor aplica
const VARIACAO_UNICA = "Único";

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

function salvarCarrinho(carrinho) {
    localStorage.setItem("carrinho", JSON.stringify(carrinho));
}

function atualizarContador() {
    const total = lerCarrinho().reduce((soma, i) => soma + i.qtd, 0);
    const contador = document.getElementById("contadorCarrinho");
    if (contador) contador.textContent = total;
}

// Texto do tamanho ("" quando o produto não tem tamanhos)
function tamanhoDe(variacao) {
    return variacao && variacao.nome !== VARIACAO_UNICA ? variacao.nome : "";
}

// Texto da cor ("" quando o produto não tem cores)
function corDe(variacao) {
    return variacao && variacao.cor ? variacao.cor : "";
}

// "Azul · M", "M", "Azul" ou "" conforme o que o produto tem
function opcaoDe(variacao) {
    return [corDe(variacao), tamanhoDe(variacao)].filter(Boolean).join(" · ");
}

// Confere o carrinho com o catálogo atual: tira o que saiu da loja ou esgotou,
// acerta quantidades acima do estoque e converte carrinhos antigos (sem tamanho).
function normalizarCarrinho(produtos) {

    const original = lerCarrinho();
    const validos = [];
    let removidos = 0;

    for (const bruto of original) {

        const produto = produtos.find(p => p.id === bruto.id);

        if (!produto) {
            removidos++;
            continue;
        }

        let variacao = produto.variacoes.find(v => v.id === bruto.variacao);

        if (!variacao && !bruto.variacao && produto.variacoes.length === 1) {
            variacao = produto.variacoes[0];
        }

        if (!variacao || variacao.estoque < 1) {
            removidos++;
            continue;
        }

        const maximo = Math.min(MAX_QTD, variacao.estoque);
        const qtd = Math.max(1, Math.min(maximo, Number(bruto.qtd) || 1));

        const repetido = validos.find(i => i.variacao === variacao.id);

        if (repetido) {
            repetido.qtd = Math.min(maximo, repetido.qtd + qtd);
        } else {
            validos.push({ id: produto.id, variacao: variacao.id, qtd });
        }
    }

    if (JSON.stringify(validos) !== JSON.stringify(original)) {
        salvarCarrinho(validos);
    }

    return { carrinho: validos, removidos };
}
