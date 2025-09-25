const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const mp = require('mercadopago');
const { MercadoPagoConfig, Preference } = mp;
const path = require('path');

// 🔹 Firebase Admin
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

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const fdb = admin.firestore();
const app = express();

/* ======================== ENV & CONFIG ======================== */
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://api.clicaipa.com.br').replace(/\/+$/, '');
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

/* ======================== MIDDLEWARES ======================== */
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

/* -------------------- SQLite -------------------- */
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
    cardapios    TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

try {
  db.prepare("ALTER TABLE orders ADD COLUMN cardapios TEXT").run();
  console.log("[BOOT][DB] Coluna 'cardapios' adicionada em orders.");
} catch (e) {
  if (!String(e.message).includes("duplicate column name")) {
    console.error("[BOOT][DB] Erro ao alterar tabela orders:", e.message);
  }
}

const upsertBase = db.prepare(`
  INSERT INTO orders (external_ref, status, amount, selections, cardapios, created_at, updated_at)
  VALUES (@external_ref, @status, @amount, @selections, @cardapios, datetime('now'), datetime('now'))
  ON CONFLICT(external_ref) DO UPDATE SET
    status=excluded.status,
    amount=excluded.amount,
    selections=excluded.selections,
    cardapios=excluded.cardapios,
    updated_at=datetime('now');
`);

const upsertPaid = db.prepare(`
  INSERT INTO orders (external_ref, status, amount, merchant_order_id, payment_id, paid_at, selections, cardapios, updated_at)
  VALUES (@external_ref, 'pago', @amount, @merchant_order_id, @payment_id, @paid_at, @selections, @cardapios, datetime('now'))
  ON CONFLICT(external_ref) DO UPDATE SET
    status='pago',
    amount=excluded.amount,
    merchant_order_id=excluded.merchant_order_id,
    payment_id=excluded.payment_id,
    paid_at=excluded.paid_at,
    selections=excluded.selections,
    cardapios=excluded.cardapios,
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

/* -------------------- Create Preference -------------------- */
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

      // ✅ back_urls via backend (/retorno) com nosso external_ref (evita duplicação)
      back_urls: {
        success: `${PUBLIC_BASE_URL}/retorno?external_ref=${encodeURIComponent(resolvedOrderId)}`,
        failure: `${PUBLIC_BASE_URL}/retorno?external_ref=${encodeURIComponent(resolvedOrderId)}`,
        pending: `${PUBLIC_BASE_URL}/retorno?external_ref=${encodeURIComponent(resolvedOrderId)}`,
      },

      auto_return: 'approved',
      external_reference: resolvedOrderId,
      statement_descriptor: 'CLICAIPA',
      metadata: { source: 'clicaipa-app' }, // ✅ sem duplicar external_reference
    };

    // 🔎 Conferência no Render
    console.log('[PREFERENCE][CONF][v7]', {
      PUBLIC_BASE_URL,
      back_urls: body.back_urls,
      external_reference: body.external_reference,
    });

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
      cardapios: null,
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

/* -------------------- Webhook (definitivo) -------------------- */
app.post('/webhook', express.json(), async (req, res) => {
  try {
    const { topic, resource, data, action } = req.body || {};
    console.log('[WEBHOOK][IN]', { topic, resource, action, data });

    let pathname = null;

    // payment.* pode vir como topic:"payment" ou action:"payment.created"
    if (topic === 'payment' || (typeof action === 'string' && action.startsWith('payment'))) {
      const paymentId = (typeof resource === 'string' && /^\d+$/.test(resource))
        ? resource
        : (data?.id || null);
      if (paymentId) pathname = `/v1/payments/${paymentId}`;
    }

    // merchant_order sempre vem como URL mercadolibre; extraímos o id
    if (!pathname && topic === 'merchant_order' && typeof resource === 'string') {
      const id = resource.split('/').pop();
      if (id && /^\d+$/.test(id)) pathname = `/merchant_orders/${id}`;
    }

    if (!pathname) {
      console.log('[WEBHOOK][SKIP] sem pathname resolvido.');
      return res.sendStatus(200);
    }

    console.log('[WEBHOOK][URL]', `https://api.mercadopago.com${pathname}`);

    // Consulta a API do MP (usa seu helper com baseURL já certa)
    let payload;
    try {
      payload = await mpGet(pathname);
    } catch (e) {
      const code = e?.response?.status || e.code;
      console.warn('[WEBHOOK][FETCH ERR]', code, pathname, e?.response?.data || e.message);
      // Mesmo com erro, sempre responde 200 para o MP não reenfileirar sem fim
      return res.sendStatus(200);
    }

    // Normaliza status/externalRef
    let externalRef = payload?.external_reference || null;
    let status = null;
    let paymentId = null;
    let merchantOrderId = null;
    let amount = null;
    let paidAt = null;

    if (pathname.startsWith('/v1/payments/')) {
      // Resposta de /v1/payments/:id
      paymentId = payload?.id || null;
      status = payload?.status || null; // approved | pending | rejected...
      amount = payload?.transaction_amount ?? null;
      paidAt = payload?.date_approved || null;
      // external_reference já veio acima
    } else {
      // Resposta de /merchant_orders/:id
      merchantOrderId = payload?.id || null;
      if (!externalRef) externalRef = payload?.external_reference || null;
      // tenta inferir status pelo primeiro pagamento
      if (Array.isArray(payload?.payments) && payload.payments.length > 0) {
        const first = payload.payments[0];
        paymentId = first?.id || null;
        status = first?.status || status || null;
        if (!paidAt && first?.date_approved) paidAt = first.date_approved;
        if (!amount && first?.total_paid_amount != null) amount = first.total_paid_amount;
      }
    }

    console.log('[WEBHOOK][PARSED]', { externalRef, status, paymentId, merchantOrderId });

    if (!externalRef) {
      console.log('[WEBHOOK][WARN] sem external_reference no payload.');
      return res.sendStatus(200);
    }

    // --- Atualiza memória ---
    setOrderStatus(externalRef, {
      status: status || 'desconhecido',
      payment_id: paymentId || undefined,
      merchant_order_id: merchantOrderId || undefined,
      amount: (typeof amount === 'number') ? amount : undefined,
      paid_at: paidAt || undefined,
    });

    // --- Atualiza SQLite ---
    try {
      if (status === 'approved') {
        upsertPaid.run({
          external_ref: externalRef,
          amount: amount ?? 0,
          merchant_order_id: merchantOrderId ?? null,
          payment_id: paymentId ?? null,
          paid_at: paidAt ?? new Date().toISOString(),
          selections: JSON.stringify((ordersStatus.get(externalRef) || {}).selections || {}),
          cardapios: JSON.stringify((ordersStatus.get(externalRef) || {}).cardapios || null),
        });
      } else if (status) {
        upsertBase.run({
          external_ref: externalRef,
          status,
          amount: amount ?? 0,
          selections: JSON.stringify((ordersStatus.get(externalRef) || {}).selections || {}),
          cardapios: JSON.stringify((ordersStatus.get(externalRef) || {}).cardapios || null),
        });
      }
    } catch (dbErr) {
      console.warn('[WEBHOOK][DB WARN]', dbErr?.message || dbErr);
    }

    console.log(`[ORDERS][UPDATE] ${externalRef} → ${status || 'desconhecido'}`);
    return res.sendStatus(200);
  } catch (e) {
    console.error('[WEBHOOK][ERR]', e?.message || e);
    return res.sendStatus(200);
  }
});


/* -------------------- Salvar e Buscar Cardápios -------------------- */
app.post('/order/save', (req, res) => {
  const { externalRef, cardapios } = req.body;
  if (!externalRef || !cardapios) {
    return res.status(400).json({ error: 'externalRef e cardapios são obrigatórios' });
  }

  const prev = ordersStatus.get(externalRef) || {};
  const merged = { ...prev, cardapios };
  ordersStatus.set(externalRef, merged);

  upsertBase.run({
    external_ref: externalRef,
    status: prev.status || 'aguardando',
    amount: prev.amount || 0,
    selections: JSON.stringify(prev.selections || {}),
    cardapios: JSON.stringify(cardapios),
  });

  res.json({ ok: true });
});

app.get('/order/result', (req, res) => {
  const externalRef = req.query.externalRef;
  if (!externalRef) return res.status(400).json({ error: 'externalRef é obrigatório' });

  const row = ordersStatus.get(externalRef);
  if (row?.cardapios) return res.json({ externalRef, cardapios: row.cardapios });

  const dbRow = db.prepare(`SELECT cardapios FROM orders WHERE external_ref = ?`).get(externalRef);
  if (dbRow?.cardapios) {
    try {
      return res.json({ externalRef, cardapios: JSON.parse(dbRow.cardapios) });
    } catch {
      return res.json({ externalRef, cardapios: [] });
    }
  }

  return res.status(404).json({ error: 'Cardápios não encontrados' });
});

/* -------------------- Retorno (robusto) -------------------- */
app.get('/retorno', async (req, res) => {
  try {
    let externalRef =
      req.query.external_ref ||
      req.query.externalRef ||
      req.query.external_reference ||
      '';

    if (Array.isArray(externalRef)) externalRef = externalRef[0];
    if (typeof externalRef === 'string' && externalRef.includes(',')) {
      externalRef = externalRef.split(',')[0].trim(); // mantém o primeiro
    }

    // Tenta resolver pelo payment/merchant_order se vierem na URL
    let paymentId =
      req.query.payment_id || req.query.collection_id || req.query['data.id'] || req.query.id || null;
    let merchantOrderId = req.query.merchant_order_id || req.query.merchant_order || null;

    if (!paymentId) {
      for (const [k, v] of Object.entries(req.query)) {
        if (/^payment/i.test(k) || /^collection/i.test(k)) { paymentId = String(v); break; }
      }
    }
    if (!merchantOrderId) {
      for (const [k, v] of Object.entries(req.query)) {
        if (/merchant.*order/i.test(k)) { merchantOrderId = String(v); break; }
      }
    }

    if (!externalRef && paymentId) {
      try {
        const pay = await mpGet(`/v1/payments/${String(paymentId).split(',')[0].trim()}`);
        if (pay?.external_reference) externalRef = String(pay.external_reference);
      } catch (e) {
        console.warn('[RETORNO][PAYMENT_LOOKUP][WARN]', e?.message || e);
      }
    }

    if (!externalRef && merchantOrderId) {
      try {
        const mo = await mpGet(`/merchant_orders/${String(merchantOrderId).split(',')[0].trim()}`);
        if (mo?.external_reference) {
          externalRef = String(mo.external_reference);
        } else if (Array.isArray(mo?.payments) && mo.payments[0]?.id) {
          const pay = await mpGet(`/v1/payments/${mo.payments[0].id}`);
          if (pay?.external_reference) externalRef = String(pay.external_reference);
        }
      } catch (e) {
        console.warn('[RETORNO][MO_LOOKUP][WARN]', e?.message || e);
      }
    }

    console.log('[RETORNO][DEBUG]', { query: req.query, resolved: { externalRef, paymentId, merchantOrderId } });

    if (!externalRef) return res.status(400).send('externalRef ausente e não foi possível resolver pelos IDs');

    const url = buildFrontResultUrl(FRONTEND_RESULT_URL, externalRef);
    console.log('[RETORNO][FINAL]', { externalRef, redirect: url });
    if (url) return res.redirect(url);
    return res.status(400).send('externalRef inválido');
  } catch (err) {
    console.error('[RETORNO][ERR]', err?.message || err);
    return res.status(500).send('erro no retorno');
  }
});

/* -------------------- Webhook TESTE -------------------- */
app.post('/webhook-test', (req, res) => {
  console.log('[WH-TEST][HEADERS]', {
    'content-type': req.headers['content-type'],
    'x-request-id': req.headers['x-request-id'],
    'x-signature': req.headers['x-signature'] ? '[present]' : undefined,
    'user-agent': req.headers['user-agent'],
  });
  console.log('[WH-TEST][QUERY]', req.query);
  console.log('[WH-TEST][BODY]', req.body);

  return res.status(200).json({
    ok: true,
    seen: {
      contentType: req.headers['content-type'],
      query: req.query,
      body: req.body,
    },
  });
});

/* ====================== FIM ====================== */
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});
