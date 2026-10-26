// "Meus pedidos": consulta por e-mail ou telefone (últimos 3 meses),
// ou por número do pedido + e-mail/telefone (qualquer data).
// Usa el(), brl() e atualizarContador() do loja-carrinho.js.

const STATUS = {
    aguardando_pagamento: ["Aguardando pagamento", ""],
    pendente: ["Aguardando pagamento", ""],
    pago: ["Pagamento confirmado", "ok"],
    em_separacao: ["Em separação", "ok"],
    em_transito: ["Em trânsito", "ok"],
    entregue: ["Entregue", "ok"],
    cancelado: ["Cancelado", "erro"]
};

const porId = id => document.getElementById(id);

atualizarContador();

// o banco guarda a data em UTC ("2026-10-20 14:30:00")
function dataBr(texto) {

    const d = new Date(String(texto || "").replace(" ", "T") + "Z");

    return Number.isNaN(d.getTime())
        ? ""
        : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function montarPedido(pedido, abrirAndamento = false) {

    const cartao = el("article", "cp-pedido");

    const topo = el("div", "cp-topo");
    const titulo = el("div");
    titulo.append(el("h2", null, `Pedido #${pedido.id}`), el("span", "cp-data", dataBr(pedido.data_pedido)));

    const [rotulo, classe] = STATUS[pedido.status] || [pedido.status, ""];
    const selo = el("span", `cp-selo ${classe}`.trim(), rotulo);

    topo.append(titulo, selo);
    cartao.appendChild(topo);

    const lista = el("ul", "cp-itens");

    pedido.itens.forEach(item => {

        const li = el("li");
        const nome = el("span", "cp-item-nome", item.nome);

        nome.appendChild(el("small", null, [item.variacao, `Qtd: ${item.quantidade}`].filter(Boolean).join(" · ")));

        li.append(nome, el("span", "cp-item-preco", brl(item.preco * item.quantidade)));
        lista.appendChild(li);
    });

    cartao.appendChild(lista);

    // andamento: o pedido mais recente já vem aberto
    if (pedido.andamento) {

        const detalhes = el("details", "cp-andamento");
        detalhes.open = abrirAndamento;
        detalhes.appendChild(el("summary", null, "Acompanhar andamento"));
        detalhes.appendChild(desenharAndamento(pedido.andamento, pedido.codigo_rastreio));

        cartao.appendChild(detalhes);
    }

    const valores = el("div", "cp-valores");

    const frete = el("div", "fx-linha");
    frete.append(
        el("span", null, pedido.transportadora ? `Frete (${pedido.transportadora})` : "Frete"),
        el("span", null, pedido.valor_frete > 0 ? brl(pedido.valor_frete) : "Grátis")
    );

    const total = el("div", "fx-linha fx-total");
    total.append(el("span", null, "Total"), el("strong", null, brl(pedido.total)));

    valores.append(frete, total);
    cartao.appendChild(valores);

    if (pedido.codigo_rastreio) {

        const rastreio = el("p", "cp-rastreio", `Código de rastreio: ${pedido.codigo_rastreio} · `);

        const link = el("a", null, "Rastrear a encomenda");
        link.href = `https://melhorrastreio.com.br/rastreio/${encodeURIComponent(pedido.codigo_rastreio)}`;
        link.target = "_blank";
        link.rel = "noopener";

        rastreio.appendChild(link);
        cartao.appendChild(rastreio);
    }

    return cartao;
}

function mostrarResultado(pedidos, porNumero) {

    const area = porId("resultado");
    area.replaceChildren();

    area.appendChild(el(
        "p",
        "cp-resumo",
        porNumero
            ? "Pedido encontrado:"
            : pedidos.length === 1
                ? "1 pedido nos últimos 3 meses:"
                : `${pedidos.length} pedidos nos últimos 3 meses:`
    ));

    pedidos.forEach((p, i) => area.appendChild(montarPedido(p, i === 0)));

    area.focus({ preventScroll: true });
    area.scrollIntoView({ behavior: "smooth", block: "start" });
}

function mostrarVazio(mensagem) {
    const area = porId("resultado");
    area.replaceChildren(el("p", "cp-vazio", mensagem));
}

async function consultar(evento) {

    evento.preventDefault();

    const aviso = porId("avisoConsulta");
    const botao = porId("btnConsultar");

    aviso.textContent = "";

    const contato = porId("contato").value.trim();
    const pedido = porId("pedido").value.trim().replace(/^#/, "");

    if (!contato) {
        aviso.textContent = "Informe o e-mail ou o telefone usado na compra.";
        porId("contato").focus();
        return;
    }

    if (pedido && !/^\d+$/.test(pedido)) {
        aviso.textContent = "O número do pedido deve conter só números.";
        porId("pedido").focus();
        return;
    }

    botao.disabled = true;
    botao.textContent = "Consultando...";
    porId("resultado").replaceChildren();

    try {

        const resposta = await fetch("/api/consultar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contato, pedido })
        });

        const dados = await resposta.json().catch(() => ({}));

        if (resposta.status === 404) {
            mostrarVazio(dados.erro || "Não encontramos pedidos com esses dados.");
            return;
        }

        if (!resposta.ok) {
            aviso.textContent = dados.erro || "Não foi possível consultar agora.";
            return;
        }

        mostrarResultado(dados.pedidos, Boolean(pedido));

    } catch (erro) {
        console.log(erro);
        aviso.textContent = "Não foi possível consultar agora. Tente novamente.";
    } finally {
        botao.disabled = false;
        botao.textContent = "Consultar pedidos";
    }
}

porId("formConsulta").addEventListener("submit", consultar);
