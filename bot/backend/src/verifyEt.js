import crypto from 'node:crypto';
import { normalizeNameForCompare } from './utils.js';

export function buildVerificationPayload({ provider, reference, accountNumber }) {
  const rawProvider = String(provider || '').toLowerCase().trim();
  const compact = rawProvider.replace(/[^a-z0-9]/g, '');
  let bank = compact;
  if (compact.includes('cbebirr')) bank = 'cbebirr';
  else if (compact.includes('cbe')) bank = 'cbe';
  else if (compact.includes('telebirr')) bank = 'telebirr';
  else if (compact.includes('mpesa')) bank = 'mpesa';
  else if (compact.includes('bankofabyssinia') || compact === 'boa') bank = 'boa';
  const ref = String(reference || '').trim();
  const account = String(accountNumber || '').replace(/\s+/g, '');
  if (!bank || !ref) throw new Error('Payment provider and transaction reference are required.');

  switch (bank) {
    case 'cbe':
      if (account.length < 8) throw new Error('CBE account number is too short.');
      return { bank: 'cbe', referenceNumber: ref, accountSuffix: account.slice(-8) };
    case 'boa':
    case 'bankofabyssinia':
      if (account.length < 5) throw new Error('Bank of Abyssinia account number is too short.');
      return { bank: 'boa', referenceNumber: ref, accountSuffix: account.slice(-5) };
    case 'telebirr':
      return { bank: 'telebirr', transactionNumber: ref, settlementAccount: account };
    case 'mpesa':
    case 'm-pesa':
      return { bank: 'mpesa', transactionNumber: ref };
    case 'cbebirr':
    case 'cbe-birr':
      return { bank: 'cbebirr', receiptNumber: ref, phone: account };
    case 'dashen':
    case 'awash':
    case 'siinqee':
    case 'kaafiebirr':
      return { bank, referenceNumber: ref };
    default:
      return { reference: ref };
  }
}

export class VerifyEtClient {
  constructor({ apiKey, baseUrl = 'https://verify.et', pollTimeoutSeconds = 125 } = {}) {
    this.apiKey = apiKey || '';
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.pollTimeoutSeconds = pollTimeoutSeconds;
  }

  get enabled() { return Boolean(this.apiKey); }

  async verify({ provider, reference, accountNumber, expectedAmount, expectedAccountName }) {
    if (!this.enabled) return { outcome: 'manual_review', reason: 'Verify.et API key is not configured.' };
    const payload = buildVerificationPayload({ provider, reference, accountNumber });
    const idem = crypto.randomUUID();
    const response = await fetch(`${this.baseUrl}/api/verify?waitMs=5000`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'idempotency-key': idem
      },
      body: JSON.stringify(payload)
    });
    const body = await safeBody(response);

    if (response.status === 202) {
      const requestId = body?.requestId || body?.verification?.requestId;
      if (!requestId) return { outcome: 'manual_review', reason: 'Verify.et queued the request without a request ID.', payload: body };
      const terminal = await this.poll(requestId);
      return this.assess(terminal, { expectedAmount, expectedAccountName, requestId, original: body });
    }

    if (!response.ok) {
      if ([401, 402, 403, 429, 503].includes(response.status)) {
        return { outcome: 'manual_review', reason: body?.message || `Verify.et returned ${response.status}.`, payload: body };
      }
      return { outcome: 'rejected', reason: body?.message || `Verify.et returned ${response.status}.`, payload: body };
    }

    return this.assess(body, { expectedAmount, expectedAccountName, requestId: body?.requestId });
  }

  async poll(requestId) {
    const deadline = Date.now() + this.pollTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const response = await fetch(`${this.baseUrl}/api/verify/${encodeURIComponent(requestId)}`, {
        headers: { 'x-api-key': this.apiKey }
      });
      const body = await safeBody(response);
      if (!response.ok) return { success: false, message: body?.message || `Polling failed (${response.status})`, data: body?.data };
      const status = body?.data?.processingStatus;
      if (status === 'completed' || status === 'failed') return body;
      await delay(Number(body?.links?.pollAfterMs) > 0 ? Number(body.links.pollAfterMs) : 1500);
    }
    return { success: false, message: 'Verification did not finish before the polling timeout.', requestId };
  }

  assess(body, { expectedAmount, expectedAccountName, requestId, original } = {}) {
    // POST /api/verify returns the completed transaction directly in data[0].
    // GET /api/verify/:requestId returns a status wrapper in data, with the
    // actual bank transaction nested under data.result. Always unwrap that
    // result before checking amount/receiver fields.
    const envelope = Array.isArray(body?.data) ? body.data[0] : body?.data || body?.verification || null;
    if (!envelope) return { outcome: 'manual_review', reason: body?.message || 'Verify.et returned no verification record.', requestId, payload: body };

    const nestedResult = envelope?.result && typeof envelope.result === 'object' ? envelope.result : null;
    const record = nestedResult
      ? {
          ...envelope,
          ...nestedResult,
          verified: nestedResult.verified ?? envelope.verified,
          status: nestedResult.status ?? envelope.status,
          processingStatus: envelope.processingStatus ?? nestedResult.processingStatus
        }
      : envelope;

    if (!record.verified || record.status === 'failed' || record.status === 'not_found') {
      return { outcome: 'rejected', reason: body?.message || 'The transaction could not be verified.', requestId, payload: body };
    }

    const rawAmount = record.amount;
    const amount = Number(rawAmount);
    if (rawAmount == null || rawAmount === '' || !Number.isFinite(amount)) {
      return { outcome: 'manual_review', reason: 'The transaction is verified, but Verify.et did not return an amount to compare.', requestId, payload: body };
    }
    if (Number.isFinite(Number(expectedAmount)) && amount !== Number(expectedAmount)) {
      return { outcome: 'rejected', reason: `Verified amount is ${amount} ETB, but ${expectedAmount} ETB is required.`, requestId, payload: body };
    }

    const receiver = normalizeNameForCompare(record.receiverName || record.receiver_name || '');
    const expected = normalizeNameForCompare(expectedAccountName || '');
    if (receiver && expected) {
      const same = receiver.includes(expected) || expected.includes(receiver);
      if (!same) {
        return { outcome: 'manual_review', reason: 'Payment verified, but the receiver name does not clearly match the configured account holder.', requestId, payload: body };
      }
    }

    return { outcome: 'approved', reason: body?.message || 'Transaction verified.', requestId, payload: { initial: original, terminal: body } };
  }
}

async function safeBody(response) {
  try { return await response.json(); } catch { return { message: `HTTP ${response.status}` }; }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
