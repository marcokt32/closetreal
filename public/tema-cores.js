// Tema de cores da loja. Usado DOS DOIS LADOS:
//  - no servidor (require) para reescrever os CSS com a cor escolhida;
//  - no painel (tag <script>) para mostrar a prévia.
//
// Ideia: o site inteiro é feito de uma cor principal (o rosé #B76E79) e de tons derivados dela
// (mais escuros para textos e botões ao passar o mouse, mais claros para fundos e bordas).
// Ao escolher outra cor principal, todos os tons são recalculados mantendo as mesmas relações,
// então a combinação sai sempre harmônica. Cores de erro (vermelho), sucesso (verde) e os cinzas não mudam.

(function (raiz, fabrica) {
    if (typeof module === "object" && module.exports) module.exports = fabrica();
    else raiz.TemaCores = fabrica();
})(typeof self !== "undefined" ? self : this, function () {

    "use strict";

    const PADRAO = "#b76e79";

    // Tons do tema original que aparecem nos CSS (todos da família do rosé)
    const FAMILIA = [
        "b76e79", "a05a65", "8a4a54", "7a4a52", "5a3a40", "4a3036",
        "a98a90", "b8a3a6", "c9b3b6", "d9bfc3", "d6bfbb", "d9c4c0",
        "e3d2d4", "e8c9cd", "ecd9d4", "ead9d4", "f0e0dc", "f0e2dd",
        "f3e6e2", "f3e3dc", "e8e0dd", "f7d9d3", "fae9e1", "fdf7f4"
    ];

    const PRESETS = [
        { id: "rose", nome: "Rosé", cor: "#b76e79" },
        { id: "vinho", nome: "Vinho", cor: "#9b3d55" },
        { id: "terracota", nome: "Terracota", cor: "#b5603f" },
        { id: "salvia", nome: "Verde sálvia", cor: "#5d8a6c" },
        { id: "petroleo", nome: "Azul petróleo", cor: "#3e7a84" },
        { id: "marinho", nome: "Azul clássico", cor: "#3d5a99" },
        { id: "lilas", nome: "Lilás", cor: "#8467a8" },
        { id: "grafite", nome: "Grafite", cor: "#5b5b66" }
    ];

    const limitar = (v, min, max) => Math.min(max, Math.max(min, v));

    function normalizar(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
        return m ? `#${m[1].toLowerCase()}` : null;
    }

    const hexParaRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

    const rgbParaHex = ([r, g, b]) =>
        "#" + [r, g, b].map(v => Math.round(limitar(v, 0, 255)).toString(16).padStart(2, "0")).join("");

    function rgbParaHsl([r, g, b]) {

        r /= 255; g /= 255; b /= 255;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const l = (max + min) / 2;
        const d = max - min;

        if (d === 0) return [0, 0, l];

        const s = d / (1 - Math.abs(2 * l - 1));

        let h;
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;

        return [(h * 60 + 360) % 360, s, l];
    }

    function hslParaRgb([h, s, l]) {

        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = l - c / 2;

        let r = 0, g = 0, b = 0;

        if (h < 60) [r, g, b] = [c, x, 0];
        else if (h < 120) [r, g, b] = [x, c, 0];
        else if (h < 180) [r, g, b] = [0, c, x];
        else if (h < 240) [r, g, b] = [0, x, c];
        else if (h < 300) [r, g, b] = [x, 0, c];
        else [r, g, b] = [c, 0, x];

        return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
    }

    const hexParaHsl = hex => rgbParaHsl(hexParaRgb(hex));
    const hslParaHex = hsl => rgbParaHex(hslParaRgb(hsl));

    function luminancia(hex) {
        const [r, g, b] = hexParaRgb(hex).map(v => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function contraste(a, b) {
        const la = luminancia(a);
        const lb = luminancia(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }

    // A cor principal vira fundo de botão com texto branco e título sobre o rodapé escuro:
    // não pode ser clara demais (texto branco some) nem escura demais (some no rodapé).
    function ajustarPrimaria(hex) {

        const original = normalizar(hex) || PADRAO;

        let [h, s, l] = hexParaHsl(original);

        l = limitar(l, 0.32, 0.6);

        let atual = hslParaHex([h, s, l]);

        while (contraste("#ffffff", atual) < 3 && l > 0.15) {
            l -= 0.01;
            atual = hslParaHex([h, s, l]);
        }

        return { hex: atual, ajustada: atual !== original };
    }

    const cacheDeMapas = new Map();

    // Para cada tom da família, o tom equivalente na nova cor principal
    function mapaDeCores(primaria) {

        const { hex: nova } = ajustarPrimaria(primaria);

        if (cacheDeMapas.has(nova)) return cacheDeMapas.get(nova);

        const [h0, s0, l0] = hexParaHsl(PADRAO);
        const [hc, sc, lc] = hexParaHsl(nova);

        const escala = limitar(sc / s0, 0, 1.35);
        const delta = lc - l0;

        const mapa = new Map();

        FAMILIA.forEach(tom => {

            const original = `#${tom}`;

            if (original === PADRAO) {
                mapa.set(tom, nova);
                return;
            }

            const [h, s, l] = hexParaHsl(original);

            const h2 = (h - h0 + hc + 360) % 360;
            const s2 = limitar(s * escala, 0, 1);

            // tons claros (fundos e bordas) ficam claros; os médios e escuros acompanham a cor principal
            let l2 = l >= 0.85 ? l : limitar(l + delta, 0.08, 0.84);

            let novo = hslParaHex([h2, s2, l2]);

            // tons escuros são usados como TEXTO: precisam de contraste com o branco
            if (l <= 0.5) {
                while (contraste("#ffffff", novo) < 4.5 && l2 > 0.1) {
                    l2 -= 0.01;
                    novo = hslParaHex([h2, s2, l2]);
                }
            }

            mapa.set(tom, novo);
        });

        cacheDeMapas.set(nova, mapa);

        return mapa;
    }

    function aplicarCores(css, primaria) {

        const alvo = normalizar(primaria) || PADRAO;

        if (alvo === PADRAO) return css;

        const mapa = mapaDeCores(alvo);
        const [r, g, b] = hexParaRgb(ajustarPrimaria(alvo).hex);

        return String(css)
            .replace(/#([0-9a-fA-F]{6})\b/g, (todo, tom) => mapa.get(tom.toLowerCase()) || todo)
            .replace(/rgba\(\s*183\s*,\s*110\s*,\s*121\s*,/g, `rgba(${r}, ${g}, ${b},`);
    }

    // Os cinco tons principais, para a prévia do painel
    function paleta(primaria) {

        const alvo = normalizar(primaria) || PADRAO;
        const mapa = alvo === PADRAO ? null : mapaDeCores(alvo);
        const pega = tom => (mapa ? mapa.get(tom) : `#${tom}`);

        return {
            primaria: pega("b76e79"),
            escura: pega("a05a65"),
            texto: pega("8a4a54"),
            suave: pega("f7d9d3"),
            fundo: pega("fae9e1")
        };
    }

    return { PADRAO, PRESETS, normalizar, ajustarPrimaria, aplicarCores, paleta, contraste };
});
