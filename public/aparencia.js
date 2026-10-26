// Aparência da loja escolhida no painel: logo e banner (carrossel) da página inicial.
// Banner: imagens 16:9 no computador e 9:16 no celular. Sem imagens, usa as capas dos produtos em destaque.
// Sem nada disso, continua o banner padrão que já está no HTML.

(function () {

    "use strict";

    if (!document.querySelector('link[href^="aparencia.css"]')) {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = "aparencia.css";
        document.head.appendChild(css);
    }

    const criar = (tag, classe, texto) => {
        const e = document.createElement(tag);
        if (classe) e.className = classe;
        if (texto !== undefined) e.textContent = texto;
        return e;
    };

    const dinheiro = v => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

    const celular = window.matchMedia("(max-width: 768px)");
    const semMovimento = window.matchMedia("(prefers-reduced-motion: reduce)");

    // ---------- logo ----------

    function aplicarLogo(cfg) {

        if (!cfg.logo) return;

        document.querySelectorAll(".logoimg").forEach(img => {
            img.src = cfg.logo;
            img.classList.add("logo-personalizado");
        });

        // só o logo, sem o nome ao lado
        if (cfg.mostrar_nome_logo === false) {
            document.querySelectorAll("header .logo > div").forEach(bloco => { bloco.hidden = true; });
        }
    }

    // ---------- banner ----------

    function slidesDo(cfg) {

        const lista = celular.matches
            ? (cfg.banners_celular.length ? cfg.banners_celular : cfg.banners_pc)
            : (cfg.banners_pc.length ? cfg.banners_pc : cfg.banners_celular);

        if (lista.length > 0) {
            return { tipo: "banner", itens: lista };
        }

        if (cfg.destaques.length > 0) {
            return { tipo: "produtos", itens: cfg.destaques };
        }

        return null;
    }

    function montarBanner(secao, cfg) {

        const original = secao.cloneNode(true);

        let indice = 0;
        let temporizador = null;
        let pausadoPelaPessoa = semMovimento.matches;
        let pausadoPorFoco = false;

        function desenhar() {

            clearInterval(temporizador);

            const conjunto = slidesDo(cfg);

            if (!conjunto) {
                secao.replaceWith(original);
                return;
            }

            const { tipo, itens } = conjunto;

            secao.className = "hero hero-carrossel" + (tipo === "produtos" ? " modo-produtos" : "");
            secao.setAttribute("role", "region");
            secao.setAttribute("aria-roledescription", "carrossel");
            secao.setAttribute("aria-label", tipo === "produtos" ? "Produtos em destaque" : "Destaques da loja");

            const faixa = criar("div", "hc-faixa");
            const slides = [];

            itens.forEach((item, i) => {

                const slide = criar("div", "hc-slide");
                slide.setAttribute("role", "group");
                slide.setAttribute("aria-roledescription", "slide");
                slide.setAttribute("aria-label", `${i + 1} de ${itens.length}`);

                if (tipo === "banner") {

                    const img = document.createElement("img");
                    img.className = "hc-imagem";
                    img.src = item.url;
                    img.alt = item.alt || "";
                    img.decoding = "async";
                    if (i === 0) img.fetchPriority = "high";
                    else img.loading = "lazy";

                    slide.appendChild(img);

                } else {

                    slide.classList.add("hc-produto");

                    const fundo = criar("div", "hc-fundo");
                    fundo.style.backgroundImage = `url("${encodeURI(item.imagem)}")`;

                    const foto = document.createElement("img");
                    foto.className = "hc-foto";
                    foto.src = item.imagem;
                    foto.alt = item.nome;

                    const legenda = criar("div", "hc-legenda");
                    legenda.append(
                        criar("span", "hc-selo", "⭐ Destaque"),
                        criar("strong", null, item.nome),
                        criar("span", "hc-preco", dinheiro(item.preco))
                    );

                    const ver = criar("a", "btn-comprar", "Ver produto");
                    ver.href = `#produto-${item.id}`;
                    legenda.appendChild(ver);

                    slide.append(fundo, foto, legenda);
                }

                slides.push(slide);
                faixa.appendChild(slide);
            });

            // mantém o botão "Comprar agora" do banner original por cima das imagens
            const comprar = original.querySelector(".btn-comprar");
            const botaoComprar = comprar ? comprar.cloneNode(true) : null;

            if (botaoComprar) botaoComprar.classList.add("hc-comprar");

            secao.replaceChildren(faixa);

            if (botaoComprar && tipo === "banner") secao.appendChild(botaoComprar);

            // ---------- controles (só com mais de uma imagem) ----------

            const pontos = [];
            let botaoPausa = null;

            function mostrar(i) {

                indice = (i + slides.length) % slides.length;

                slides.forEach((s, n) => {
                    const ativo = n === indice;
                    s.classList.toggle("ativo", ativo);
                    s.setAttribute("aria-hidden", String(!ativo));
                    if (ativo) s.removeAttribute("inert"); else s.setAttribute("inert", "");
                });

                pontos.forEach((p, n) => {
                    if (n === indice) p.setAttribute("aria-current", "true");
                    else p.removeAttribute("aria-current");
                });
            }

            const tocando = () => !pausadoPelaPessoa && !pausadoPorFoco && !document.hidden;

            function agendar() {

                clearInterval(temporizador);

                if (slides.length < 2 || !tocando()) return;

                temporizador = setInterval(() => mostrar(indice + 1), Math.max(3, cfg.intervalo) * 1000);
            }

            if (slides.length > 1) {

                const ant = criar("button", "hc-seta ant", "‹");
                ant.type = "button";
                ant.setAttribute("aria-label", "Imagem anterior");
                ant.addEventListener("click", () => { mostrar(indice - 1); agendar(); });

                const prox = criar("button", "hc-seta prox", "›");
                prox.type = "button";
                prox.setAttribute("aria-label", "Próxima imagem");
                prox.addEventListener("click", () => { mostrar(indice + 1); agendar(); });

                const controles = criar("div", "hc-controles");

                slides.forEach((_, n) => {
                    const ponto = criar("button", "hc-ponto");
                    ponto.type = "button";
                    ponto.setAttribute("aria-label", `Ir para a imagem ${n + 1}`);
                    ponto.addEventListener("click", () => { mostrar(n); agendar(); });
                    pontos.push(ponto);
                    controles.appendChild(ponto);
                });

                botaoPausa = criar("button", "hc-pausa");
                botaoPausa.type = "button";

                const rotularPausa = () => {
                    botaoPausa.textContent = pausadoPelaPessoa ? "▶" : "❚❚";
                    botaoPausa.setAttribute("aria-label", pausadoPelaPessoa ? "Iniciar a troca automática" : "Pausar a troca automática");
                };

                botaoPausa.addEventListener("click", () => {
                    pausadoPelaPessoa = !pausadoPelaPessoa;
                    rotularPausa();
                    agendar();
                });

                rotularPausa();
                controles.appendChild(botaoPausa);

                secao.append(ant, prox, controles);

                // mouse ou teclado em cima: não troca sozinho
                secao.addEventListener("pointerenter", e => { if (e.pointerType === "mouse") { pausadoPorFoco = true; agendar(); } });
                secao.addEventListener("pointerleave", () => { pausadoPorFoco = false; agendar(); });
                secao.addEventListener("focusin", () => { pausadoPorFoco = true; agendar(); });
                secao.addEventListener("focusout", () => { pausadoPorFoco = false; agendar(); });

                // setas do teclado e deslizar o dedo
                secao.addEventListener("keydown", e => {
                    if (e.key === "ArrowLeft") { mostrar(indice - 1); agendar(); }
                    if (e.key === "ArrowRight") { mostrar(indice + 1); agendar(); }
                });

                let inicioX = null;

                secao.addEventListener("touchstart", e => { inicioX = e.touches[0].clientX; }, { passive: true });

                secao.addEventListener("touchend", e => {

                    if (inicioX === null) return;

                    const dx = e.changedTouches[0].clientX - inicioX;
                    inicioX = null;

                    if (Math.abs(dx) > 50) { mostrar(indice + (dx < 0 ? 1 : -1)); agendar(); }

                }, { passive: true });
            }

            // imagem que não carrega (arquivo apagado): sai do carrossel
            if (tipo === "banner") {
                secao.querySelectorAll("img.hc-imagem").forEach((img, n) => {
                    img.addEventListener("error", () => {
                        itens.splice(n, 1);
                        indice = 0;
                        desenhar();
                    }, { once: true });
                });
            }

            indice = Math.min(indice, slides.length - 1);
            mostrar(indice);
            agendar();
        }

        desenhar();

        celular.addEventListener("change", () => { indice = 0; desenhar(); });
        document.addEventListener("visibilitychange", () => { /* o intervalo reavalia na próxima volta */ });
    }

    async function iniciar() {

        let cfg = null;

        try {
            const resposta = await fetch("/api/aparencia", { cache: "no-cache" });
            if (resposta.ok) cfg = await resposta.json();
        } catch { /* mantém o visual padrão */ }

        if (!cfg) return;

        aplicarLogo(cfg);

        const hero = document.querySelector("section.hero");

        if (hero) montarBanner(hero, {
            banners_pc: cfg.banners_pc || [],
            banners_celular: cfg.banners_celular || [],
            destaques: cfg.destaques || [],
            intervalo: cfg.intervalo || 6
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", iniciar);
    } else {
        iniciar();
    }

})();
