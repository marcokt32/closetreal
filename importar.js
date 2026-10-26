const fs = require("fs");
const csv = require("csv-parser");

const produtos = [];

fs.createReadStream("produtos.csv")
  .pipe(csv())
  .on("data", (row) => {
    try {
      // pegar imagens válidas
      const imagens = Object.keys(row)
        .filter((key) => key.toLowerCase().includes("imagem"))
        .map((key) => row[key])
        .filter((url) => url && url.includes("http"));

      // descrição limpa (primeira linha só)
      const descricao = row["Descrição do Produto"]
        ?.split("\n")[0]
        ?.trim();

      const produto = {
        id: Number(row["ID do Produto"]),
        nome: row["Nome do Produto"]?.trim(),
        preco: 0, // você pode ajustar depois
        descricao: descricao,
        imagem: imagens[0] || "",
        imagens: imagens,
        estoque: 10
      };

      produtos.push(produto);

    } catch (err) {
      console.log("Erro ao processar:", row["Nome do Produto"]);
    }
  })
  .on("end", () => {
    fs.writeFileSync(
      "./public/produtos.json",
      JSON.stringify(produtos, null, 2)
    );

    console.log(`✅ ${produtos.length} produtos convertidos!`);
  });n