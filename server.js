// server.js — Clicaipá backend (limpo)

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const mp = require('mercadopago');
const { MercadoPagoConfig, Preference } = mp;
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); // <- para tokens

// 🔹 Firebase Admin (robusto: aceita várias fontes)
const admin = require('firebase-admin');

// .env (carrega apenas fora de produção; em produção use env do host)
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

/* ======================== FIREBASE CREDS ======================== */
let serviceAccountJson = null;

function loadJsonFromEnvVar(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[FIREBASE] ${name} inválido (JSON malformado):`, e.message);
    return null;
  }
}

function loadJsonFromFile(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[FIREBASE] Falha ao ler arquivo ${p}:`, e.message);
    return null;
  }
}

(function resolveFirebaseCredentials() {
  // 1) Preferência: FIREBASE_CONFIG (JSON inline)
  serviceAccountJson = loadJsonFromEnvVar('FIREBASE_CONFIG');
  if (serviceAccountJson) {
    console.log('[FIREBASE] Usando credenciais de FIREBASE_CONFIG');
    return;
  }

  // 2) GOOGLE_APPLICATION_CREDENTIALS → ADC
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log('[FIREBASE] Usando GOOGLE_APPLICATION_CREDENTIALS:', process.env.GOOGLE_APPLICATION_CREDENTIALS);
    return; // admin.initializeApp() com default credentials logo abaixo
  }

  // 3) FIREBASE_KEY_PATH → arquivo no disco
  if (process.env.FIREBASE_KEY_PATH) {
    const p = process.env.FIREBASE_KEY_PATH;
    const j = loadJsonFromFile(p);
    if (j) {
      serviceAccountJson = j;
      console.log('[FIREBASE] Usando FIREBASE_KEY_PATH:', p);
      return;
    }
  }

  // 4) Local: ./keys/serviceAccountKey.json
  const localPath = path.join(__dirname, 'keys', 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    const j = loadJsonFromFile(localPath);
    if (j) {
      serviceAccountJson = j;
      console.log('[FIREBASE] Usando ./keys/serviceAccountKey.json');
      return;
    }
  }

  // 5) Alternativa: GOOGLE_SERVICE_ACCOUNT_JSON
  serviceAccountJson = loadJsonFromEnvVar('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (serviceAccountJson) {
    console.log('[FIREBASE] Usando GOOGLE_SERVICE_ACCOUNT_JSON');
    return;
  }
})();

if (serviceAccountJson) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccountJson) });
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  // ADC (Application Default Credentials) — arquivo apontado pela env var
  admin.initializeApp();
} else {
  console.error('⛔ Firebase: nenhuma credencial encontrada. Configure uma das opções:');
  console.error('   - FIREBASE_CONFIG com JSON da service account (1 linha)');
  console.error('   - GOOGLE_APPLICATION_CREDENTIALS apontando para o arquivo .json');
  console.error('   - FIREBASE_KEY_PATH apontando para o arquivo .json');
  console.error('   - Ou salve ./keys/serviceAccountKey.json');
  process.exit(1);
}

const fdb = admin.firestore();

/* ======================== APP ======================== */
const app = express(); // <<< CRIADO ANTES DE QUALQUER app.use

/* ======================== ENV & CONFIG ======================== */
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://api.clicaipa.com.br').replace(/\/+$/, ''); // backend público (sem barra final)
const APP_BASE_URL    = String(process.env.APP_BASE_URL    || 'https://app.clicaipa.com.br').replace(/\/+$/, ''); // app frontend (sem barra final)

console.log('[BOOT] NODE_ENV=', process.env.NODE_ENV);
console.log('[BOOT] PUBLIC_BASE_URL=', PUBLIC_BASE_URL);
console.log('[BOOT] APP_BASE_URL=', APP_BASE_URL);

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const tokenFlavor =
  MP_ACCESS_TOKEN.startsWith('APP_USR-') ? 'APP_USR' :
  MP_ACCESS_TOKEN.startsWith('TEST-')    ? 'TEST'    : 'UNKNOWN';
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

/* ======================== CORS (ROBUSTO) ======================== */
const ALLOW_LIST = [
  /^http:\/\/localhost(?::\d+)?$/,         // localhost qualquer porta
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/,      // 127.0.0.1 qualquer porta
  /^https:\/\/.*\.vercel\.app$/,           // previews vercel
  'https://app.clicaipa.com.br',
  'https://clicaipa.com.br',
  'https://www.clicaipa.com.br',           // www incluído
  'https://api.clicaipa.com.br',
];

const corsOptions = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true); // permite curl/healthchecks
    const ok = ALLOW_LIST.some((rule) => rule instanceof RegExp ? rule.test(origin) : rule === origin);
    if (ok) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Accept',
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Pragma',
    'X-Requested-With',
    'ngrok-skip-browser-warning',
  ],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

/* ======================== BODY PARSERS ======================== */
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

// --- Secure Link: migração robusta (recria a tabela se necessário) ---
function ensureSecureLinkColumnsSync(db) {
  const cols = db.prepare("PRAGMA table_info(orders);").all().map(r => r.name);
  const needSecureToken  = !cols.includes("secure_token");
  const needSecureExpiry = !cols.includes("secure_expiry");
  const needSecureUsed   = !cols.includes("secure_used");
  const needsRebuild = needSecureToken || needSecureExpiry || needSecureUsed;

  if (!needsRebuild) {
    try {
      db.prepare("CREATE INDEX IF NOT EXISTS idx_orders_secure_token ON orders(secure_token)").run();
    } catch (e) {
      console.warn("[MIGRATION] Aviso ao criar índice:", e.message);
    }
    console.log("[MIGRATION] Secure Link OK — colunas já existem.");
    return;
  }

  console.log("[MIGRATION] Reconstruindo tabela orders para adicionar colunas secure_* ...");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS orders_new (
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
    `);

    const has = (c) => cols.includes(c);
    const srcCols = [
      "external_ref",
      "status",
      has("amount")             ? "amount"             : "NULL as amount",
      has("merchant_order_id")  ? "merchant_order_id"  : "NULL as merchant_order_id",
      has("payment_id")         ? "payment_id"         : "NULL as payment_id",
      has("paid_at")            ? "paid_at"            : "NULL as paid_at",
      has("selections")         ? "selections"         : "NULL as selections",
      has("cardapios")          ? "cardapios"          : "NULL as cardapios",
      has("secure_token")       ? "secure_token"       : "NULL as secure_token",
      has("secure_expiry")      ? "secure_expiry"      : "NULL as secure_expiry",
      has("secure_used")        ? "secure_used"        : "0 as secure_used",
      has("created_at")         ? "created_at"         : "datetime('now') as created_at",
      has("updated_at")         ? "updated_at"         : "datetime('now') as updated_at",
    ].join(", ");

    db.exec(`
      INSERT INTO orders_new (
        external_ref, status, amount, merchant_order_id, payment_id, paid_at,
        selections, cardapios, secure_token, secure_expiry, secure_used,
        created_at, updated_at
      )
      SELECT ${srcCols} FROM orders;
    `);

    db.exec(`
      DROP TABLE orders;
      ALTER TABLE orders_new RENAME TO orders;
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orders_secure_token ON orders(secure_token);
    `);

    db.exec("COMMIT");
    console.log("[MIGRATION] Reconstrução concluída com sucesso.");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("[MIGRATION] Falhou:", e.message);
    throw e;
  }

  const finalCols = db.prepare("PRAGMA table_info(orders);").all().map(r => r.name);
  console.log("[MIGRATION] Colunas finais:", finalCols);
}

// Chamada da migração no boot
ensureSecureLinkColumnsSync(db);

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

/* -------------------- Create Preference -------------------- */
app.post('/create_preference', async (req, res) => {
  try {
    const {
      title = 'Item de teste',
      quantity = 1,
      unit_price = 1.0,
      orderId,

      // ✅ seleções vindas do app
      proteinasSelecionadas = [],
      carboidratosSelecionados = [],
      legumesSelecionados = [],
      outrosSelecionados = [],
      frescosSelecionados = [],

      // ✅ modo + quantidade
      modo = 'congelado',
      quantidade,             // preferencial
      quantidadeTotal,        // alias aceito
      quantityTotal,          // alias aceito
      pessoas = null,         // semanal costuma usar pessoas
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
      (_modo === 'semanal'
        ? Math.max(1, parseInt(pessoas, 10) || 1)
        : 24);

    const pref = new Preference(mpClient);
    const retorno = `${PUBLIC_BASE_URL}/retorno`; // base comum das back_urls

    const body = {
      items: [{
        title: String(title),
        quantity: qtt,
        unit_price: price,
        currency_id: 'BRL',
      }],

      // Webhook
      notification_url: `${PUBLIC_BASE_URL}/webhook`,

      // 🔁 back_urls por status — NÃO levam direto à tela resultado
      back_urls: {
        success: `${retorno}?status=approved&external_ref=${encodeURIComponent(resolvedOrderId)}`,
        pending: `${retorno}?status=pending&external_ref=${encodeURIComponent(resolvedOrderId)}`,
        failure: `${retorno}?status=failure&external_ref=${encodeURIComponent(resolvedOrderId)}`,
      },
      auto_return: 'approved', // auto redireciona apenas quando aprovado

      external_reference: resolvedOrderId,
      statement_descriptor: 'CLICAIPA',
      metadata: { source: 'clicaipa-app' },

      // ✅ PIX habilitado (sem excluir métodos)
      payment_methods: {
        excluded_payment_methods: [],
        excluded_payment_types: [],
        default_payment_method_id: 'pix',
      },
    };

    console.log('[PREFERENCE][CONF][v7]', {
      PUBLIC_BASE_URL,
      back_urls: body.back_urls,
      external_reference: body.external_reference,
    });

    const mpRes = await pref.create({ body });

    // --- dados úteis do MP ---
    const preferenceId = mpRes?.id || mpRes?.body?.id || null;
    const initPoint    = mpRes?.init_point || mpRes?.body?.init_point || null;
    const sandboxInit  = mpRes?.sandbox_init_point || mpRes?.body?.sandbox_init_point || null;
    const checkoutUrl  = initPoint || sandboxInit || null;

    // ✅ memória (runtime)
    setOrdersStatus(resolvedOrderId, {
      status: 'aguardando',
      amount: price,
      preference_id: preferenceId,
      checkout_url: checkoutUrl,
      selections: {
        proteinasSelecionadas,
        carboidratosSelecionados,
        legumesSelecionados,
        outrosSelecionados,
        frescosSelecionados,
        modo: _modo,
        pessoas,
        quantidade: resolvedQuantidade,
      },
    });

    // ✅ persistência (SQLite)
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
        modo: _modo,
        pessoas,
        quantidade: resolvedQuantidade,
      }),
      cardapios: null,
    });

    // ✅ retorno p/ app
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

/* -------------------- Webhook -------------------- */
const STATUS_SCORE = {
  rejected: 0,
  cancelled: 0,
  in_mediation: 1,
  pending: 1,
  in_process: 2,
  authorized: 3,
  approved: 4,
  refunded: 5,
  charged_back: 6,
};
const score = s => STATUS_SCORE[(s || '').toLowerCase()] ?? -1;

app.post('/webhook', express.json(), async (req, res) => {
  try {
    const { topic, resource, data, action } = req.body || {};
    console.log('[WEBHOOK][IN]', { topic, resource, action, data });

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

    if (!pathname) {
      console.log('[WEBHOOK][SKIP] sem pathname resolvido.');
      return res.sendStatus(200);
    }

    console.log('[WEBHOOK][URL]', `https://api.mercadopago.com${pathname}`);

    let payload;
    try {
      payload = await mpGet(pathname);
    } catch (e) {
      const code = e?.response?.status || e.code;
      console.warn('[WEBHOOK][FETCH ERR]', code, pathname, e?.response?.data || e.message);
      return res.sendStatus(200);
    }

    let externalRef = payload?.external_reference || null;
    let status = null;
    let paymentId = null;
    let merchantOrderId = null;
    let amount = null;
    let paidAt = null;

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

    console.log('[WEBHOOK][PARSED]', { externalRef, status, paymentId, merchantOrderId });

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

    console.log(`[ORDERS][UPDATE] ${externalRef} → ${merged.status}`);
    return res.sendStatus(200);
  } catch (e) {
    console.error('[WEBHOOK][ERR]', e?.message || e);
    return res.sendStatus(200);
  }
});

/* -------------------- Retorno validado -------------------- */
app.get('/retorno', async (req, res) => {
  const q = req.query || {};
  const statusQ = String(q.status || '').toLowerCase();        // approved | pending | failure | ...
  const externalRef =
    q.external_ref || q.externalRef || q.external_reference || '';

  const ext = String(externalRef || '').trim();
  if (!ext) {
    res.status(400).send('<h3>external_ref ausente</h3>');
    return;
  }

  // informações em memória / banco
  const mem = ordersStatus.get(ext) || {};
  const row = db.prepare('SELECT status FROM orders WHERE external_ref = ?').get(ext) || {};

  const statusMem = String(mem.status || '').toLowerCase();
  const statusDb  = String(row.status || '').toLowerCase();

  // aprovado?
  const isApproved =
    statusQ === 'approved' ||
    statusMem === 'approved' || statusMem === 'pago' || statusMem === 'accredited' || statusMem === 'closed' ||
    statusDb  === 'approved' || statusDb  === 'pago' || statusDb  === 'accredited' || statusDb  === 'closed';

  // URL para continuar pagamento (se não aprovado)
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

  // Aprovado → redireciona para a tela Resultado do app
  const appUrl = `${APP_BASE_URL}/#/resultado?externalRef=${encodeURIComponent(ext)}`;
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(302, appUrl);
});

/* -------------------- Retorno (legado/hard) -------------------- */
app.get('/retorno-hard', (req, res) => {
  const externalRef =
    req.query.external_ref ||
    req.query.externalRef ||
    'PED-TESTE-123';

  const ext = encodeURIComponent(String(externalRef).trim());
  const url = `https://app.clicaipa.com.br/?externalRef=${ext}#/resultado?externalRef=${ext}`;
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(302, url);
});

/* -------------------- Salvar/Buscar Cardápios -------------------- */
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
  const externalRef = req.query.externalRef || req.query.external_ref || '';
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

// GET /order/continue?externalRef=PED-...
app.get('/order/continue', (req, res) => {
  let externalRef = req.query.externalRef || req.query.external_ref || '';
  externalRef = String(externalRef || '').trim();
  if (!externalRef) return res.status(400).json({ error: 'externalRef é obrigatório' });

  const mem = ordersStatus.get(externalRef) || {};
  const checkoutUrl =
    mem.checkout_url ||
    (mem.preference_id
      ? `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${mem.preference_id}`
      : null);

  if (!checkoutUrl) return res.status(404).json({ error: 'continue url indisponível' });
  return res.json({ externalRef, checkoutUrl });
});

/* -------------------- Entregar pacote p/ pospagamento -------------------- */
app.get('/order/selections', (req, res) => {
  let externalRef =
    req.query.externalRef ||
    req.query.external_ref ||
    req.query.external_reference ||
    '';

  if (Array.isArray(externalRef)) externalRef = externalRef[0];
  externalRef = String(externalRef || '').trim();
  if (!externalRef) return res.status(400).json({ error: 'externalRef é obrigatório' });

  const mem = ordersStatus.get(externalRef);
  const row = db.prepare(`SELECT status, amount, selections FROM orders WHERE external_ref = ?`).get(externalRef);

  function parseSelections(raw) {
    try {
      if (!raw) return null;
      return (typeof raw === 'string') ? JSON.parse(raw) : raw;
    } catch { return null; }
  }

  const selMem = parseSelections(mem?.selections) || mem?.selections || null;
  const selDb  = parseSelections(row?.selections) || null;
  const selections = selMem || selDb || {};

  const amount = (typeof mem?.amount === 'number') ? mem.amount
                : (typeof row?.amount === 'number') ? row.amount
                : null;

  const status = mem?.status || row?.status || 'pending';

  const modo = (String(selections?.modo || 'congelado').toLowerCase() === 'semanal') ? 'semanal' : 'congelado';
  const quantidade = Number.isFinite(selections?.quantidade)
    ? Number(selections.quantidade)
    : (modo === 'semanal' ? Math.max(1, parseInt(selections?.pessoas, 10) || 1) : 24);

  const arr = (x) => Array.isArray(x) ? x : [];

  const payload = {
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
    status,
  };

  return res.json(payload);
});

/* -------------------- Pedido por externalRef (DINÂMICA) -------------------- */
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

// === Alias legado: /orders/:externalRef → redireciona para /order/:externalRef
app.get('/orders/:externalRef', (req, res) => {
  const { externalRef } = req.params;
  console.log('[ORDERS][ALIAS] redirect → /order/', externalRef);
  return res.redirect(307, `/order/${encodeURIComponent(externalRef)}`);
});

/* =================== SECURE LINK: criar token e endpoint oficial =================== */

// validade: 3 dias (em ms)
const SEC_DAY_MS = 24 * 60 * 60 * 1000;
const SEC_TTL_MS = 3 * SEC_DAY_MS;

// status considerados "aprovado"
function isApprovedLike(status) {
  const s = String(status || '').toLowerCase();
  return s === 'approved' || s === 'pago' || s === 'accredited' || s === 'closed';
}

// token aleatório hex
function makeToken(nBytes = 24) {
  return crypto.randomBytes(nBytes).toString('hex');
}

// grava/regrava token para um externalRef
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

  if (info.changes === 0) {
    throw new Error('Pedido não encontrado');
  }
  return { token, expiry };
}

// POST /order/:extRef/secure — cria ou recria o link protegido
app.post('/order/:extRef/secure', (req, res) => {
  try {
    const extRef = String(req.params.extRef || '').trim();
    if (!extRef) return res.status(400).json({ ok:false, error:'externalRef inválido' });

    const row = db.prepare(`SELECT status FROM orders WHERE external_ref = ?`).get(extRef);
    if (!row) return res.status(404).json({ ok:false, error:'Pedido não encontrado' });

    if (!isApprovedLike(row.status)) {
      return res.status(403).json({ ok:false, error:'Pedido ainda não aprovado' });
    }

    const { token, expiry } = createSecureLinkForOrder(extRef);
    const protected_url = `${PUBLIC_BASE_URL}/secure/${token}`;

    return res.json({
      ok: true,
      external_ref: extRef,
      token,
      expires_at: expiry,
      protected_url
    });
  } catch (e) {
    console.error('[SECURE][CREATE][ERR]', e?.message || e);
    return res.status(500).json({ ok:false, error:'Falha ao criar link protegido' });
  }
});

/* ====================== ERR HANDLERS & START ====================== */

// --- handlers (coloque antes do listen e DEPOIS de todas as rotas válidas) ---
app.use((err, req, res, next) => {
  if (err?.message?.startsWith('Not allowed by CORS')) {
    console.warn('[CORS][BLOCKED]', req.headers.origin);
    return res.status(403).json({ error: 'CORS blocked', origin: req.headers.origin || null });
  }
  console.error('[UNCAUGHT]', err?.stack || err?.message || err);
  return res.status(500).json({ error: 'internal error' });
});

// catch-all 404 precisa ser o ÚLTIMO middleware de rota
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// --- START: use SEMPRE a porta do Render e 0.0.0.0 ---
const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`[BOOT] Server listening on http://${HOST}:${PORT}`);
});
