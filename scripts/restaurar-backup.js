// Restaura uma cópia do banco de dados feita pela loja (pasta backups/AAAA-MM-DD/loja.db).
//
// IMPORTANTE: PARE o servidor antes (pm2 stop closetreal) e ligue de novo depois.
//
// Uso:
//   node scripts/restaurar-backup.js backups/2026-10-24/loja.db --sim
//   node scripts/restaurar-backup.js backups/2026-10-24/loja.db --sim --fotos
//
//  --sim     confirma que você entendeu que o banco ATUAL será substituído (ele é guardado ao lado)
//  --fotos   copia também as fotos de backups/uploads que estiverem faltando na pasta de fotos

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");

const [, , origem, ...opcoes] = process.argv;

const DB_PATH = process.env.DB_PATH || "loja.db";
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "..", "public", "uploads");

const sair = mensagem => {
    console.error(`\n❌ ${mensagem}\n`);
    process.exit(1);
};

if (!origem) sair("Informe a cópia a restaurar. Ex.: node scripts/restaurar-backup.js backups/2026-10-24/loja.db --sim");
if (!fs.existsSync(origem)) sair(`Arquivo não encontrado: ${origem}`);
if (!opcoes.includes("--sim")) {
    sair(
        `Isto vai SUBSTITUIR o banco atual (${path.resolve(DB_PATH)}) pela cópia ${origem}.\n` +
        "   O banco atual será guardado ao lado, mas o servidor precisa estar PARADO.\n" +
        "   Para continuar, rode de novo acrescentando --sim"
    );
}

// confere se a cópia é um banco SQLite íntegro e se é da loja
const banco = new sqlite3.Database(origem, sqlite3.OPEN_READONLY, erro => {
    if (erro) sair(`Não foi possível abrir a cópia: ${erro.message}`);
});

banco.get("PRAGMA integrity_check", (erro, linha) => {

    if (erro || !linha || linha.integrity_check !== "ok") {
        sair(`A cópia está danificada (${erro ? erro.message : JSON.stringify(linha)}). Nada foi alterado.`);
    }

    banco.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('pedidos', 'produtos')", (erro2, tabelas) => {

        if (erro2 || !tabelas || tabelas.n !== 2) {
            sair("Este arquivo não parece ser um banco da loja (faltam as tabelas de pedidos e produtos). Nada foi alterado.");
        }

        banco.get("SELECT (SELECT COUNT(*) FROM pedidos) AS pedidos, (SELECT COUNT(*) FROM produtos) AS produtos", (erro3, totais) => {

            banco.close(() => {

                const destino = path.resolve(DB_PATH);
                const agora = new Date().toISOString().replace(/[:.]/g, "-");

                if (fs.existsSync(destino)) {
                    const guardado = `${destino}.antes-da-restauracao-${agora}`;
                    fs.copyFileSync(destino, guardado);
                    console.log(`📦 Banco atual guardado em: ${guardado}`);
                }

                fs.mkdirSync(path.dirname(destino), { recursive: true });
                fs.copyFileSync(origem, destino);

                // arquivos temporários de um banco antigo não podem ficar misturados com o restaurado
                for (const extra of ["-journal", "-wal", "-shm"]) fs.rmSync(destino + extra, { force: true });

                console.log(`✅ Banco restaurado em ${destino}`);

                if (totais) console.log(`   Contém ${totais.pedidos} pedidos e ${totais.produtos} produtos.`);

                if (opcoes.includes("--fotos")) {

                    const fotos = path.join(path.dirname(path.resolve(origem)), "..", "uploads");

                    if (!fs.existsSync(fotos)) {
                        console.log("⚠️  Pasta de fotos do backup não encontrada; fotos não restauradas.");
                    } else {

                        fs.mkdirSync(UPLOADS_DIR, { recursive: true });

                        let copiadas = 0;

                        for (const nome of fs.readdirSync(fotos)) {
                            const alvo = path.join(UPLOADS_DIR, nome);
                            if (!fs.existsSync(alvo)) {
                                fs.copyFileSync(path.join(fotos, nome), alvo);
                                copiadas++;
                            }
                        }

                        console.log(`🖼️  ${copiadas} fotos restauradas em ${UPLOADS_DIR}`);
                    }
                }

                console.log("\nAgora ligue o servidor de novo (pm2 start closetreal).\n");
            });
        });
    });
});
