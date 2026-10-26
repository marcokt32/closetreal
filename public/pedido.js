const pedidoId = new URLSearchParams(window.location.search).get("id");

const somenteDigitos = valor => String(valor || "").replace(/\D/g, "");

function formatarTelefone(valor) {

    const d = somenteDigitos(valor);

    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;

    return valor || "-";
}

function formatarCep(valor) {

    const d = somenteDigitos(valor);

    return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : valor || "-";
}

function cartao(titulo, classe) {
    const secao = el("section", `fx-card ${classe || ""}`.trim());
    secao.appendChild(el("h2", null, titulo));
    return secao;
}

function dado(rotulo, valor) {

    const linha = el("div", "ped-dado");
    linha.append(el("span", "ped-rotulo", rotulo));

    if (valor instanceof Node) {
        linha.appendChild(valor);
    } else {
        linha.appendChild(el("span", null, valor || "-"));
    }

    return linha;
}

function campo(rotulo, id, valor, dica) {

    const grupo = el("div", "fx-campo");

    const label = el("label", null, rotulo);
    label.htmlFor = id;

    const entrada = document.createElement("input");
    entrada.id = id;
    entrada.value = valor || "";
    if (dica) entrada.placeholder = dica;

    grupo.append(label, entrada);

    return grupo;
}

async function carregar() {

    let pedido;
    let produtos = [];
    let statusME = null;

    try {

        const [dadosPedido, dadosProdutos, dadosME] = await Promise.all([
            api("GET", `/api/pedido/${encodeURIComponent(pedidoId)}`),
            api("GET", "/api/admin/produtos").catch(() => []),
            api("GET", "/api/admin/melhorenvio/status").catch(() => null)
        ]);

        pedido = dadosPedido;
        produtos = dadosProdutos;
        statusME = dadosME;

    } catch (erro) {
        $("erroPedido").textContent = erro.message;
        return;
    }

    $("erroPedido").textContent = "";

    document.title = `Pedido #${pedido.id} | Administração`;

    const area = $("dadosPedido");
    area.replaceChildren();

    // ---------- cabeçalho ----------
    const cabecalho = el("div", "ped-cabecalho");

    const titulo = el("div");
    titulo.append(
        el("h1", "fx-titulo", `Pedido #${pedido.id}`),
        el("p", "fx-sub", formatarData(pedido.data_pedido))
    );

    cabecalho.append(titulo, etiquetaStatus(pedido.status));
    area.appendChild(cabecalho);

    // aviso gerado pelo sistema (estoque insuficiente, valor diferente, estorno...)
    if (pedido.alerta) {

        const aviso = el("div", "fx-aviso ped-alerta");
        aviso.setAttribute("role", "alert");
        aviso.appendChild(el("strong", null, "⚠ Atenção: "));
        aviso.appendChild(document.createTextNode(pedido.alerta));

        const dispensar = el("button", "fx-link", "Já resolvi, dispensar aviso");
        dispensar.type = "button";
        dispensar.addEventListener("click", async () => {
            try {
                await api("DELETE", `/api/admin/pedidos/${encodeURIComponent(pedidoId)}/alerta`);
                await carregar();
            } catch (erro) {
                toast(erro.message, true);
            }
        });

        aviso.append(document.createElement("br"), dispensar);
        area.appendChild(aviso);
    }

    const grade = el("div", "fx-grid");
    area.appendChild(grade);

    const principal = el("div", "fx-coluna");
    const lateral = el("div", "fx-coluna ped-lateral");

    grade.append(principal, lateral);

    // ---------- itens ----------
    const itens = cartao("Produtos");

    pedido.itens.forEach(item => {

        const produto = produtos.find(p => p.id === item.id);

        const linha = el("div", "ped-item");

        if (produto?.imagem) {
            const img = document.createElement("img");
            img.src = produto.imagem;
            img.alt = "";
            img.loading = "lazy";
            linha.appendChild(img);
        } else {
            linha.appendChild(el("div", "ped-sem-foto"));
        }

        const info = el("div");
        // Pedidos muito antigos foram gravados sem nome: usa o do catálogo
        info.appendChild(el("div", "ped-item-nome", item.nome || produto?.nome || "Produto sem nome"));

        if (item.variacao) {
            info.appendChild(el("div", "ped-meta", `Opção: ${item.variacao}`));
        }

        const semValor = !(Number(item.preco) > 0);

        info.appendChild(
            el("div", "ped-meta", semValor
                ? `${item.quantidade} un. · valor não registrado`
                : `${item.quantidade} × ${brl(item.preco)}`)
        );

        linha.append(info, el("div", "ped-item-sub", semValor ? "—" : brl(item.subtotal)));

        itens.appendChild(linha);
    });

    principal.appendChild(itens);

    // ---------- cliente ----------
    const cliente = cartao("Cliente");

    const email = pedido.email
        ? Object.assign(el("a", "fx-link", pedido.email), { href: `mailto:${pedido.email}` })
        : "-";

    cliente.append(
        dado("Nome", pedido.cliente),
        dado("E-mail", email),
        dado("Telefone", formatarTelefone(pedido.telefone))
    );

    principal.appendChild(cliente);

    // ---------- entrega ----------
    const entrega = cartao("Endereço de entrega");

    entrega.append(
        dado("Endereço", `${pedido.rua}, ${pedido.numero}`),
        dado("Bairro", pedido.bairro),
        dado("Cidade", `${pedido.cidade} - ${pedido.estado}`),
        dado("CEP", formatarCep(pedido.cep))
    );

    principal.appendChild(entrega);

    // ---------- resumo ----------
    const frete = Number(pedido.valor_frete || 0);
    const total = Number(pedido.total || 0);

    const resumo = el("aside", "fx-resumo");
    resumo.appendChild(el("h2", null, "Resumo"));

    const linhaResumo = (rotulo, valor) => {
        const l = el("div", "fx-linha");
        l.append(el("span", null, rotulo), el("span", null, valor));
        return l;
    };

    resumo.append(
        linhaResumo("Produtos", brl(total - frete)),
        linhaResumo("Frete", brl(frete))
    );

    const linhaTotal = el("div", "fx-linha fx-total");
    linhaTotal.append(el("span", null, "Total"), el("strong", null, brl(total)));
    resumo.appendChild(linhaTotal);

    lateral.appendChild(resumo);

    // ---------- situação ----------
    const situacao = cartao("Situação do pedido");

    const grupoStatus = el("div", "fx-campo");
    const rotuloStatus = el("label", null, "Situação");
    rotuloStatus.htmlFor = "status";

    const seletor = document.createElement("select");
    seletor.id = "status";

    Object.entries(STATUS).forEach(([chave, info]) => {
        if (chave === "pendente" && pedido.status !== "pendente") return;
        const opcao = el("option", null, info.nome);
        opcao.value = chave;
        seletor.appendChild(opcao);
    });

    seletor.value = pedido.status;

    grupoStatus.append(rotuloStatus, seletor);

    const botaoStatus = el("button", "fx-btn", "Atualizar situação");
    botaoStatus.type = "button";
    botaoStatus.addEventListener("click", () => alterarStatus(seletor.value, botaoStatus));

    situacao.append(grupoStatus, botaoStatus);

    // pagamento no Mercado Pago
    if (pedido.mp_payment_id) {
        situacao.appendChild(dado("Pagamento (Mercado Pago)", `#${pedido.mp_payment_id}`));
    }

    if (["aguardando_pagamento", "pendente", "cancelado"].includes(pedido.status)) {

        const verificar = el("button", "fx-btn fx-btn-sec", "Verificar pagamento no Mercado Pago");
        verificar.type = "button";
        verificar.addEventListener("click", () => verificarPagamento(verificar));

        situacao.append(
            el("p", "fx-sub", "Se o cliente já pagou e o pedido não mudou, confira direto no Mercado Pago."),
            verificar
        );
    }

    lateral.appendChild(situacao);

    // ---------- envio ----------
    lateral.appendChild(montarEnvio(pedido, statusME));
}

const ETAPAS_ME = {
    carrinho: "Etiqueta criada, falta pagar",
    comprada: "Etiqueta paga, falta gerar"
};

const STATUS_ME = {
    pending: "Aguardando pagamento",
    released: "Liberada para geração",
    generated: "Etiqueta gerada, aguardando postagem",
    posted: "Postado",
    delivered: "Entregue",
    canceled: "Cancelada",
    undelivered: "Não entregue",
    paused: "Pausada",
    suspended: "Suspensa"
};

function montarEnvio(pedido, statusME) {

    const envio = cartao("Envio");

    envio.append(
        dado("Serviço", pedido.transportadora),
        dado("Frete pago", brl(pedido.valor_frete || 0))
    );

    if (pedido.etiqueta_custo) {
        envio.appendChild(dado("Custo da etiqueta", brl(pedido.etiqueta_custo)));
    }

    const podeGerar = ["pago", "em_separacao"].includes(pedido.status);
    const etapa = pedido.me_etapa;

    // ---------- etiqueta já gerada ----------
    if (etapa === "gerada") {

        envio.append(
            dado("Etiqueta", "Gerada"),
            dado("Situação", STATUS_ME[pedido.me_status] || pedido.me_status || "-")
        );

        const codigo = el("span", null, pedido.codigo_rastreio || "Ainda não disponível");
        envio.appendChild(dado("Rastreio", codigo));

        const acoes = el("div", "ped-acoes");

        const imprimir = el("button", "fx-btn", "Imprimir etiqueta");
        imprimir.type = "button";
        imprimir.addEventListener("click", () => imprimirEtiqueta(imprimir));

        const atualizar = el("button", "fx-btn fx-btn-sec", "Atualizar rastreio");
        atualizar.type = "button";
        atualizar.addEventListener("click", () => atualizarRastreio(atualizar));

        acoes.append(imprimir, atualizar);
        envio.appendChild(acoes);

        if (pedido.codigo_rastreio) {
            const rastrear = el("a", "fx-link ped-etiqueta", "Rastrear a encomenda ↗");
            rastrear.href = `https://melhorrastreio.com.br/rastreio/${encodeURIComponent(pedido.codigo_rastreio)}`;
            rastrear.target = "_blank";
            rastrear.rel = "noopener";
            envio.appendChild(rastrear);
        }

    // ---------- etiqueta ainda não existe (ou parou no meio) ----------
    } else {

        if (ETAPAS_ME[etapa]) {
            envio.appendChild(el(
                "p",
                "adm-aviso-info",
                `ℹ ${ETAPAS_ME[etapa]}. Clique em "Continuar" para terminar (confira o saldo do Melhor Envio).`
            ));
        }

        if (!podeGerar) {

            envio.appendChild(el(
                "p",
                "fx-sub",
                "A etiqueta pode ser gerada depois que o pedido estiver pago."
            ));

        } else {

            const abrir = el("button", "fx-btn", etapa ? "Continuar geração da etiqueta" : "Gerar etiqueta");
            abrir.type = "button";

            const formulario = montarFormularioEtiqueta(pedido, statusME);
            formulario.hidden = true;

            abrir.addEventListener("click", () => {
                formulario.hidden = !formulario.hidden;
            });

            envio.append(abrir, formulario);
        }
    }

    // ---------- envio feito por fora do Melhor Envio ----------
    const manual = el("details", "ped-manual");
    manual.appendChild(el("summary", null, "Informar envio manualmente"));

    manual.append(
        campo("Transportadora", "transportadora", pedido.transportadora, "Ex.: Correios - PAC"),
        campo("Código de rastreio", "codigoRastreio", pedido.codigo_rastreio, "Cole o código aqui")
    );

    const botaoRastreio = el("button", "fx-btn fx-btn-sec", "Salvar envio");
    botaoRastreio.type = "button";
    botaoRastreio.addEventListener("click", () => salvarRastreio(botaoRastreio));

    manual.appendChild(botaoRastreio);
    envio.appendChild(manual);

    return envio;
}

function montarFormularioEtiqueta(pedido, statusME) {

    const form = el("div", "ped-form-etiqueta");

    if (statusME) {

        const ambiente = statusME.ambiente === "teste" ? " (ambiente de testes)" : "";

        if (statusME.saldo !== null) {
            form.appendChild(el("p", "fx-sub", `Saldo no Melhor Envio: ${brl(statusME.saldo)}${ambiente}. O valor da etiqueta é descontado dele.`));
        }

        if (statusME.dadosDaLojaFaltando.length > 0) {
            form.appendChild(el(
                "p",
                "fx-aviso",
                "Faltam dados da loja no arquivo .env: " + statusME.dadosDaLojaFaltando.join(", ")
            ));
        }
    }

    const cpf = campo("CPF do destinatário", "etqCpf", formatarCpf(pedido.cpf), "000.000.000-00");
    const complemento = campo("Complemento", "etqComplemento", pedido.complemento, "Apto, bloco...");
    const nota = campo("Chave da nota fiscal (opcional)", "etqNota", "", "44 números");

    form.append(
        cpf,
        complemento,
        nota,
        el(
            "p",
            "fx-sub",
            "Sem nota fiscal, o envio sai como declaração de conteúdo. Se a sua empresa emite nota " +
            "fiscal para esta venda, informe a chave acima."
        )
    );

    const erro = el("div", "fx-aviso");
    erro.id = "etqErro";
    erro.setAttribute("role", "alert");

    const confirmar = el("button", "fx-btn", "Comprar e gerar etiqueta");
    confirmar.type = "button";
    confirmar.addEventListener("click", () => gerarEtiqueta(confirmar));

    form.append(erro, confirmar);

    return form;
}

function formatarCpf(valor) {

    const d = somenteDigitos(valor);

    return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : valor || "";
}

async function gerarEtiqueta(botao) {

    $("etqErro").textContent = "";

    botao.disabled = true;
    botao.textContent = "Gerando... (pode levar alguns segundos)";

    try {

        await api("POST", `/api/admin/pedidos/${encodeURIComponent(pedidoId)}/etiqueta`, {
            cpf: $("etqCpf").value,
            complemento: $("etqComplemento").value,
            chave_nf: $("etqNota").value
        });

        toast("Etiqueta gerada ✓ O cliente já vê o pedido como \"preparando o envio\"");

        await carregar();

    } catch (erro) {

        $("etqErro").textContent = erro.message;

        botao.disabled = false;
        botao.textContent = "Comprar e gerar etiqueta";

        // se parou no meio, a tela precisa mostrar a etapa em que ficou
        carregarSemFechar();
    }
}

// Atualiza só o aviso de etapa, sem fechar o formulário aberto
async function carregarSemFechar() {

    try {

        const pedido = await api("GET", `/api/pedido/${encodeURIComponent(pedidoId)}`);

        if (pedido.me_etapa === "carrinho" || pedido.me_etapa === "comprada") {
            $("etqErro").textContent += `\n(${ETAPAS_ME[pedido.me_etapa]}. Depois de resolver, clique de novo para continuar de onde parou.)`;
        }

    } catch {
        // sem problema
    }
}

// ---------- visor da etiqueta (imprime dentro do painel) ----------

let visor = null;
let urlEtiqueta = null;

function criarVisor() {

    const dialogo = document.createElement("dialog");
    dialogo.className = "vz";
    dialogo.setAttribute("aria-labelledby", "vzTitulo");

    const topo = el("div", "vz-topo");
    const titulo = el("h2", null, `Etiqueta do pedido #${pedidoId}`);
    titulo.id = "vzTitulo";

    const imprimir = el("button", "vz-btn principal", "🖨 Imprimir");
    imprimir.type = "button";
    imprimir.disabled = true;

    const baixar = el("a", "vz-btn", "Baixar PDF");
    baixar.hidden = true;

    const nova = el("button", "vz-btn", "Abrir em outra aba");
    nova.type = "button";
    nova.disabled = true;

    const fechar = el("button", "vz-btn", "Fechar");
    fechar.type = "button";

    topo.append(titulo, imprimir, baixar, nova, fechar);

    const corpo = el("div", "vz-corpo");
    const mensagem = el("div", "vz-msg", "Carregando a etiqueta...");
    mensagem.setAttribute("role", "status");

    const quadro = document.createElement("iframe");
    quadro.title = `Etiqueta do pedido ${pedidoId}`;
    quadro.hidden = true;

    corpo.append(quadro, mensagem);
    dialogo.append(topo, corpo);

    fechar.addEventListener("click", () => dialogo.close());
    dialogo.addEventListener("click", e => { if (e.target === dialogo) dialogo.close(); });

    imprimir.addEventListener("click", () => {

        try {
            quadro.contentWindow.focus();
            quadro.contentWindow.print();
        } catch {
            // alguns navegadores não deixam imprimir de dentro do quadro: abre o PDF em outra aba
            if (urlEtiqueta) window.open(urlEtiqueta, "_blank");
        }
    });

    nova.addEventListener("click", () => {
        if (urlEtiqueta) window.open(urlEtiqueta, "_blank");
    });

    dialogo.addEventListener("close", () => {
        if (urlEtiqueta) URL.revokeObjectURL(urlEtiqueta);
        urlEtiqueta = null;
        dialogo.remove();
        visor = null;
    });

    document.body.appendChild(dialogo);

    return { dialogo, imprimir, baixar, nova, quadro, mensagem, corpo };
}

async function imprimirEtiqueta(botao) {

    botao.disabled = true;

    if (visor) visor.dialogo.close();

    visor = criarVisor();

    const v = visor;
    v.dialogo.showModal();

    try {

        const resposta = await fetch(`/api/admin/pedidos/${encodeURIComponent(pedidoId)}/etiqueta.pdf`, {
            credentials: "same-origin",
            cache: "no-store"
        });

        if (resposta.status === 401) {
            window.location.href = "/admin.html?expirou=1";
            return;
        }

        const tipo = resposta.headers.get("content-type") || "";

        if (!resposta.ok || !tipo.includes("pdf")) {

            const dados = await resposta.json().catch(() => ({}));

            const falha = new Error(dados.erro || "Não foi possível carregar a etiqueta.");
            falha.link = dados.url || null;
            throw falha;
        }

        const blob = await resposta.blob();

        // o visor pode ter sido fechado enquanto carregava
        if (visor !== v) return;

        urlEtiqueta = URL.createObjectURL(blob);

        v.quadro.src = urlEtiqueta;
        v.quadro.hidden = false;
        v.mensagem.hidden = true;

        v.imprimir.disabled = false;
        v.nova.disabled = false;

        v.baixar.href = urlEtiqueta;
        v.baixar.download = `etiqueta-pedido-${pedidoId}.pdf`;
        v.baixar.hidden = false;

        v.imprimir.focus();

    } catch (erro) {

        if (visor !== v) return;

        v.mensagem.hidden = false;
        v.mensagem.classList.add("erro");
        v.mensagem.replaceChildren(el("p", null, erro.message));

        // plano B: o link de impressão do próprio Melhor Envio
        if (erro.link) {

            const abrir = el("a", "vz-btn principal", "Abrir no Melhor Envio ↗");
            abrir.href = erro.link;
            abrir.target = "_blank";
            abrir.rel = "noopener";

            v.mensagem.appendChild(abrir);
        }

    } finally {
        botao.disabled = false;
    }
}

async function verificarPagamento(botao) {

    botao.disabled = true;
    botao.textContent = "Consultando o Mercado Pago...";

    try {

        const { status, resultado } = await api(
            "POST",
            `/api/admin/pedidos/${encodeURIComponent(pedidoId)}/verificar-pagamento`
        );

        if (resultado?.pagamentos === 0) {
            toast("Nenhum pagamento encontrado para este pedido no Mercado Pago", true);
        } else {
            toast(status === "pago" ? "Pagamento confirmado ✓" : "Pagamento consultado");
        }

        await carregar();

    } catch (erro) {

        toast(erro.message, true);

        botao.disabled = false;
        botao.textContent = "Verificar pagamento no Mercado Pago";
    }
}

async function atualizarRastreio(botao) {

    botao.disabled = true;

    try {
        await api("POST", `/api/admin/pedidos/${encodeURIComponent(pedidoId)}/rastreio/atualizar`);
        toast("Rastreio atualizado ✓");
        await carregar();
    } catch (erro) {
        toast(erro.message, true);
    } finally {
        botao.disabled = false;
    }
}

async function alterarStatus(status, botao) {

    botao.disabled = true;

    try {
        await api("PUT", `/api/pedido/${encodeURIComponent(pedidoId)}/status`, { status });
        toast("Situação atualizada ✓");
        await carregar();
    } catch (erro) {
        toast(erro.message, true);
    } finally {
        botao.disabled = false;
    }
}

async function salvarRastreio(botao) {

    botao.disabled = true;

    try {

        await api("PUT", `/api/pedido/${encodeURIComponent(pedidoId)}/rastreio`, {
            transportadora: $("transportadora").value,
            codigo_rastreio: $("codigoRastreio").value
        });

        toast("Dados de envio salvos ✓");

    } catch (erro) {
        toast(erro.message, true);
    } finally {
        botao.disabled = false;
    }
}

carregar();
