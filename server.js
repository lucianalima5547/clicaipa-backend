// server.js — validação via /retorno + webhook que concilia (formatos novo e antigo)
require('dotenv').config({ override: true });

const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const mp = require('mercadopago');
const { MercadoPagoConfig, Preference, MerchantOrder } = mp;

const app = express();

/* -------------------- Middlewares base (uma vez só) -------------------- */
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
}));
app.options(/.*/, cors()); // Express 5: preflight catch-all

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* -------------------- Ping / Health -------------------- */
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

/* -------------------- Mercado Pago config -------------------- */
const token = process.env.MP_ACCESS_TOKEN || '';
const flavor = token.includes('APP_USR-') ? 'APP_USR' : token.startsWith('TEST-') ? 'TEST' : 'unknown';
console.log(`[BOOT] MP token flavor: ${flavor} | last6=${token.slice(-6)}`);

const {
  // NÃO declare PORT aqui para evitar duplicar lá no listen
  MP_ACCESS_TOKEN,
  MP_PUBLIC_KEY,
  PUBLIC_BASE_URL,
} = process.env;

if (!MP_ACCESS_TOKEN || !MP_PUBLIC_KEY || !PUBLIC_BASE_URL) {
  console.error('[BOOT] Faltam variáveis no .env: MP_ACCESS_TOKEN, MP_PUBLIC_KEY, PUBLIC_BASE_URL');
  process.exit(1);
}

const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// http helper (Axios) para endpoints REST do MP
const MP_HTTP = axios.create({
  baseURL: 'https://api.mercadopago.com',
  headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
});
async function mpGet(path) {
  const { data } = await MP_HTTP.get(path);
  return data;
}

/* -------------------- Rotas auxiliares -------------------- */
app.get('/whoami', async (_req, res) => {
  try {
    const me = await MP_HTTP.get('/users/me').then(r => r.data);
    res.json({ id: me.id, nickname: me.nickname, email: me.email, site_id: me.site_id });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || e?.message });
  }
});

// Trata JSON inválido sem derrubar webhook
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    console.warn('[PARSER] JSON inválido em', req.path);
    return res.sendStatus(200);
  }
  next(err);
});

/* -------------------- Helpers -------------------- */
function gerarOrderId() {
  const dt = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = [
    dt.getFullYear(),
    pad(dt.getMonth() + 1),
    pad(dt.getDate()),
    '-',
    pad(dt.getHours()), 'h',
    pad(dt.getMinutes()), 'm',
  ].join('');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PED-${stamp}-${rand}`;
}

/* -------------------- Create Preference (Checkout Pro) -------------------- */
app.post('/create_preference', async (req, res) => {
  try {
    const {
      title = 'Produto teste',
      quantity = 1,
      unit_price = 9.9,
      orderId,        // opcional
      payer_email,    // opcional (comprador de teste)
    } = req.body || {};

    const resolvedOrderId = String(orderId || gerarOrderId());

    const pref = new Preference(mpClient);
    const body = {
      items: [{
        title: String(title),
        quantity: Number(quantity) || 1,
        unit_price: Number(unit_price) || 9.9,
      }],
      notification_url: `${PUBLIC_BASE_URL}/webhook`,
      back_urls: {
        success: `${PUBLIC_BASE_URL}/retorno?status=success`,
        failure: `${PUBLIC_BASE_URL}/retorno?status=failure`,
        pending: `${PUBLIC_BASE_URL}/retorno?status=pending`,
      },
      auto_return: 'approved',
      external_reference: resolvedOrderId,
    };

    if (payer_email) body.payer = { email: payer_email };

    const mpRes = await pref.create({ body });
    console.log('[PREFERENCE][OK]', mpRes.id, 'external_reference=', body.external_reference);

    return res.status(201).json({
      init_point: mpRes.init_point,
      sandbox_init_point: mpRes.sandbox_init_point,
      preference_id: mpRes.id,
      public_key: MP_PUBLIC_KEY,
      external_reference: body.external_reference,
    });
  } catch (err) {
    console.error('[PREFERENCE][ERR]', err?.response?.data || err?.message || err);
    return res.status(500).json({ error: 'Erro ao criar preferência' });
  }
});

/* -------------------- PIX (criação) -------------------- */
/* -------------------- PIX (criação) -------------------- */
app.post('/payments/pix', async (req, res) => {
  try {
    const {
      external_ref,
      amount,
      // campos opcionais vindos do app (se não vierem, uso defaults de teste)
      payer_email,
      payer_first_name,
      payer_last_name,
      payer_doc_type,
      payer_doc_number,
    } = req.body || {};

    const body = {
      transaction_amount: Number(amount || 9.9),
      description: 'Clicaipá - Geração de Cardápio',
      payment_method_id: 'pix',
      external_reference: external_ref || gerarOrderId(),
      notification_url: `${PUBLIC_BASE_URL}/webhook`,
      payer: {
        email: (payer_email || 'comprador+pix@example.com').toString(),
        first_name: (payer_first_name || 'Pix').toString(),
        last_name: (payer_last_name || 'Buyer').toString(),
        identification: {
          type: (payer_doc_type || 'CPF').toString(),
          number: (payer_doc_number || '19119119100').toString(), // CPF de teste
        },
      },
    };

    const mpResp = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
    });

    const pay = await mpResp.json();

    if (!mpResp.ok) {
      console.error('[PIX][CREATE][ERR]', JSON.stringify(pay, null, 2));
      // devolve os detalhes pra conseguirmos ver no app/log
      return res.status(400).json({ error: 'pix_create_failed', details: pay });
    }

    const td = pay?.point_of_interaction?.transaction_data || {};
    return res.json({
      payment_id: pay.id,
      status: pay.status, // normalmente 'pending' até pagar
      qr_base64: td.qr_code_base64,
      qr_copia_e_cola: td.qr_code,
      external_reference: pay.external_reference,
    });
  } catch (e) {
    console.error('[PIX][CREATE][ERR]', e);
    return res.status(500).json({ error: 'internal_error' });
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
    console.log('[PAGO][DB] Persistido no SQLite:', {
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
  const paid = mo.paid_amount || 0;
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
      total,
      paid,
      moStatus: mo.status,
    });
  }
}

async function conciliarPorMerchantOrder(merchantOrderId) {
  const mo = await mpGet(`/merchant_orders/${merchantOrderId}`);
  const total = mo.total_amount || 0;
  const paid = mo.paid_amount || 0;

  console.log('[MO][RAW]', { id: mo.id, status: mo.status, total_amount: total, paid_amount: paid, preference_id: mo.preference_id, collector: mo.collector, payments: mo.payments });

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
    console.log('[MO][ABERTO] Aguardando pagamento fechar.', {
      total,
      paid,
      status: mo.status,
    });
  }
}

/* -------------------- Webhook -------------------- */
app.all('/webhook', async (req, res) => {
  try {
    console.log('=== [WEBHOOK] HEADERS ===\n', req.headers);
    console.log('=== [WEBHOOK] QUERY   ===\n', req.query);
    console.log('=== [WEBHOOK] BODY    ===\n', req.body);

    res.sendStatus(200);

    const body = req.body || {};
    const q = req.query || {};

    if (body?.type === 'payment' && body?.data?.id) {
      await conciliarPorPayment(body.data.id); return;
    }
    if (body?.type === 'merchant_order' && body?.data?.id) {
      await conciliarPorMerchantOrder(body.data.id); return;
    }

    if (q?.topic === 'merchant_order' && q?.id) {
      await conciliarPorMerchantOrder(String(q.id)); return;
    }
    if (q?.type === 'payment' && q['data.id']) {
      await conciliarPorPayment(String(q['data.id'])); return;
    }

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

/* -------------------- Retorno (backup com poll) -------------------- */
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

app.get('/retorno', async (req, res) => {
  try {
    console.log('[RETORNO]', req.query);

    const toArr = (v) => Array.isArray(v) ? v : (v == null ? [] : [v]);

    const statuses = [
      ...toArr(req.query?.status),
      ...toArr(req.query?.collection_status),
    ].map(s => String(s).toLowerCase());

    const isApprovedLike = statuses.some(s => s === 'success' || s === 'approved');
    const moId = req.query?.merchant_order_id || req.query?.merchant_order;

    if (isApprovedLike && moId) {
      try {
        const r = await waitForMerchantOrderPaid(moId, { tries: 20, intervalMs: 3000 });
        console.log('[RETORNO][MERCHANT_ORDER][OK]', {
          id: r.id,
          status: r.status,
          total_amount: r.total_amount,
          paid_amount: r.paid_amount,
          payments: (r.payments || []).map(p => ({
            id: p.id,
            status: p.status,
            status_detail: p.status_detail,
            total_paid_amount: p.total_paid_amount,
          })),
        });
      } catch (e) {
        console.error('[RETORNO][MO][ERR]', e?.message || e);
      }
    } else {
      console.log('[RETORNO] status não aprovado ou sem merchant_order_id:', { statuses, moId });
    }

    return res.send('ok');
  } catch (err) {
    console.error('[RETORNO][ERR]', err);
    return res.send('ok');
  }
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

/* -------------------- Consulta pedidos pagos -------------------- */
app.get('/orders/:external_ref', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM orders WHERE external_ref = ?').get(req.params.external_ref);
    if (!row) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    res.json(row);
  } catch (e) {
    console.error('[ORDERS][ERR]', e?.message || e);
    res.status(500).json({ error: 'Erro ao consultar pedido' });
  }
});

/* ====================== FIM DAS SUAS ROTAS ====================== */

// 404 padrão (opcional)
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;     // único local onde PORT é declarado
app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});
