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


// === Helpers de Link Protegido (PostgreSQL) — UNIFICADO ===
const pool = pgPool; // reaproveita pool criado acima

async function ensureSecureLinksTableUnified() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS secure_links (
      token        TEXT PRIMARY KEY,
      external_ref TEXT NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_secure_links_extref
      ON secure_links (external_ref, expires_at DESC);
  `);
}
ensureSecureLinksTableUnified()
  .then(() => console.log('[MIGRATION] secure_links OK (unified)'))
  .catch(err => console.error('[MIGRATION] secure_links FAIL', err?.message || err));

function makeUrlSafeToken() {
  return crypto.randomBytes(24).toString('base64url'); // seguro p/ URL
}
function appUrlForToken(token) {
  const base = process.env.APP_BASE_URL || 'https://app.clicaipa.com.br';
  return `${base}/#/resultado?token=${token}`;
}
function secureUrlForToken(token) {
  const base = (process.env.PUBLIC_BASE_URL || 'https://api.clicaipa.com.br').replace(/\/+$/,'');
  return `${base}/secure/${token}`;
}
async function getPgOrder(externalRef) {
  const r = await pool.query(
    `SELECT external_ref, status, amount, merchant_order_id, payment_id
       FROM orders
      WHERE external_ref = $1
      LIMIT 1`,
    [externalRef]
  );
  return r.rows[0] || null;
}
function isPaidLike(status) {
  const s = String(status || '').toLowerCase();
  return s === 'approved' || s === 'pago' || s === 'paid' || s === 'accredited' || s === 'closed';
}
async function createOrReuseSecureLinkForOrderPgUnified(externalRef) {
  // Tenta reusar token válido (não expirado, não usado)
  const reuse = await pool.query(
    `SELECT token, expires_at
       FROM secure_links
      WHERE external_ref = $1
        AND expires_at > NOW()
        AND (used_at IS NULL)
      ORDER BY created_at DESC
      LIMIT 1`,
    [externalRef]
  );
  if (reuse.rows[0]) {
    const { token, expires_at } = reuse.rows[0];
    return {
      ok: true,
      token,
      secureUrl: secureUrlForToken(token),
      appUrl: appUrlForToken(token),
      expiresAt: new Date(expires_at).toISOString(),
      reused: true
    };
  }

  const token = makeUrlSafeToken();
  await pool.query(
    `INSERT INTO secure_links (token, external_ref, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '24 HOURS')`,
    [token, externalRef]
  );
  const ex = await pool.query(`SELECT expires_at FROM secure_links WHERE token = $1`, [token]);
  const expiresAt = ex.rows[0].expires_at;

  return {
    ok: true,
    token,
    secureUrl: secureUrlForToken(token),
    appUrl: appUrlForToken(token),
    expiresAt: new Date(expiresAt).toISOString(),
    reused: false
  };
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

/* ======================== SQLite (LEGADO / COMPAT) ======================== */
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
    secure: Number(SMTP_PORT) === 465,
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

    // grava no SQLite já na criação (compat)
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

    // espelha no PostgreSQL
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

/* ======================== /retorno (MP → aprovado) ======================== */
app.get('/retorno', async (req, res) => {
  const q = req.query || {};
  const statusQ = String(q.status || '').toLowerCase();
  const externalRef = q.external_ref || q.externalRef || q.external_reference || '';
  const ext = String(externalRef || '').trim();
  if (!ext) return res.status(400).send('<h3>external_ref ausente</h3>');

  // checa status confirmado (mem/sqlite) apenas para mensagem amigável
  const mem = ordersStatus.get(ext) || {};
  const row = db.prepare('SELECT status FROM orders WHERE external_ref = ?').get(ext) || {};

  const statusMem = String(mem.status || '').toLowerCase();
  const statusDb  = String(row.status || '').toLowerCase();
  const isApproved =
    statusQ === 'approved' ||
    ['approved','pago','accredited','closed'].includes(statusMem) ||
    ['approved','pago','accredited','closed'].includes(statusDb);

  if (!isApproved) {
    const continueUrl =
      mem.checkout_url ||
      (mem.preference_id ? `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${mem.preference_id}` : null);

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

  // Gera/usa token PROTEGIDO no Postgres (unificado)
  try {
    const out = await createOrReuseSecureLinkForOrderPgUnified(ext);
    const secureUrl = out.secureUrl; // PUBLIC_BASE_URL/secure/:token
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, secureUrl);
  } catch (e) {
    console.error('[RETORNO] falha ao criar token PG, fallback para app com externalRef', e?.message || e);
    const appUrl = `${APP_BASE_URL}/#/resultado?externalRef=${encodeURIComponent(ext)}`;
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, appUrl);
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

// /order/selections — aceita externalRef ou token e sempre retorna cardapios “seguros”
app.get('/order/selections', async (req, res) => {
  try {
    // 0) externalRef direto
    let externalRef =
      req.query.externalRef ||
      req.query.external_ref ||
      req.query.external_reference || '';

    // 1) se não veio, resolve via token
    if (!externalRef && req.query.token) {
      const tok = String(req.query.token).trim();
      if (tok) {
        try {
          const rTok = await pgPool.query(
            `select external_ref
               from secure_links
              where token = $1
                and (expires_at is null or expires_at > now())
              limit 1`,
            [tok]
          );
          if (rTok.rows.length) externalRef = rTok.rows[0].external_ref;
        } catch (e) {
          console.warn('[SELECTIONS][PG token] warn:', e.message);
        }
      }
    }

    if (!externalRef) {
      return res.status(400).json({ error: 'externalRef ou token é obrigatório' });
    }

    // 2) PG primeiro
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

    // 3) Mem/SQLite (legado) para fallback
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

    // ✅ resposta única, sem returns duplicados
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


// /order/status — agora aceita ?token=... (resolve para external_ref via secure_links)
app.get('/order/status', async (req, res) => {
  try {
    // 1) tenta pegar externalRef direto
    let ext =
      req.query.externalRef ||
      req.query.external_ref ||
      req.query.ext ||
      '';

    // 2) se não veio, tenta resolver via token (secure_links)
    if (!ext && req.query.token) {
      try {
        const t = String(req.query.token).trim();
        const rTok = await pgPool.query(
          `select external_ref
             from secure_links
            where token = $1
              and (expires_at is null or expires_at > now())
            limit 1`,
          [t]
        );
        if (rTok.rows.length) ext = rTok.rows[0].external_ref;
      } catch (e) {
        console.warn('[PG] /order/status token->ext warn:', e.message);
      }
    }

    if (!ext) {
      return res.status(400).json({ ok: false, error: 'missing externalRef or token' });
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

// === PG: gerar link protegido (GET auxiliar) ===
// Mantido para compat: usa o bloco unificado
app.get('/pg/protect', async (req, res) => {
  try {
    const extRef = String(req.query.externalRef || req.query.external_ref || '').trim();
    if (!extRef) return res.status(400).json({ ok:false, error:'externalRef é obrigatório' });

    const ord = await getPgOrder(extRef);
    if (!ord) return res.status(404).json({ ok:false, error:'Pedido não encontrado no PostgreSQL' });
    if (!isPaidLike(ord.status)) return res.status(403).json({ ok:false, error:'Pedido ainda não aprovado' });

    const out = await createOrReuseSecureLinkForOrderPgUnified(extRef);
    return res.json(out);
  } catch (e) {
    console.error('[PG] /pg/protect erro:', e);
    return res.status(500).json({ ok:false, error:'Falha ao criar link protegido (PG)' });
  }
});

// === Consumir token protegido (PG) — redireciona com ?token=...
app.get('/secure_pg/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).send('token ausente');

    const sel = await pgPool.query(
      `select external_ref, expires_at, used_at
         from secure_links
        where token = $1
        limit 1`,
      [token]
    );
    if (!sel.rows.length) return res.status(404).send('token inválido');

    const row = sel.rows[0];
    if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).send('token expirado');

    // Se quiser consumo único, descomente:
    // await pgPool.query(`update secure_links set used_at = NOW() where token = $1`, [token]);

    const appUrl = `${APP_BASE_URL}/#/resultado?token=${encodeURIComponent(token)}`;
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, appUrl);
  } catch (e) {
    console.error('[PG] /secure_pg erro:', e?.message || e);
    return res.status(500).send('erro interno');
  }
});

// ================== ROTAS OFICIAIS DE LINK PROTEGIDO ==================

// POST /order/protect → cria/reusa token para pedido pago (PG)
app.post('/order/protect', async (req, res) => {
  try {
    const externalRef = String(req.body?.externalRef || '').trim();
    if (!externalRef) return res.status(400).json({ ok:false, error:'externalRef obrigatório' });

    const ord = await getPgOrder(externalRef);
    if (!ord) return res.status(404).json({ ok:false, error:'pedido não encontrado' });
    if (!isPaidLike(ord.status)) return res.status(409).json({ ok:false, error:'pedido não está pago' });

    const out = await createOrReuseSecureLinkForOrderPgUnified(externalRef);
    return res.json(out);
  } catch (err) {
    console.error('[POST /order/protect] erro', err?.message || err);
    return res.status(500).json({ ok:false, error:'falha interna' });
  }
});

// GET /secure/:token → valida token e redireciona para o app (agora com externalRef)
app.get('/secure/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).send('token inválido');

    const r = await pgPool.query(
      `SELECT token, external_ref, expires_at, used_at
         FROM secure_links
        WHERE token = $1
        LIMIT 1`,
      [token]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).send('token não encontrado');
    if (row.expires_at && new Date(row.expires_at) <= new Date()) return res.status(410).send('token expirado');

    // opcional: consumo único
    // if (row.used_at) return res.status(410).send('token já utilizado');
    // await pgPool.query(`UPDATE secure_links SET used_at = NOW() WHERE token = $1`, [token]);

    // 👉 redireciona com externalRef (o front já entende)
    const appUrl = `${APP_BASE_URL}/#/resultado?externalRef=${encodeURIComponent(row.external_ref)}`;
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, appUrl);
  } catch (e) {
    console.error('[GET /secure/:token] erro', e?.message || e);
    return res.status(500).send('erro interno');
  }
});


// (Opcional) GET /order/secure/:token → payload mínimo para o app
app.get('/order/secure/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ ok:false, error:'token inválido' });

    const r = await pool.query(
      `SELECT external_ref, expires_at, used_at
         FROM secure_links
        WHERE token = $1
        LIMIT 1`,
      [token]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ ok:false, error:'token não encontrado' });
    if (row.expires_at && new Date(row.expires_at) <= new Date()) return res.status(410).json({ ok:false, error:'token expirado' });

    return res.json({
      ok: true,
      token,
      externalRef: row.external_ref,
      appUrl: `${APP_BASE_URL}/#/resultado?externalRef=${encodeURIComponent(row.external_ref)}`,
      expiresAt: new Date(row.expires_at).toISOString()
    });
  } catch (err) {
    console.error('[GET /order/secure/:token] erro', err?.message || err);
    return res.status(500).json({ ok:false, error:'erro interno' });
  }
});

/* ======================== LISTEN ======================== */
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => { console.log(`[BOOT] Clicaipá backend ouvindo em :${PORT}`); });
