// Página "pedido recebido": o cliente volta do Mercado Pago para cá.
// A situação mostrada vem SEMPRE do nosso servidor (nunca dos parâmetros do endereço).
// Se o pagamento ainda não foi confirmado, a página consulta de novo a cada poucos segundos.

const params = new URLSearchParams(location.search);
const pedidoId = params.get("pedido");
const token = params.get("t");
const retorno = params.get("retorno") || "";

// Número do pagamento que o Mercado Pago coloca no link de volta (serve só para o servidor conferir lá)
const pagamentoId = (params.get("payment_id") || params.get("collection_id") || "").replace(/\D/g, "");

const PAGOS = ["pago", "em_separacao", "em_transito", "entregue"];

const INTERVALO_MS = 4000;
const MAX_TENTATIVAS = 45; // ~3 minutos

const raiz = document.getElementById("conteudo");

let ultimoStatus = null;
let ultimaAssinatura = null;
let tentativas = 0;
let desistiu = false;
let temporizador = null;

atualizarContador();

// ---------- carrinho: o pedido já foi criado, então o carrinho não deve ficar cheio ----------

function limparCarrinhoUmaVez(pedido) {

    if (retorno === "falha" || pedido.status === "cancelado") return;

    // Só uma vez por pedido: reabrir este link depois não pode esvaziar um carrinho novo
    if (localStorage.getItem("pedidoLimpo") === String(pedido.id)) return;

    localStorage.removeItem("carrinho");
    localStorage.setItem("pedidoLimpo", String(pedido.id));

    atualizarContador();
}

// ---------- montagem da tela ----------

function situacaoDe(pedido) {

    if (PAGOS.includes(pedido.status)) return "confirmado";
    if (pedido.status === "cancelado") return "recusado";

    return "aguardando";
}

function montarCartaoSituacao(pedido) {

    const situacao = situacaoDe(pedido);
    const nome = pedido.primeiro_nome ? `, ${pedido.primeiro_nome}` : "";

    const cartao = el("section", "fx-card pr-situacao");
    cartao.setAttribute("aria-live", "polite");

    const icone = el("div", "pr-icone");
    const titulo = el("h1");
    const texto = el("p");

    if (situacao === "confirmado") {

        cartao.classList.add("ok");
        icone.textContent = "✓";
        titulo.textContent = "Pedido recebido!";
        texto.textContent = `Obrigada pela compra${nome}! Seu pagamento foi confirmado e já vamos separar as suas peças.`;

    } else if (situacao === "recusado") {

        cartao.classList.add("erro");
        icone.textContent = "!";
        titulo.textContent = "Pagamento não aprovado";
        texto.textContent = "Não conseguimos confirmar o pagamento deste pedido, e nada foi cobrado de você. Você pode tentar novamente com outra forma de pagamento.";

    } else if (desistiu) {

        icone.textContent = "⏳";
        titulo.textContent = "Pedido recebido";
        texto.textContent = "Ainda estamos aguardando a confirmação do pagamento. Pode levar alguns minutos (PIX) ou até 2 dias úteis (boleto). Guarde o número do pedido para acompanhar.";

    } else if (retorno === "pendente") {

        icone.textContent = "⏳";
        titulo.textContent = "Pedido recebido, aguardando pagamento";
        texto.textContent = "Assim que o pagamento for confirmado, esta página mostra a novidade. PIX costuma confirmar em minutos; boleto pode levar até 2 dias úteis.";

    } else {

        icone.className = "pr-icone";
        icone.appendChild(el("div", "pr-giro"));
        titulo.textContent = "Confirmando o seu pagamento...";
        texto.textContent = "Isso leva só alguns segundos. Não feche esta página.";
    }

    cartao.append(icone, titulo, texto);

    // número do pedido
    const numero = el("div", "pr-numero");
    numero.append(el("span", null, "Número do pedido"), el("strong", null, `#${pedido.id}`));

    if (navigator.clipboard) {

        const copiar = el("button", "pr-copiar", "Copiar");
        copiar.type = "button";
        copiar.setAttribute("aria-label", `Copiar o número do pedido ${pedido.id}`);

        copiar.addEventListener("click", async () => {

            try {
                await navigator.clipboard.writeText(String(pedido.id));
                copiar.textContent = "Copiado ✓";
            } catch {
                copiar.textContent = "Não foi possível copiar";
            }

            setTimeout(() => { copiar.textContent = "Copiar"; }, 2000);
        });

        numero.appendChild(copiar);
    }

    cartao.appendChild(numero);

    if (situacao !== "recusado") {
        cartao.appendChild(el(
            "p",
            "pr-dica",
            "Com este número e o e-mail da compra você acompanha o pedido em “Meus pedidos”."
        ));
    }

    // botões
    const acoes = el("div", "pr-acoes");

    if (situacao === "recusado") {

        const temCarrinho = lerCarrinho().length > 0;

        const tentar = el("a", "fx-btn", temCarrinho ? "Voltar ao carrinho" : "Voltar à loja");
        tentar.href = temCarrinho ? "/carrinho.html" : "/";
        acoes.appendChild(tentar);

    } else {

        const acompanhar = el("a", "fx-btn", "Acompanhar meus pedidos");
        acompanhar.href = "/consultar.html";

        const continuar = el("a", "fx-btn fx-btn-sec", "Continuar comprando");
        continuar.href = "/";

        acoes.append(acompanhar, continuar);
    }

    cartao.appendChild(acoes);

    return cartao;
}

function montarPassos(pedido) {

    if (situacaoDe(pedido) === "recusado" || !pedido.andamento) return null;

    const cartao = el("section", "fx-card");
    cartao.appendChild(el("h2", null, "Andamento do pedido"));
    cartao.appendChild(el("p", "fx-sub", "Cada etapa aparece aqui assim que acontece."));
    cartao.appendChild(desenharAndamento(pedido.andamento, pedido.codigo_rastreio));

    return cartao;
}

function montarEntrega(pedido) {

    const e = pedido.entrega;

    const cartao = el("section", "fx-card");
    cartao.appendChild(el("h2", null, "Entrega"));

    const endereco = document.createElement("address");
    endereco.className = "pr-endereco";

    const linha1 = `${e.rua}, ${e.numero}${e.complemento ? ` - ${e.complemento}` : ""}`;

    endereco.append(
        document.createTextNode(linha1),
        document.createElement("br"),
        document.createTextNode(`${e.bairro} - ${e.cidade}/${e.estado}`),
        document.createElement("br"),
        document.createTextNode(`CEP ${String(e.cep || "").replace(/^(\d{5})(\d{3})$/, "$1-$2")}`)
    );

    cartao.appendChild(endereco);

    if (pedido.transportadora) {
        cartao.appendChild(el("p", "fx-sub", `Envio: ${pedido.transportadora}`));
    }

    if (pedido.codigo_rastreio) {

        const bloco = el("div", "pr-rastreio");
        bloco.appendChild(el("p", null, `Código de rastreio: ${pedido.codigo_rastreio}`));

        const link = el("a", "fx-link", "Rastrear a encomenda");
        link.href = `https://melhorrastreio.com.br/rastreio/${encodeURIComponent(pedido.codigo_rastreio)}`;
        link.target = "_blank";
        link.rel = "noopener";

        bloco.appendChild(link);
        cartao.appendChild(bloco);
    }

    return cartao;
}

function montarResumo(pedido) {

    const resumo = el("aside", "fx-resumo");
    resumo.appendChild(el("h2", null, "Resumo do pedido"));

    let subtotal = 0;

    pedido.itens.forEach(item => {

        const total = item.preco * item.quantidade;
        subtotal += total;

        const linha = el("div", "pr-item");
        linha.append(
            el("span", "pr-item-nome", item.nome),
            el("span", "pr-item-det", [item.variacao, `Qtd: ${item.quantidade}`].filter(Boolean).join(" · ")),
            el("span", "pr-item-preco", brl(total))
        );

        resumo.appendChild(linha);
    });

    const frete = el("div", "fx-linha");
    frete.append(el("span", null, "Frete"), el("span", null, pedido.valor_frete > 0 ? brl(pedido.valor_frete) : "Grátis"));

    const produtos = el("div", "fx-linha");
    produtos.append(el("span", null, "Produtos"), el("span", null, brl(subtotal)));

    const total = el("div", "fx-linha fx-total");
    total.append(el("span", null, "Total"), el("strong", null, brl(pedido.total)));

    const hr = el("hr", "fx-div");

    resumo.append(hr, produtos, frete, total);

    return resumo;
}

function desenhar(pedido) {

    const grid = el("div", "fx-grid");
    const coluna = el("div", "fx-coluna");

    coluna.appendChild(montarCartaoSituacao(pedido));

    const passos = montarPassos(pedido);
    if (passos) coluna.appendChild(passos);

    coluna.appendChild(montarEntrega(pedido));

    grid.append(coluna, montarResumo(pedido));

    raiz.replaceChildren(grid);

    document.title = `Pedido #${pedido.id} | Closet Real`;
}

function desenharErro(mensagem) {

    const cartao = el("section", "fx-card pr-situacao erro");

    const icone = el("div", "pr-icone", "?");
    const titulo = el("h1", null, "Não encontramos este pedido");
    const texto = el("p", null, mensagem);

    const acoes = el("div", "pr-acoes");

    const consultar = el("a", "fx-btn", "Consultar meus pedidos");
    consultar.href = "/consultar.html";

    const inicio = el("a", "fx-btn fx-btn-sec", "Voltar à loja");
    inicio.href = "/";

    acoes.append(consultar, inicio);
    cartao.append(icone, titulo, texto, acoes);

    raiz.replaceChildren(cartao);
}

// ---------- consulta ao servidor ----------

async function buscar() {

    const resposta = await fetch(
        `/api/pedido-recebido/${encodeURIComponent(pedidoId)}?t=${encodeURIComponent(token)}` +
        (pagamentoId ? `&payment_id=${encodeURIComponent(pagamentoId)}` : ""),
        { cache: "no-store" }
    );

    if (resposta.status === 404) {
        const erro = new Error("nao-encontrado");
        erro.naoEncontrado = true;
        throw erro;
    }

    if (!resposta.ok) throw new Error("falha");

    return resposta.json();
}

async function carregar() {

    if (!pedidoId || !token) {
        desenharErro("O link está incompleto. Use o número do pedido e o e-mail da compra para consultar.");
        return;
    }

    let pedido;

    try {
        pedido = await buscar();
    } catch (erro) {

        if (erro.naoEncontrado) {
            desenharErro("Confira se o link está completo. Você também pode consultar o pedido com o número e o e-mail da compra.");
            return;
        }

        // falha de rede: tenta de novo sem derrubar a tela
        if (++tentativas < MAX_TENTATIVAS) temporizador = setTimeout(carregar, INTERVALO_MS);
        else desenharErro("Não conseguimos carregar o pedido agora. Tente de novo em instantes.");

        return;
    }

    limparCarrinhoUmaVez(pedido);

    const assinatura = JSON.stringify([pedido.status, pedido.codigo_rastreio, pedido.andamento]);

    if (assinatura !== ultimaAssinatura) {
        ultimoStatus = pedido.status;
        ultimaAssinatura = assinatura;
        desenhar(pedido);
    }

    // Aguardando: continua consultando até confirmar (ou até desistir depois de ~3 minutos)
    if (situacaoDe(pedido) === "aguardando" && !desistiu) {

        if (++tentativas >= MAX_TENTATIVAS) {
            desistiu = true;
            desenhar(pedido);
            return;
        }

        temporizador = setTimeout(carregar, INTERVALO_MS);
    }
}

// Ao voltar para a aba, consulta na hora
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && situacaoDe({ status: ultimoStatus || "aguardando_pagamento" }) === "aguardando" && !desistiu) {
        clearTimeout(temporizador);
        carregar();
    }
});

carregar();
