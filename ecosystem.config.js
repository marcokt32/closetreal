// Configuração do pm2 (mantém a loja no ar e a reinicia se cair).
// Uso:  pm2 start ecosystem.config.js && pm2 save
module.exports = {
    apps: [
        {
            name: "closetreal",
            script: "server.js",
            cwd: __dirname,            // é daqui que o servidor lê o arquivo .env
            instances: 1,              // SQLite: um único processo
            exec_mode: "fork",
            autorestart: true,
            max_memory_restart: "400M",
            kill_timeout: 12000,       // dá tempo do servidor fechar o banco antes do pm2 forçar
            time: true,                // data e hora nos logs
            env: { NODE_ENV: "production" }
        }
    ]
};
