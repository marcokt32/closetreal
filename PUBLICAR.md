# Como publicar a Closet Real

Tempo estimado: meio dia, sem contar a espera do domínio propagar.
Depois de publicar, o ngrok deixa de ser necessário.

**Ordem recomendada**

1. Conferir o que você precisa ter (seção 1)
2. Escolher a hospedagem (seção 2)
3. Subir a loja (seção 3A ou 3B)
4. Domínio e HTTPS (seção 4)
5. Mercado Pago em produção (seção 5)
6. Melhor Envio em produção (seção 6)
7. Limpar os pedidos de teste e fazer **uma compra real de valor baixo** (seção 7)
8. Só então divulgar

Durante todo o processo, use a página **Sistema** do painel (`/sistema-admin.html`). Ela confere sozinha
quase tudo que está nesta lista e diz o que falta.

---

## 1. O que você precisa ter

| Item | Observação |
|---|---|
| Conta no **Registro.br** | O `.com.br` aceita CPF ou CNPJ. Os preços mudam: cerca de R$ 40 por ano segundo fontes de 2026; confira no site. |
| Conta **Mercado Pago** vendedora | Com as **credenciais de produção** liberadas (seção 5). |
| Conta **Melhor Envio** real | O sandbox é um cadastro à parte: endereço do remetente, documento e **saldo** precisam ser feitos de novo na conta real (seção 6). |
| **Hospedagem** | Seção 2. |
| E-mail da loja | O mesmo de `LOJA_EMAIL`. Ele aparece no rodapé e na página de contato. |

> **Fora do que o sistema faz:** vender com regularidade pode exigir CNPJ/MEI, emissão de nota fiscal e outras
> obrigações. Converse com um contador antes de abrir. A loja não emite nota fiscal.

---

## 2. Escolhendo a hospedagem

A loja usa **SQLite** e guarda as fotos em uma pasta. Por isso precisa de um **disco que não seja apagado**
a cada reinício, e de **um único processo** rodando.

| Opção | Serve? | O que saber |
|---|---|---|
| **Render, plano grátis** | **Não** | O disco é temporário (banco e fotos somem a cada reinício ou deploy) e o serviço "dorme" após 15 minutos sem visitas. |
| **Render, plano pago + Disk** | Sim | O disco persistente só existe em serviços pagos. Com disco, o serviço fica preso a uma instância e cada deploy tem uma pequena parada. |
| **Railway (plano Hobby) + Volume** | Sim | Cobra uma assinatura mensal pequena mais o uso, e o volume por GB. Um volume por serviço e uma pequena parada ao publicar versão nova. |
| **VPS** (servidor próprio na nuvem) | Sim | Preço fixo e controle total. Exige seguir alguns comandos (seção 3A). |

Os preços e planos mudam com frequência: **confira nas páginas oficiais antes de contratar.**

**Minha sugestão:** se você prefere não mexer em servidor, Railway ou Render pago com disco. Se quer o menor custo e não
se importa em seguir comandos, uma VPS com Ubuntu. Em qualquer caso, prefira uma região perto do Brasil.

Seja qual for a escolha, o servidor precisa ter **Node.js 22 (LTS)**. A versão mínima aceita é a 20.17.

---

## 3A. Publicando em uma VPS (Ubuntu 22.04 ou 24.04)

Troque `loja` e `SEU_DOMINIO.com.br` pelos seus. Os comandos abaixo rodam no servidor, por SSH.

### 1) Preparar o servidor

```bash
# usuário só para a loja (e use-o no lugar do root)
sudo adduser loja
sudo usermod -aG sudo loja
su - loja

sudo apt update && sudo apt install -y nginx ufw git curl

# Node.js 22 (LTS) e pm2 (mantém a loja no ar)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

# pasta dos dados: fica FORA da pasta do programa
sudo mkdir -p /var/lib/closetreal/uploads /var/lib/closetreal/backups
sudo chown -R loja:loja /var/lib/closetreal
```

### 2) Enviar o projeto

Envie a pasta `loja-api` para `/home/loja/loja-api` (por `git clone` de um repositório **privado** ou por SFTP).
**Não envie** `.env`, `loja.db`, `node_modules` nem `public/uploads` (o `.gitignore` já protege se você usar git).

```bash
cd ~/loja-api
npm ci --omit=dev
cp deploy/env.producao.example .env
nano .env        # preencha tudo (seção "Variáveis" abaixo)
```

### 3) Ligar a loja

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup      # copie e rode o comando que ele mostrar: é o que religa a loja se o servidor reiniciar
pm2 logs closetreal --lines 30    # deve aparecer "Servidor rodando em http://localhost:3000"
```

### 4) Nginx e firewall

```bash
sudo cp deploy/nginx-closetreal.conf /etc/nginx/sites-available/closetreal
sudo nano /etc/nginx/sites-available/closetreal      # troque SEU_DOMINIO.com.br
sudo ln -s /etc/nginx/sites-available/closetreal /etc/nginx/sites-enabled/closetreal
sudo nginx -t && sudo systemctl reload nginx

sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

O HTTPS vem na seção 4. **Atualizações futuras:** substitua os arquivos, rode `npm ci --omit=dev` e `pm2 restart closetreal`.

---

## 3B. Publicando no Railway ou no Render

1. Coloque o projeto em um repositório **privado** do GitHub (sem `.env`, `loja.db` e `public/uploads`; o `.gitignore` já cobre).
2. Crie um serviço "Web" apontando para o repositório. Comando de início: `npm start`.
3. **Crie o disco/volume** e monte em `/data`. No Render isso exige um plano pago.
4. Cadastre as variáveis de ambiente no painel da hospedagem (as mesmas de `deploy/env.producao.example`), com estas diferenças:
   - **não** defina `PORT` (a hospedagem define);
   - `DB_PATH=/data/loja.db`, `UPLOADS_DIR=/data/uploads`, `BACKUP_DIR=/data/backups`.
5. Configure a verificação de saúde (health check) para o caminho `/healthz`.
6. Ao final de cada deploy, confira em **Sistema** se aparece o IP real de quem acessa (veja o aviso sobre `TRUST_PROXY` abaixo).

---

## 4. Domínio e HTTPS

1. No **Registro.br**, registre o domínio.
2. No painel do Registro.br, abra o domínio e vá na parte de **DNS** (editar zona). Os nomes dos menus mudam com o tempo.
   - **VPS:** crie um registro **A** para `@` e outro para `www` apontando para o IP do servidor.
   - **Railway/Render:** adicione o domínio no painel da hospedagem; ela mostra o que cadastrar (normalmente um **CNAME**). Use `www.seudominio.com.br` como endereço principal e siga a orientação da hospedagem para o endereço sem `www`.
3. A propagação pode levar de alguns minutos a algumas horas.
4. **HTTPS:**
   - **VPS:** `sudo apt install -y certbot python3-certbot-nginx` e depois
     `sudo certbot --nginx -d SEU_DOMINIO.com.br -d www.SEU_DOMINIO.com.br`. O certificado é gratuito e renova sozinho.
   - **Railway/Render:** o certificado é emitido automaticamente depois que o domínio é confirmado.
5. Atualize `BASE_URL=https://SEU_DOMINIO.com.br` (sem barra no final) e reinicie a loja.
6. Em **Sistema**, "Endereço da loja" e "Você está acessando por HTTPS?" devem ficar verdes.

---

## Variáveis de ambiente (`.env`)

O modelo completo, comentado, está em `deploy/env.producao.example`. As que mudam em relação ao seu `.env` atual:

| Variável | Em produção |
|---|---|
| `NODE_ENV` | `production` (liga o cookie seguro do login) |
| `BASE_URL` | `https://SEU_DOMINIO.com.br` |
| `DB_PATH`, `UPLOADS_DIR`, `BACKUP_DIR` | pastas no disco persistente |
| `SESSION_SECRET`, `ADMIN_PASSWORD` | **novos**, só para produção (os atuais passaram por aqui) |
| `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` | os de **produção** (seção 5) |
| `MELHOR_ENVIO_URL`, `MELHOR_ENVIO_TOKEN` | os de **produção** (seção 6) |
| `TRUST_PROXY` | `1` com nginx, Railway ou Render. Se houver mais de um proxy na frente (ex.: Cloudflare + nginx), `2`. |

**`TRUST_PROXY`:** a página **Sistema** mostra o IP com que o servidor enxerga o seu acesso. Se aparecer sempre o mesmo número
interno (como `10.x.x.x`) para qualquer pessoa, o valor está baixo. Se aparecer um IP que você não reconhece, está alto.
Com o valor errado, o bloqueio de tentativas erradas de senha do painel pode atingir todo mundo de uma vez.

---

## 5. Mercado Pago em produção

1. No painel do Mercado Pago, em **Suas integrações**, abra a sua aplicação e vá em **Credenciais de produção**.
   Pode ser preciso ativá-las (o painel pede dados do negócio).
2. Copie o **Access Token de produção** para `MP_ACCESS_TOKEN`.
3. Em **Webhooks**, no modo **produtivo**:
   - URL: `https://SEU_DOMINIO.com.br/webhook`
   - Evento: **Pagamentos**
   - Copie a **assinatura secreta** para `MP_WEBHOOK_SECRET`. Ela é **diferente** da do modo de teste.
4. Reinicie a loja e, em **Sistema**, clique em **Conferir conta do Mercado Pago**. Deve aparecer **"Conta real"**.
   (As credenciais de teste e as reais começam igual; só essa conferência mostra a diferença.)
5. Use **Simular notificação** no painel do Mercado Pago. No log (`pm2 logs closetreal`) deve aparecer
   `Webhook: pagamento ... não encontrado no Mercado Pago`. Isso significa que a assinatura passou.

---

## 6. Melhor Envio em produção

O sandbox é outro cadastro. Na conta **real** do Melhor Envio:

1. Complete o cadastro com o mesmo remetente que está nas variáveis `LOJA_*` (nome, documento, endereço, telefone).
2. Adicione **saldo**: as etiquetas são pagas na hora em que são geradas.
3. Gere um **token** com as mesmas permissões que você marcou no sandbox.
4. No `.env`:
   - `MELHOR_ENVIO_URL=https://melhorenvio.com.br`
   - `MELHOR_ENVIO_TOKEN=` (o novo)
   - `ME_USER_AGENT=Closet Real (seu-email@dominio.com.br)`
5. Em **Sistema**, "Melhor Envio" deve aparecer em produção (não mais em teste).
6. Preencha **peso e medidas** dos produtos. Sem isso a loja usa um pacote padrão de 0,3 kg (20×5×25 cm) e o frete pode sair errado.
   A página **Sistema** diz quantos produtos ainda estão assim.

---

## 7. Antes de divulgar

### Tirar os pedidos de teste

Os pedidos de teste aparecem no painel e em "Meus pedidos". Para limpá-los **uma vez**, com o servidor parado:

```bash
pm2 stop closetreal
node scripts/limpar-pedidos-de-teste.js --sim --zerar-numeracao
pm2 start closetreal
```

O script guarda uma cópia do banco antes de apagar. Produtos, categorias, fotos e aparência **não** são mexidos.
Os pedidos de teste já descontaram estoque: **confira o estoque dos produtos** depois.

### A compra real de valor baixo

Faça com a loja ainda sem divulgar.

1. Cadastre um produto "Teste" de **R$ 1,00**, com peso e medidas, e ative.
2. Compre com cartão ou PIX de **outra conta**. O Mercado Pago normalmente não deixa a conta vendedora comprar de si mesma.
3. Confira, nesta ordem:
   - a página "Pedido recebido" muda sozinha para **"Pedido recebido!"**;
   - no painel, o pedido está **Pago** e o estoque da cor e do tamanho comprados **baixou**;
   - em **Meus pedidos**, pelo e-mail ou telefone, o andamento aparece.
4. **Gere a etiqueta.** Ela é **real e tem custo**: o valor sai do seu saldo no Melhor Envio. Imprima pelo painel e confira o PDF.
   Se não for postar, cancele a etiqueta no Melhor Envio para pedir o reembolso (confira a regra de cancelamento deles).
5. **Estorne o pagamento** pelo painel do Mercado Pago. O pedido deve virar **Cancelado** e o estoque deve voltar.
6. **Desative o produto de teste** e limpe o pedido de novo, se quiser.
7. Em **Sistema**, baixe uma **cópia do banco** e guarde fora do servidor.

### Última conferência

- [ ] **Sistema** sem nenhum item vermelho.
- [ ] Banner da home revisado. A faixa antiga "Toda Loja com 50% Off" só pode ficar se a promoção for real.
- [ ] Textos de **Trocas e devoluções** e **Privacidade** lidos e ajustados ao que você de fato pratica.
- [ ] Você abriu a loja pelo celular, fez a compra de teste e testou o menu.
- [ ] Senhas do painel, do Mercado Pago, do Melhor Envio, do Registro.br e da hospedagem são fortes e únicas; ative a verificação em duas etapas onde existir.

---

## 8. Rotina depois de publicar

**Backup.** Todo dia a loja guarda uma cópia do banco e das fotos em `BACKUP_DIR` (por padrão, as últimas 14).
Isso protege contra erro e exclusão sem querer, mas **não** contra a perda do disco. Por isso:

- baixe uma cópia pelo painel (Sistema > Baixar cópia) toda semana, ou antes de qualquer mudança grande, e guarde fora do servidor;
- o arquivo tem dados de clientes: guarde com cuidado.

**Restaurar** (servidor parado):

```bash
pm2 stop closetreal
node scripts/restaurar-backup.js backups/AAAA-MM-DD/loja.db --sim --fotos
pm2 start closetreal
```

O script recusa arquivos danificados e guarda o banco atual ao lado antes de trocar.

**Monitoramento.** Cadastre `https://SEU_DOMINIO.com.br/healthz` em um serviço gratuito de monitoramento (como o UptimeRobot;
confira os planos) para receber um aviso se a loja sair do ar.

**Atualizar a loja.** Na VPS: substitua os arquivos, `npm ci --omit=dev`, `pm2 restart closetreal`. Faça uma cópia do banco antes.

**Domínio.** Ative a renovação automática no Registro.br. Domínio vencido derruba a loja.

**Conferir às vezes.** Abra **Sistema** de vez em quando: ele avisa de backup parado, credencial errada e produtos sem medidas.

---

## 9. Se algo der errado

| Sintoma | Causa provável |
|---|---|
| Não consigo entrar no painel em produção | O login só funciona por **HTTPS** com `NODE_ENV=production`. Confira o certificado. Atrás de proxy, ele precisa enviar `X-Forwarded-Proto` (o nginx do guia já envia). |
| O painel volta sempre para a página de pedidos, ou o "Sair" não sai | Cookie antigo no navegador. Apague os cookies do site (ou use uma janela anônima). A loja já tolera isso, mas um cookie muito velho pode precisar ser apagado. |
| Pagamento aprovado, mas o pedido não muda | A notificação não chegou: confira a URL do webhook e o evento "Pagamentos" no painel do Mercado Pago. A loja confere sozinha a cada 10 minutos, e o botão **Verificar pagamento** do pedido força a conferência. |
| Notificação do Mercado Pago rejeitada (401 no log) | `MP_WEBHOOK_SECRET` de outro modo (teste x produção) ou colado errado. |
| Fotos e pedidos somem depois de reiniciar | Banco ou fotos em disco temporário. Use disco persistente e `DB_PATH` / `UPLOADS_DIR` apontando para ele. |
| Etiqueta falha | Sem saldo, remetente diferente do cadastrado ou token de outro ambiente (teste x produção). |
| Frete errado | Produtos sem peso e medidas. Veja o item em **Sistema**. |
| Erro ao enviar foto grande | `client_max_body_size` do nginx abaixo de 10m (o arquivo do guia já define). |

Onde olhar: `pm2 logs closetreal` (VPS) ou a aba de logs da hospedagem.

---

## Limitações que você deve conhecer

- **O estoque só baixa quando o pagamento é aprovado.** Dois clientes ainda podem comprar a última peça ao mesmo tempo. Nesse caso o painel mostra um aviso no pedido, mas não há bloqueio.
- **Não há e-mails automáticos** ao cliente (confirmação, envio). O cliente acompanha pela página do pedido e por "Meus pedidos".
- **Um único processo:** o SQLite não foi feito para vários servidores ao mesmo tempo. Não aumente o número de instâncias.
- **O backup diário fica no mesmo disco** do banco; veja a seção 8 sobre baixar uma cópia.
- **A planilha de importação** ainda não tem as colunas de preço antigo (promoção) e de destaque.
- **Não há emissão de nota fiscal.**
