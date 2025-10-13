// server.js — Clicaipá backend (produção limpo)
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const mp = require('mercadopago');
const { MercadoPagoConfig, Preference } = mp;
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); // tokens protegidos
const nodemailer = require('nodemailer');

// 🔹 Firebase Admin
const admin = require('firebase-admin');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
require('dotenv').config();

// --- PostgreSQL (Neon) ---
const { Pool } = require('pg');

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon exige SSL
  keepAlive: true,
  max: 10,
  idleTimeoutMillis: 30000,        // fecha conexões ociosas após 30s
  connectionTimeoutMillis: 10000,  // timeout de conexão inicial
});

// Evita crash quando o pool encerra cliente ocioso
pgPool.on('error', (err) => {
  console.error('[PG] Pool idle client error:', err.message);
});

// Teste rápido de conexão (sem manter client pendurado)
pgPool
  .query('select 1')
  .then(() => console.log('[PG] conectado com sucesso'))
  .catch((err) => console.error('[PG] erro de conexão:', err.message));

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

// === Helpers de Link Protegido (PostgreSQL) ===
const SEC_TTL_HOURS = 24;
function isApprovedLike(status) {
  const s = String(status || '').toLowerCase();
  return s === 'approved' || s === 'pago' || s === 'accredited' || s === 'closed';
}
async function createSecureLinkForOrderPg(extRef) {
  const token = crypto.randomBytes(24).toString('hex');
  const sql = `
    INSERT INTO secure_links (external_ref, token, expires_at, used_at)
    VALUES ($1, $2, NOW() + INTERVAL '${SEC_TTL_HOURS} hours', NULL)
    ON CONFLICT (token) DO UPDATE
      SET expires_at = EXCLUDED.expires_at, used_at = NULL
    RETURNING token, expires_at
  `;
  const { rows } = await pgPool.query(sql, [extRef, token]);
  return { token: rows[0].token, expires_at: rows[0].expires_at };
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

/* ======================== HEALTH ======================== */
app.get('/ping', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/', (_req, res) => res.send('OK – Clicaipá backend no ar'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

/* ======================== SQLite ======================== */
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
    secure_token  TEXT,
    secure_expiry INTEGER,
    secure_used   INTEGER DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_orders_secure_token ON orders(secure_token);
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
function mailerOrNull() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.warn('[MAIL] SMTP não configurado — e-mails serão pulados.');
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // 465 => SSL
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}
async function sendProtectedEmail(toEmail, protectedUrl) {
  const t = mailerOrNull(); if (!t) return false;
  const from = process.env.FROM_EMAIL || 'Clicaipá <no-reply@clicaipa.com.br>';
  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.5">
      <h2>Seu link protegido do Clicaipá</h2>
      <p>Use o link abaixo para acessar seus cardápios, lista de compras e modo de preparo (válido por 24 horas):</p>
      <p><a href="${protectedUrl}" style="background:#25d366;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Acessar meu Clicaipá</a></p>
      <p>Ou copie e cole no navegador: <br><code>${protectedUrl}</code></p>
    </div>`;
  await t.sendMail({ from, to: toEmail, subject: 'Seu link protegido do Clicaipá', html });
  return true;
}

/* ======================== Create Preference ======================== */
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
      quantidade, quantidadeTotal, quantityTotal, pessoas = null,
    } = req.body || {};

    const resolvedOrderId = String(orderId || gerarOrderId());
    const qtt = Math.max(1, parseInt(quantity, 10) || 1);
    const price = Number(unit_price);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'unit_price inválido' });
    }

    const _modo = (String(modo).toLowerCase() === 'semanal') ? 'semanal' : 'congelado';
    const resolvedQuantidade =
      Number.isFinite(quantidade) ? Number(quantidade) :
      Number.isFinite(quantidadeTotal) ? Number(quantidadeTotal) :
      Number.isFinite(quantityTotal) ? Number(quantityTotal) :
      (_modo === 'semanal' ? Math.max(1, parseInt(pessoas, 10) || 1) : 24);

    const pref = new Preference(mpClient);
    const retorno = `${PUBLIC_BASE_URL}/retorno`;

    const body = {
      items: [{ title: String(title), quantity: qtt, unit_price: price, currency_id: 'BRL' }],
      notification_url: `${PUBLIC_BASE_URL}/webhook`,
      back_urls: {
        success: `${retorno}?status=approved&external_ref=${encodeURIComponent(resolvedOrderId)}`,
        pending: `${retorno}?status=pending&external_ref=${encodeURIComponent(resolvedOrderId)}`,
        failure: `${retorno}?status=failure&external_ref=${encodeURIComponent(resolvedOrderId)}`,
      },
      auto_return: 'approved',
      external_reference: resolvedOrderId,
      statement_descriptor: 'CLICAIPA',
      metadata: { source: 'clicaipa-app' },
      payment_methods: { excluded_payment_methods: [], excluded_payment_types: [], default_payment_method_id: 'pix' },
    };

    const mpRes = await pref.create({ body });
    const preferenceId = mpRes?.id || mpRes?.body?.id || null;
    const initPoint    = mpRes?.init_point || mpRes?.body?.init_point || null;
    const sandboxInit  = mpRes?.sandbox_init_point || mpRes?.body?.sandbox_init_point || null;
    const checkoutUrl  = initPoint || sandboxInit || null;

    // grava no SQLite já na criação (não depende do webhook)
    upsertBase.run({
      external_ref: resolvedOrderId,
      status: 'aguardando',           // ✅ produção
      amount: price,
      selections: JSON.stringify({
        proteinasSelecionadas, carboidratosSelecionados, legumesSelecionados,
        outrosSelecionados, frescosSelecionados, modo: _modo,
        quantidade: resolvedQuantidade, pessoas,
      }),
      cardapios: JSON.stringify([]),
    });

    // 👉 também persiste no PostgreSQL (espelha o SQLite)
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

    // memória
    setOrderStatus(resolvedOrderId, {
      status: 'aguardando',
      amount: price,
      preference_id: preferenceId,
      checkout_url: checkoutUrl,
      selections: {
        proteinasSelecionadas, carboidratosSelecionados, legumesSelecionados,
        outrosSelecionados, frescosSelecionados, modo: _modo,
        pessoas, quantidade: resolvedQuantidade,
      },
    });

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

    // 👉 também persiste no PostgreSQL (espelha o SQLite/webhook)
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

/* ======================== Secure Link helpers (SQLite) ======================== */
const SEC_DAY_MS = 24 * 60 * 60 * 1000;
const SEC_TTL_MS = 1 * SEC_DAY_MS; // 24h
function makeToken(nBytes = 24) { return crypto.randomBytes(nBytes).toString('hex'); }
function createSecureLinkForOrder(extRef) {
  const token = makeToken(24);
  const expiry = Date.now() + SEC_TTL_MS;
  const info = db.prepare(`
    UPDATE orders
       SET secure_token = @token,
           secure_expiry = @expiry,
           secure_used = 0,
           updated_at = datetime('now')
     WHERE external_ref = @ext
  `).run({ token, expiry, ext: extRef });
  if (info.changes === 0) throw new Error('Pedido não encontrado');
  return { token, expiry };
}

/* ======================== /retorno (MP → aprovado) ======================== */
app.get('/retorno', async (req, res) => {
  const q = req.query || {};
  const statusQ = String(q.status || '').toLowerCase();
  const externalRef = q.external_ref || q.externalRef || q.external_reference || '';
  const ext = String(externalRef || '').trim();
  if (!ext) return res.status(400).send('<h3>external_ref ausente</h3>');

  const mem = ordersStatus.get(ext) || {};
  const row = db.prepare('SELECT status FROM orders WHERE external_ref = ?').get(ext) || {};

  const statusMem = String(mem.status || '').toLowerCase();
  const statusDb  = String(row.status || '').toLowerCase();
  const isApproved =
    statusQ === 'approved' ||
    statusMem === 'approved' || statusMem === 'pago' || statusMem === 'accredited' || statusMem === 'closed' ||
    statusDb  === 'approved' || statusDb  === 'pago' || statusDb  === 'accredited' || statusDb  === 'closed';

  const continueUrl =
    mem.checkout_url ||
    (mem.preference_id ? `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${mem.preference_id}` : null);

  if (!isApproved) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(`<!doctype html>
<html lang="pt-br"><head><meta charset="utf-8"><title>Pagamento não concluído</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial; padding:24px; color:#222;}
.btn{display:inline-block;padding:10px 14px;background:#0a7;color:#fff;text-decoration:none;border-radius:8px}
.card{background:#f7f7f7;border-radius:12px;padding:16px;margin-top:12px}
.small{color:#666;font-size:12px}
</style></head><body>
  <h2>Pagamento não concluído</h2>
  <div class="card">
    <p>Status atual: <b>${statusQ || 'desconhecido'}</b>.</p>
    <p>Você pode retornar ao checkout para concluir o pagamento.</p>
    ${continueUrl ? `<p><a class="btn" href="${continueUrl}">Voltar ao pagamento</a></p>` : `<p class="small">Link de retorno indisponível.</p>`}
    <p class="small">Ref.: ${ext}</p>
  </div>
</body></html>`);
  }

  // ✅ Blindagem: garanta linha no DB (auto_return timing)
  const exists = db.prepare('SELECT 1 FROM orders WHERE external_ref = ?').get(ext);
  if (!exists) {
    upsertBase.run({
      external_ref: ext,
      status: mem.status || 'aguardando',
      amount: mem.amount || 0,
      selections: JSON.stringify(mem.selections || {}),
      cardapios: JSON.stringify(mem.cardapios || []),
    });
  }

  try {
    const { token: secureToken } = createSecureLinkForOrder(ext);
    const secureUrl = `${PUBLIC_BASE_URL}/secure/${secureToken}`;
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, secureUrl);
  } catch {
    const appUrl = `${APP_BASE_URL}/#/resultado?externalRef=${encodeURIComponent(ext)}`;
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, appUrl); // fallback
  }
});

/* ======================== Salvar/Buscar Cardápios ======================== */
app.post('/order/save', (req, res) => {
  const { externalRef, cardapios } = req.body || {};
  if (!externalRef || !cardapios) return res.status(400).json({ error: 'externalRef e cardapios são obrigatórios' });

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

  return res.json({ ok: true });
});

app.get('/order/selections', (req, res) => {
  let externalRef = req.query.externalRef || req.query.external_ref || req.query.external_reference || '';
  if (Array.isArray(externalRef)) externalRef = externalRef[0];
  externalRef = String(externalRef || '').trim();
  if (!externalRef) return res.status(400).json({ error: 'externalRef é obrigatório' });

  const mem = ordersStatus.get(externalRef);
  const row = db.prepare(`SELECT status, amount, selections FROM orders WHERE external_ref = ?`).get(externalRef);

  function parseSelections(raw) { try { return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch { return null; } }

  const selMem = parseSelections(mem?.selections) || mem?.selections || null;
  const selDb  = parseSelections(row?.selections) || null;
  const selections = selMem || selDb || {};

  const amount = (typeof mem?.amount === 'number') ? mem.amount : (typeof row?.amount === 'number') ? row.amount : null;
  const status = mem?.status || row?.status || 'pending';

  const modo = (String(selections?.modo || 'congelado').toLowerCase() === 'semanal') ? 'semanal' : 'congelado';
  const quantidade = Number.isFinite(selections?.quantidade)
    ? Number(selections.quantidade)
    : (modo === 'semanal' ? Math.max(1, parseInt(selections?.pessoas, 10) || 1) : 24);

  const arr = (x) => Array.isArray(x) ? x : [];

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
    modo, quantidade, status,
  });
});

// /order/status — agora lendo do PostgreSQL (tem que vir ANTES de /order/:externalRef)
app.get('/order/status', async (req, res) => {
  try {
    const ext =
      req.query.externalRef ||
      req.query.external_ref ||
      req.query.ext ||
      '';

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
      status: o.status,
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

app.get('/order/:externalRef', (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE external_ref = ?').get(req.params.externalRef);
  if (!row) return res.status(404).json({ error: 'pedido não encontrado' });
  res.json({
    externalRef: req.params.externalRef,
    status: row.status,
    amount: row.amount,
    selections: row.selections ? JSON.parse(row.selections) : {},
    cardapios: row.cardapios ? JSON.parse(row.cardapios) : [],
    updated_at: row.updated_at,
    payment_id: row.payment_id,
    merchant_order_id: row.merchant_order_id,
  });
});
app.get('/orders/:externalRef', (req, res) => {
  const { externalRef } = req.params;
  return res.redirect(307, `/order/${encodeURIComponent(externalRef)}`);
});

// Criar link protegido (PostgreSQL) — fora de /order/* para não conflitar
app.get('/pg/protect', async (req, res) => {
  try {
    const extRef = (req.query?.externalRef || '').toString().trim();
    if (!extRef) return res.status(400).json({ ok:false, error:'externalRef é obrigatório' });

    const o = await pgPool.query(
      `select external_ref, status
         from orders
        where external_ref = $1
        limit 1`,
      [extRef]
    );
    if (!o.rows.length) return res.status(404).json({ ok:false, error:'Pedido não encontrado no PostgreSQL' });
    if (!isApprovedLike(o.rows[0].status)) return res.status(403).json({ ok:false, error:'Pedido ainda não aprovado' });

    const { token, expires_at } = await createSecureLinkForOrderPg(extRef);
    const protectedUrl = `${req.protocol}://${req.get('host')}/secure_pg/${token}`;

    return res.json({ ok:true, url: protectedUrl, expiresAt: expires_at });
  } catch (e) {
    console.error('[PG][protect GET] err:', e?.message || e);
    return res.status(500).json({ ok:false, error:'Falha ao criar link protegido (PG)' });
  }
});

// === Consumir token protegido (PG) ===
app.get('/secure_pg/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).send('token ausente');

    // valida token no PostgreSQL
    const sel = await pgPool.query(
      `select external_ref, expires_at, used_at
         from secure_links
        where token = $1
        limit 1`,
      [token]
    );
    if (!sel.rows.length) return res.status(404).send('token inválido');

    const row = sel.rows[0];
    if (row.used_at) return res.status(410).send('token já utilizado');
    if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).send('token expirado');

    // marca uso
    await pgPool.query(`update secure_links set used_at = NOW() where token = $1`, [token]);

    const appUrl = `${APP_BASE_URL}/#/resultado?externalRef=${encodeURIComponent(row.external_ref)}`;
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, appUrl);
  } catch (e) {
    console.error('[PG] /secure_pg erro:', e?.message || e);
    return res.status(500).send('erro interno');
  }
});

app.get('/db/ping', async (_req, res) => {
  try {
    const r = await pgPool.query('select current_database() as db, now() as ts');
    res.json({ ok: true, db: r.rows[0].db, ts: r.rows[0].ts });
  } catch (e) {
    console.error('[PG] ping erro:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Rota temporária para inspecionar pedido no Postgres por external_ref
app.get('/pg/order/:ext', async (req, res) => {
  try {
    const { ext } = req.params;
    const { rows } = await pgPool.query(
      `select external_ref, status, amount, merchant_order_id, payment_id, created_at, updated_at
         from orders
        where external_ref = $1`,
      [ext]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, order: rows[0] });
  } catch (e) {
    console.error('[PG] /pg/order erro:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// DEBUG: ver em qual DB estamos e exemplos da tabela orders
app.get('/db/debug_orders', async (_req, res) => {
  try {
    const meta = await pgPool.query(
      `select current_database() as db, current_user as usr, inet_server_addr()::text as host`
    );
    const cnt = await pgPool.query(`select count(*)::int as n from orders`);
    const sample = await pgPool.query(
      `select external_ref, status, created_at
         from orders
        order by created_at desc
        limit 5`
    );
    res.json({
      ok: true,
      db: meta.rows[0].db,
      user: meta.rows[0].usr,
      host: meta.rows[0].host,
      orders_count: cnt.rows[0].n,
      sample: sample.rows
    });
  } catch (e) {
    console.error('[PG] /db/debug_orders erro:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// /pg/status — consulta no PostgreSQL sem conflitar com /order/:externalRef
app.get('/pg/status', async (req, res) => {
  try {
    const extRaw =
      req.query.externalRef ||
      req.query.external_ref ||
      req.query.ext ||
      '';

    const extStr = String(extRaw);
    if (!extStr) return res.status(400).json({ ok: false, error: 'missing externalRef' });

    // 1) exata
    let r = await pgPool.query(
      `select external_ref, status, amount, merchant_order_id, payment_id, created_at, updated_at
         from orders
        where external_ref = $1
        limit 1`,
      [extStr]
    );
    if (r.rows.length) return res.json({ ok: true, ...r.rows[0], match: 'exact' });

    // 2) TRIM
    r = await pgPool.query(
      `select external_ref, status, amount, merchant_order_id, payment_id, created_at, updated_at
         from orders
        where trim(external_ref) = trim($1)
        limit 1`,
      [extStr]
    );
    if (r.rows.length) return res.json({ ok: true, ...r.rows[0], match: 'trim' });

    // 3) CONTAINS
    r = await pgPool.query(
      `select external_ref, status, amount, merchant_order_id, payment_id, created_at, updated_at
         from orders
        where external_ref ilike '%' || $1 || '%'
        order by created_at desc
        limit 1`,
      [extStr]
    );
    if (r.rows.length) return res.json({ ok: true, ...r.rows[0], match: 'contains' });

    return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
  } catch (e) {
    console.error('[PG] /pg/status erro:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


// === PG: status do pedido (não conflita com /order/:externalRef) ===
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
    if (r.rows.length) return res.json({ ok: true, ...r.rows[0], match: 'exact' });

    // 2) TRIM
    r = await pgPool.query(
      `select external_ref, status, amount, merchant_order_id, payment_id, created_at, updated_at
         from orders
        where trim(external_ref) = trim($1)
        limit 1`,
      [ext]
    );
    if (r.rows.length) return res.json({ ok: true, ...r.rows[0], match: 'trim' });

    // 3) CONTAINS (fallback)
    r = await pgPool.query(
      `select external_ref, status, amount, merchant_order_id, payment_id, created_at, updated_at
         from orders
        where external_ref ilike '%' || $1 || '%'
        order by created_at desc
        limit 1`,
      [ext]
    );
    if (r.rows.length) return res.json({ ok: true, ...r.rows[0], match: 'contains' });

    return res.status(404).json({ ok: false, error: 'pedido não encontrado' });
  } catch (e) {
    console.error('[PG] /pg/status erro:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// === PG: gerar link protegido ===
app.get('/pg/protect', async (req, res) => {
  try {
    const extRef = String(req.query.externalRef || req.query.external_ref || '').trim();
    if (!extRef) return res.status(400).json({ ok:false, error:'externalRef é obrigatório' });

    // precisa existir e estar aprovado/pago
    const q = await pgPool.query(
      `select external_ref, status
         from orders
        where external_ref = $1
        limit 1`,
      [extRef]
    );
    if (!q.rows.length) return res.status(404).json({ ok:false, error:'Pedido não encontrado no PostgreSQL' });

    const s = String(q.rows[0].status || '').toLowerCase();
    const approved = ['approved','pago','accredited','closed'].includes(s);
    if (!approved) return res.status(403).json({ ok:false, error:'Pedido ainda não aprovado' });

    // cria token na secure_links
    const token = require('crypto').randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 24*60*60*1000); // +24h
    await pgPool.query(
      `insert into secure_links (token, external_ref, expires_at) values ($1,$2,$3)
       on conflict (token) do nothing`,
      [token, extRef, expiresAt]
    );

    // monta URL pública (em produção use o domínio público)
    const base =
      process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get('host')}`;
    const url = `${base.replace(/\/+$/,'')}/secure_pg/${token}`;

    return res.json({ ok:true, url, expiresAt });
  } catch (e) {
    console.error('[PG] /pg/protect erro:', e);
    return res.status(500).json({ ok:false, error:'Falha ao criar link protegido (PG)' });
  }
});


/* ======================== LISTEN ======================== */
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => { console.log(`[BOOT] Clicaipá backend ouvindo em :${PORT}`); });
