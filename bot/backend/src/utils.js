import crypto from 'node:crypto';

export const POOLS = [200, 100, 50];
export const PACKAGE_PRICES = Object.freeze({ bundle: 300, '200': 200, '100': 100, '50': 50 });

export function nowIso() {
  return new Date().toISOString();
}

export function addMinutesIso(minutes, from = Date.now()) {
  return new Date(from + minutes * 60_000).toISOString();
}

export function normalizePhone(input) {
  const value = String(input || '').replace(/[\s()-]/g, '');
  if (/^0[79]\d{8}$/.test(value)) return `+251${value.slice(1)}`;
  if (/^[79]\d{8}$/.test(value)) return `+251${value}`;
  if (/^251[79]\d{8}$/.test(value)) return `+${value}`;
  if (/^\+251[79]\d{8}$/.test(value)) return value;
  return null;
}

export function maskPhone(phone) {
  const p = normalizePhone(phone) || String(phone || '');
  if (p.length < 7) return p;
  return `${p.slice(0, 5)}****${p.slice(-3)}`;
}

export function formatNumber(n) {
  return String(n).padStart(3, '0');
}

export function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function shortCode(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeJsonParse(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

export function truncate(value, max = 120) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function packagePools(packageType) {
  if (packageType === 'bundle') return POOLS;
  const n = Number(packageType);
  return POOLS.includes(n) ? [n] : [];
}

export function amountForPackage(packageType) {
  return PACKAGE_PRICES[packageType] ?? null;
}

export function encodeUnavailableBitset(numbers) {
  const bytes = Buffer.alloc(25, 0);
  for (const raw of numbers) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 200) continue;
    const idx = n - 1;
    bytes[Math.floor(idx / 8)] |= (1 << (idx % 8));
  }
  return bytes.toString('base64url');
}

export function decodeUnavailableBitset(encoded) {
  const set = new Set();
  if (!encoded) return set;
  let bytes;
  try { bytes = Buffer.from(encoded, 'base64url'); } catch { return set; }
  for (let idx = 0; idx < Math.min(200, bytes.length * 8); idx += 1) {
    if (bytes[Math.floor(idx / 8)] & (1 << (idx % 8))) set.add(idx + 1);
  }
  return set;
}

export function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function normalizeNameForCompare(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}
