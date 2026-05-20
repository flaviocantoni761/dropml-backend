require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const { Pool }   = require('pg');
const cors       = require('cors');
const crypto     = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
service: 'gmail',
auth: {
user: process.env.GMAIL_USER,
pass: process.env.GMAIL_PASS,
}
});

async function notificarLojista(pedido) {
try {
await transporter.sendMail({
from: process.env.GMAIL_USER,
to: process.env.GMAIL_USER,
subject: `Nova venda DropML - Pedido ${pedido.mlOrderId}`,
html: `<h2>Nova venda recebida!</h2> <p><b>Pedido ML:</b> ${pedido.mlOrderId}</p> <p><b>Produto:</b> ${pedido.title}</p> <p><b>Quantidade:</b> ${pedido.quantity}</p> <p><b>Comprador:</b> ${pedido.buyerName}</p>`
});
console.log('Email de notificacao enviado');
} catch (e) {
console.error('Erro ao enviar email:', e.message);
}
}

async function notificarComprador(telefone, pedido) {
try {
const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
await client.messages.create({
from: process.env.TWILIO_WHATSAPP_FROM,
to: `whatsapp:+55${telefone}`,
body: `Ola! Seu pedido ${pedido.mlOrderId} foi confirmado e esta sendo preparado para envio. Acompanhe pelo Mercado Livre.`
});
console.log('WhatsApp enviado para comprador');
} catch (e) {
console.error('Erro WhatsApp:', e.message);
}
}

const app  = express();
const PORT = process.env.PORT || process.env.port || 3000;
console.log('PORT ENV:', process.env.PORT);

// ─── SERVIR PAINEL DO LOJISTA ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
const f = path.join(__dirname, 'public', 'painel.html');
if (require('fs').existsSync(f)) res.sendFile(f);
else res.json({ ok: true, message: 'DropML Backend rodando!', endpoints: ['/auth/login', '/api/'] });
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── BANCO DE DADOS PostgreSQL ────────────────────────────────────────────────
const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
await pool.query(`CREATE TABLE IF NOT EXISTS ml_tokens ( id            SERIAL PRIMARY KEY, access_token  TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at    BIGINT NOT NULL, user_id       TEXT, created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT )`);

await pool.query(`CREATE TABLE IF NOT EXISTS products ( id              TEXT PRIMARY KEY, ml_id           TEXT NOT NULL, title           TEXT NOT NULL, image           TEXT, buy_price       REAL NOT NULL, sell_price      REAL NOT NULL, markup          REAL NOT NULL, link            TEXT, rep_score       REAL, supplier_ml_id  TEXT, active          INTEGER DEFAULT 1, created_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT )`);

await pool.query(`CREATE TABLE IF NOT EXISTS customers ( id           TEXT PRIMARY KEY, name         TEXT NOT NULL, email        TEXT, phone        TEXT, address      TEXT, city         TEXT, state        TEXT, zip          TEXT, ml_buyer_id  TEXT, created_at   BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT )`);

await pool.query(`CREATE TABLE IF NOT EXISTS orders ( id              TEXT PRIMARY KEY, customer_id     TEXT NOT NULL, product_id      TEXT NOT NULL, sell_price      REAL NOT NULL, buy_price       REAL NOT NULL, profit          REAL NOT NULL, payment_id      TEXT, payment_status  TEXT DEFAULT 'pending', ml_order_id     TEXT, ml_status       TEXT DEFAULT 'not_placed', ml_sale_id      TEXT, ml_sale_status  TEXT, status          TEXT DEFAULT 'pending', created_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT, updated_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT )`);

await pool.query(`CREATE TABLE IF NOT EXISTS payments ( id            TEXT PRIMARY KEY, order_id      TEXT NOT NULL, mp_payment_id TEXT, amount        REAL NOT NULL, status        TEXT DEFAULT 'pending', method        TEXT, pix_qr        TEXT, pix_code      TEXT, created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT )`);

await pool.query(`CREATE TABLE IF NOT EXISTS returns ( id            TEXT PRIMARY KEY, order_id      TEXT NOT NULL, reason        TEXT NOT NULL, details       TEXT, pix_key       TEXT NOT NULL, status        TEXT DEFAULT 'pending', ml_return_id  TEXT, ml_qr_code    TEXT, refund_id     TEXT, refund_status TEXT DEFAULT 'pending', expires_at    BIGINT, created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT, updated_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT )`);

console.log('✅ PostgreSQL conectado e tabelas criadas');
}

initDB().catch(err => console.error('Erro ao iniciar DB:', err));

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function dbGet(sql, params = []) {
// Converte ? para $1, $2, etc (PostgreSQL usa $N em vez de ?)
let i = 0;
const pgSql = sql.replace(/\?/g, () => `$${++i}`);
const result = await pool.query(pgSql, params);
return result.rows[0] || null;
}

async function dbAll(sql, params = []) {
let i = 0;
const pgSql = sql.replace(/\?/g, () => `$${++i}`);
const result = await pool.query(pgSql, params);
return result.rows;
}

async function dbRun(sql, params = []) {
let i = 0;
// Converte strftime('%s','now') para PostgreSQL
let pgSql = sql.replace(/strftime('%s','now')/g, `EXTRACT(EPOCH FROM NOW())::BIGINT`);
// Converte INSERT OR REPLACE para INSERT ... ON CONFLICT
pgSql = pgSql.replace(/INSERT OR REPLACE INTO/g, 'INSERT INTO');
// Adiciona ON CONFLICT DO NOTHING para upserts simples
if (pgSql.includes('INSERT INTO') && !pgSql.includes('ON CONFLICT')) {
pgSql = pgSql + ' ON CONFLICT (id) DO NOTHING';
}
pgSql = pgSql.replace(/\?/g, () => `$${++i}`);
const result = await pool.query(pgSql, params);
return result;
}

// ─── MERCADO LIVRE OAuth ──────────────────────────────────────────────────────
const ML = {
BASE:          'https://api.mercadolibre.com',
AUTH_URL:      'https://auth.mercadolivre.com.br/authorization',
TOKEN_URL:     'https://api.mercadolibre.com/oauth/token',
CLIENT_ID:     process.env.ML_CLIENT_ID     || 'SEU_APP_ID_AQUI',
CLIENT_SECRET: process.env.ML_CLIENT_SECRET || 'SEU_APP_SECRET_AQUI',
REDIRECT_URI:  process.env.ML_REDIRECT_URI  || 'http://localhost:3001/auth/callback',
};

async function getValidToken() {
const token = await dbGet('SELECT * FROM ml_tokens ORDER BY id DESC LIMIT 1');
if (!token) throw new Error('ML não autenticado. Acesse /auth/login');

const now = Math.floor(Date.now() / 1000);
if (token.expires_at > now + 60) return token.access_token;

const resp = await axios.post(ML.TOKEN_URL, {
grant_type:    'refresh_token',
client_id:     ML.CLIENT_ID,
client_secret: ML.CLIENT_SECRET,
refresh_token: token.refresh_token,
});

const { access_token, refresh_token, expires_in } = resp.data;
await pool.query(
'UPDATE ml_tokens SET access_token=$1, refresh_token=$2, expires_at=$3 WHERE id=$4',
[access_token, refresh_token, now + expires_in, token.id]
);
return access_token;
}

async function mlGet(path, params = {}) {
const token = await getValidToken();
const resp  = await axios.get(`${ML.BASE}${path}`, {
headers: { Authorization: `Bearer ${token}` },
params,
});
return resp.data;
}

async function mlPost(path, body) {
const token = await getValidToken();
const resp  = await axios.post(`${ML.BASE}${path}`, body, {
headers: {
Authorization:  `Bearer ${token}`,
'Content-Type': 'application/json',
},
});
return resp.data;
}

async function mlPut(path, body) {
const token = await getValidToken();
const resp  = await axios.put(`${ML.BASE}${path}`, body, {
headers: {
Authorization:  `Bearer ${token}`,
'Content-Type': 'application/json',
},
});
return resp.data;
}

function buildDescription(original) {
const attrs = (original.attributes || [])
.filter(a => a.value_name)
.slice(0, 8)
.map(a => `• ${a.name}: ${a.value_name}`)
.join('\n');

return [
original.title,
'',
original.descriptions?.[0]?.plain_text || '',
'',
attrs ? `Especificações:\n${attrs}` : '',
'',
'Produto com garantia. Enviamos com Mercado Envios.',
].filter(Boolean).join('\n').trim();
}

// ─── ROTAS: AUTH ML ───────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
const state = crypto.randomBytes(16).toString('hex');
const url = `${ML.AUTH_URL}?response_type=code&client_id=${ML.CLIENT_ID}&redirect_uri=${encodeURIComponent(ML.REDIRECT_URI)}&state=${state}`;
res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
const { code } = req.query;
if (!code) return res.status(400).json({ error: 'Código ausente' });

try {
const resp = await axios.post(ML.TOKEN_URL, {
grant_type:    'authorization_code',
client_id:     ML.CLIENT_ID,
client_secret: ML.CLIENT_SECRET,
code,
redirect_uri:  ML.REDIRECT_URI,
});

const { access_token, refresh_token, expires_in, user_id } = resp.data;
const expires_at = Math.floor(Date.now() / 1000) + expires_in;

await pool.query('DELETE FROM ml_tokens');
await pool.query(
  'INSERT INTO ml_tokens (access_token, refresh_token, expires_at, user_id) VALUES ($1,$2,$3,$4)',
  [access_token, refresh_token, expires_at, user_id]
);

res.json({ ok: true, message: 'Autenticado com Mercado Livre!', user_id });

} catch (err) {
console.error(err.response?.data || err.message);
res.status(500).json({ error: 'Falha na autenticação ML' });
}
});

app.get('/auth/status', async (req, res) => {
const token = await dbGet('SELECT user_id, expires_at FROM ml_tokens ORDER BY id DESC LIMIT 1');
if (!token) return res.json({ authenticated: false });
const ok = token.expires_at > Math.floor(Date.now() / 1000);
res.json({ authenticated: true, user_id: token.user_id, token_valid: ok });
});

// ─── ROTAS: BUSCA ML (pública) ────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
const { q, category, limit = 40 } = req.query;
if (!q) return res.status(400).json({ error: 'Parâmetro q obrigatório' });

try {
let url = `${ML.BASE}/sites/MLB/search?q=${encodeURIComponent(q)}&limit=${limit}`;
if (category) url += `&category=${category}`;

const resp = await mlGet(`/sites/MLB/search?q=${encodeURIComponent(q)}&limit=${limit}${category ? "&category="+category : ""}`);
const items = resp.results || [];

const analyzed = items.map(item => {
  const competitorMultiplier = 1.3 + Math.random() * 1.2;
  const maxPrice = item.price * competitorMultiplier;
  const spread   = ((maxPrice - item.price) / item.price) * 100;
  const repScore = calcRepScore(item.seller);

  return {
    id:          item.id,
    title:       item.title,
    price:       item.price,
    maxPrice,
    spread:      parseFloat(spread.toFixed(2)),
    repScore,
    image:       item.thumbnail?.replace('http://', 'https://'),
    link:        item.permalink,
    condition:   item.condition,
    freeShipping: item.shipping?.free_shipping,
    seller: {
      id:     item.seller?.id,
      power:  item.seller?.seller_reputation?.power_seller_status,
      level:  item.seller?.seller_reputation?.level_id,
      transactions: item.seller?.seller_reputation?.transactions?.completed,
    },
  };
});

const minSpread = parseFloat(req.query.minSpread || 0);
const minRep    = parseFloat(req.query.minRep    || 0);
const filtered  = analyzed
  .filter(p => p.spread >= minSpread && p.repScore >= minRep)
  .sort((a, b) => b.spread - a.spread);

res.json({ total: filtered.length, items: filtered });

} catch (err) {
console.error(err.message);
res.status(500).json({ error: 'Erro na busca ML' });
}
});

function calcRepScore(seller) {
if (!seller) return 50;
const power = seller.seller_reputation?.power_seller_status;
const level = seller.seller_reputation?.level_id;
const trx   = seller.seller_reputation?.transactions?.completed || 0;
if (power === 'platinum')        return 95;
if (power === 'gold')            return 85;
if (power === 'silver')          return 75;
if (level === '5_green')         return 90;
if (level === '4_light_green')   return 78;
if (level === '3_yellow')        return 65;
if (trx > 1000)                  return 80;
if (trx > 100)                   return 70;
return 55;
}

// ─── ROTAS: PRODUTOS ──────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
const products = await dbAll('SELECT * FROM products WHERE active=1 ORDER BY created_at DESC');
res.json(products);
});

app.post('/api/products', async (req, res) => {
const { ml_id, title, image, buy_price, sell_price, markup, link, rep_score } = req.body;
if (!ml_id || !title || !buy_price || !sell_price)
return res.status(400).json({ error: 'Campos obrigatórios: ml_id, title, buy_price, sell_price' });

const id = uuidv4();
await pool.query(
'INSERT INTO products (id, ml_id, title, image, buy_price, sell_price, markup, link, rep_score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
[id, ml_id, title, image, buy_price, sell_price, markup, link, rep_score]
);
const product = await dbGet('SELECT * FROM products WHERE id=?', [id]);
res.status(201).json(product);
});

app.put('/api/products/:id', async (req, res) => {
const { sell_price, markup, active } = req.body;
await pool.query(
'UPDATE products SET sell_price=COALESCE($1,sell_price), markup=COALESCE($2,markup), active=COALESCE($3,active) WHERE id=$4',
[sell_price, markup, active, req.params.id]
);
const product = await dbGet('SELECT * FROM products WHERE id=?', [req.params.id]);
res.json(product);
});

app.delete('/api/products/:id', async (req, res) => {
await pool.query('UPDATE products SET active=0 WHERE id=$1', [req.params.id]);
res.json({ ok: true });
});

// ─── ROTAS: CLIENTES ──────────────────────────────────────────────────────────
app.post('/api/customers', async (req, res) => {
const { name, email, phone, address, city, state, zip } = req.body;
if (!name) return res.status(400).json({ error: 'Nome obrigatório' });

if (email) {
const existing = await dbGet('SELECT * FROM customers WHERE email=?', [email]);
if (existing) return res.json(existing);
}

const id = uuidv4();
await pool.query(
'INSERT INTO customers (id, name, email, phone, address, city, state, zip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
[id, name, email, phone, address, city, state, zip]
);
const customer = await dbGet('SELECT * FROM customers WHERE id=?', [id]);
res.status(201).json(customer);
});

app.get('/api/customers', async (req, res) => {
const customers = await dbAll('SELECT * FROM customers ORDER BY created_at DESC');
res.json(customers);
});

// ─── ROTAS: PAGAMENTO (Mercado Pago PIX) ─────────────────────────────────────
app.post('/api/payments/pix', async (req, res) => {
const { order_id, amount, customer_email, customer_name, customer_cpf } = req.body;
if (!order_id || !amount) return res.status(400).json({ error: 'order_id e amount obrigatórios' });

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
if (!MP_TOKEN) {
const payment_id = 'DEMO-' + Date.now();
const pix_code   = `00020126580014br.gov.bcb.pix0136${uuidv4()}5204000053039865802BR5913DropML Loja6009Sao Paulo62070503***6304${Math.random().toString(36).substr(2,4).toUpperCase()}`;
await pool.query(
'INSERT INTO payments (id, order_id, mp_payment_id, amount, status, method, pix_code) VALUES ($1,$2,$3,$4,$5,$6,$7)',
[uuidv4(), order_id, payment_id, amount, 'demo', 'pix', pix_code]
);
await pool.query('UPDATE orders SET payment_id=$1, payment_status=$2 WHERE id=$3', [payment_id, 'demo', order_id]);
return res.json({ mode: 'demo', pix_code, payment_id, message: 'Configure MP_ACCESS_TOKEN para PIX real' });
}

try {
const resp = await axios.post('https://api.mercadopago.com/v1/payments', {
transaction_amount: amount,
description:        'Pedido DropML',
payment_method_id:  'pix',
payer: {
email:            customer_email || 'cliente@dropml.com',
first_name:       (customer_name || 'Cliente').split(' ')[0],
last_name:        (customer_name || 'DropML').split(' ').slice(1).join(' ') || 'DropML',
identification:   { type: 'CPF', number: customer_cpf || '00000000000' },
},
}, {
headers: {
Authorization:     `Bearer ${MP_TOKEN}`,
'X-Idempotency-Key': uuidv4(),
}
});

const { id: mp_id, point_of_interaction } = resp.data;
const pix_qr   = point_of_interaction?.transaction_data?.qr_code_base64;
const pix_code = point_of_interaction?.transaction_data?.qr_code;

const pay_id = uuidv4();
await pool.query(
  'INSERT INTO payments (id, order_id, mp_payment_id, amount, status, method, pix_qr, pix_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
  [pay_id, order_id, String(mp_id), amount, 'pending', 'pix', pix_qr, pix_code]
);
await pool.query('UPDATE orders SET payment_id=$1, payment_status=$2 WHERE id=$3', [String(mp_id), 'pending', order_id]);

res.json({ payment_id: mp_id, pix_qr, pix_code });

} catch (err) {
console.error(err.response?.data || err.message);
res.status(500).json({ error: 'Falha ao criar pagamento MP' });
}
});

// ─── ROTAS: ANÚNCIOS NA SUA CONTA ML ─────────────────────────────────────────
app.post('/api/listings', async (req, res) => {
const { ml_id, markup } = req.body;
if (!ml_id) return res.status(400).json({ error: 'ml_id obrigatório' });

try {
const original = await mlGet(`/items/${ml_id}`);
if (!original) return res.status(404).json({ error: 'Produto não encontrado no ML' });

const buyPrice  = original.price;
const mkp       = markup || parseFloat(process.env.DEFAULT_MARKUP || '40');
const sellPrice = parseFloat((buyPrice * (1 + mkp / 100)).toFixed(2));

const supplierDays  = original.shipping?.logistic_type === 'fulfillment' ? 3 : 7;
const handlingDays  = parseInt(process.env.HANDLING_DAYS || '2');
const totalDays     = supplierDays + handlingDays;

const listing = {
  title:        original.title,
  category_id:  original.category_id,
  price:        sellPrice,
  currency_id:  'BRL',
  available_quantity: Math.min(original.available_quantity || 10, 50),
  buying_mode:  'buy_it_now',
  condition:    original.condition,
  listing_type_id: 'gold_special',
  description:  { plain_text: buildDescription(original) },
  pictures:     (original.pictures || []).slice(0, 10).map(p => ({ source: p.url })),
  attributes:   (original.attributes || []).slice(0, 20),
  shipping: {
    mode:           'me2',
    local_pick_up:  false,
    free_shipping:  original.shipping?.free_shipping || false,
    logistic_type:  'drop_off',
    handling_time:  handlingDays,
  },
};

const created = await mlPost('/items', listing);

const id = uuidv4();
await pool.query(
  `INSERT INTO products (id, ml_id, title, image, buy_price, sell_price, markup, link, rep_score, supplier_ml_id)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
   ON CONFLICT (id) DO UPDATE SET ml_id=$2, title=$3, image=$4, buy_price=$5, sell_price=$6, markup=$7, link=$8, rep_score=$9, supplier_ml_id=$10`,
  [id, created.id, created.title, original.pictures?.[0]?.url || '', buyPrice, sellPrice, mkp,
   `https://www.mercadolivre.com.br/p/${created.id}`, 90, ml_id]
);

console.log(`✅ Anúncio criado: ${created.id} | Fornecedor: ${ml_id} | Preço: R$${sellPrice}`);
res.status(201).json({
  ok: true,
  your_listing_id:   created.id,
  supplier_item_id:  ml_id,
  buy_price:         buyPrice,
  sell_price:        sellPrice,
  markup:            mkp,
  url:               `https://www.mercadolivre.com.br/p/${created.id}`,
});

} catch (err) {
console.error('Erro criar anúncio ML:', err.response?.data || err.message);
res.status(500).json({ error: 'Falha ao criar anúncio no ML', detail: err.response?.data });
}
});

app.get('/api/listings', async (req, res) => {
try {
const token  = await dbGet('SELECT * FROM ml_tokens ORDER BY id DESC LIMIT 1');
if (!token)  return res.status(401).json({ error: 'ML não autenticado' });

const active = await mlGet(`/users/${token.user_id}/items/search?status=active&limit=50`);
const ids    = (active?.results || []).join(',');
if (!ids) return res.json([]);

const items  = await mlGet(`/items?ids=${ids}`);
const local  = await dbAll('SELECT * FROM products WHERE active=1');

const merged = (items || []).map(r => {
  const loc = local.find(l => l.ml_id === r.body?.id);
  return {
    id:              r.body?.id,
    title:           r.body?.title,
    sell_price:      r.body?.price,
    buy_price:       loc?.buy_price,
    markup:          loc?.markup,
    supplier_ml_id:  loc?.supplier_ml_id,
    status:          r.body?.status,
    sold_quantity:   r.body?.sold_quantity,
    url:             `https://www.mercadolivre.com.br/p/${r.body?.id}`,
    image:           r.body?.pictures?.[0]?.url,
  };
});

res.json(merged);
} catch (err) {
console.error(err.response?.data || err.message);
res.status(500).json({ error: 'Falha ao buscar anúncios' });
}
});

app.patch('/api/listings/:ml_item_id', async (req, res) => {
const { status } = req.body;
try {
const result = await mlPut(`/items/${req.params.ml_item_id}`, { status });
if (status === 'closed') {
await pool.query('UPDATE products SET active=0 WHERE ml_id=$1', [req.params.ml_item_id]);
}
res.json({ ok: true, status: result.status });
} catch (err) {
res.status(500).json({ error: err.response?.data || err.message });
}
});

// ─── WEBHOOK ML — VENDA REALIZADA ────────────────────────────────────────────
app.post('/webhooks/ml-orders', async (req, res) => {
const { resource, user_id, topic } = req.body;
if (topic !== 'orders_v2' && topic !== 'orders') return res.sendStatus(200);

try {
const mlOrder = await mlGet(resource.replace('https://api.mercadolibre.com', ''));
if (!mlOrder || mlOrder.status !== 'paid') return res.sendStatus(200);

const mlItemId  = mlOrder.order_items?.[0]?.item?.id;
const quantity  = mlOrder.order_items?.[0]?.quantity || 1;
const buyerId   = mlOrder.buyer?.id;
const mlOrderId = mlOrder.id;

console.log(`Venda ML recebida: pedido ${mlOrderId} | item ${mlItemId} | comprador ${buyerId}`);

const existing = await dbGet('SELECT id FROM orders WHERE ml_sale_id=?', [String(mlOrderId)]);
if (existing) { console.log('Pedido já processado'); return res.sendStatus(200); }

const product = await dbGet('SELECT * FROM products WHERE ml_id=?', [mlItemId]);
if (!product) {
  console.error(`Produto ${mlItemId} não encontrado no banco local`);
  return res.sendStatus(200);
}

const shipping  = await mlGet(`/shipments/${mlOrder.shipping?.id}`);
const buyerAddr = shipping?.receiver_address || {};

const deliveryAddress = {
  street_name:   buyerAddr.street_name   || '',
  street_number: buyerAddr.street_number || 'S/N',
  zip_code:      buyerAddr.zip_code      || '',
  city:          buyerAddr.city?.name    || '',
  state:         buyerAddr.state?.name   || '',
  country:       'BR',
  comment:       buyerAddr.comment       || '',
  receiver_name: `${mlOrder.buyer?.first_name || ''} ${mlOrder.buyer?.last_name || ''}`.trim(),
  receiver_phone: mlOrder.buyer?.phone?.number || '',
};

const orderId    = uuidv4();
const sellPrice  = mlOrder.total_amount;
const buyPrice   = product.buy_price;
const profit     = sellPrice - buyPrice;

let customer = await dbGet('SELECT * FROM customers WHERE ml_buyer_id=?', [String(buyerId)]);
if (!customer) {
  const custId = uuidv4();
  await pool.query(
    'INSERT INTO customers (id, name, email, address, city, state, zip, ml_buyer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [custId, `${mlOrder.buyer?.first_name} ${mlOrder.buyer?.last_name}`,
     mlOrder.buyer?.email || '',
     `${deliveryAddress.street_name}, ${deliveryAddress.street_number}`,
     deliveryAddress.city, deliveryAddress.state, deliveryAddress.zip_code, String(buyerId)]
  );
  customer = await dbGet('SELECT * FROM customers WHERE id=?', [custId]);
}

await pool.query(
  `INSERT INTO orders (id, customer_id, product_id, sell_price, buy_price, profit, payment_status, ml_sale_id, ml_sale_status, status)
   VALUES ($1,$2,$3,$4,$5,$6,'approved',$7,$8,'paid')`,
  [orderId, customer.id, product.id, sellPrice, buyPrice, profit, String(mlOrderId), mlOrder.status]
);

console.log(`Pedido ${orderId} salvo | Lucro: R$${profit.toFixed(2)}`);

await notificarLojista({
  mlOrderId: mlOrderId,
  title: product.title,
  quantity: quantity,
  buyerName: `${mlOrder.buyer?.first_name} ${mlOrder.buyer?.last_name}`
});

if (mlOrder.buyer?.phone) {
  await notificarComprador(mlOrder.buyer.phone.number, { mlOrderId });
}

await purchaseFromSupplier(orderId, product, deliveryAddress, quantity);

} catch (err) {
console.error('Webhook ML orders error:', err.response?.data || err.message);
}

res.sendStatus(200);
});

// ─── COMPRA DO FORNECEDOR ─────────────────────────────────────────────────────
async function purchaseFromSupplier(orderId, product, deliveryAddress, quantity = 1) {
try {
console.log(`Comprando fornecedor ${product.supplier_ml_id} → entrega: ${deliveryAddress.street_name}, ${deliveryAddress.city}`);

const cart = await mlPost('/checkout/cart', {
  items: [{ item_id: product.supplier_ml_id, quantity }]
});

if (!cart?.id) throw new Error('Falha ao criar carrinho ML');

const cartDetail = await mlGet(`/checkout/cart/${cart.id}`);
const shippingOption = cartDetail?.available_shipping_methods?.[0]?.id;

const checkout = await mlPost(`/checkout/cart/${cart.id}/purchase`, {
  shipping_option_id: shippingOption,
  shipping_address: {
    zip_code:      deliveryAddress.zip_code,
    street_name:   deliveryAddress.street_name,
    street_number: deliveryAddress.street_number,
    city:          { name: deliveryAddress.city },
    state:         { name: deliveryAddress.state },
    country:       { id: 'BR' },
    comment:       deliveryAddress.comment,
    receiver_name: deliveryAddress.receiver_name,
    receiver_phone:deliveryAddress.receiver_phone,
  },
  payment_data: { use_preferred_payment_method: true }
});

const supplierOrderId = checkout?.order_id || checkout?.id;
console.log(`Compra no fornecedor confirmada: ${supplierOrderId}`);

await pool.query(
  `UPDATE orders SET ml_order_id=$1, ml_status='placed', status='processing', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$2`,
  [String(supplierOrderId), orderId]
);

} catch (err) {
console.error('Erro compra fornecedor:', err.response?.data || err.message);
await pool.query(
`UPDATE orders SET ml_status='error', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`,
[orderId]
);
console.error(`ATENCAO: Pedido ${orderId} precisa de compra manual no ML`);
}
}

app.post('/api/orders/:id/purchase-supplier', async (req, res) => {
const order = await dbGet(`SELECT o.*, p.supplier_ml_id, p.buy_price, c.address, c.city, c.state, c.zip, c.name as customer_name FROM orders o LEFT JOIN products  p ON o.product_id  = p.id LEFT JOIN customers c ON o.customer_id = c.id WHERE o.id = ?`, [req.params.id]);

if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });

const product = await dbGet('SELECT * FROM products WHERE id=?', [order.product_id]);
const deliveryAddress = {
street_name:   order.address || '',
street_number: 'S/N',
zip_code:      order.zip    || '',
city:          order.city   || '',
state:         order.state  || '',
receiver_name: order.customer_name || '',
};

await purchaseFromSupplier(order.id, product, deliveryAddress, 1);
const updated = await dbGet('SELECT * FROM orders WHERE id=?', [req.params.id]);
res.json(updated);
});

app.get('/api/orders/:id/supplier-status', async (req, res) => {
const order = await dbGet('SELECT * FROM orders WHERE id=?', [req.params.id]);
if (!order || !order.ml_order_id) return res.status(404).json({ error: 'Pedido ou compra no fornecedor não encontrada' });

try {
const mlOrder = await mlGet(`/orders/${order.ml_order_id}`);
const shipment = mlOrder?.shipping?.id
? await mlGet(`/shipments/${mlOrder.shipping.id}`)
: null;

res.json({
  order_id:        order.id,
  supplier_order:  order.ml_order_id,
  ml_status:       mlOrder?.status,
  shipment_status: shipment?.status,
  tracking_number: shipment?.tracking_number,
  estimated_delivery: shipment?.estimated_delivery_final?.date,
});

} catch (err) {
res.status(500).json({ error: err.response?.data || err.message });
}
});

app.post('/api/orders', async (req, res) => {
const { product_id, customer_id, sell_price, buy_price } = req.body;
if (!product_id || !customer_id) return res.status(400).json({ error: 'product_id e customer_id obrigatórios' });

const product  = await dbGet('SELECT * FROM products WHERE id=?', [product_id]);
const customer = await dbGet('SELECT * FROM customers WHERE id=?', [customer_id]);
if (!product)  return res.status(404).json({ error: 'Produto não encontrado' });
if (!customer) return res.status(404).json({ error: 'Cliente não encontrado' });

const finalSell = sell_price || product.sell_price;
const finalBuy  = buy_price  || product.buy_price;
const profit    = finalSell  - finalBuy;
const id        = uuidv4();

await pool.query(
'INSERT INTO orders (id, customer_id, product_id, sell_price, buy_price, profit) VALUES ($1,$2,$3,$4,$5,$6)',
[id, customer_id, product_id, finalSell, finalBuy, profit]
);
const order = await dbGet('SELECT * FROM orders WHERE id=?', [id]);
res.status(201).json({ ...order, customer, product });
});

app.get('/api/orders', async (req, res) => {
const orders = await dbAll(`SELECT o.*, c.name as customer_name, c.email as customer_email, p.title as product_title, p.image as product_image FROM orders o LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN products  p ON o.product_id  = p.id ORDER BY o.created_at DESC`);
res.json(orders);
});

app.get('/api/orders/:id', async (req, res) => {
const order = await dbGet(`SELECT o.*, c.name as customer_name, c.email, c.address, c.city, c.state, c.zip, p.title as product_title, p.image, p.ml_id FROM orders o LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN products  p ON o.product_id  = p.id WHERE o.id=?`, [req.params.id]);
if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
res.json(order);
});

// ─── ROTAS: DEVOLUÇÕES ────────────────────────────────────────────────────────
app.get('/api/returns/find', async (req, res) => {
const { order_id, email } = req.query;
if (!order_id || !email) return res.status(400).json({ error: 'order_id e email obrigatórios' });

const order = await dbGet(`SELECT o.*, c.name as customer_name, c.email as customer_email, p.title as product_title, p.image as product_image, p.sell_price, p.buy_price FROM orders o LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN products  p ON o.product_id  = p.id WHERE o.id = ?`, [order_id]);

if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
if (order.customer_email?.toLowerCase() !== email.toLowerCase())
return res.status(403).json({ error: 'Email não corresponde ao pedido' });
if (order.payment_status !== 'approved' && order.payment_status !== 'demo')
return res.status(400).json({ error: 'Pedido não foi pago' });

const daysSince = (Math.floor(Date.now() / 1000) - order.created_at) / 86400;
if (daysSince > 15)
return res.status(400).json({ error: `Prazo de devolução expirado (${Math.floor(daysSince)} dias após compra)` });

const existing = await dbGet(`SELECT * FROM returns WHERE order_id = ? AND status NOT IN ('rejected','cancelled')`, [order_id]);
if (existing) return res.status(409).json({ error: 'Já existe uma solicitação de devolução para este pedido', return: existing });

res.json({
id:             order.id,
product_title:  order.product_title,
product_image:  order.product_image,
sell_price:     order.sell_price,
buy_price:      order.buy_price,
created_at:     order.created_at,
status:         order.status,
customer_email: order.customer_email,
ml_order_id:    order.ml_order_id,
days_since:     Math.floor(daysSince),
days_remaining: Math.max(0, 15 - Math.floor(daysSince)),
});
});

app.post('/api/returns', async (req, res) => {
const { order_id, reason, details, pix_key, email } = req.body;
if (!order_id || !reason || !pix_key)
return res.status(400).json({ error: 'order_id, reason e pix_key obrigatórios' });

const order = await dbGet(`SELECT o.*, c.email as customer_email, p.buy_price, p.sell_price, p.ml_id FROM orders o LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN products  p ON o.product_id  = p.id WHERE o.id = ?`, [order_id]);

if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });

const id         = uuidv4();
const expires_at = Math.floor(Date.now() / 1000) + (5 * 86400);

let ml_return_id = null;
let ml_qr_code   = null;

if (order.ml_order_id && !order.ml_order_id.startsWith('MLBR-SIM')) {
try {
const mlReturn = await mlPost(`/orders/${order.ml_order_id}/returns`, {
reason:  mapReasonToML(reason),
message: details || reason,
});
ml_return_id = mlReturn.id;
ml_qr_code   = mlReturn.label?.url || mlReturn.shipping_label;
} catch (err) {
console.error('Erro ao criar devolução ML:', err.response?.data || err.message);
}
}

if (!ml_qr_code) {
ml_qr_code = `DEV-${order_id}-${Date.now()}`.toUpperCase();
}

await pool.query(
'INSERT INTO returns (id, order_id, reason, details, pix_key, ml_return_id, ml_qr_code, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
[id, order_id, reason, details, pix_key, ml_return_id, ml_qr_code, expires_at]
);

await pool.query(
`UPDATE orders SET status='return_requested', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`,
[order_id]
);

const ret = await dbGet('SELECT * FROM returns WHERE id=?', [id]);
res.status(201).json({ ...ret, qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(ml_qr_code)}` });
});

app.get('/api/returns', async (req, res) => {
const returns = await dbAll(`SELECT r.*, o.sell_price, o.buy_price, o.ml_order_id, c.name as customer_name, c.email as customer_email, p.title as product_title, p.image as product_image FROM returns r LEFT JOIN orders    o ON r.order_id     = o.id LEFT JOIN customers c ON o.customer_id  = c.id LEFT JOIN products  p ON o.product_id   = p.id ORDER BY r.created_at DESC`);
res.json(returns);
});

app.get('/api/returns/:id', async (req, res) => {
const ret = await dbGet(`SELECT r.*, o.sell_price, o.buy_price, o.ml_order_id, c.name as customer_name, c.email, c.phone, p.title as product_title, p.image as product_image, p.ml_id FROM returns r LEFT JOIN orders    o ON r.order_id    = o.id LEFT JOIN customers c ON o.customer_id = c.id LEFT JOIN products  p ON o.product_id  = p.id WHERE r.id = ?`, [req.params.id]);
if (!ret) return res.status(404).json({ error: 'Devolução não encontrada' });

if (ret.ml_qr_code) {
ret.qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(ret.ml_qr_code)}`;
}
res.json(ret);
});

app.post('/api/returns/:id/approve', async (req, res) => {
const ret = await dbGet(`SELECT r.*, o.sell_price, o.buy_price, c.name as customer_name, c.email FROM returns r LEFT JOIN orders    o ON r.order_id    = o.id LEFT JOIN customers c ON o.customer_id = c.id WHERE r.id = ?`, [req.params.id]);

if (!ret) return res.status(404).json({ error: 'Devolução não encontrada' });
if (ret.status !== 'pending' && ret.status !== 'received')
return res.status(400).json({ error: `Devolução já está: ${ret.status}` });

await pool.query(
`UPDATE returns SET status='approved', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`,
[ret.id]
);

const refundResult = await issuePixRefund(ret);
if (refundResult.ok) {
await pool.query(
`UPDATE returns SET refund_id=$1, refund_status='processing', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$2`,
[refundResult.refund_id, ret.id]
);
await pool.query(
`UPDATE orders SET status='refunded', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`,
[ret.order_id]
);
}

const updated = await dbGet('SELECT * FROM returns WHERE id=?', [ret.id]);
res.json({ ...updated, refund: refundResult });
});

app.post('/api/returns/:id/reject', async (req, res) => {
const { reason } = req.body;
await pool.query(
`UPDATE returns SET status='rejected', details=COALESCE($1||' | Rejeição: '||COALESCE(details,''), details), updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$2`,
[reason || '', req.params.id]
);
await pool.query(
`UPDATE orders SET status='return_rejected', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=(SELECT order_id FROM returns WHERE id=$1)`,
[req.params.id]
);
const updated = await dbGet('SELECT * FROM returns WHERE id=?', [req.params.id]);
res.json(updated);
});

app.post('/api/returns/:id/received', async (req, res) => {
await pool.query(
`UPDATE returns SET status='received', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`,
[req.params.id]
);
await pool.query(
`UPDATE orders SET status='return_received', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=(SELECT order_id FROM returns WHERE id=$1)`,
[req.params.id]
);
res.json({ ok: true, message: 'Produto marcado como recebido. Aprovar para liberar reembolso.' });
});

function mapReasonToML(reason) {
const map = {
produto_diferente:  'ITEM_NOT_AS_DESCRIBED',
produto_danificado: 'ITEM_DAMAGED',
nao_funciona:       'ITEM_NOT_WORKING',
nao_gostei:         'BUYER_REMORSE',
tamanho_errado:     'WRONG_ITEM',
outro:              'OTHER',
};
return map[reason] || 'OTHER';
}

async function issuePixRefund(ret) {
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
if (!MP_TOKEN) {
console.log(`[DEMO] Reembolso PIX de R$${ret.sell_price} para chave: ${ret.pix_key}`);
return { ok: true, refund_id: 'DEMO-REFUND-' + Date.now(), demo: true };
}

try {
const payment = await dbGet(`SELECT mp_payment_id FROM payments WHERE order_id=? AND status IN ('approved','demo')`, [ret.order_id]);

if (payment?.mp_payment_id && !payment.mp_payment_id.startsWith('DEMO')) {
  const resp = await axios.post(
    `https://api.mercadopago.com/v1/payments/${payment.mp_payment_id}/refunds`,
    { amount: ret.sell_price },
    { headers: { Authorization: `Bearer ${MP_TOKEN}`, 'X-Idempotency-Key': uuidv4() } }
  );
  console.log(`Reembolso MP emitido: ${resp.data.id}`);
  return { ok: true, refund_id: String(resp.data.id) };
}

const resp = await axios.post('https://api.mercadopago.com/v1/payments', {
  transaction_amount: ret.sell_price,
  description:        `Reembolso pedido ${ret.order_id}`,
  payment_method_id:  'pix',
  payer:              { email: ret.email || 'reembolso@dropml.com' },
}, {
  headers: { Authorization: `Bearer ${MP_TOKEN}`, 'X-Idempotency-Key': uuidv4() }
});

return { ok: true, refund_id: String(resp.data.id) };

} catch (err) {
console.error('Erro reembolso MP:', err.response?.data || err.message);
return { ok: false, error: err.message };
}
}

app.post('/webhooks/ml-returns', async (req, res) => {
const { resource, user_id } = req.body;
if (!resource) return res.sendStatus(200);

try {
const mlData = await mlGet(resource.replace('https://api.mercadolibre.com',''));
if (mlData?.status === 'delivered' || mlData?.substatus === 'returned_to_seller') {
const ret = await dbGet('SELECT * FROM returns WHERE ml_return_id=?', [String(mlData.id)]);
if (ret) {
await pool.query(
`UPDATE returns SET status='received', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`,
[ret.id]
);
console.log(`ML confirmou devolução recebida: ${ret.id}`);
}
}
} catch (err) {
console.error('Webhook ML returns error:', err.message);
}
res.sendStatus(200);
});

// ─── ROTAS: DASHBOARD ─────────────────────────────────────────────────────────

// BUSCA PRODUTO POR ID ML
app.get('/api/items/:ml_id', async (req, res) => {
  try {
    const item = await mlGet('/items/' + req.params.ml_id);
    res.json(item);
  } catch (err) {
    res.status(404).json({ error: 'Produto nao encontrado', detail: err.response && err.response.data });
  }
});

app.get('/api/dashboard', async (req, res) => {
const [totalOrders]    = await dbAll('SELECT COUNT(*) as c FROM orders');
const [totalRevenue]   = await dbAll(`SELECT SUM(sell_price) as s FROM orders WHERE payment_status='approved'`);
const [totalProfit]    = await dbAll(`SELECT SUM(profit) as s FROM orders WHERE payment_status='approved' AND status NOT IN ('refunded','return_requested','return_received')`);
const [totalProducts]  = await dbAll('SELECT COUNT(*) as c FROM products WHERE active=1');
const [totalCustomers] = await dbAll('SELECT COUNT(*) as c FROM customers');
const [totalReturns]   = await dbAll('SELECT COUNT(*) as c FROM returns');
const [pendingReturns] = await dbAll(`SELECT COUNT(*) as c FROM returns WHERE status='pending'`);
const [refunded]       = await dbAll(`SELECT SUM(o.sell_price) as s FROM returns r LEFT JOIN orders o ON r.order_id=o.id WHERE r.status='approved'`);
const recentOrders     = await dbAll(`SELECT o.*, c.name as customer_name, p.title as product_title FROM orders o LEFT JOIN customers c ON o.customer_id=c.id LEFT JOIN products  p ON o.product_id=p.id ORDER BY o.created_at DESC LIMIT 5`);
const recentReturns    = await dbAll(`SELECT r.*, c.name as customer_name, p.title as product_title FROM returns r LEFT JOIN orders    o ON r.order_id=o.id LEFT JOIN customers c ON o.customer_id=c.id LEFT JOIN products  p ON o.product_id=p.id ORDER BY r.created_at DESC LIMIT 5`);

res.json({
totalOrders:    totalOrders.c,
totalRevenue:   totalRevenue.s   || 0,
totalProfit:    totalProfit.s    || 0,
totalProducts:  totalProducts.c,
totalCustomers: totalCustomers.c,
totalReturns:   totalReturns.c,
pendingReturns: pendingReturns.c,
totalRefunded:  refunded.s       || 0,
recentOrders,
recentReturns,
});
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
console.log(`\nDropML Backend rodando em http://localhost:${PORT}`);
console.log(`   Auth ML:  http://localhost:${PORT}/auth/login`);
console.log(`   API:      http://localhost:${PORT}/api/`);
console.log(`   Dashboard:http://localhost:${PORT}/api/dashboard\n`);
});
// redeploy Thu May 14 15:42:15     2026
// reconnect Thu May 14 15:57:18     2026
// upgrade
// fix db url
// fix db url
// new postgres
// fix pg credentials
// fix pg credentials
