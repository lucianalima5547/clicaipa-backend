// config.js — centraliza ENV e valida o que é obrigatório

function must(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`[ENV] Missing required variable: ${name}`);
  }
  return v;
}

function mask(token, keep = 6) {
  if (!token) return '(empty)';
  const s = String(token);
  return s.length <= keep ? '*'.repeat(s.length) : s.slice(-keep).padStart(s.length, '*');
}

const CONFIG = {
  // Básico
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: parseInt(process.env.PORT || '10000', 10),

  // URLs
  PUBLIC_BASE_URL: must('PUBLIC_BASE_URL'), // ex: https://api.clicaipa.com.br
  APP_BASE_URL: must('APP_BASE_URL'),       // ex: https://app.clicaipa.com.br
  FRONTEND_RESULT_URL: process.env.FRONTEND_RESULT_URL, // ex: https://app.clicaipa.com.br/#/resultado

  // Banco
  DATABASE_URL: must('DATABASE_URL'),

  // Mercado Pago
  MP_ACCESS_TOKEN: must('MP_ACCESS_TOKEN'),
  MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY, // opcional (frontend)

  // Firebase (uma das duas pode estar presente)
  FIREBASE_CONFIG: process.env.FIREBASE_CONFIG, // JSON inline
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS, // caminho para Secret File

  // Email/SMTP (opcional, se você usa disparo de emails)
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  FROM_EMAIL: process.env.FROM_EMAIL,

  // Admin (opcional)
  ADMIN_KEY: process.env.ADMIN_KEY,

  // CORS (opcional)
  CORS_ORIGINS: process.env.CORS_ORIGINS, // separado por vírgula
};

function printSummary() {
  console.log('[BOOT]', 'NODE_ENV=', CONFIG.NODE_ENV);
  console.log('[BOOT]', 'PUBLIC_BASE_URL=', CONFIG.PUBLIC_BASE_URL);
  console.log('[BOOT]', 'APP_BASE_URL=', CONFIG.APP_BASE_URL);
  if (CONFIG.FRONTEND_RESULT_URL) {
    console.log('[BOOT]', 'FRONTEND_RESULT_URL=', CONFIG.FRONTEND_RESULT_URL);
  }
  console.log('[BOOT]', 'DB last6=', mask(CONFIG.DATABASE_URL));
  console.log('[BOOT]', 'MP token flavor:',
    CONFIG.MP_ACCESS_TOKEN.startsWith('APP_USR') ? 'APP_USR' :
    (CONFIG.MP_ACCESS_TOKEN.startsWith('TEST-') ? 'TEST' : 'OTHER'),
    '| last6=', mask(CONFIG.MP_ACCESS_TOKEN));
  if (CONFIG.MP_PUBLIC_KEY) console.log('[BOOT]', 'MP_PUBLIC_KEY last6=', mask(CONFIG.MP_PUBLIC_KEY));

  if (CONFIG.GOOGLE_APPLICATION_CREDENTIALS) console.log('[FIREBASE] usando GOOGLE_APPLICATION_CREDENTIALS');
  else if (CONFIG.FIREBASE_CONFIG) console.log('[FIREBASE] usando FIREBASE_CONFIG');
  else console.log('[FIREBASE] sem credenciais (Firebase desativado?)');

  if (CONFIG.SMTP_HOST) {
    console.log('[SMTP] host=', CONFIG.SMTP_HOST, 'user last4=', mask(CONFIG.SMTP_USER || '', 4));
  }
  if (CONFIG.CORS_ORIGINS) console.log('[CORS] origins=', CONFIG.CORS_ORIGINS);
  if (CONFIG.ADMIN_KEY) console.log('[ADMIN] ADMIN_KEY configurada (oculta)');
}

module.exports = { CONFIG, printSummary };
