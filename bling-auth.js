const axios = require('axios');

const BLING_CLIENT_ID     = process.env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const BLING_REDIRECT_URI  = process.env.BLING_REDIRECT_URI
  || 'https://dropml-backend-production.up.railway.app/auth/bling/callback';

const BLING_AUTH_URL  = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const BLING_API_BASE  = 'https://api.bling.com.br/Api/v3';

async function initBlingTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bling_tokens (
      id           SERIAL PRIMARY KEY,
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    BIGINT NOT NULL,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('[Bling] Tabela bling_tokens OK');
}

async function saveBlingTokens(pool, accessToken, refreshToken, expiresIn) {
  const expiresAt = Date.now() + (expiresIn - 60) * 1000;
  await pool.query('DELETE FROM bling_tokens');
  await pool.query(
    'INSERT INTO bling_tokens (access_token, refresh_token, expires_at) VALUES ($1, $2, $3)',
    [accessToken, refreshToken, expiresAt]
  );
  console.log('[Bling] Tokens salvos. Expira em:', new Date(expiresAt).toISOString());
}

async function loadBlingTokens(pool) {
  const result = await pool.query('SELECT * FROM bling_tokens ORDER BY id DESC LIMIT 1');
  return result.rows[0] || null;
}

async function exchangeCodeForTokens(pool, code) {
  const credentials = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
  const response = await axios.post(
    BLING_TOKEN_URL,
    new URLSearchParams({
      grant_type:   'authorization_code',
      code:         code,
      redirect_uri: BLING_REDIRECT_URI,
    }),
    {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Accept':        'application/json',
      },
    }
  );
  const { access_token, refresh_token, expires_in } = response.data;
  await saveBlingTokens(pool, access_token, refresh_token, expires_in);
  return { access_token, refresh_token };
}

async function refreshBlingToken(pool) {
  const stored = await loadBlingTokens(pool);
  if (!stored) throw new Error('[Bling] Nenhum token salvo. Faca o OAuth primeiro.');
  const credentials = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
  const response = await axios.post(
    BLING_TOKEN_URL,
    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: stored.refresh_token,
    }),
    {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Accept':        'application/json',
      },
    }
  );
  const { access_token, refresh_token, expires_in } = response.data;
  await saveBlingTokens(pool, access_token, refresh_token, expires_in);
  console.log('[Bling] Token renovado com sucesso.');
  return access_token;
}

async function getValidBlingToken(pool) {
  const stored = await loadBlingTokens(pool);
  if (!stored) throw new Error('[Bling] Nao autenticado. Acesse /auth/bling para autorizar.');
  if (Date.now() >= stored.expires_at) {
    console.log('[Bling] Token expirado, renovando...');
    return await refreshBlingToken(pool);
  }
  return stored.access_token;
}

async function blingRequest(pool, method, endpoint, data = null) {
  const token = await getValidBlingToken(pool);
  const config = {
    method,
    url: `${BLING_API_BASE}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
  };
  if (data) config.data = data;
  try {
    const response = await axios(config);
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data;
    console.error(`[Bling] Erro ${status} em ${method} ${endpoint}:`, msg);
    throw err;
  }
}

function registerRoutes(app, pool) {
  app.get('/auth/bling', (req, res) => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     BLING_CLIENT_ID,
      redirect_uri:  BLING_REDIRECT_URI,
    });
    const authUrl = `${BLING_AUTH_URL}?${params.toString()}`;
    res.redirect(authUrl);
  });

  app.get('/auth/bling/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error || !code) {
      return res.status(400).send(`Erro na autorizacao Bling: ${error || 'codigo nao recebido'}`);
    }
    try {
      await exchangeCodeForTokens(pool, code);
      res.send(`
        <h2>Bling autorizado com sucesso!</h2>
        <p>Tokens salvos no banco. O DropML ja pode usar a API Bling.</p>
        <a href="/auth/bling/status">Ver status</a>
      `);
    } catch (err) {
      console.error('[Bling] Erro ao trocar codigo por token:', err.response?.data || err.message);
      res.status(500).send('Erro ao obter tokens Bling. Verifique os logs.');
    }
  });

  app.get('/auth/bling/status', async (req, res) => {
    try {
      const stored = await loadBlingTokens(pool);
      if (!stored) {
        return res.json({ autenticado: false, mensagem: 'Nenhum token Bling salvo.' });
      }
      const expirado = Date.now() >= stored.expires_at;
      const expiraEm = new Date(Number(stored.expires_at)).toISOString();
      res.json({ autenticado: true, expirado, expiraEm });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  app.post('/auth/bling/refresh', async (req, res) => {
    try {
      await refreshBlingToken(pool);
      res.json({ sucesso: true, mensagem: 'Token renovado com sucesso.' });
    } catch (err) {
      res.status(500).json({ erro: err.message });
    }
  });

  console.log('[Bling] Rotas registradas.');
}
// ── Busca de produtos no Bling ───────────────────────────────
async function buscarProdutosBling(pool, nome = '', pagina = 1) {
  const params = new URLSearchParams({
    pagina: pagina,
    limite: 20,
  });
  if (nome) params.append('nome', nome);

  const resultado = await blingRequest(pool, 'GET', `/produtos?${params.toString()}`);
  return resultado?.data || [];
}
// ── Criar produto no Bling ───────────────────────────────────
async function criarProdutoBling(pool, produto) {
  const data = {
    nome: produto.titulo,
    preco: produto.precoVenda,
    situacao: 'A',
    tipo: 'P',
    formato: 'S',
    descricaoCurta: produto.titulo,
    imagensProduto: produto.imagem ? [{ link: produto.imagem }] : [],
  };
  const result = await blingRequest(pool, 'POST', '/produtos', data);
  return result.data;
}

// ── Criar anúncio no ML via Bling ───────────────────────────
async function criarAnuncioBling(pool, idProdutoBling, precoVenda, idCanal) {
  const data = {
    idProduto: idProdutoBling,
    idCanal: idCanal || Number(process.env.BLING_CANAL_ML_ID),
    preco: precoVenda,
    tipo: 'gold_special',
  };
  const result = await blingRequest(pool, 'POST', '/anunciosmarketplaces', data);
  return result.data;
}
module.exports = {
  initBlingTable,
  registerRoutes,
  getValidBlingToken,
  blingRequest,
  refreshBlingToken,
  buscarProdutosBling,
  criarProdutoBling,
  criarAnuncioBling,
};


