// Apaga TODOS os pedidos (e os pagamentos e históricos ligados a eles) do banco.
// Use UMA vez, antes de divulgar a loja, para tirar os pedidos de teste. Produtos, categorias,
// fotos, aparência e configurações NÃO são mexidos.
//
// ATENÇÃO:
//  - PARE o servidor antes (pm2 stop closetreal) e ligue de novo depois.
//  - Os pedidos de teste já descontaram estoque. Depois de limpar, confira o estoque dos produtos no painel.
//  - Não há como desfazer, exceto restaurando a cópia que este script guarda ao lado do banco.
//
// Uso:
//   node scripts/limpar-pedidos-de-teste.js --sim
//   node scripts/limpar-pedidos-de-teste.js --sim --zerar-numeracao     (o próximo pedido volta a ser o nº 1)

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");

const opcoes = process.argv.slice(2);
const DB_PATH = path.resolve(process.env.DB_PATH || "loja.db");

const sair = mensagem => {
    console.error(`\n❌ ${mensagem}\n`);
    process.exit(1);
};

if (!fs.existsSync(DB_PATH)) sair(`Banco não encontrado: ${DB_PATH}`);

if (!opcoes.includes("--sim")) {
    sair(
        `Isto vai APAGAR todos os pedidos de ${DB_PATH}.\n` +
        "   Uma cópia do banco é guardada ao lado antes de apagar, e o servidor precisa estar PARADO.\n" +
        "   Para continuar, rode de novo acrescentando --sim"
    );
}

const agora = new Date().toISOString().replace(/[:.]/g, "-");
const copia = `${DB_PATH}.antes-da-limpeza-${agora}`;

fs.copyFileSync(DB_PATH, copia);
console.log(`📦 Cópia guardada em: ${copia}`);

const db = new sqlite3.Database(DB_PATH);

const rodar = (sql, params = []) =>
    new Promise((ok, falha) => db.run(sql, params, function (erro) { erro ? falha(erro) : ok(this.changes); }));

const buscar = (sql) =>
    new Promise((ok, falha) => db.get(sql, (erro, linha) => erro ? falha(erro) : ok(linha)));

const existe = async tabela =>
    (await buscar(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${tabela}'`)).n === 1;

(async () => {

    try {

        const { n } = await buscar("SELECT COUNT(*) AS n FROM pedidos");

        // os gatilhos do banco apagam o histórico sozinhos, mas limpamos tudo explicitamente
        await rodar("BEGIN");

        for (const tabela of ["pedido_eventos", "pagamentos_mp", "pedido_itens", "pedidos"]) {
            if (await existe(tabela)) {
                const apagadas = await rodar(`DELETE FROM ${tabela}`);
                console.log(`🗑️  ${tabela}: ${apagadas} linhas`);
            }
        }

        if (opcoes.includes("--zerar-numeracao") && await existe("sqlite_sequence")) {
            await rodar("DELETE FROM sqlite_sequence WHERE name IN ('pedidos', 'pedido_itens', 'pedido_eventos')");
            console.log("🔢 Numeração dos pedidos zerada (o próximo será o nº 1).");
        }

        await rodar("COMMIT");

        await rodar("VACUUM");

        console.log(`\n✅ ${n} pedidos de teste removidos. Confira o estoque dos produtos no painel antes de abrir a loja.\n`);

    } catch (erro) {
        await rodar("ROLLBACK").catch(() => {});
        sair(`Falhou e nada foi apagado: ${erro.message}`);
    } finally {
        db.close();
    }
})();
