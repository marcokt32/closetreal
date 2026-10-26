// Página "Sistema" do painel: conferência antes de publicar, conta do Mercado Pago e backup.
// Usa $, api, el e toast do admin-comum.js.

const ICONES = { ok: "✓", aviso: "!", erro: "✕", info: "i" };

function desenharConferencia(dados) {

    const lista = $("listaConf");
    lista.replaceChildren();

    // erros primeiro, depois avisos, depois o que está certo
    const ordem = { erro: 0, aviso: 1, info: 2, ok: 3 };

    [...dados.itens]
        .sort((a, b) => ordem[a.nivel] - ordem[b.nivel])
        .forEach(i => {

            const li = el("li", `sis-item ${i.nivel}`);

            const icone = el("span", "sis-icone", ICONES[i.nivel] || "i");
            icone.setAttribute("aria-hidden", "true");

            const texto = el("div");
            texto.append(
                el("strong", null, `${i.titulo}${i.nivel === "ok" ? "" : i.nivel === "erro" ? " (corrigir)" : i.nivel === "aviso" ? " (atenção)" : ""}`),
                el("span", null, i.detalhe)
            );

            li.append(icone, texto);
            lista.appendChild(li);
        });

    const resumo = $("resumoConf");

    if (dados.erros > 0) {
        resumo.className = "sis-resumo erro";
        resumo.textContent = `${dados.erros} ${dados.erros === 1 ? "item precisa" : "itens precisam"} de correção antes de publicar.`;
    } else if (dados.avisos > 0) {
        resumo.className = "sis-resumo aviso";
        resumo.textContent = `Sem erros. ${dados.avisos} ${dados.avisos === 1 ? "ponto de atenção" : "pontos de atenção"} para revisar.`;
    } else {
        resumo.className = "sis-resumo ok";
        resumo.textContent = "Tudo certo para vender.";
    }

    $("infoIp").textContent =
        `O servidor enxerga o seu acesso como vindo do IP ${dados.ip}. ` +
        "Se esse número for sempre o mesmo para qualquer pessoa ou celular (ou parecer interno, como 10.x.x.x), " +
        "ajuste TRUST_PROXY: senão o bloqueio de tentativas erradas de senha afeta todo mundo junto.";

    desenharBackup(dados.backup);
}

function desenharBackup(backup) {

    const info = $("infoBackup");

    info.classList.remove("erro");

    if (!backup) {
        info.textContent = "Nenhuma cópia automática feita ainda.";
        return;
    }

    if (backup.erro) {
        info.classList.add("erro");
        info.textContent = `A última tentativa falhou: ${backup.erro}`;
        return;
    }

    const kb = Math.max(1, Math.round(backup.bancoBytes / 1024));

    info.textContent =
        `Última cópia: ${new Date(backup.em).toLocaleString("pt-BR")} ` +
        `(banco de dados com ${kb} KB${backup.fotosNovas ? `, ${backup.fotosNovas} fotos novas guardadas` : ""}).`;
}

async function carregar() {

    $("resumoConf").className = "sis-resumo";
    $("resumoConf").textContent = "Conferindo...";

    try {
        desenharConferencia(await api("GET", "/api/admin/sistema"));
    } catch (erro) {
        if (erro.message === "Sessão expirada") return;
        $("resumoConf").className = "sis-resumo erro";
        $("resumoConf").textContent = erro.message;
    }
}

$("btnReconferir").addEventListener("click", carregar);

$("btnMp").addEventListener("click", async () => {

    const botao = $("btnMp");
    const resposta = $("respostaMp");

    botao.disabled = true;
    resposta.className = "sis-resposta";
    resposta.textContent = "Consultando o Mercado Pago...";

    try {

        const c = await api("GET", "/api/admin/sistema/mercadopago");

        resposta.replaceChildren(
            el("span", `sis-selo ${c.pareceTeste ? "teste" : "real"}`, c.pareceTeste ? "Conta de TESTE" : "Conta real"),
            document.createTextNode(
                `Usuário ${c.apelido || "(sem apelido)"} · número ${c.id}${c.email ? ` · ${c.email}` : ""}. ` +
                (c.pareceTeste
                    ? "Os pagamentos feitos agora não movimentam dinheiro de verdade."
                    : "Os pagamentos feitos agora são reais.")
            )
        );

    } catch (erro) {

        if (erro.message === "Sessão expirada") return;

        resposta.className = "sis-resposta erro";
        resposta.textContent = erro.message;

    } finally {
        botao.disabled = false;
    }
});

$("btnBackupAgora").addEventListener("click", async () => {

    const botao = $("btnBackupAgora");
    botao.disabled = true;
    botao.textContent = "Fazendo backup...";

    try {
        const resultado = await api("POST", "/api/admin/backup/agora");
        desenharBackup(resultado);
        toast("Backup feito ✓");
        carregar();
    } catch (erro) {
        if (erro.message !== "Sessão expirada") toast(erro.message, true);
    } finally {
        botao.disabled = false;
        botao.textContent = "Fazer backup agora";
    }
});

$("btnBaixar").addEventListener("click", async () => {

    const botao = $("btnBaixar");
    botao.disabled = true;

    try {

        const resposta = await fetch("/api/admin/backup/baixar", { cache: "no-store" });

        if (resposta.status === 401) {
            window.location.href = "/admin.html?expirou=1";
            return;
        }

        if (!resposta.ok) {
            const dados = await resposta.json().catch(() => ({}));
            throw new Error(dados.erro || "Não foi possível gerar a cópia.");
        }

        const blob = await resposta.blob();
        const url = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = url;
        link.download = `closet-real-${new Date().toLocaleDateString("sv-SE")}.db`;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => URL.revokeObjectURL(url), 5000);

        toast("Cópia baixada ✓ Guarde em um lugar seguro");

    } catch (erro) {
        toast(erro.message, true);
    } finally {
        botao.disabled = false;
    }
});

carregar();
