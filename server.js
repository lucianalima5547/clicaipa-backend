// server.js — Clicaipá backend (produção limpo) — SOMENTE externalRef
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const mp = require('mercadopago');
const { MercadoPagoConfig, Preference } = mp;
const path = require('path');
const fs = require('fs');

// 🔹 Firebase Admin
const admin = require('firebase-admin');

// 🔧 dotenv — carrega só em ambiente local (fora do Render)
if (!process.env.RENDER) {
  require('dotenv').config();
}

// --- PostgreSQL (Neon) ---
const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon exige SSL
  keepAlive: true,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pgPool.on('error', (err) => {
  console.error('[PG] Pool idle client error:', err.message);
});

pgPool
  .query('select 1')
  .then(() => console.log('[PG] conectado com sucesso'))
  .catch((err) => console.error('[PG] erro de conexão:', err.message));


const crypto = require('crypto');

function genSecureToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSecureToken(token) {
  const secret = process.env.SECURE_LINK_SECRET || '';
  const h = crypto.createHmac('sha256', secret);
  h.update(token);
  return h.digest('hex');
}


// === Helper: upsert no PostgreSQL ===
async function upsertOrderPg({
  external_ref, status, amount = null,
  merchant_order_id = null, payment_id = null,
  selections = null, cardapios = null,
  created_at = null, updated_at = null,
}) {
  const payload = {
    selections: selections ? (typeof selections === 'string' ? JSON.parse(selections) : selections) : null,
    cardapios:  cardapios  ? (typeof cardapios  === 'string' ? JSON.parse(cardapios)  : cardapios)  : null,
  };
  const sql = `
    INSERT INTO orders (external_ref, status, amount, merchant_order_id, payment_id, payload, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), COALESCE($8, now()))
    ON CONFLICT (external_ref) DO UPDATE SET
      status=$2, amount=$3, merchant_order_id=$4, payment_id=$5, payload=$6, updated_at=COALESCE($8, now())
  `;
  await pgPool.query(sql, [
    external_ref, status, amount, merchant_order_id, payment_id,
    payload, created_at, updated_at,
  ]);
}

// Normalizador de status (front espera 'pago' para aprovado)
function normalizeStatus(s) {
  const v = String(s || '').toLowerCase();
  if (['approved', 'pago', 'accredited', 'closed'].includes(v)) return 'pago';
  if (['pending', 'aguardando', 'in_process', 'in mediation'].includes(v)) return 'pending';
  if (['rejected', 'cancelled', 'canceled'].includes(v)) return 'rejected';
  return v || 'pending';
}

/* ======================== FIREBASE CREDS ======================== */
let serviceAccountJson = null;
function loadJsonFromEnvVar(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (e) { console.error(`[FIREBASE] ${name} inválido (JSON):`, e.message); return null; }
}
function loadJsonFromFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`[FIREBASE] Falha ao ler ${p}:`, e.message); return null; }
}
(function resolveFirebaseCredentials() {
  serviceAccountJson = loadJsonFromEnvVar('FIREBASE_CONFIG');
  if (serviceAccountJson) { console.log('[FIREBASE] Usando FIREBASE_CONFIG'); return; }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) { console.log('[FIREBASE] Usando GOOGLE_APPLICATION_CREDENTIALS'); return; }
  if (process.env.FIREBASE_KEY_PATH) {
    const j = loadJsonFromFile(process.env.FIREBASE_KEY_PATH);
    if (j) { serviceAccountJson = j; console.log('[FIREBASE] Usando FIREBASE_KEY_PATH'); return; }
  }
  const localPath = path.join(__dirname, 'keys', 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    const j = loadJsonFromFile(localPath);
    if (j) { serviceAccountJson = j; console.log('[FIREBASE] Usando ./keys/serviceAccountKey.json'); return; }
  }
  serviceAccountJson = loadJsonFromEnvVar('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (serviceAccountJson) { console.log('[FIREBASE] Usando GOOGLE_SERVICE_ACCOUNT_JSON'); return; }
})();
if (serviceAccountJson) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccountJson) });
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  admin.initializeApp();
} else {
  console.error('⛔ Firebase: nenhuma credencial encontrada.');
  process.exit(1);
}
const fdb = admin.firestore();

/* ======================== APP / ENV ======================== */
const app = express();

const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://api.clicaipa.com.br').replace(/\/+$/, '');
const APP_BASE_URL    = String(process.env.APP_BASE_URL    || 'https://app.clicaipa.com.br').replace(/\/+$/, '');

console.log('[BOOT] NODE_ENV=', process.env.NODE_ENV);
console.log('[BOOT] PUBLIC_BASE_URL=', PUBLIC_BASE_URL);
console.log('[BOOT] APP_BASE_URL=', APP_BASE_URL);

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const tokenFlavor =
  MP_ACCESS_TOKEN.startsWith('APP_USR-') ? 'APP_USR' :
  MP_ACCESS_TOKEN.startsWith('TEST-')    ? 'TEST'    : 'UNKNOWN';
console.log(`[BOOT] MP token flavor: ${tokenFlavor} | last6=${MP_ACCESS_TOKEN.slice(-6)}`);
if (!MP_ACCESS_TOKEN) { console.error('⛔ MP_ACCESS_TOKEN não definido'); process.exit(1); }

const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const MP_HTTP = axios.create({
  baseURL: 'https://api.mercadopago.com',
  headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
});
async function mpGet(pathname) { const { data } = await MP_HTTP.get(pathname); return data; }

app.set('trust proxy', true);



// 1) Arquivos estáticos do Flutter Web (cache longo p/ assets hasheados)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // index.html, service worker e manifest SEM cache
    const noCache = ['index.html', 'flutter_service_worker.js', 'manifest.json'];
    if (noCache.some(name => filePath.endsWith('/' + name))) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return;
    }
    // Demais arquivos (hasheados): cache longo
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

/* ======================== MEM STORE ======================== */
const ordersStatus = new Map();
function setOrdersStatus(externalRef, payload) {
  const prev = ordersStatus.get(externalRef) || {};
  const merged = {
    ...prev, ...payload,
    updated_at: new Date().toISOString(),
    selections: { ...(prev.selections || {}), ...(payload.selections || {}) },
  };
  ordersStatus.set(externalRef, merged);
  console.log('[ORDERS][SET]', externalRef, merged);
}
const setOrderStatus = (ref, payload) => setOrdersStatus(ref, payload);

/* ======================== CORS / BODY ======================== */
const ALLOW_LIST = [
  /^http:\/\/localhost(?::\d+)?$/, /^http:\/\/127\.0\.0\.1(?::\d+)?$/,
  /^https:\/\/.*\.vercel\.app$/, 'https://app.clicaipa.com.br',
  'https://clicaipa.com.br', 'https://www.clicaipa.com.br', 'https://api.clicaipa.com.br',
];
const corsOptions = {
  origin: (origin, cb) => (!origin ? cb(null, true) :
    (ALLOW_LIST.some(rule => rule instanceof RegExp ? rule.test(origin) : rule === origin)
      ? cb(null, true) : cb(new Error('Not allowed by CORS: ' + origin), false))),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Accept','Content-Type','Authorization','Cache-Control','Pragma','X-Requested-With','ngrok-skip-browser-warning'],
  maxAge: 86400, optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));


app.use((req, _res, next) => {
  try {
    console.log('[REQ]', req.method, req.path);
  } catch (_) {}
  next();
});


/* ======================== HEALTH ======================== */
app.get('/ping', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/', (_req, res) => res.send('OK – Clicaipá backend no ar'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

/* ======================== SQLite (LEGADO / COMPAT) ======================== */
const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    external_ref       TEXT PRIMARY KEY,
    status             TEXT NOT NULL,
    amount             REAL,
    merchant_order_id  TEXT,
    payment_id         TEXT,
    paid_at            TEXT,
    selections         TEXT,
    cardapios          TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Índices úteis para relatórios/listagens
  CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders (updated_at);
  CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders (status);

  -- Trigger para manter updated_at SEMPRE que atualizar
  CREATE TRIGGER IF NOT EXISTS trg_orders_updated_at
  AFTER UPDATE ON orders
  FOR EACH ROW
  BEGIN
    UPDATE orders SET updated_at = datetime('now') WHERE external_ref = NEW.external_ref;
  END;
`);

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

/* ======================== Helpers ======================== */
function gerarOrderId() {
  const dt = new Date(); const pad = (n) => String(n).padStart(2, '0');
  const stamp = [dt.getFullYear(), pad(dt.getMonth()+1), pad(dt.getDate()), '-', pad(dt.getHours()), 'h', pad(dt.getMinutes()), 'm'].join('');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PED-${stamp}-${rand}`;
}

// 🔎 novo helper: extrai externalRef (body/query ou do hash do Referer)
function extractExternalRef(req) {
  let ext = String(
    req.body?.externalRef ||
    req.query?.externalRef ||
    req.body?.external_ref ||
    req.query?.external_ref ||
    ''
  ).trim();
  if (ext) return ext;
  try {
    const refUrl = req.headers?.referer ? new URL(req.headers.referer) : null;
    if (refUrl) {
      const hash = refUrl.hash || '';
      const qStr = hash.includes('?') ? hash.split('?')[1] : '';
      const params = new URLSearchParams(qStr);
      const fromHash = params.get('externalRef') || params.get('external_ref') || '';
      if (fromHash) return String(fromHash).trim();
    }
  } catch (_) {}
  return '';
}



/* ======================== Create Preference (somente externalRef) ======================== */
app.post('/create_preference', async (req, res) => {
  try {
    const {
      title = 'Clicaipá — Plano',
      quantity = 1,
      unit_price = 1.0,

      // identificador do pedido (se vier do app usamos; senão geramos)
      orderId,

      // seleções do app (mantemos para registrar no banco)
      proteinasSelecionadas = [],
      carboidratosSelecionados = [],
      legumesSelecionados = [],
      outrosSelecionados = [],
      frescosSelecionados = [],

      // modo e quantidades
      modo = 'congelado',
      quantidade, quantidadeTotal, quantityTotal, pessoas = null,
    } = req.body || {};

    // --------- sanity checks / normalizações ---------
    const resolvedOrderId = String(orderId || gerarOrderId()).trim();
    const qtt   = Math.max(1, parseInt(quantity, 10) || 1);
    const price = Number(unit_price);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'unit_price inválido' });
    }

    const _modo = (String(modo).toLowerCase() === 'semanal') ? 'semanal' : 'congelado';
    const resolvedQuantidade =
      Number.isFinite(quantidade)       ? Number(quantidade) :
      Number.isFinite(quantidadeTotal)  ? Number(quantidadeTotal) :
      Number.isFinite(quantityTotal)    ? Number(quantityTotal) :
      (_modo === 'semanal' ? Math.max(1, parseInt(pessoas, 10) || 1) : 24);

    // --------- bases de URL (garanta isso no Render) ---------
    const APP_BASE_URL    = process.env.APP_BASE_URL    || 'https://app.clicaipa.com.br';
    const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://api.clicaipa.com.br';

    // URL da tela Resultado (Flutter web usa hash routing)
    const resultadoUrl = `${APP_BASE_URL}/#/resultado?externalRef=${encodeURIComponent(resolvedOrderId)}`;

    // --------- Mercado Pago ---------
    const pref = new Preference(mpClient);

    const body = {
      items: [{
        title: String(title).slice(0, 255),
        quantity: qtt,
        unit_price: Number(price.toFixed(2)),
        currency_id: 'BRL'
      }],

      notification_url: `${PUBLIC_BASE_URL}/webhook`,

      // voltamos sempre para a tela Resultado carregando pelo externalRef
      back_urls: {
        success: `${resultadoUrl}&status=approved`,
        pending: `${resultadoUrl}&status=pending`,
        failure: `${resultadoUrl}&status=failure`,
      },

      // ao aprovar, o MP já redireciona de volta
      auto_return: 'approved',

      // dica para abrir na mesma aba (alguns ambientes ignoram; não tem problema)
      redirect_mode: 'self',

      // *** ponto central: somente externalRef ***
      external_reference: resolvedOrderId,

      statement_descriptor: 'CLICAIPA',
      metadata: { source: 'clicaipa-app' },

      // prioriza PIX, mas não bloqueia outros (ajuste se desejar)
      payment_methods: {
        excluded_payment_methods: [],
        excluded_payment_types: [],
        default_payment_method_id: 'pix',
      },

      // opcional: se quiser apenas aprovado/rejeitado sem "pendente" (desaconselhado para PIX)
      // binary_mode: true,
    };

    // logs úteis (saída)
    console.log('[PREFERENCE][OUT]', JSON.stringify({
      external_reference: body.external_reference,
      back_urls: body.back_urls,
      auto_return: body.auto_return,
      redirect_mode: body.redirect_mode,
    }));

    const mpRes = await pref.create({ body });

    // SDKs variam a forma do retorno — cobrimos ambos
    const preferenceId  = mpRes?.id || mpRes?.body?.id || null;
    const initPoint     = mpRes?.init_point || mpRes?.body?.init_point || null;
    const sandboxInit   = mpRes?.sandbox_init_point || mpRes?.body?.sandbox_init_point || null;

    // logs úteis (entrada)
    console.log('[PREFERENCE][IN]', JSON.stringify({
      id: preferenceId,
      init_point: initPoint,
      sandbox_init_point: sandboxInit,
    }));

    // --------- persiste nas bases (mantém sua compat) ---------
    upsertBase.run({
      external_ref: resolvedOrderId,
      status: 'aguardando',
      amount: price,
      selections: JSON.stringify({
        proteinasSelecionadas, carboidratosSelecionados, legumesSelecionados,
        outrosSelecionados, frescosSelecionados, modo: _modo,
        quantidade: resolvedQuantidade, pessoas,
      }),
      cardapios: JSON.stringify([]),
    });

    try {
      await upsertOrderPg({
        external_ref: resolvedOrderId,
        status: 'aguardando',
        amount: price,
        selections: JSON.stringify({
          proteinasSelecionadas, carboidratosSelecionados, legumesSelecionados,
          outrosSelecionados, frescosSelecionados, modo: _modo,
          quantidade: resolvedQuantidade, pessoas,
        }),
        cardapios: JSON.stringify([]),
      });
    } catch (e) {
      console.warn('[PG][create_preference] upsert warn:', e.message || e);
    }

    // memória (cache in-memory)
    setOrderStatus(resolvedOrderId, {
      status: 'aguardando',
      amount: price,
      preference_id: preferenceId,
      checkout_url: initPoint || sandboxInit || null,
      selections: {
        proteinasSelecionadas, carboidratosSelecionados, legumesSelecionados,
        outrosSelecionados, frescosSelecionados, modo: _modo,
        pessoas, quantidade: resolvedQuantidade,
      },
    });

    // resposta para o app abrir o checkout
    return res.json({
      id: preferenceId,
      init_point: initPoint,
      sandbox_init_point: sandboxInit,
      external_reference: resolvedOrderId,
    });

  } catch (err) {
    console.error('[PREFERENCE][ERR]', err?.response?.data || err?.message || err);
    return res.status(500).json({ error: 'Erro ao criar preferência' });
  }
});


/* ======================== Webhook (MP) ======================== */
const STATUS_SCORE = { rejected:0, cancelled:0, in_mediation:1, pending:1, in_process:2, authorized:3, approved:4, refunded:5, charged_back:6 };
const score = s => STATUS_SCORE[(s || '').toLowerCase()] ?? -1;

app.post('/webhook', express.json(), async (req, res) => {
  try {
    const { topic, resource, data, action } = req.body || {};
    let pathname = null;

    if (topic === 'payment' || (typeof action === 'string' && action.startsWith('payment'))) {
      const paymentId =
        (typeof resource === 'string' && /^\d+$/.test(resource)) ? resource :
        (data?.id || null);
      if (paymentId) pathname = `/v1/payments/${paymentId}`;
    }
    if (!pathname && topic === 'merchant_order' && typeof resource === 'string') {
      const id = resource.split('/').pop();
      if (id && /^\d+$/.test(id)) pathname = `/merchant_orders/${id}`;
    }
    if (!pathname) return res.sendStatus(200);

    let payload; try { payload = await mpGet(pathname); } catch { return res.sendStatus(200); }

    let externalRef = payload?.external_reference || null;
    let status = null, paymentId = null, merchantOrderId = null, amount = null, paidAt = null;

    if (pathname.startsWith('/v1/payments/')) {
      paymentId = payload?.id || null;
      status = payload?.status || null;
      amount = payload?.transaction_amount ?? null;
      paidAt = payload?.date_approved || null;
    } else {
      merchantOrderId = payload?.id || null;
      if (!externalRef) externalRef = payload?.external_reference || null;
      if (Array.isArray(payload?.payments) && payload.payments.length > 0) {
        const first = payload.payments[0];
        paymentId = first?.id || null;
        status = first?.status || status || null;
        if (!paidAt && first?.date_approved) paidAt = first.date_approved;
        if (!amount && first?.total_paid_amount != null) amount = first.total_paid_amount;
      }
    }
    if (!externalRef) return res.sendStatus(200);

    const prev = ordersStatus.get(externalRef) || {};
    const prevStatus = prev.status || null;
    const newStatus = status || prevStatus || 'desconhecido';
    const canUpgrade = score(newStatus) >= score(prevStatus) || prevStatus == null;

    const merged = {
      status: canUpgrade ? newStatus : prevStatus,
      payment_id: paymentId ?? prev.payment_id,
      merchant_order_id: merchantOrderId ?? prev.merchant_order_id,
      amount: (typeof amount === 'number' ? amount : prev.amount),
      paid_at: paidAt || prev.paid_at,
    };
    setOrderStatus(externalRef, merged);

    try {
      if (canUpgrade && merged.status === 'approved') {
        upsertPaid.run({
          external_ref: externalRef,
          amount: merged.amount ?? 0,
          merchant_order_id: merged.merchant_order_id ?? null,
          payment_id: merged.payment_id ?? null,
          paid_at: merged.paid_at ?? new Date().toISOString(),
          selections: JSON.stringify((ordersStatus.get(externalRef) || {}).selections || {}),
          cardapios: JSON.stringify((ordersStatus.get(externalRef) || {}).cardapios || null),
        });
      } else if (canUpgrade && merged.status) {
        upsertBase.run({
          external_ref: externalRef,
          status: merged.status,
          amount: merged.amount ?? 0,
          selections: JSON.stringify((ordersStatus.get(externalRef) || {}).selections || {}),
          cardapios: JSON.stringify((ordersStatus.get(externalRef) || {}).cardapios || null),
        });
      }
    } catch (dbErr) {
      console.warn('[WEBHOOK][DB WARN]', dbErr?.message || dbErr);
    }

    // espelha no PostgreSQL
    try {
      await upsertOrderPg({
        external_ref: externalRef,
        status: merged.status || 'desconhecido',
        amount: merged.amount ?? null,
        merchant_order_id: merged.merchant_order_id ?? null,
        payment_id: merged.payment_id ?? null,
        selections: JSON.stringify((ordersStatus.get(externalRef) || {}).selections || {}),
        cardapios:  JSON.stringify((ordersStatus.get(externalRef) || {}).cardapios  || []),
      });
    } catch (e) {
      console.warn('[PG][webhook] upsert warn:', e.message || e);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('[WEBHOOK][ERR]', e?.message || e);
    return res.sendStatus(200);
  }
});

// ======================== RETORNO (Mercado Pago) — legado ========================
// Mantemos por compatibilidade: se alguma preferência antiga ainda apontar pra /retorno,
// redirecionamos direto para a tela Resultado do app com externalRef
app.get('/retorno', (req, res) => {
  try {
    const APP_BASE_URL = String(process.env.APP_BASE_URL || 'https://app.clicaipa.com.br').replace(/\/+$/, '');
    const status = String(req.query.status || '').toLowerCase();
    const ext = String(req.query.external_ref || req.query.externalRef || req.query.external_reference || '').trim();

    if (!ext) {
      console.warn('[RETORNO][LEGADO] chamado sem external_ref');
      return res.status(400).send('external_ref ausente no retorno.');
    }

    const destino = `${APP_BASE_URL}/#/resultado?externalRef=${encodeURIComponent(ext)}${status ? `&status=${status}` : ''}`;
    console.log('[RETORNO][LEGADO] 302 =>', destino);
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, destino);
  } catch (e) {
    console.error('[RETORNO][LEGADO][ERR]', e?.message || e);
    return res.status(500).send('Erro ao processar retorno.');
  }
});

/* ======================== Salvar/Buscar Cardápios ======================== */
// Salvar/Atualizar Cardápios — grava em Memória, SQLite e **PG**
app.post('/order/save', async (req, res) => {
  try {
    const { externalRef, cardapios } = req.body || {};
    if (!externalRef || !cardapios) {
      return res.status(400).json({ error: 'externalRef e cardapios são obrigatórios' });
    }

    // 1) Merge em memória
    const prevMem = ordersStatus.get(externalRef) || {};
    const mergedMem = { ...prevMem, cardapios };
    ordersStatus.set(externalRef, mergedMem);

    // 2) SQLite (legado/compat)
    upsertBase.run({
      external_ref: externalRef,
      status: prevMem.status || 'aguardando',
      amount: prevMem.amount || 0,
      selections: JSON.stringify(prevMem.selections || {}),
      cardapios: JSON.stringify(cardapios),
    });

    // 3) Postgres (fonte que o /order/selections prioriza)
    try {
      // busca payload atual do PG p/ preservar selections existentes
      let payloadPg = null;
      try {
        const r = await pgPool.query(
          `select payload from orders where external_ref = $1 limit 1`,
          [externalRef]
        );
        if (r.rows.length) payloadPg = r.rows[0].payload || null;
      } catch (_) {}

      const selectionsPg = payloadPg?.selections || prevMem.selections || {};

      await upsertOrderPg({
        external_ref: externalRef,
        status: prevMem.status || 'aguardando',
        amount: prevMem.amount || 0,
        selections: JSON.stringify(selectionsPg),
        cardapios: JSON.stringify(cardapios),
      });
    } catch (e) {
      console.warn('[PG][order/save] upsert warn:', e?.message || e);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[ORDER/SAVE][ERR]', e?.message || e);
    return res.status(500).json({ error: 'erro interno' });
  }
});


// /order/selections — SOMENTE externalRef
app.get('/order/selections', async (req, res) => {
  try {
    const externalRef = String(
      req.query.externalRef || req.query.external_ref || req.query.external_reference || ''
    ).trim();

    if (!externalRef) {
      return res.status(400).json({ error: 'externalRef é obrigatório' });
    }

    // 1) PG primeiro
    let pgRow = null;
    try {
      const r = await pgPool.query(
        `select external_ref, status, amount, payload
           from orders
          where external_ref = $1
          limit 1`,
        [externalRef]
      );
      if (r.rows.length) pgRow = r.rows[0];
    } catch (e) {
      console.warn('[SELECTIONS][PG] warn:', e.message);
    }

    // base PG
    let status = pgRow?.status ?? null;
    let amount = pgRow?.amount ?? null;
    let payload = pgRow?.payload ?? null;

    // 2) Mem/SQLite (legado) para fallback
    const mem = ordersStatus.get(externalRef) || {};
    const sqliteRow = db.prepare(
      `SELECT status, amount, selections, cardapios
         FROM orders
        WHERE external_ref = ?`
    ).get(externalRef) || null;

    const parseJSON = (raw) => {
      try { return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; }
      catch { return null; }
    };

    const selections =
      (payload && payload.selections) ||
      parseJSON(mem.selections) ||
      parseJSON(sqliteRow?.selections) ||
      {};

    const cardapiosRaw =
      (payload && payload.cardapios) ||
      mem.cardapios ||
      parseJSON(sqliteRow?.cardapios) ||
      [];

    // 🔒 SEMPRE devolve array não-vazio
    const cardapios = Array.isArray(cardapiosRaw) && cardapiosRaw.length
      ? cardapiosRaw
      : [{ titulo: 'Cardápio em preparação', receitas: [] }];

    if (status == null) status = mem.status || sqliteRow?.status || 'pending';
    if (amount == null) {
      amount = (typeof mem.amount === 'number') ? mem.amount
              : (typeof sqliteRow?.amount === 'number') ? sqliteRow.amount
              : null;
    }

    const arr = (x) => Array.isArray(x) ? x : [];
    const modo = (String((selections?.modo ?? 'congelado')).toLowerCase() === 'semanal') ? 'semanal' : 'congelado';
    const quantidade = Number.isFinite(selections?.quantidade)
      ? Number(selections.quantidade)
      : (modo === 'semanal'
          ? Math.max(1, parseInt(selections?.pessoas, 10) || 1)
          : 24);

    return res.json({
      externalRef,
      amount: amount ?? null,
      selections: {
        proteinasSelecionadas:    arr(selections?.proteinasSelecionadas),
        carboidratosSelecionados: arr(selections?.carboidratosSelecionados),
        legumesSelecionados:      arr(selections?.legumesSelecionados),
        outrosSelecionados:       arr(selections?.outrosSelecionados),
        frescosSelecionados:      arr(selections?.frescosSelecionados),
      },
      modo,
      quantidade,
      status: normalizeStatus(status),  // já retorna “pago”
      cardapios,
      source: pgRow ? (payload ? 'pg' : 'pg+sqlite') : (sqliteRow ? 'sqlite' : 'mem')
    });
  } catch (e) {
    console.error('[ORDER/SELECTIONS][ERR]', e?.message || e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// /order/status — SOMENTE externalRef
app.get('/order/status', async (req, res) => {
  try {
    const ext = String(
      req.query.externalRef || req.query.external_ref || req.query.ext || ''
    ).trim();

    if (!ext) {
      return res.status(400).json({ ok: false, error: 'missing externalRef' });
    }

    const { rows } = await pgPool.query(
      `select external_ref, status, amount, merchant_order_id, payment_id, created_at, updated_at
         from orders
        where external_ref = $1
        limit 1`,
      [String(ext)]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
    }

    const o = rows[0];
    return res.json({
      ok: true,
      external_ref: o.external_ref,
      status: normalizeStatus(o.status), // já retorna "pago"
      amount: o.amount,
      merchant_order_id: o.merchant_order_id,
      payment_id: o.payment_id,
      created_at: o.created_at,
      updated_at: o.updated_at,
    });
  } catch (e) {
    console.error('[PG] /order/status erro:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// /order/:externalRef — PG primeiro, fallback SQLite (legado)
app.get('/order/:externalRef', async (req, res) => {
  const ext = String(req.params.externalRef || '').trim();
  if (!ext) return res.status(400).json({ error: 'externalRef é obrigatório' });

  try {
    // 1) Postgres
    const r = await pgPool.query(
      `select external_ref, status, amount, merchant_order_id, payment_id, created_at, updated_at, payload
         from orders
        where external_ref = $1
        limit 1`,
      [ext]
    );

    if (r.rows.length) {
      const o = r.rows[0];
      const selections = o.payload?.selections || {};
      const cardapios  = o.payload?.cardapios  || [];
      return res.json({
        externalRef: o.external_ref,
        status: normalizeStatus(o.status),
        amount: o.amount,
        selections,
        cardapios,
        updated_at: o.updated_at,
        payment_id: o.payment_id,
        merchant_order_id: o.merchant_order_id,
        source: 'pg'
      });
    }

    // 2) Fallback: SQLite (legado)
    const row = db.prepare('SELECT * FROM orders WHERE external_ref = ?').get(ext);
    if (!row) return res.status(404).json({ error: 'pedido não encontrado' });

    return res.json({
      externalRef: ext,
      status: normalizeStatus(row.status),
      amount: row.amount,
      selections: row.selections ? JSON.parse(row.selections) : {},
      cardapios: row.cardapios ? JSON.parse(row.cardapios) : [],
      updated_at: row.updated_at,
      payment_id: row.payment_id,
      merchant_order_id: row.merchant_order_id,
      source: 'sqlite'
    });
  } catch (e) {
    console.error('[ORDER BY EXT][ERR]', e?.message || e);
    return res.status(500).json({ error: 'erro interno' });
  }
});

app.get('/orders/:externalRef', (req, res) => {
  const { externalRef } = req.params;
  return res.redirect(307, `/order/${encodeURIComponent(externalRef)}`);
});

// === PG: status do pedido (rota única, sem duplicatas) ===
app.get('/pg/status', async (req, res) => {
  try {
    const extRaw =
      req.query.externalRef ||
      req.query.external_ref ||
      req.query.ext || '';

    const ext = String(extRaw).trim();
    if (!ext) return res.status(400).json({ ok: false, error: 'missing externalRef' });

    // 1) exata
    let r = await pgPool.query(
      `select external_ref, status, amount, merchant_order_id, payment_id, created_at, updated_at
         from orders
        where external_ref = $1
        limit 1`,
      [ext]
    );
    if (r.rows.length) {
      const row = r.rows[0];
      return res.json({ ok: true, ...row, status: normalizeStatus(row.status), match: 'exact' });
    }

    // 2) TRIM
    r = await pgPool.query(
      `select external_ref, status, amount, merchant_order_id, payment_id, created_at, updated_at
         from orders
        where trim(external_ref) = trim($1)
        limit 1`,
      [ext]
    );
    if (r.rows.length) {
      const row = r.rows[0];
      return res.json({ ok: true, ...row, status: normalizeStatus(row.status), match: 'trim' });
    }

    // 3) CONTAINS
    r = await pgPool.query(
      `select external_ref, status, amount, merchant_order_id, payment_id, created_at, updated_at
         from orders
        where external_ref ilike '%' || $1 || '%'
        order by created_at desc
        limit 1`,
      [ext]
    );
    if (r.rows.length) {
      const row = r.rows[0];
      return res.json({ ok: true, ...row, status: normalizeStatus(row.status), match: 'contains' });
    }

    return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
  } catch (e) {
    console.error('[PG] /pg/status erro:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// POST /order/protect  → body: { externalRef: "PED-...", email?: "..." }
app.post('/order/protect', async (req, res) => {
  try {
    const externalRef = String(req.body?.externalRef || req.query?.externalRef || '').trim();
    const email = (req.body?.email || req.query?.email || '').trim() || null;
    if (!externalRef) return res.status(400).json({ error: 'externalRef ausente' });

    // (opcional) valide se o pedido existe e está aprovado
    // const { rows: ord } = await pgPool.query('select status from orders where external_ref = $1 limit 1', [externalRef]);
    // if (!ord.length || ord[0].status !== 'approved') return res.status(403).json({ error: 'pedido não aprovado' });

    const token = genSecureToken();
    const tokenHash = hashSecureToken(token);

    // expira em 7 dias; ajuste se quiser
    await pgPool.query(
      `insert into secure_links (external_ref, token_hash, expires_at, email, notes)
       values ($1, $2, now() + interval '7 days', $3, $4)`,
      [externalRef, tokenHash, email, 'criado via /order/protect']
    );

    const base = process.env.PUBLIC_BASE_URL || 'http://localhost:10000';
    const secureUrl = `${base}/secure/${token}`;

console.log('[ORDER/PROTECT]',
  { externalRef, email, secureUrl,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress });


    // (envio de e-mail virá em passo posterior)
    return res.json({ ok: true, secureUrl, externalRef });
  } catch (err) {
    console.error('[order/protect] erro:', err);
    return res.status(500).json({ error: 'erro interno' });
  }
});

// GET /secure/:token → redireciona para APP/#/resultado?externalRef=...
app.get('/secure/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token ausente' });

    const tokenHash = hashSecureToken(token);
    const { rows } = await pgPool.query(
      `select external_ref, expires_at, used_at
         from secure_links
        where token_hash = $1
        limit 1`,
      [tokenHash]
    );

    if (!rows.length) return res.status(404).json({ error: 'token inválido' });

    const row = rows[0];
    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
      return res.status(410).json({ error: 'token expirado' });
    }

    // (opcional) consumo único: descomente para marcar uso
    // await pgPool.query(`update secure_links set used_at = now() where token_hash = $1 and used_at is null`, [tokenHash]);

    const appBase = process.env.APP_BASE_URL || 'http://localhost:5173';
    const redirectUrl = `${appBase}/#/resultado?externalRef=${encodeURIComponent(row.external_ref)}`;

    return res.redirect(302, redirectUrl);
  } catch (err) {
    console.error('[secure/:token] erro:', err);
    return res.status(500).json({ error: 'erro interno' });
  }
});


// 2) SPA fallback: qualquer GET não-API volta para index.html
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();

  const p = req.path || '/';

  // deixe APIs / webhooks / utilidades passarem
  if (
    p === '/' || p === '/ping' || p === '/health' ||
    p.startsWith('/api') ||
    p.startsWith('/webhook') ||
    p.startsWith('/create_preference') ||
    p.startsWith('/order') ||
    p.startsWith('/pg')
  ) {
    return next();
  }

  // se parece arquivo estático (tem extensão), deixa o static resolver
  if (/\.[a-z0-9]+$/i.test(p)) return next();

  // cai no SPA (Flutter Web)
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ======================== SPA FALLBACK (Express 5) ========================
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const p = req.path || '/';

  if (
    p === '/' || p === '/ping' || p === '/health' ||
    p.startsWith('/api') ||
    p.startsWith('/webhook') ||
    p.startsWith('/create_preference') ||
    p.startsWith('/order') ||
    p.startsWith('/pg')
  ) {
    return next();
  }

  if (/\.[a-z0-9]+$/i.test(p)) return next();

  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ======================== LISTEN ======================== */
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => { console.log(`[BOOT] Clicaipá backend ouvindo em :${PORT}`); });
