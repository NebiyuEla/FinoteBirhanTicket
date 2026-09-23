import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(file = '.env') {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) return;
  const content = fs.readFileSync(full, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function asInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function asSafeId(name) {
  const value = Number(process.env[name] ?? '');
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export const config = {
  botToken: process.env.BOT_TOKEN?.trim() || '',
  miniAppUrl: process.env.MINI_APP_URL?.trim() || '',
  adminSetupCode: process.env.ADMIN_SETUP_CODE?.trim() || '',
  adminTelegramId: asSafeId('ADMIN_TELEGRAM_ID'),
  defaultPaymentProvider: process.env.DEFAULT_PAYMENT_PROVIDER?.trim() || '',
  defaultPaymentAccountName: process.env.DEFAULT_PAYMENT_ACCOUNT_NAME?.trim() || '',
  defaultPaymentAccountNumber: process.env.DEFAULT_PAYMENT_ACCOUNT_NUMBER?.trim() || '',
  verifyEtApiKey: process.env.VERIFY_ET_API_KEY?.trim() || '',
  verifyEtBaseUrl: (process.env.VERIFY_ET_BASE_URL?.trim() || 'https://verify.et').replace(/\/$/, ''),
  dbPath: process.env.DB_PATH?.trim() || './data/finotebirhan.sqlite',
  reservationMinutes: asInt('RESERVATION_MINUTES', 10),
  manualReviewMinutes: asInt('MANUAL_REVIEW_MINUTES', 30),
  pollTimeoutSeconds: asInt('POLL_TIMEOUT_SECONDS', 125)
};

export function assertRuntimeConfig() {
  const missing = [];
  if (!config.botToken) missing.push('BOT_TOKEN');
  if (!config.adminTelegramId && (!config.adminSetupCode || config.adminSetupCode === 'CHANGE_ME_TO_A_RANDOM_SECRET')) {
    missing.push('ADMIN_TELEGRAM_ID or ADMIN_SETUP_CODE');
  }
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}
