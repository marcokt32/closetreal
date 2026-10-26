// Funções compartilhadas pelas telas de pedidos do painel

const $ = id => document.getElementById(id);

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

// Situações do pedido: nome para mostrar e cor da etiqueta
const STATUS = {
    aguardando_pagamento: { nome: "Aguardando pagamento", classe: "aguardando" },
    pago: { nome: "Pago", classe: "pago" },
    em_separacao: { nome: "Em separação", classe: "separacao" },
    em_transito: { nome: "Em trânsito", classe: "transito" },
    entregue: { nome: "Entregue", classe: "entregue" },
    cancelado: { nome: "Cancelado", classe: "cancelado" },
    pendente: { nome: "Pendente", classe: "aguardando" }
};

function etiquetaStatus(status) {
    const info = STATUS[status] || { nome: status, classe: "aguardando" };
    return el("span", `adm-badge ${info.classe}`, info.nome);
}

// O banco guarda a data em UTC; aqui vira o horário local de quem está vendo
function formatarData(valor) {

    if (!valor) return "";

    const data = new Date(String(valor).replace(" ", "T") + "Z");

    return isNaN(data)
        ? String(valor)
        : data.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

async function api(metodo, caminho, corpo) {

    const resposta = await fetch(caminho, {
        method: metodo,
        headers: corpo !== undefined ? { "Content-Type": "application/json" } : {},
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined
    });

    if (resposta.status === 401) {
        window.location.href = "/admin.html?expirou=1";
        throw new Error("Sessão expirada");
    }

    let dados = null;

    try {
        dados = await resposta.json();
    } catch {
        dados = null;
    }

    if (!resposta.ok) {
        throw new Error(dados?.erro || "Erro inesperado. Tente novamente.");
    }

    return dados;
}

let temporizadorToast = null;

function toast(texto, erro = false) {

    let aviso = $("toastAdmin");

    if (!aviso) {
        aviso = el("div", "fx-toast");
        aviso.id = "toastAdmin";
        aviso.setAttribute("role", "status");
        aviso.setAttribute("aria-live", "polite");
        document.body.appendChild(aviso);
    }

    aviso.textContent = texto;
    aviso.classList.toggle("erro", erro);
    aviso.classList.add("visivel");

    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => aviso.classList.remove("visivel"), 2800);
}

const botaoSair = $("btnSair");

if (botaoSair) {
    botaoSair.addEventListener("click", async () => {
        await fetch("/api/admin-logout", { method: "POST", cache: "no-store" }).catch(() => {});
        window.location.href = "/admin.html?saiu=1";
    });
}
