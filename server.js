// Carrega .env só em dev (não sobrescreve env do Render)
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const mp = require('mercadopago');
const { MercadoPagoConfig, Preference, MerchantOrder } = mp;

const app = express();

/* ======================== ENV & CONFIG ======================== */
// Host público usado em notification_url e back_urls
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://api.clicaipa.com.br')
  .replace(/\/+$/, ''); // remove barra final

// URL da tela de resultado do FRONT (usada no redirect do /retorno, Web mesma aba)
const FRONTEND_RESULT_URL = process.env.FRONTEND_RESULT_URL || 'https://app.clicaipa.com.br/#/resultado';
console.log('[BOOT] FRONTEND_RESULT_URL=', FRONTEND_RESULT_URL);

// Token do MP (LIVE = APP_USR-..., TEST = TEST-...)
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

// Cliente Mercado Pago (SDK v2)
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// Helper HTTP p/ APIs REST do MP
const MP_HTTP = axios.create({
  baseURL: 'https://api.mercadopago.com',
  headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
});
async function mpGet(pathname) {
  const { data } = await MP_HTTP.get(pathname);
  return data;
}

/* ======================== STORE EM MEMÓRIA ======================== */
// Para testes E2E; em produção troque por DB.
const ordersStatus = new Map();
// Estrutura: ordersStatus.set(externalRef, { status, payment_id, merchant_order_id, last_status_raw, updated_at })
function setOrdersStatus(externalRef, payload) {
  const prev = ordersStatus.get(externalRef) || {};
  const merged = { ...prev, ...payload, updated_at: new Date().toISOString() };
  ordersStatus.set(externalRef, merged);
  console.log('[ORDERS][SET]', externalRef, merged);
}
// Alias para compat com trechos antigos
const setOrderStatus = (ref, payload) => setOrdersStatus(ref, payload);

/* ======================== MIDDLEWARES BASE ======================== */
// CORS — permite localhost (dev) e seus domínios de produção
const allowedOrigins = [
  /^http:\/\/localhost:\d+$/, // ex: http://localhost:5173 etc.
  'http://localhost',
  'https://localhost',
  'https://api.clicaipa.com.br',
  'https://clicaipa-backend.onrender.com',
  'https://clicaipa.com.br',
  'https://app.clicaipa.com.br',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // apps nativos/curl
    if (allowedOrigins.some(p => p instanceof RegExp ? p.test(origin) : p === origin)) {
      return cb(null, true);
    }
    // Durante testes, liberar tudo. No hardening, troque por: cb(new Error('CORS not allowed'));
    return cb(null, true);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  maxAge: 86400,
}));
app.options(/.*/, cors()); // Express 5: catch-all preflight

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
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
const upsertPaid = db.prepare(`
  INSERT INTO orders (external_ref, status, amount, merchant_order_id, payment_id, paid_at, updated_at)
  VALUES (@external_ref, 'pago', @amount, @merchant_order_id, @payment_id, @paid_at, datetime('now'))
  ON CONFLICT(external_ref) DO UPDATE SET
    status='pago',
    amount=excluded.amount,
    merchant_order_id=excluded.merchant_order_id,
    payment_id=excluded.payment_id,
    paid_at=excluded.paid_at,
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

// Monta URL de resultado respeitando hash-routes (ex.: #/resultado?externalRef=...)
function buildFrontResultUrl(frontBase, externalRef) {
  if (!frontBase) return null;
  try {
    if (frontBase.includes('#')) {
      const [base, hash] = frontBase.split('#');        // base = https://app..., hash = /resultado?foo=bar
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
      unit_price = 1.0, // pra validar fluxo; em prod use valor real
      orderId,          // opcional
      payer_email,      // opcional (prefill)
    } = req.body || {};

    const resolvedOrderId = String(orderId || gerarOrderId());

    const qtt = Math.max(1, parseInt(quantity, 10) || 1);
    const price = Number(unit_price);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'unit_price inválido' });
    }

    const notificationUrl = `${PUBLIC_BASE_URL}/webhook`;
    const pref = new Preference(mpClient);
    const body = {
      items: [{
        title: String(title),
        quantity: qtt,
        unit_price: price,
        currency_id: 'BRL',
      }],
      notification_url: notificationUrl,
      back_urls: {
        success: `${PUBLIC_BASE_URL}/retorno?status=success&external_ref=${encodeURIComponent(resolvedOrderId)}&external_reference=${encodeURIComponent(resolvedOrderId)}`,
        failure: `${PUBLIC_BASE_URL}/retorno?status=failure&external_ref=${encodeURIComponent(resolvedOrderId)}&external_reference=${encodeURIComponent(resolvedOrderId)}`,
        pending: `${PUBLIC_BASE_URL}/retorno?status=pending&external_ref=${encodeURIComponent(resolvedOrderId)}&external_reference=${encodeURIComponent(resolvedOrderId)}`,
      },

      auto_return: 'approved',
      external_reference: resolvedOrderId,
      statement_descriptor: 'CLICAIPA',
      metadata: { external_reference: resolvedOrderId, source: 'clicaipa-app' },
    };
    if (payer_email) body.payer = { email: String(payer_email) };

    // Loga o que vai pra preference (verifica se não ficou ngrok)
    console.log('[PREFERENCE][CONF]', {
      PUBLIC_BASE_URL,
      notification_url: notificationUrl,
      back_urls: body.back_urls,
    });

    const mpRes = await pref.create({ body });

    console.log('[PREFERENCE][OK]', {
      id: mpRes?.id,
      external_reference: resolvedOrderId,
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

/* -------------------- Conciliação / Persistência -------------------- */
const pagamentosProcessados = new Set();

async function marcarPedidoComoPago(externalRef, meta = {}) {
  if (!externalRef) {
    console.warn('[PAGO][DB] external_reference ausente');
    return;
  }
  try {
    upsertPaid.run({
      external_ref: externalRef,
      amount: Number(meta.amount) || null,
      merchant_order_id: meta.merchantOrderId ? String(meta.merchantOrderId) : null,
      payment_id: meta.paymentId ? String(meta.paymentId) : null,
      paid_at: new Date().toISOString(),
    });
    // também atualiza o Map usado pelo /orders/:externalRef
    setOrdersStatus(externalRef, {
      status: 'pago',
      payment_id: meta.paymentId || null,
      merchant_order_id: meta.merchantOrderId || null,
    });
    console.log('[PAGO][DB] Persistido no SQLite + Map:', {
      external_ref: externalRef,
      amount: meta.amount,
      merchant_order_id: meta.merchantOrderId,
      payment_id: meta.paymentId,
    });
  } catch (e) {
    console.error('[PAGO][DB][ERR]', e?.message || e);
  }
}

async function conciliarPorPayment(paymentId) {
  let p;
  try {
    p = await mpGet(`/v1/payments/${paymentId}`);
  } catch (err) {
    if (err?.response?.status === 404) {
      console.warn('[PAYMENT] 404 Not Found — aguardando conciliação via merchant_order.', { paymentId });
      return;
    }
    throw err;
  }

  // status bruto p/ debug
  if (p?.external_reference) {
    setOrdersStatus(p.external_reference, { last_status_raw: String(p.status || '') });
  }

  console.log('[RETORNO][PAYMENT]', {
    id: p.id,
    status: p.status,
    transaction_amount: p.transaction_amount,
    external_reference: p.external_reference || null,
    orderId: p.order?.id || null,
  });

  if (pagamentosProcessados.has(p.id)) {
    console.log('[IDEMP] Payment já processado:', p.id);
    return;
  }
  if (p.status !== 'approved') {
    console.log('[PENDENTE] Payment ainda não aprovado:', p.status);
    return;
  }

  let mo;
  if (p.order?.id) {
    mo = await mpGet(`/merchant_orders/${p.order.id}`);
  } else {
    const list = await mpGet(`/merchant_orders?payment_id=${p.id}`);
    mo = list?.elements?.[0];
  }
  if (!mo) {
    console.warn('[MO] Não encontrada para payment:', p.id);
    return;
  }

  const total = mo.total_amount || 0;
  const paid  = mo.paid_amount || 0;
  console.log('[MO][CHECK]', { id: mo.id, status: mo.status, total, paid });

  if (paid >= total && total > 0) {
    await marcarPedidoComoPago(mo.external_reference || p.external_reference, {
      paymentId: p.id,
      merchantOrderId: mo.id,
      amount: paid,
    });
    pagamentosProcessados.add(p.id);
    console.log('[OK] Conciliação concluída (payment->MO).');
  } else {
    console.log('[PENDENTE] MO ainda não fechada; aguardar webhook merchant_order.', {
      total, paid, moStatus: mo.status,
    });
  }
}

async function conciliarPorMerchantOrder(merchantOrderId) {
  const mo = await mpGet(`/merchant_orders/${merchantOrderId}`);

  // status bruto p/ debug
  if (mo?.external_reference) {
    setOrdersStatus(mo.external_reference, { last_status_raw: String(mo.status || '') });
  }

  const total = mo.total_amount || 0;
  const paid  = mo.paid_amount || 0;
  console.log('[MO][RAW]', { id: mo.id, status: mo.status, total_amount: total, paid_amount: paid });

  if (paid >= total && total > 0) {
    const paymentId = mo.payments?.[0]?.id || null;
    if (paymentId && pagamentosProcessados.has(paymentId)) {
      console.log('[IDEMP] Já conciliado via payment:', paymentId);
      return;
    }
    await marcarPedidoComoPago(mo.external_reference, {
      paymentId,
      merchantOrderId: mo.id,
      amount: paid,
    });
    if (paymentId) pagamentosProcessados.add(paymentId);
    console.log('[OK] Conciliação concluída (merchant_order).');
  } else {
    console.log('[MO][ABERTO] Aguardando pagamento fechar.', { total, paid, status: mo.status });
  }
}

/* -------------------- Webhook -------------------- */
app.all('/webhook', async (req, res) => {
  try {
    console.log('=== [WEBHOOK] HEADERS ===\n', req.headers);
    console.log('=== [WEBHOOK] QUERY   ===\n', req.query);
    console.log('=== [WEBHOOK] BODY    ===\n', req.body);

    // responde 200 rápido para evitar retries excessivos
    res.sendStatus(200);

    const body = req.body || {};
    const q = req.query || {};

    // Formato novo (body.type/data.id)
    if (body?.type === 'payment' && body?.data?.id) { await conciliarPorPayment(body.data.id); return; }
    if (body?.type === 'merchant_order' && body?.data?.id) { await conciliarPorMerchantOrder(body.data.id); return; }

    // Formato antigo (?topic=&id=)
    if (q?.topic === 'merchant_order' && q?.id) { await conciliarPorMerchantOrder(String(q.id)); return; }
    if (q?.type === 'payment' && q['data.id']) { await conciliarPorPayment(String(q['data.id'])); return; }

    // Formato legado (resource=/merchant_orders/:id ou /payments/:id)
    if (body?.resource && typeof body.resource === 'string') {
      if (body.resource.includes('/merchant_orders/')) {
        const id = body.resource.split('/merchant_orders/')[1]?.split(/[^\d]/)[0];
        if (id) { await conciliarPorMerchantOrder(id); return; }
      }
      if (body.resource.includes('/payments/')) {
        const id = body.resource.split('/payments/')[1]?.split(/[^\d]/)[0];
        if (id) { await conciliarPorPayment(id); return; }
      }
    }

    console.log('[WEBHOOK] Tipo/forma não tratada:', { query: q, body });
  } catch (err) {
    console.error('[WEBHOOK][ERR]', err);
  }
});

/* -------------------- Consulta de status (Map + SQLite fallback) -------------------- */
app.get('/orders/:externalRef', async (req, res) => {
  try {
    const externalRef = String(req.params.externalRef || '').trim();
    if (!externalRef) {
      return res.status(400).json({ error: 'externalRef obrigatório' });
    }

    // 1) Tenta o Map (webhook em memória)
    const stored = ordersStatus.get(externalRef);
    if (stored) {
      return res.status(200).json({
        external_reference: externalRef,
        status: stored.status || 'aguardando',
        payment_id: stored.payment_id || null,
        merchant_order_id: stored.merchant_order_id || null,
        updated_at: stored.updated_at || null,
        last_status_raw: stored.last_status_raw || null,
      });
    }

    // 2) Fallback: consulta o SQLite (útil após restart)
    const row = db.prepare('SELECT status, payment_id, merchant_order_id, updated_at FROM orders WHERE external_ref = ?')
                  .get(externalRef);
    if (row) {
      return res.status(200).json({
        external_reference: externalRef,
        status: row.status,
        payment_id: row.payment_id,
        merchant_order_id: row.merchant_order_id,
        updated_at: row.updated_at,
        last_status_raw: row.status,
      });
    }

    // 3) Nada ainda → aguardando
    return res.status(200).json({
      external_reference: externalRef,
      status: 'aguardando',
      updated_at: null,
    });
  } catch (err) {
    console.error('[ORDER][GET][ERR]', err?.message || err);
    return res.status(500).json({ error: 'Erro ao consultar pedido' });
  }
});

// Debug (REMOVER no go-live)
app.get('/orders/_debug', (_req, res) => {
  const all = [];
  for (const [k, v] of ordersStatus.entries()) {
    all.push({ external_reference: k, ...v });
  }
  return res.status(200).json(all);
});

/* -------------------- Retorno (backup com poll + redirect p/ FRONT) -------------------- */
async function waitForMerchantOrderPaid(merchantOrderId, { tries = 20, intervalMs = 3000 } = {}) {
  const moClient = new MerchantOrder(mpClient);
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await moClient.get({ merchantOrderId: String(merchantOrderId) });
      const paidEnough = (r.paid_amount || 0) >= (r.total_amount || 0);
      const anyApproved = (r.payments || []).some(p => p.status === 'approved');
      if (paidEnough && anyApproved) return r;
      console.log(`[MO][POLL ${i}/${tries}] status=${r.status} paid=${r.paid_amount}/${r.total_amount}`);
    } catch (e) {
      console.warn('[MO][POLL][ERR]', e?.message || e);
    }
    await new Promise(res => setTimeout(res, intervalMs));
  }
  throw new Error('Merchant Order ainda não confirmada como paga dentro do tempo de espera.');
}

app.get('/retorno', (req, res) => {
  console.log('[RETORNO v5]', req.query, 'FRONTEND_RESULT_URL=', FRONTEND_RESULT_URL);

  const externalRef = '' + (req.query.external_reference || req.query.external_ref || '');
  if (!externalRef) return res.status(400).send('missing externalRef');

  let target;
  if (FRONTEND_RESULT_URL.includes('#')) {
    const [base, hash = ''] = FRONTEND_RESULT_URL.split('#');
    const [path, q = ''] = hash.split('?');
    const sp = new URLSearchParams(q);
    sp.set('externalRef', externalRef);
    target = `${base}#${path}?${sp.toString()}`;
  } else {
    const u = new URL(FRONTEND_RESULT_URL);
    u.searchParams.set('externalRef', externalRef);
    target = u.toString();
  }

  console.log('[RETORNO v5][REDIRECT] →', target);
  return res.redirect(302, target);
});




/* -------------------- IPN legado -------------------- */
app.all('/ipn', async (req, res) => {
  try {
    console.log('=== [IPN] QUERY ===\n', req.query);
    return res.sendStatus(200);
  } catch (e) {
    console.error('[IPN][ERR]', e?.message || e);
    return res.sendStatus(200);
  }
});

/* ====================== FIM DAS ROTAS ====================== */

// 404 padrão (opcional)
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});
