DropML — Dropshipping com Mercado Livre
Backend completo para dropshipping usando o Mercado Livre como canal de vendas e fornecedor.

Arquitetura
Comprador → compra no seu anúncio ML
         → webhook notifica o DropML
         → DropML compra do fornecedor ML com endereço do comprador como destino
         → Você recebe email de notificação
         → Comprador recebe WhatsApp de confirmação

Stack

Runtime: Node.js v18+
Framework: Express
Banco de dados: PostgreSQL (Railway)
OAuth: Mercado Livre
Email: Nodemailer + Gmail
WhatsApp: Twilio
Deploy: Railway


Variáveis de Ambiente
Configure no Railway → serviço dropml-backend → Variables:
VariávelDescriçãoNODE_ENVproductionPORT3000ML_CLIENT_IDID do app no ML DevelopersML_CLIENT_SECRETSecret do app no ML DevelopersML_REDIRECT_URIhttps://SEU-DOMINIO.up.railway.app/auth/callbackFRONTEND_URLURL do frontend (ou * para liberar tudo)JWT_SECRETChave secreta para JWT (qualquer string aleatória)DEFAULT_MARKUPMarkup padrão em % (ex: 40)HANDLING_DAYSDias de manuseio antes de postar (ex: 2)MP_ACCESS_TOKENToken do Mercado Pago (para PIX real)GMAIL_USEREmail Gmail para notificações (ex: seuemail@gmail.com)GMAIL_PASSSenha de app do Gmail (gerada em myaccount.google.com/apppasswords)TWILIO_ACCOUNT_SIDAccount SID do TwilioTWILIO_AUTH_TOKENAuth Token do TwilioTWILIO_WHATSAPP_FROMwhatsapp:+14155238886 (sandbox Twilio)DATABASE_URLURL completa do PostgreSQL (copiada do serviço Postgres no Railway)DB_PATHNão necessário com PostgreSQL

Configuração do App no Mercado Livre

Acessa: https://developers.mercadolivre.com.br/devcenter/edit-app/SEU_APP_ID
Em URIs de redirect adiciona: https://SEU-DOMINIO.up.railway.app/auth/callback
Em URL de retorno (webhook) coloca: https://SEU-DOMINIO.up.railway.app/webhooks/ml-orders
Ativa os fluxos: Authorization Code e Refresh Token
Salva


Deploy no Railway
Pré-requisitos

Conta no Railway (railway.app) — plano Hobby ($5/mês)
Repositório no GitHub com server.js e package.json
Git instalado localmente

Passo a passo
1. Criar projeto no Railway

Acessa railway.app → New Project
Deploy from GitHub → seleciona o repositório dropml-backend

2. Adicionar PostgreSQL

No projeto → clica em + New → Database → PostgreSQL
Aguarda o banco ser criado

3. Conectar banco ao backend

No serviço dropml-backend → Variables
Adiciona DATABASE_URL com a URL completa do PostgreSQL
A URL está em: serviço Postgres → Variables → olho ao lado de DATABASE_URL
Formato: postgresql://postgres:SENHA@postgres.railway.internal:5432/railway

4. Configurar variáveis de ambiente

No serviço dropml-backend → Variables
Adiciona todas as variáveis da tabela acima

5. Configurar networking

No serviço dropml-backend → Settings → Networking
Verifica que o domínio público está apontando para a porta correta (mesma que o PORT)

6. Configurar Health Check

No serviço dropml-backend → Settings
Healthcheck Path: /
Healthcheck Timeout: 300

7. Deploy
bash# Instala Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link ao projeto
railway link

# Deploy
railway up --detach

Autenticação com Mercado Livre
Após o deploy, acessa:
https://SEU-DOMINIO.up.railway.app/auth/login
Isso redireciona para o ML, você autoriza, e o token é salvo no banco.
Para verificar:
https://SEU-DOMINIO.up.railway.app/auth/status
Resposta esperada:
json{"authenticated": true, "user_id": "SEU_USER_ID", "token_valid": true}

Configuração do Gmail (notificações para o lojista)

Acessa myaccount.google.com/apppasswords
Cria uma senha de app com o nome DropML
Copia a senha de 16 caracteres gerada
Adiciona nas variáveis: GMAIL_USER e GMAIL_PASS


Configuração do Twilio (WhatsApp para o comprador)

Cria conta em twilio.com
Acessa Messaging → Try it out → Send a WhatsApp message
Ativa o sandbox aceitando os termos
No celular, envia WhatsApp para +1 415 523 8886 com o texto join birds-greater
Copia o Account SID e Auth Token do painel
Adiciona nas variáveis: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM


Endpoints principais
MétodoRotaDescriçãoGET/auth/loginInicia OAuth com MLGET/auth/callbackCallback do OAuthGET/auth/statusStatus da autenticaçãoGET/api/searchBusca produtos no MLPOST/api/listingsCria anúncio na sua conta MLGET/api/listingsLista seus anúncios ativosPATCH/api/listings/:idPausa/reativa/fecha anúncioGET/api/ordersLista pedidosGET/api/dashboardDashboard com métricasPOST/webhooks/ml-ordersWebhook de vendas do MLPOST/api/returnsSolicitar devoluçãoGET/api/returnsListar devoluções

Fluxo de uma venda

Comprador compra seu anúncio no ML
ML envia notificação para /webhooks/ml-orders
DropML busca detalhes do pedido na API do ML
DropML busca endereço de entrega do comprador
DropML salva o pedido no banco PostgreSQL
DropML envia email de notificação para o lojista
DropML envia WhatsApp de confirmação para o comprador
DropML compra o produto do fornecedor original no ML com o endereço do comprador como destino de entrega


Dependências (package.json)
json{
  "dependencies": {
    "axios": "^1.7.2",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "nodemailer": "^6.9.9",
    "pg": "^8.11.3",
    "twilio": "^5.3.0",
    "uuid": "^10.0.0"
  },
  "scripts": {
    "start": "node server.js"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}

Roadmap

 A — Backend no Railway
 B — OAuth Mercado Livre
 C — Notificações (email lojista + WhatsApp comprador)
 D — Migração para PostgreSQL
 E — PWA mobile (painel do lojista no celular)
 F — Multi-tenancy (múltiplos lojistas)


Solução de problemas comuns
"Application failed to respond" no Railway

Verifica se a porta no código usa process.env.PORT
Verifica se o app.listen usa '0.0.0.0'
Verifica se o domínio em Networking aponta para a porta correta

"password authentication failed" no PostgreSQL

A DATABASE_URL está com senha incorreta
Pega a URL diretamente do serviço Postgres → Variables → olho no DATABASE_URL

"Cannot find module 'pg'"

O pacote pg não está no package.json
Adiciona "pg": "^8.11.3" nas dependencies

OAuth ML "não foi possível conectar"

O ML_REDIRECT_URI não está cadastrado no app do ML Developers
Acessa o app em developers.mercadolivre.com.br e adiciona a URI de redirect


Documentação atualizada em maio de 2026
