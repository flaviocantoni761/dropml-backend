const axios = require('axios');

const CJ_API_KEY = process.env.CJ_API_KEY;
const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

let cjToken = null;
let cjTokenExpiry = 0;

async function getCJToken() {
  if (cjToken && Date.now() < cjTokenExpiry) return cjToken;

  const resp = await axios.post(
    `${CJ_BASE}/authentication/getAccessToken`,
    { apiKey: CJ_API_KEY },
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (resp.data.result) {
    cjToken = resp.data.data.accessToken;
    cjTokenExpiry = Date.now() + (resp.data.data.expiresIn - 60) * 1000;
    return cjToken;
  }
  throw new Error('[CJ] Falha ao obter token: ' + resp.data.message);
}

async function buscarProdutosCJ(nome = '', pagina = 1, limite = 20) {
  const token = await getCJToken();
  const resp = await axios.get(`${CJ_BASE}/product/list`, {
    headers: { 'CJ-Access-Token': token },
    params: {
      productNameEn: nome,
      pageNum: pagina,
      pageSize: limite,
    },
  });

  if (!resp.data.result) throw new Error('[CJ] Erro na busca: ' + resp.data.message);

  return resp.data.data.list.map(p => ({
    cj_id: p.pid,
    titulo: p.productNameEn,
    preco: p.sellPrice,
    imagem: p.productImage,
    categoria: p.categoryName,
    frete_estimado: p.shippingTime,
  }));
}

function registerRoutes(app) {
  app.get('/api/cj/buscar', async (req, res) => {
    try {
      const { q = '', pagina = 1 } = req.query;
      const produtos = await buscarProdutosCJ(q, pagina);
      res.json({ sucesso: true, total: produtos.length, produtos });
    } catch (err) {
      console.error('[CJ] Erro:', err.message);
      res.status(500).json({ sucesso: false, erro: err.message });
    }
  });

  console.log('[CJ] Rota registrada: /api/cj/buscar');
}

module.exports = { registerRoutes, buscarProdutosCJ, getCJToken };
