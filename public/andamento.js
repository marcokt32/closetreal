// Linha do tempo do pedido. Recebe o "andamento" calculado pelo servidor:
// { cancelado, passos: [{ chave, titulo, detalhe, estado: feito|atual|pendente|cancelado, data }] }
// Usa el() do loja-carrinho.js.

// O banco guarda a data em UTC ("2026-10-20 14:30:00")
function dataHoraBr(texto) {

    if (!texto) return "";

    const d = new Date(String(texto).replace(" ", "T") + "Z");

    if (Number.isNaN(d.getTime())) return "";

    return d.toLocaleString("pt-BR", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit"
    }).replace(",", " ·");
}

function desenharAndamento(andamento, codigoRastreio) {

    const lista = el("ol", "pr-passos");

    andamento.passos.forEach((passo, i) => {

        const item = el("li", passo.estado);

        const simbolo = passo.estado === "feito" ? "✓" : passo.estado === "cancelado" ? "✕" : String(i + 1);
        const bolinha = el("span", "bolinha", simbolo);
        bolinha.setAttribute("aria-hidden", "true");

        const texto = el("div");
        texto.appendChild(el("strong", null, passo.titulo));
        texto.appendChild(el("small", null, passo.detalhe));

        if (passo.data) {
            texto.appendChild(el("small", "pr-quando", dataHoraBr(passo.data)));
        }

        if (passo.chave === "em_transito" && passo.estado !== "pendente" && codigoRastreio) {

            const codigo = el("small", null, `Código de rastreio: ${codigoRastreio} · `);

            const link = el("a", "pr-passo-link", "Rastrear");
            link.href = `https://melhorrastreio.com.br/rastreio/${encodeURIComponent(codigoRastreio)}`;
            link.target = "_blank";
            link.rel = "noopener";

            codigo.appendChild(link);
            texto.appendChild(codigo);
        }

        if (passo.estado === "feito") item.setAttribute("aria-label", `${passo.titulo}: concluído`);
        if (passo.estado === "atual") item.setAttribute("aria-current", "step");

        item.append(bolinha, texto);
        lista.appendChild(item);
    });

    return lista;
}
