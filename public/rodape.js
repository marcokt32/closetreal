// Rodapé e dados de contato da loja, todos vindos de /api/loja (que lê o .env).
// - Reescreve o <footer> da página com nome, CPF/CNPJ, endereço, contato e links das políticas.
//   Se a consulta falhar, o rodapé simples que já está no HTML continua valendo.
// - Preenche qualquer elemento marcado com data-loja="campo", data-loja-href="tipo" ou data-loja-mostrar="campo".

(function () {

    "use strict";

    if (!document.querySelector('link[href^="rodape.css"]')) {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = "rodape.css";
        document.head.appendChild(css);
    }

    const criar = (tag, classe, texto) => {
        const e = document.createElement(tag);
        if (classe) e.className = classe;
        if (texto !== undefined) e.textContent = texto;
        return e;
    };

    const link = (texto, href, extra = {}) => {
        const a = criar("a", null, texto);
        a.href = href;
        if (extra.fora) { a.target = "_blank"; a.rel = "noopener"; }
        return a;
    };

    const soDigitos = t => String(t || "").replace(/\D/g, "");

    function hrefDe(tipo, loja) {

        if (tipo === "email" && loja.email) return `mailto:${loja.email}`;
        if (tipo === "whatsapp" && loja.whatsapp) return `https://wa.me/${loja.whatsapp}`;

        if (tipo === "telefone" && loja.telefone) {
            const d = soDigitos(loja.telefone);
            return `tel:+${d.length <= 11 ? "55" : ""}${d}`;
        }

        if (tipo === "instagram" && loja.instagram) return `https://instagram.com/${encodeURIComponent(loja.instagram)}`;

        return "";
    }

    function preencherPagina(loja) {

        document.querySelectorAll("[data-loja]").forEach(no => {
            const valor = loja[no.dataset.loja];
            if (valor) no.textContent = valor;
        });

        document.querySelectorAll("[data-loja-href]").forEach(no => {
            const href = hrefDe(no.dataset.lojaHref, loja);
            if (href) {
                no.href = href;
                if (/^https?:/.test(href)) { no.target = "_blank"; no.rel = "noopener"; }
            } else {
                no.hidden = true;
            }
        });

        document.querySelectorAll("[data-loja-mostrar]").forEach(no => {
            if (!loja[no.dataset.lojaMostrar]) no.hidden = true;
        });
    }

    function montarRodape(loja) {

        const rodape = document.querySelector("footer");

        if (!rodape) return;

        rodape.classList.add("rodape-loja");

        // 1) quem somos + identificação do vendedor
        const quem = criar("div");
        quem.appendChild(criar("h3", null, loja.nome));
        quem.appendChild(criar("p", null, "Loja especializada em moda feminina."));

        if (loja.documento) {
            quem.appendChild(criar("p", "rodape-pequeno", `${loja.tipoDocumento || "Documento"}: ${loja.documento}`));
        }

        if (loja.endereco) {
            quem.appendChild(criar("p", "rodape-pequeno", loja.endereco));
        }

        // 2) atendimento
        const atendimento = criar("div");
        atendimento.appendChild(criar("h3", null, "Atendimento"));
        atendimento.appendChild(criar("p", null, loja.horario || "Segunda a Sexta"));

        if (loja.email) {
            const p = criar("p");
            p.appendChild(link(loja.email, `mailto:${loja.email}`));
            atendimento.appendChild(p);
        }

        const telefone = hrefDe("telefone", loja);

        if (loja.telefone && telefone) {
            const p = criar("p");
            p.appendChild(link(loja.telefone, telefone));
            atendimento.appendChild(p);
        }

        if (loja.whatsapp) {
            const p = criar("p");
            p.appendChild(link("Falar no WhatsApp", `https://wa.me/${loja.whatsapp}`, { fora: true }));
            atendimento.appendChild(p);
        }

        if (loja.instagram) {
            const p = criar("p");
            p.appendChild(link(`@${loja.instagram}`, hrefDe("instagram", loja), { fora: true }));
            atendimento.appendChild(p);
        }

        // 3) informações
        const info = criar("div");
        info.appendChild(criar("h3", null, "Informações"));

        const nav = criar("nav");
        nav.setAttribute("aria-label", "Informações da loja");

        [
            ["Trocas e devoluções", "/trocas-e-devolucoes.html"],
            ["Política de privacidade", "/privacidade.html"],
            ["Contato", "/contato.html"],
            ["Meus pedidos", "/consultar.html"]
        ].forEach(([texto, href]) => nav.appendChild(link(texto, href)));

        info.appendChild(nav);

        // 4) pagamento
        const pagamento = criar("div");
        pagamento.appendChild(criar("h3", null, "Pagamento Seguro"));
        pagamento.appendChild(criar("p", null, "Processado por Mercado Pago."));

        rodape.replaceChildren(quem, atendimento, info, pagamento);
    }

    async function iniciar() {

        let loja = null;

        try {
            const resposta = await fetch("/api/loja");
            if (resposta.ok) loja = await resposta.json();
        } catch { /* mantém o rodapé simples do HTML */ }

        if (!loja) return;

        preencherPagina(loja);
        montarRodape(loja);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", iniciar);
    } else {
        iniciar();
    }

})();
