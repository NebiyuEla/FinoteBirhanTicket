import crypto from 'node:crypto';
import { normalizeNameForCompare } from './utils.js';

// Payment apps often share a sentence containing the official receipt link.
// Extract only an actual HTTPS URL; do not accept arbitrary external URLs.
export function extractPaymentReference(input) {
  const text = String(input || '').trim();
  const links = text.match(/https?:\/\/[^\s<>"'()]+/gi) || [];
  const clean = (value) => value.replace(/[.,;!?\]\u1361\u1362]+$/u, '');
  const officialHosts = new Set([
    'transactioninfo.ethiotelecom.et',
    'mbreciept.cbe.com.et',
    'mbreceipt.cbe.com.et',
    'apps.cbe.com.et'
  ]);
  const official = links.find((value) => {
    try { return officialHosts.has(new URL(clean(value)).hostname.toLowerCase()); }
    catch { return false; }
  });
  return official ? clean(official) : links.length ? clean(links[0]) : text;
}

export function parsePaymentReference(input) {
  const raw = extractPaymentReference(input);
  if (!raw) throw new Error('Transaction reference is required.');
  if (!/^https?:\/\//i.test(raw)) {
    if (!/^[a-z0-9_-]{3,96}$/i.test(raw)) throw new Error('Send a valid transaction reference or official receipt link.');
    return { bank: null, reference: raw };
  }

  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid receipt URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Use an official HTTPS receipt link.');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'transactioninfo.ethiotelecom.et') {
    const match = url.pathname.match(/^\/receipt\/([a-z0-9]{8,32})\/?$/i);
    if (!match) throw new Error('The Telebirr receipt link has no valid transaction number.');
    return { bank: 'telebirr', reference: match[1].toUpperCase() };
  }
  if (host === 'mbreciept.cbe.com.et' || host === 'mbreceipt.cbe.com.et' || host === 'apps.cbe.com.et') {
    return { bank: 'cbe', reference: url.origin + url.pathname + url.search };
  }
  throw new Error('Unsupported receipt URL. Send an official Telebirr/CBE receipt link or transaction reference.');
}

export function looksLikePaymentReference(input) {
  const value = extractPaymentReference(input);
  if (/^https?:\/\//i.test(value)) {
    try { return ['transactioninfo.ethiotelecom.et','mbreciept.cbe.com.et','mbreceipt.cbe.com.et','apps.cbe.com.et'].includes(new URL(value).hostname.toLowerCase()); }
    catch { return false; }
  }
  return /^(?=[a-z0-9_-]{8,64}$)(?=.*[0-9])[a-z0-9_-]+$/i.test(value);
}

export function buildVerificationPayload({ provider, reference, accountNumber }) {
  const source = parsePaymentReference(reference);
  const compact = String(provider || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let bank = source.bank || compact;
  if (!source.bank) {
    if (compact.includes('cbebirr')) bank = 'cbebirr';
    else if (compact.includes('cbe')) bank = 'cbe';
    else if (compact.includes('telebirr')) bank = 'telebirr';
    else if (compact.includes('mpesa')) bank = 'mpesa';
    else if (compact.includes('bankofabyssinia') || compact === 'boa') bank = 'boa';
  }
  const ref = source.reference;
  const account = String(accountNumber || '').replace(/\s+/g, '');
  if (!bank) throw new Error('Payment provider is required.');

  switch (bank) {
    case 'cbe':
      // Modern CBE receipt IDs and links do not require a suffix. Legacy FT references do.
      if (/^FT[a-z0-9]+$/i.test(ref)) {
        if (account.length < 8) throw new Error('CBE account number is too short.');
        return { bank: 'cbe', referenceNumber: ref, accountSuffix: account.slice(-8) };
      }
      return { bank: 'cbe', referenceNumber: ref };
    case 'boa':
      if (account.length < 5) throw new Error('Bank of Abyssinia account number is too short.');
      return { bank: 'boa', referenceNumber: ref, accountSuffix: account.slice(-5) };
    case 'telebirr':
      // The ticket's destination may be CBE even though the receipt is Telebirr.
      // Only submit a settlement wallet number when the destination is Telebirr.
      return compact.includes('telebirr') && !compact.includes('cbe')
        ? { bank: 'telebirr', transactionNumber: ref, settlementAccount: account }
        : { bank: 'telebirr', transactionNumber: ref };
    case 'mpesa': return { bank: 'mpesa', transactionNumber: ref };
    case 'cbebirr': return { bank: 'cbebirr', receiptNumber: ref, phone: account };
    case 'dashen':
    case 'awash':
    case 'siinqee':
    case 'kaafiebirr': return { bank, referenceNumber: ref };
    default: return { reference: ref };
  }
}

export class VerifyEtClient {
  constructor({ apiKey, baseUrl = 'https://verify.et', pollTimeoutSeconds = 125 } = {}) {
    this.apiKey = apiKey || '';
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.pollTimeoutSeconds = pollTimeoutSeconds;
  }

  get enabled() { return Boolean(this.apiKey); }

  // Read-only health check for administrators. No transaction is submitted,
  // no verification credits are consumed and the API key is never exposed.
  async diagnostics() {
    if (!this.enabled) return { status: 'missing_key', detail: 'VERIFY_ET_API_KEY is not configured.' };
    try {
      const response = await fetch(this.baseUrl + '/api/verify/history?limit=1', {
        headers: { 'x-api-key': this.apiKey },
        signal: AbortSignal.timeout(10000)
      });
      return response.ok
        ? { status: 'authenticated', detail: 'API key has verification:read access. Verification credits are not checked.' }
        : { status: 'api_error', detail: 'Verify.et returned HTTP ' + response.status + ' for a read-only API check.' };
    } catch {
      return { status: 'unreachable', detail: 'Verify.et is not reachable from this bot host.' };
    }
  }

  async verify({ provider, reference, accountNumber, expectedAmount, expectedAccountName, expectedAccountNumber }) {
    if (!this.enabled) return { outcome: 'manual_review', reason: 'Verify.et API key is not configured.' };
    const payload = buildVerificationPayload({ provider, reference, accountNumber });
    const response = await fetch(this.baseUrl + '/api/verify?waitMs=5000', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'idempotency-key': crypto.randomUUID()
      },
      body: JSON.stringify(payload)
    });
    const body = await safeBody(response);
    const expected = { expectedAmount, expectedAccountName, expectedAccountNumber };
    if (response.status === 202) {
      const requestId = body?.requestId || body?.verification?.requestId;
      if (!requestId) return { outcome: 'manual_review', reason: 'Verify.et queued without a request ID.', payload: body };
      return this.assess(await this.poll(requestId), { ...expected, requestId, original: body });
    }
    // Transport errors, insufficient credits, and provider outages are not
    // evidence that the buyer did not pay.
    if (!response.ok) return {
      outcome: 'manual_review',
      reason: 'Verify.et could not complete verification (HTTP ' + response.status + ').',
      payload: body
    };
    return this.assess(body, { ...expected, requestId: body?.requestId });
  }

  async poll(requestId) {
    const deadline = Date.now() + this.pollTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const response = await fetch(`${this.baseUrl}/api/verify/${encodeURIComponent(requestId)}`, {
        headers: { 'x-api-key': this.apiKey },
        signal: AbortSignal.timeout(10000)
      });
      const body = await safeBody(response);
      if (!response.ok) return { success: false, message: body?.message || `Polling failed (${response.status})`, data: body?.data };
      const status = body?.data?.processingStatus;
      if (status === 'completed' || status === 'failed') return body;
      await delay(Number(body?.links?.pollAfterMs) > 0 ? Number(body.links.pollAfterMs) : 1500);
    }
    return { success: false, message: 'Verification did not finish before the polling timeout.', requestId };
  }

  assess(body, { expectedAmount, expectedAccountName, expectedAccountNumber, requestId, original } = {}) {
    // A completed GET status can omit the transaction's amount and receiver.
    // Never issue tickets from status alone.
    const envelope = Array.isArray(body?.data) ? body.data[0] : body?.data || body?.verification || null;
    if (!envelope || typeof envelope !== 'object') return {
      outcome: 'manual_review', reason: 'Verify.et did not return transaction details.', requestId, payload: body
    };
    const nested = Array.isArray(envelope.result) ? envelope.result[0] : envelope.result;
    const record = nested && typeof nested === 'object'
      ? { ...envelope, ...nested, processingStatus: envelope.processingStatus || nested.processingStatus }
      : envelope;
    const processing = String(record.processingStatus || '').toLowerCase();
    const status = String(record.status || '').toLowerCase();
    if ((processing && processing !== 'completed') || record.verified !== true || (status && status !== 'success')) {
      return { outcome: 'manual_review', reason: 'Automatic verification was inconclusive. An administrator must review the receipt.', requestId, payload: body };
    }

    const amount = Number(record.amount);
    if (record.amount == null || record.amount === '' || !Number.isFinite(amount)) {
      return { outcome: 'manual_review', reason: 'Verified status returned without a transaction amount.', requestId, payload: body };
    }
    if (record.currency && String(record.currency).toUpperCase() !== 'ETB') {
      return { outcome: 'manual_review', reason: 'Verified currency is not ETB.', requestId, payload: body };
    }
    if (Number.isFinite(Number(expectedAmount)) && amount !== Number(expectedAmount)) {
      return { outcome: 'rejected', reason: 'Verified transfer amount is ' + amount + ' ETB; required amount is ' + expectedAmount + ' ETB.', requestId, payload: body };
    }

    const expectedName = normalizeNameForCompare(expectedAccountName || '');
    const receivedName = normalizeNameForCompare(record.receiverName || record.receiver_name || '');
    const expectedDigits = String(expectedAccountNumber || '').replace(/\D/g, '');
    const receivedAccount = String(record.receiverAccount || record.receiver_account || '');
    const receivedDigits = receivedAccount.replace(/\D/g, '');
    const hasReceiverName = Boolean(expectedName && receivedName);
    const hasReceiverAccount = Boolean(expectedDigits.length >= 4 && receivedDigits.length >= 4);

    const match = record.settlementAccountMatch;
    // Verify.et reports no_registered_accounts when its *account registry* is
    // empty. That is not a negative match against this purchase's destination.
    // Use the verified receipt fields instead. A genuinely mismatching account
    // or ambiguous result must still go to manual review.
    if (match?.matched === false &&
        !['no_registered_accounts', 'missing_receiver_account'].includes(String(match.reason || ''))) {
      return { outcome: 'manual_review', reason: 'The receipt does not match the intended payment account.', requestId, payload: body };
    }
    const matchedDigits = String(match?.matchedSettlementAccount || '').replace(/\D/g, '');
    const expectedCanonical = expectedDigits.startsWith('0') && expectedDigits.length === 10
      ? '251' + expectedDigits.slice(1) : expectedDigits;
    const matchedCanonical = matchedDigits.startsWith('0') && matchedDigits.length === 10
      ? '251' + matchedDigits.slice(1) : matchedDigits;
    const explicitlyMatchedAccount = match?.matched === true && !match.ambiguous &&
      expectedCanonical.length >= 9 && matchedCanonical === expectedCanonical;
    if (match?.matched === true && !explicitlyMatchedAccount) {
      return { outcome: 'manual_review', reason: 'The verified settlement account does not match this ticket payment destination.', requestId, payload: body };
    }
    if (!hasReceiverAccount && !explicitlyMatchedAccount) {
      return { outcome: 'manual_review', reason: 'Verified receipt has insufficient recipient account details to confirm the payment destination.', requestId, payload: body };
    }
    if (hasReceiverName && !explicitlyMatchedAccount &&
        !(receivedName.includes(expectedName) || expectedName.includes(receivedName))) {
      return { outcome: 'manual_review', reason: 'Verified recipient name does not match the configured account holder.', requestId, payload: body };
    }
    if (hasReceiverAccount && !expectedDigits.endsWith(receivedDigits.slice(-4))) {
      return { outcome: 'manual_review', reason: 'Verified recipient account does not match the payment destination.', requestId, payload: body };
    }

    return {
      outcome: 'approved', reason: 'Transfer verified with matching amount and recipient.',
      requestId, payload: { initial: original, terminal: body }
    };
  }

}

async function safeBody(response) {
  try { return await response.json(); } catch { return { message: `HTTP ${response.status}` }; }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
