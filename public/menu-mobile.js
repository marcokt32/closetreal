// Menu sanduíche + carrinho flutuante (celular).
// Não precisa mudar o HTML das páginas: o script acha o <header>, o <nav> e o .btn-carrinho
// que já existem, cria o botão do menu e troca o texto do carrinho por um ícone de sacola
// (o ícone só aparece no celular; no computador continua "🛒 Carrinho").

(function () {

    "use strict";

    const header = document.querySelector("header");

    if (!header) return;

    const nav = header.querySelector("nav");
    const celular = window.matchMedia("(max-width: 768px)");

    // ---------- menu sanduíche ----------

    if (nav) {

        if (!nav.id) nav.id = "menuPrincipal";

        const botao = document.createElement("button");
        botao.type = "button";
        botao.className = "menu-toggle";
        botao.setAttribute("aria-controls", nav.id);
        botao.setAttribute("aria-expanded", "false");
        botao.setAttribute("aria-label", "Abrir menu");

        const barras = document.createElement("span");
        barras.className = "menu-toggle-barras";
        barras.setAttribute("aria-hidden", "true");
        botao.appendChild(barras);

        // logo -> botão -> links: a ordem do Tab fica natural
        header.insertBefore(botao, nav);

        const definir = aberto => {
            header.classList.toggle("menu-aberto", aberto);
            botao.setAttribute("aria-expanded", String(aberto));
            botao.setAttribute("aria-label", aberto ? "Fechar menu" : "Abrir menu");
        };

        const estaAberto = () => header.classList.contains("menu-aberto");

        botao.addEventListener("click", () => definir(!estaAberto()));

        // clicar num link, fora do cabeçalho ou apertar Esc fecha
        nav.addEventListener("click", e => {
            if (e.target.closest("a")) definir(false);
        });

        document.addEventListener("click", e => {
            if (estaAberto() && !header.contains(e.target)) definir(false);
        });

        document.addEventListener("keydown", e => {
            if (e.key === "Escape" && estaAberto()) {
                definir(false);
                botao.focus();
            }
        });

        // girou o celular / abriu em tela grande: volta ao normal
        celular.addEventListener("change", () => definir(false));
    }

    // ---------- carrinho com ícone de sacola ----------

    const carrinho = header.querySelector(".btn-carrinho");

    if (carrinho) {

        // "🛒 Carrinho" vira um <span> (escondido da vista no celular, mas lido por leitores de tela)
        [...carrinho.childNodes].forEach(no => {

            if (no.nodeType === Node.TEXT_NODE && no.textContent.trim()) {

                const texto = document.createElement("span");
                texto.className = "btn-carrinho-texto";
                texto.textContent = no.textContent.trim();

                no.replaceWith(texto);
            }
        });

        const icone = document.createElement("span");
        icone.className = "btn-carrinho-icone";
        icone.setAttribute("aria-hidden", "true");
        icone.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
            'stroke-linecap="round" stroke-linejoin="round" focusable="false">' +
            '<path d="M5.5 8h13l1.1 12.2a1 1 0 0 1-1 1.1H5.4a1 1 0 0 1-1-1.1L5.5 8z"/>' +
            '<path d="M8.6 8V6.8a3.4 3.4 0 0 1 6.8 0V8"/>' +
            '</svg>';

        carrinho.prepend(icone);

        // a bolinha de quantidade some quando o carrinho está vazio
        const contador = carrinho.querySelector("#contadorCarrinho");

        if (contador) {

            const marcar = () => {
                const n = contador.textContent.trim();
                carrinho.classList.toggle("vazio", n === "" || n === "0");
            };

            marcar();

            new MutationObserver(marcar).observe(contador, {
                childList: true,
                characterData: true,
                subtree: true
            });
        }

        if (/carrinho\.html$/.test(location.pathname)) {
            carrinho.classList.add("na-pagina-do-carrinho");
        }
    }

})();
