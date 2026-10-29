// Páginas de produto (/produto/123) e feed de produtos para o Google Merchant Center (/feed.xml).
// Usa a mesma listarProdutos() da vitrine: o que não aparece na loja (inativo, sem preço) também não vai ao Google.
// Uso no server.js:  require("./feed-produtos")(app, listarProdutos);

const fs = require("fs");
const path = require("path");

const LOJA = "Closet Real";

// escapa texto para XML/HTML e tira caracteres de controle que quebrariam o XML
const esc = valor => String(valor ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const cortar = (texto, max) => {
    const t = String(texto ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};

const baseDoSite = req =>
    (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

const absoluta = (base, url) => {
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url.replace(/ /g, "%20");
    const caminho = String(url).replace(/^\.\//, "").replace(/ /g, "%20");
    return base + (caminho.startsWith("/") ? "" : "/") + caminho;
};

const preco = valor => `${Number(valor).toFixed(2)} BRL`;

// ---------- feed (RSS 2.0 com o namespace g: do Google) ----------

function itensDoProduto(p, base) {

    const link = `${base}/produto/${p.id}`;
    const imagens = (p.imagens || []).map(u => absoluta(base, u)).filter(Boolean);

    // sem foto o Google reprova o item: melhor nem enviar
    if (!imagens.length) return [];

    const comuns = (extra) => {

        const linhas = [
            `<g:title>${esc(cortar(p.nome, 150))}</g:title>`,
            `<g:description>${esc(cortar(p.descricao || p.nome, 5000))}</g:description>`,
            `<g:link>${esc(link)}</g:link>`,
            `<g:image_link>${esc(imagens[0])}</g:image_link>`,
            ...imagens.slice(1, 10).map(u => `<g:additional_image_link>${esc(u)}</g:additional_image_link>`),
            `<g:condition>new</g:condition>`,
            `<g:brand>${esc(LOJA)}</g:brand>`,
            `<g:identifier_exists>no</g:identifier_exists>`,
            `<g:google_product_category>1604</g:google_product_category>`,
            `<g:gender>female</g:gender>`,
            `<g:age_group>adult</g:age_group>`
        ];

        if (p.categoria) linhas.push(`<g:product_type>${esc(p.categoria)}</g:product_type>`);

        // "de X por Y": price é o preço cheio e sale_price o preço atual
        if (p.preco_antigo) {
            linhas.push(`<g:price>${preco(p.preco_antigo)}</g:price>`);
            linhas.push(`<g:sale_price>${preco(p.preco)}</g:sale_price>`);
        } else {
            linhas.push(`<g:price>${preco(p.preco)}</g:price>`);
        }

        return linhas.concat(extra);
    };

    const vars = p.variacoes || [];

    // produto sem variações cadastradas: um único item
    if (!vars.length) {
        return [[
            `<g:id>${esc(p.id)}</g:id>`,
            ...comuns([`<g:availability>${p.estoque > 0 ? "in_stock" : "out_of_stock"}</g:availability>`])
        ]];
    }

    // com variações: um item por cor/tamanho, todos ligados pelo item_group_id
    return vars.map(v => [
        `<g:id>${esc(`${p.id}-${v.id}`)}</g:id>`,
        `<g:item_group_id>${esc(p.id)}</g:item_group_id>`,
        ...comuns([
            `<g:availability>${v.estoque > 0 ? "in_stock" : "out_of_stock"}</g:availability>`,
            ...(v.nome ? [`<g:size>${esc(v.nome)}</g:size>`] : []),
            ...(v.cor ? [`<g:color>${esc(v.cor)}</g:color>`] : [])
        ])
    ]);
}

async function montarFeed(req, listarProdutos) {

    const base = baseDoSite(req);
    const produtos = await listarProdutos();

    const itens = produtos
        .flatMap(p => itensDoProduto(p, base))
        .map(linhas => `    <item>\n      ${linhas.join("\n      ")}\n    </item>`)
        .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${esc(LOJA)}</title>
    <link>${esc(base)}</link>
    <description>Moda feminina</description>
${itens}
  </channel>
</rss>
`;
}

// ---------- página de produto: o mesmo index.html, com o <head> preenchido para o produto ----------

function paginaDoProduto(html, produto, id, base) {

    // <base> faz os caminhos relativos (style.css, ./img/...) partirem da raiz mesmo em /produto/123
    let cabecalho = '<base href="/">';
    let titulo = `${LOJA} | Moda Feminina`;

    if (produto) {

        const url = `${base}/produto/${produto.id}`;
        const imagens = (produto.imagens || []).map(u => absoluta(base, u)).filter(Boolean);
        const descricao = cortar(produto.descricao || `${produto.nome} na ${LOJA}`, 200);
        titulo = `${produto.nome} | ${LOJA}`;

        const ld = {
            "@context": "https://schema.org",
            "@type": "Product",
            name: produto.nome,
            description: cortar(produto.descricao || produto.nome, 500),
            image: imagens,
            brand: { "@type": "Brand", name: LOJA },
            offers: {
                "@type": "Offer",
                url,
                priceCurrency: "BRL",
                price: Number(produto.preco).toFixed(2),
                itemCondition: "https://schema.org/NewCondition",
                availability: produto.estoque > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock"
            }
        };

        cabecalho += [
            `<meta name="description" content="${esc(descricao)}">`,
            `<link rel="canonical" href="${esc(url)}">`,
            `<meta property="og:type" content="product">`,
            `<meta property="og:site_name" content="${esc(LOJA)}">`,
            `<meta property="og:title" content="${esc(produto.nome)}">`,
            `<meta property="og:description" content="${esc(descricao)}">`,
            `<meta property="og:url" content="${esc(url)}">`,
            imagens[0] ? `<meta property="og:image" content="${esc(imagens[0])}">` : "",
            `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`
        ].join("\n    ");

    } else {
        titulo = `Produto não encontrado | ${LOJA}`;
        cabecalho += '<meta name="robots" content="noindex">';
    }

    return html
        .replace(/<title>[^<]*<\/title>/i, `<title>${esc(titulo)}</title>`)
        .replace(/(<meta charset="UTF-8">)/i, `$1\n    ${cabecalho}`);
}

module.exports = function registrar(app, listarProdutos) {

    const arquivoIndex = path.join(__dirname, "public", "index.html");

    app.get("/feed.xml", async (req, res) => {

        try {
            const xml = await montarFeed(req, listarProdutos);
            res.set("Content-Type", "application/xml; charset=utf-8");
            res.set("Cache-Control", "public, max-age=600");
            res.send(xml);
        } catch (erro) {
            console.log("ERRO FEED:", erro);
            res.status(500).type("text/plain").send("Erro ao gerar o feed");
        }
    });

    app.get(/^\/produto\/(\d+)\/?$/, async (req, res) => {

        try {

            const id = Number(req.params[0]);
            const produto = (await listarProdutos()).find(p => p.id === id) || null;
            const html = fs.readFileSync(arquivoIndex, "utf8");

            res.status(produto ? 200 : 404);
            res.set("Content-Type", "text/html; charset=utf-8");
            res.send(paginaDoProduto(html, produto, id, baseDoSite(req)));

        } catch (erro) {
            console.log("ERRO PAGINA PRODUTO:", erro);
            res.status(500).type("text/plain").send("Erro ao carregar o produto");
        }
    });
};
