let pedidos = [];
let filtroStatus = "todos";

const normalizar = texto =>
    String(texto || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

async function carregar() {

    try {
        pedidos = await api("GET", "/api/pedidos");
        $("erroLista").textContent = "";
    } catch (erro) {
        $("erroLista").textContent = erro.message;
        return;
    }

    renderizarChips();
    renderizarLista();
}

function renderizarChips() {

    const area = $("chipsStatus");
    area.replaceChildren();

    const contagem = {};

    pedidos.forEach(p => {
        contagem[p.status] = (contagem[p.status] || 0) + 1;
    });

    const opcoes = [["todos", "Todos", pedidos.length]];

    Object.keys(STATUS).forEach(chave => {
        if (contagem[chave]) opcoes.push([chave, STATUS[chave].nome, contagem[chave]]);
    });

    // se o filtro escolhido ficou sem pedidos, volta para "todos"
    if (!opcoes.some(o => o[0] === filtroStatus)) filtroStatus = "todos";

    opcoes.forEach(([chave, nome, total]) => {

        const botao = el("button", "adm-chip");
        botao.type = "button";
        botao.setAttribute("aria-pressed", String(chave === filtroStatus));
        botao.append(document.createTextNode(nome + " "), el("b", null, String(total)));

        botao.addEventListener("click", () => {
            filtroStatus = chave;
            renderizarChips();
            renderizarLista();
        });

        area.appendChild(botao);
    });
}

function renderizarLista() {

    const busca = normalizar($("busca").value.trim().replace(/^#/, ""));

    const visiveis = pedidos.filter(p =>
        (filtroStatus === "todos" || p.status === filtroStatus) &&
        (
            !busca ||
            String(p.id) === busca ||
            normalizar(p.cliente).includes(busca) ||
            normalizar(p.email).includes(busca)
        )
    );

    $("contagem").textContent = `${visiveis.length} de ${pedidos.length} pedidos`;

    const lista = $("lista");
    lista.replaceChildren();

    if (visiveis.length === 0) {
        lista.appendChild(
            el("p", "adm-vazio", pedidos.length === 0 ? "Nenhum pedido ainda." : "Nenhum pedido encontrado.")
        );
        return;
    }

    visiveis.forEach(p => lista.appendChild(criarLinha(p)));
}

function criarLinha(p) {

    const linha = el("a", "ped-linha");
    linha.href = `/pedido.html?id=${encodeURIComponent(p.id)}`;

    const numero = el("div");
    numero.append(el("div", "ped-num", `#${p.id}`), el("div", "ped-data", formatarData(p.data_pedido)));

    const info = el("div");

    const itens = Number(p.quantidade_itens) || 0;

    let etiqueta = "";

    if (p.me_etapa === "gerada") etiqueta = " · etiqueta gerada";
    else if (["pago", "em_separacao"].includes(p.status)) etiqueta = " · ⚠ etiqueta pendente";

    info.append(
        el("div", "ped-cliente", p.cliente || "-"),
        el("div", "ped-meta", `${itens} ${itens === 1 ? "item" : "itens"} · ${p.transportadora || "sem transportadora"}${etiqueta}`)
    );

    linha.append(
        numero,
        info,
        etiquetaStatus(p.status),
        el("div", "ped-total", brl(p.total || 0))
    );

    return linha;
}

$("busca").addEventListener("input", renderizarLista);

carregar();
