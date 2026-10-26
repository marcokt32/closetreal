// O navegador só mostra valores para o cliente conferir.
// Quem calcula e confirma preço, frete e total de verdade é o servidor.

let totalProdutos = 0;
let freteSelecionado = null; // { id, nome, preco, prazo }

const $ = id => document.getElementById(id);

function itensParaApi() {
    return lerCarrinho().map(item => ({
        id: item.id,
        variacao: item.variacao,
        quantidade: item.qtd
    }));
}

// Confere os dígitos verificadores do CPF
function cpfValido(valor) {

    const cpf = String(valor || "").replace(/\D/g, "");

    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;

    const digito = (base, pesoInicial) => {
        let soma = 0;
        for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
        const resto = (soma * 10) % 11;
        return resto === 10 ? 0 : resto;
    };

    return (
        digito(cpf.slice(0, 9), 10) === Number(cpf[9]) &&
        digito(cpf.slice(0, 10), 11) === Number(cpf[10])
    );
}

function aviso(id, mensagem) {
    $(id).textContent = mensagem || "";
}

async function carregarResumo() {

    let produtos = [];

    try {
        const resposta = await fetch("/api/produtos");
        produtos = await resposta.json();
    } catch {
        aviso("avisoPagar", "Não foi possível carregar o pedido. Atualize a página.");
        $("btnPagar").disabled = true;
        $("btnFrete").disabled = true;
        return;
    }

    const { carrinho, removidos } = normalizarCarrinho(produtos);

    if (removidos > 0) {
        aviso("avisoPagar", "Alguns itens esgotaram ou saíram da loja e foram retirados do pedido.");
    }

    atualizarContador();

    const div = $("resumoCarrinho");
    div.replaceChildren();
    totalProdutos = 0;

    if (carrinho.length === 0) {

        const vazio = el("p", "fx-sub", "Seu carrinho está vazio. ");
        const link = el("a", "fx-link", "Ver produtos");
        link.href = "/#catalogo";
        vazio.appendChild(link);
        div.appendChild(vazio);

        $("btnFrete").disabled = true;
        $("btnPagar").disabled = true;

        atualizarTotal();
        return;
    }

    carrinho.forEach(item => {

        const produto = produtos.find(p => p.id === item.id);
        const variacao = produto.variacoes.find(v => v.id === item.variacao);

        const subtotal = produto.preco * item.qtd;

        totalProdutos += subtotal;

        const linha = el("div", "fx-mini");

        const img = document.createElement("img");
        img.src = produto.imagem;
        img.alt = "";
        img.loading = "lazy";

        const detalhe = opcaoDe(variacao)
            ? `${opcaoDe(variacao)} · Qtd: ${item.qtd}`
            : `Qtd: ${item.qtd}`;

        const info = el("div");
        info.append(
            el("div", "fx-mini-nome", produto.nome),
            el("div", "fx-mini-qtd", detalhe)
        );

        linha.append(img, info, el("div", "fx-mini-preco", brl(subtotal)));

        div.appendChild(linha);
    });

    atualizarTotal();
}

function limparFrete() {
    freteSelecionado = null;
    $("frete").replaceChildren();
    aviso("avisoFrete", "");
    atualizarTotal();
}

async function calcularFrete() {

    aviso("avisoFrete", "");

    const cep = $("cep").value.replace(/\D/g, "");

    if (cep.length !== 8) {
        $("cep").classList.add("invalido");
        $("cep").focus();
        aviso("avisoFrete", "Informe um CEP válido para calcular o frete.");
        return;
    }

    const botao = $("btnFrete");
    botao.disabled = true;
    botao.textContent = "Calculando...";

    try {

        const resposta = await fetch("/api/frete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                cepDestino: cep,
                itens: itensParaApi()
            })
        });

        const dados = await resposta.json();

        if (!resposta.ok) {

            const detalhes = Array.isArray(dados.detalhes) && dados.detalhes.length
                ? "\n" + dados.detalhes.join("\n")
                : "";

            aviso("avisoFrete", (dados.erro || "Erro no cálculo de frete") + detalhes);
            return;
        }

        if (dados.length === 0) {
            aviso("avisoFrete", "Nenhum frete disponível para este CEP.");
            return;
        }

        limparFrete();

        const divFrete = $("frete");

        dados.forEach(opcao => {

            const label = el("label", "fx-opcao");

            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "frete";

            radio.addEventListener("change", () => {

                divFrete
                    .querySelectorAll(".fx-opcao")
                    .forEach(o => o.classList.remove("sel"));

                label.classList.add("sel");

                freteSelecionado = opcao;
                aviso("avisoPagar", "");
                atualizarTotal();
            });

            const nome = el("span", "fx-opcao-nome", opcao.nome);

            if (opcao.prazo) {
                nome.appendChild(
                    el("span", "fx-opcao-prazo", `Chega em até ${opcao.prazo} dias úteis`)
                );
            }

            label.append(radio, nome, el("span", "fx-opcao-preco", brl(opcao.preco)));

            divFrete.appendChild(label);
        });

    } catch (erro) {
        console.log(erro);
        aviso("avisoFrete", "Não foi possível calcular o frete agora. Tente novamente.");
    } finally {
        botao.disabled = false;
        botao.textContent = "Calcular frete";
    }
}

function atualizarTotal() {

    const frete = freteSelecionado ? freteSelecionado.preco : 0;

    $("subtotalResumo").textContent = brl(totalProdutos);

    $("freteResumo").textContent = freteSelecionado
        ? brl(freteSelecionado.preco)
        : "Escolha o frete";

    $("totalFinal").textContent = brl(totalProdutos + frete);
}

async function pagar() {

    aviso("avisoPagar", "");

    document
        .querySelectorAll(".fx-campo input.invalido")
        .forEach(i => i.classList.remove("invalido"));

    if (lerCarrinho().length === 0) {
        aviso("avisoPagar", "Seu carrinho está vazio.");
        return;
    }

    const campos = [
        "cliente", "email", "telefone", "cpf",
        "cep", "rua", "numero", "bairro", "cidade", "estado"
    ];

    const vazios = campos.filter(id => !$(id).value.trim());

    if (vazios.length > 0) {
        vazios.forEach(id => $(id).classList.add("invalido"));
        $(vazios[0]).focus();
        aviso("avisoPagar", "Preencha os campos destacados.");
        return;
    }

    const valor = id => $(id).value.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor("email"))) {
        $("email").classList.add("invalido");
        $("email").focus();
        aviso("avisoPagar", "Informe um e-mail válido.");
        return;
    }

    if (!cpfValido(valor("cpf"))) {
        $("cpf").classList.add("invalido");
        $("cpf").focus();
        aviso("avisoPagar", "Informe um CPF válido.");
        return;
    }

    if (!freteSelecionado) {
        aviso("avisoPagar", "Calcule o frete e escolha uma opção de entrega.");
        return;
    }

    const botao = $("btnPagar");
    botao.disabled = true;
    botao.textContent = "Aguarde...";

    try {

        // 1) cria o pedido — o servidor recalcula tudo
        const pedidoResponse = await fetch("/api/pedido", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                cliente: valor("cliente"),
                email: valor("email"),
                telefone: valor("telefone"),
                cpf: valor("cpf"),
                complemento: valor("complemento"),
                cep: valor("cep"),
                rua: valor("rua"),
                numero: valor("numero"),
                bairro: valor("bairro"),
                cidade: valor("cidade"),
                estado: valor("estado"),
                frete_servico_id: freteSelecionado.id,
                total_esperado: totalProdutos + freteSelecionado.preco,
                itens: itensParaApi()
            })
        });

        const pedidoData = await pedidoResponse.json();

        if (pedidoResponse.status === 409) {
            alert(
                `${pedidoData.erro}\nNovo total: ${brl(pedidoData.total)}`
            );
            window.location.reload();
            return;
        }

        if (!pedidoResponse.ok || !pedidoData.id) {
            throw new Error(pedidoData.erro || "Erro ao criar pedido");
        }

        // 2) gera o pagamento no Mercado Pago
        const resposta = await fetch("/api/pagar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pedidoId: pedidoData.id })
        });

        const dados = await resposta.json();

        if (!dados.url) {
            throw new Error(dados.erro || "Erro ao iniciar pagamento");
        }

        window.location.href = dados.url;

    } catch (erro) {

        console.log(erro);

        aviso(
            "avisoPagar",
            erro.message || "Erro no processo de pagamento"
        );

        botao.disabled = false;
        botao.textContent = "Ir para o pagamento";
    }
}

async function buscarCep() {

    const cep = $("cep").value.replace(/\D/g, "");

    if (cep.length !== 8) return;

    try {

        const resposta = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
        const dados = await resposta.json();

        if (dados.erro) {
            aviso("avisoFrete", "CEP não encontrado. Confira os números.");
            return;
        }

        const preenchidos = {
            rua: dados.logradouro,
            bairro: dados.bairro,
            cidade: dados.localidade,
            estado: dados.uf
        };

        for (const [id, valor] of Object.entries(preenchidos)) {
            $(id).value = valor || "";
            $(id).classList.remove("invalido");
        }

        aviso("avisoFrete", "");

    } catch (erro) {
        console.log("Erro ViaCEP:", erro);
    }
}

// Máscara do CEP; se ele mudar depois de escolher o frete, a opção deixa de valer
$("cep").addEventListener("input", () => {

    const digitos = $("cep").value.replace(/\D/g, "").slice(0, 8);

    $("cep").value =
        digitos.length > 5
            ? `${digitos.slice(0, 5)}-${digitos.slice(5)}`
            : digitos;

    limparFrete();
});

// Máscara do CPF: 000.000.000-00
$("cpf").addEventListener("input", () => {

    const d = $("cpf").value.replace(/\D/g, "").slice(0, 11);

    $("cpf").value = d
        .replace(/^(\d{3})(\d)/, "$1.$2")
        .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
        .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, "$1.$2.$3-$4");
});

// Tira o destaque vermelho assim que a pessoa corrige o campo
document.querySelectorAll(".fx-campo input").forEach(input => {
    input.addEventListener("input", () => input.classList.remove("invalido"));
});

carregarResumo();
