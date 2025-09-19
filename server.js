const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const mp = require('mercadopago');
const { MercadoPagoConfig, Preference } = mp;

// 🔹 Firebase Admin (suporta env e arquivo local)
const admin = require("firebase-admin");
let serviceAccount;

if (process.env.FIREBASE_CONFIG) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    console.log("[BOOT] Firebase config carregado da variável de ambiente.");
  } catch (e) {
    console.error("⛔ FIREBASE_CONFIG inválido:", e.message);
    process.exit(1);
  }
} else {
  try {
    serviceAccount = require("./keys/serviceAccountKey.json");
    console.log("[BOOT] Firebase config carregado do arquivo ./keys/serviceAccountKey.json");
  } catch (e) {
    console.error("⛔ Não encontrou serviceAccountKey.json e FIREBASE_CONFIG não definido.");
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const fdb = admin.firestore();
const app = express();

/* ======================== ENV & CONFIG ======================== */
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://api.clicaipa.com.br')
  .replace(/\/+$/, '');

const FRONTEND_RESULT_URL = process.env.FRONTEND_RESULT_URL || 'https://app.clicaipa.com.br/#/resultado';
console.log('[BOOT] FRONTEND_RESULT_URL=', FRONTEND_RESULT_URL);

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const tokenFlavor =
  MP_ACCESS_TOKEN.startsWith('APP_USR-') ? 'APP_USR' :
  MP_ACCESS_TOKEN.startsWith('TEST-')    ? 'TEST'    : 'UNKNOWN';

console.log('[BOOT] NODE_ENV=', process.env.NODE_ENV);
console.log('[BOOT] PUBLIC_BASE_URL=', PUBLIC_BASE_URL);
console.log(`[BOOT] MP token flavor: ${tokenFlavor} | last6=${MP_ACCESS_TOKEN.slice(-6)}`);

if (!MP_ACCESS_TOKEN) {
  console.error('⛔ MP_ACCESS_TOKEN não definido nas variáveis de ambiente');
  process.exit(1);
}

// Cliente Mercado Pago
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const MP_HTTP = axios.create({
  baseURL: 'https://api.mercadopago.com',
  headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
});
async function mpGet(pathname) {
  const { data } = await MP_HTTP.get(pathname);
  return data;
}

/* ======================== STORE EM MEMÓRIA ======================== */
const ordersStatus = new Map();
function setOrdersStatus(externalRef, payload) {
  const prev = ordersStatus.get(externalRef) || {};

  const merged = {
    ...prev,
    ...payload,
    updated_at: new Date().toISOString(),
    selections: {
      ...(prev.selections || {}),
      ...(payload.selections || {}),
    },
  };

  ordersStatus.set(externalRef, merged);
  console.log('[ORDERS][SET]', externalRef, merged);
}
const setOrderStatus = (ref, payload) => setOrdersStatus(ref, payload);

/* ======================== MIDDLEWARES BASE ======================== */
const allowedOrigins = [
  /^http:\/\/localhost:\d+$/,
  'http://localhost',
  'https://localhost',
  'https://api.clicaipa.com.br',
  'https://clicaipa-backend.onrender.com',
  'https://clicaipa.com.br',
  'https://app.clicaipa.com.br',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.some(p => p instanceof RegExp ? p.test(origin) : p === origin)) {
      return cb(null, true);
    }
    return cb(null, true); // liberar tudo por enquanto
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  maxAge: 86400,
}));
app.options(/.*/, cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* ======================== HEALTH/PING ======================== */
app.get('/ping', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/', (_req, res) => res.send('OK – Clicaipá backend no ar'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

/* -------------------- SQLite (persistência) -------------------- */
const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    external_ref TEXT PRIMARY KEY,
    status       TEXT NOT NULL,
    amount       REAL,
    merchant_order_id TEXT,
    payment_id   TEXT,
    paid_at      TEXT,
    selections   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const upsertBase = db.prepare(`
  INSERT INTO orders (external_ref, status, amount, selections, created_at, updated_at)
  VALUES (@external_ref, @status, @amount, @selections, datetime('now'), datetime('now'))
  ON CONFLICT(external_ref) DO UPDATE SET
    status=excluded.status,
    amount=excluded.amount,
    selections=excluded.selections,
    updated_at=datetime('now');
`);

const upsertPaid = db.prepare(`
  INSERT INTO orders (external_ref, status, amount, merchant_order_id, payment_id, paid_at, selections, updated_at)
  VALUES (@external_ref, 'pago', @amount, @merchant_order_id, @payment_id, @paid_at, @selections, datetime('now'))
  ON CONFLICT(external_ref) DO UPDATE SET
    status='pago',
    amount=excluded.amount,
    merchant_order_id=excluded.merchant_order_id,
    payment_id=excluded.payment_id,
    paid_at=excluded.paid_at,
    selections=excluded.selections,
    updated_at=datetime('now');
`);

/* -------------------- Helpers -------------------- */
function gerarOrderId() {
  const dt = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = [
    dt.getFullYear(), pad(dt.getMonth() + 1), pad(dt.getDate()),
    '-', pad(dt.getHours()), 'h', pad(dt.getMinutes()), 'm',
  ].join('');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PED-${stamp}-${rand}`;
}

function buildFrontResultUrl(frontBase, externalRef) {
  if (!frontBase) return null;
  try {
    if (frontBase.includes('#')) {
      const [base, hash] = frontBase.split('#');
      const [hashPath, hashQuery] = (hash || '').split('?');
      const qp = new URLSearchParams(hashQuery || '');
      qp.set('externalRef', externalRef);
      return `${base}#${hashPath}?${qp.toString()}`;
    }
    const u = new URL(frontBase);
    u.searchParams.set('externalRef', externalRef);
    return u.toString();
  } catch {
    return null;
  }
}

/* -------------------- Create Preference (Checkout Pro) -------------------- */
app.post('/create_preference', async (req, res) => {
  try {
    const {
      title = 'Item de teste',
      quantity = 1,
      unit_price = 1.0,
      orderId,
      proteinasSelecionadas = [],
      carboidratosSelecionados = [],
      legumesSelecionados = [],
      outrosSelecionados = [],
      frescosSelecionados = [],
      modo = 'congelado',
      pessoas = null,
    } = req.body || {};

    const resolvedOrderId = String(orderId || gerarOrderId());
    const qtt = Math.max(1, parseInt(quantity, 10) || 1);
    const price = Number(unit_price);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'unit_price inválido' });
    }

    const pref = new Preference(mpClient);
    const body = {
      items: [{
        title: String(title),
        quantity: qtt,
        unit_price: price,
        currency_id: 'BRL',
      }],
      notification_url: `${PUBLIC_BASE_URL}/webhook`,
      back_urls: {
        success: `${FRONTEND_RESULT_URL}?status=success&externalRef=${encodeURIComponent(resolvedOrderId)}`,
        failure: `${FRONTEND_RESULT_URL}?status=failure&externalRef=${encodeURIComponent(resolvedOrderId)}`,
        pending: `${FRONTEND_RESULT_URL}?status=pending&externalRef=${encodeURIComponent(resolvedOrderId)}`,
      },
      auto_return: 'approved',
      external_reference: resolvedOrderId,
      statement_descriptor: 'CLICAIPA',
      metadata: {
        external_reference: resolvedOrderId,
        source: 'clicaipa-app',
      },
    };

    console.log('[PREFERENCE][CONF]', { PUBLIC_BASE_URL, back_urls: body.back_urls });

    const mpRes = await pref.create({ body });

    setOrdersStatus(resolvedOrderId, {
      status: 'aguardando',
      selections: {
        proteinasSelecionadas,
        carboidratosSelecionados,
        legumesSelecionados,
        outrosSelecionados,
        frescosSelecionados,
        modo,
        pessoas,
      },
    });

    upsertBase.run({
      external_ref: resolvedOrderId,
      status: 'aguardando',
      amount: price,
      selections: JSON.stringify({
        proteinasSelecionadas,
        carboidratosSelecionados,
        legumesSelecionados,
        outrosSelecionados,
        frescosSelecionados,
        modo,
        pessoas,
      }),
    });

    return res.status(201).json({
      preference_id: mpRes?.id,
      init_point: mpRes?.init_point,
      external_reference: resolvedOrderId,
    });
  } catch (err) {
    console.error('[PREFERENCE][ERR]', err?.response?.data || err?.message || err);
    return res.status(500).json({ error: 'Erro ao criar preferência' });
  }
});

/* -------------------- Webhook -------------------- */
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    console.log('[WEBHOOK][BODY]', JSON.stringify(body));

    const paymentId = body?.data?.id || body?.id;
    if (!paymentId) {
      return res.status(400).json({ error: 'paymentId ausente' });
    }

    const pagamento = await mpGet(`/v1/payments/${paymentId}`);
    console.log('[WEBHOOK][PAYMENT]', pagamento?.id, pagamento?.status, pagamento?.external_reference);

    const externalRef = pagamento?.external_reference;
    if (!externalRef) {
      return res.status(200).send('ok sem externalRef');
    }

    const prev = ordersStatus.get(externalRef) || {};
    const merged = {
      ...prev,
      status: pagamento?.status || 'desconhecido',
      payment_id: String(pagamento?.id || ''),
      merchant_order_id: pagamento?.order?.id ? String(pagamento.order.id) : null,
      amount: pagamento?.transaction_amount || prev.amount,
      paid_at: pagamento?.status === 'approved' ? new Date().toISOString() : prev.paid_at,
      last_status_raw: pagamento?.status,
      updated_at: new Date().toISOString(),
    };
    ordersStatus.set(externalRef, merged);
    console.log('[WEBHOOK][SET]', externalRef, merged);

    if (pagamento?.status === 'approved') {
      upsertPaid.run({
        external_ref: externalRef,
        amount: pagamento.transaction_amount,
        merchant_order_id: pagamento?.order?.id ? String(pagamento.order.id) : null,
        payment_id: String(pagamento.id),
        paid_at: new Date().toISOString(),
        selections: JSON.stringify(prev.selections || {}),
      });
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error('[WEBHOOK][ERR]', err?.message || err);
    return res.status(500).send('error');
  }
});

// === Mercado Pago: status sem banco (stateless) ===
const MP_BASE = 'https://api.mercadopago.com';

if (!MP_ACCESS_TOKEN) {
  console.error('[BOOT] MP_ACCESS_TOKEN ausente — configure nas env vars!');
}

// Se seu Node no Render for 18+ já existe global fetch.
// Se aparecer "fetch is not defined", me chama que eu te mando a linha com node-fetch.
async function mpGetJson(url) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`MP ${r.status}: ${text}`);
  }
  return r.json();
}

async function resolveOrderStatus(externalRef) {
  // 1) Merchant Order (melhor visão agregada)
  try {
    const data = await mpGetJson(
      `${MP_BASE}/merchant_orders/search?external_reference=${encodeURIComponent(externalRef)}`
    );
    const mo = Array.isArray(data.elements) ? data.elements[0] : null;
    if (mo) {
      const paid = (mo.payments || []).reduce(
        (sum, p) => sum + (p.total_paid_amount || 0),
        0
      );
      const total = mo.total_amount ?? mo.order_amount ?? 0;
      return {
        source: 'merchant_order',
        status: mo.status, // opened | closed | expired
        paid_amount: paid,
        total_amount: total,
        merchant_order_id: mo.id,
      };
    }
  } catch (e) {
    console.warn('[MP] merchant_orders/search falhou:', e.message);
  }

  // 2) Fallback: Payments Search
  try {
    const pr = await mpGetJson(
      `${MP_BASE}/v1/payments/search?external_reference=${encodeURIComponent(externalRef)}`
    );
    const pay = Array.isArray(pr.results) ? pr.results[0] : null;
    if (pay) {
      return {
        source: 'payments',
        status: pay.status, // approved | pending | rejected | in_process
        paid_amount:
          pay.transaction_details?.total_paid_amount ??
          pay.transaction_amount ??
          0,
        total_amount: pay.transaction_amount ?? 0,
        payment_id: pay.id,
      };
    }
  } catch (e) {
    console.warn('[MP] payments/search falhou:', e.message);
  }

  return { source: 'none', status: 'not_found' };
}

// GET /order/status?externalRef=PED-123
app.get('/order/status', async (req, res) => {
  const externalRef = req.query.externalRef;
  if (!externalRef) {
    return res.status(400).json({ error: 'externalRef é obrigatório' });
  }
  try {
    const info = await resolveOrderStatus(externalRef);
    res.json({ external_ref: externalRef, ...info });
  } catch (err) {
    console.error('[ORDER][status] erro', err);
    res.status(500).json({ error: 'Falha ao consultar status' });
  }
});


/* -------------------- Consulta de status -------------------- */
app.get('/orders/:externalRef', (req, res) => {
  const externalRef = String(req.params.externalRef || '').trim();

  const row = ordersStatus.get(externalRef);
  if (row) return res.json(row);

  const dbRow = db.prepare(`
    SELECT status, payment_id, merchant_order_id, updated_at, selections
    FROM orders WHERE external_ref = ?
  `).get(externalRef);

  if (dbRow) {
    let selections = {};
    try {
      selections = dbRow.selections ? JSON.parse(dbRow.selections) : {};
    } catch (_) {
      selections = {};
    }

    return res.json({
      external_reference: externalRef,
      status: dbRow.status,
      payment_id: dbRow.payment_id,
      merchant_order_id: dbRow.merchant_order_id,
      updated_at: dbRow.updated_at,
      last_status_raw: dbRow.status,
      ...selections,
    });
  }

  return res.status(404).json({ error: 'Pedido não encontrado' });
});

/* -------------------- Retorno -------------------- */
app.get('/retorno', (req, res) => {
  const externalRef = req.query.externalRef || req.query.external_reference;
  const url = buildFrontResultUrl(FRONTEND_RESULT_URL, externalRef);
  console.log('[RETORNO]', externalRef, '→', url);
  if (url) return res.redirect(url);
  return res.status(400).send('externalRef inválido');
});

/* ====================== FIM DAS ROTAS ====================== */
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});
