import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePaymentReference, extractPaymentReference, looksLikePaymentReference, buildVerificationPayload, VerifyEtClient } from '../src/verifyEt.js';

const source = 'https://transactioninfo.ethiotelecom.et/receipt/DET8FJGUJ4';
const expected = {
  expectedAmount: 100,
  expectedAccountName: 'Finote Birhan',
  expectedAccountNumber: '0911223344'
};
const paid = (extras = {}) => ({
  success: true,
  data: [{
    bank: 'telebirr',
    status: 'success',
    verified: true,
    amount: 100,
    currency: 'ETB',
    receiverName: 'Finote Birhan',
    receiverAccount: '2519****3344',
    ...extras
  }]
});

test('extracts official Telebirr URLs from shared Telegram text', () => {
  const message = 'Your payment was successful!\nOpen receipt: ' + source + '?utm_source=share\nThank you.';
  assert.equal(extractPaymentReference(message), source + '?utm_source=share');
  assert.equal(parsePaymentReference(message).reference, 'DET8FJGUJ4');
  assert.equal(parsePaymentReference(message).bank, 'telebirr');
  assert.equal(looksLikePaymentReference(message), true);
  assert.equal(parsePaymentReference(source + '.').reference, 'DET8FJGUJ4');
  assert.equal(looksLikePaymentReference('https://evil.example/receipt/DET8FJGUJ4'), false);
  assert.throws(() => parsePaymentReference('https://evil.example/receipt/DET8FJGUJ4'), /Unsupported/);
});

test('Telebirr API payload matches Verify.et and identifies expected settlement wallet', () => {
  assert.deepEqual(buildVerificationPayload({
    provider: 'telebirr', reference: source, accountNumber: '0911223344'
  }), {
    bank: 'telebirr', transactionNumber: 'DET8FJGUJ4', settlementAccount: '0911223344'
  });
  assert.deepEqual(buildVerificationPayload({
    provider: 'CBE', reference: source, accountNumber: '1000303997441'
  }), {
    bank: 'telebirr', transactionNumber: 'DET8FJGUJ4'
  });
});

test('successful payment with matching amount and receipt recipient auto-approves without saved Verify.et accounts', () => {
  const verifier = new VerifyEtClient({ apiKey: 'mock' });
  const outcome = verifier.assess(paid({
    settlementAccountMatch: { matched: false, reason: 'no_registered_accounts', source: 'account_registry' }
  }), expected);
  assert.equal(outcome.outcome, 'approved');
});

test('explicit high-confidence wallet match permits masked receipt receiver', () => {
  const verifier = new VerifyEtClient({ apiKey: 'mock' });
  const result = verifier.assess(paid({
    receiverAccount: null,
    receiverName: null,
    settlementAccountMatch: {
      matched: true, ambiguous: false, source: 'manual',
      matchedSettlementAccount: '251911223344', matchConfidence: 'high'
    }
  }), expected);
  assert.equal(result.outcome, 'approved');
});

test('never auto-approve an unmatched receiver, mismatched amount or a wrong explicit settlement account', () => {
  const verifier = new VerifyEtClient({ apiKey: 'mock' });
  assert.equal(verifier.assess(paid({ amount: 200 }), expected).outcome, 'rejected');
  assert.equal(verifier.assess(paid({ receiverAccount: '2519****9999' }), expected).outcome, 'manual_review');
  assert.equal(verifier.assess(paid({ receiverName: 'Wrong Recipient' }), expected).outcome, 'manual_review');
  assert.equal(verifier.assess(paid({
    settlementAccountMatch: { matched: false, reason: 'candidate_account_mismatch' }
  }), expected).outcome, 'manual_review');
  assert.equal(verifier.assess(paid({
    receiverAccount: null,
    settlementAccountMatch: { matched: false, reason: 'no_registered_accounts' }
  }), expected).outcome, 'manual_review');
  assert.equal(verifier.assess(paid({
    receiverAccount: null, receiverName: null,
    settlementAccountMatch: { matched: true, matchedSettlementAccount: '09118889999', ambiguous: false }
  }), expected).outcome, 'manual_review');
});

test('Verify.et POST success immediately verifies a Telebirr link without manual review', async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  try {
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/api\/verify\?waitMs=5000/);
      payload = JSON.parse(options.body);
      return new Response(JSON.stringify(paid()), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const verifier = new VerifyEtClient({ apiKey: 'mock' });
    const result = await verifier.verify({
      provider: 'telebirr', reference: 'Shared receipt:\n' + source,
      accountNumber: '0911223344', ...expected
    });
    assert.equal(result.outcome, 'approved');
    assert.equal(payload.transactionNumber, 'DET8FJGUJ4');
    assert.equal(payload.settlementAccount, '0911223344');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bot payment flow uses extracted links and does not swallow pending confirmations', () => {
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /const rawReference = text && !text.startsWith\('\/'\) \? extractPaymentReference\(text\)/);
  assert.match(index, /parsePaymentReference\(reference\)/);
  assert.match(index, /'verification_pending'\]\.includes\(purchase.status\)/);
});

test('finds the official Telebirr link even after an unrelated link in shared text', () => {
  const shared = 'Visit https://example.com/help first. Receipt: ' + source + '?source=telegram.';
  assert.equal(parsePaymentReference(shared).reference, 'DET8FJGUJ4');
});

test('explicit Verify.et wallet match overcomes masked or differently spelled receiver name', () => {
  const verifier = new VerifyEtClient({ apiKey: 'mock' });
  assert.equal(verifier.assess(paid({
    receiverName: 'Masked recipient',
    settlementAccountMatch: {
      matched: true, ambiguous: false,
      matchedSettlementAccount: '0911223344', matchConfidence: 'high', source: 'manual'
    }
  }), expected).outcome, 'approved');
});

test('admin read-only check reports API authorization without spending verification credits', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/api\/verify\/history\?limit=1/);
      assert.equal(options.method, undefined);
      assert.equal(options.headers['x-api-key'], 'test-api-key');
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    };
    const verifier = new VerifyEtClient({ apiKey: 'test-api-key' });
    assert.equal((await verifier.diagnostics()).status, 'authenticated');
    assert.equal((await new VerifyEtClient().diagnostics()).status, 'missing_key');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('bot exposes Verify.et diagnostics to administrators only', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /if \(cmd === '\/verifystatus'\)/);
  assert.match(source, /if \(!db\.isAdmin\(telegramId\)\) return true;/);
  assert.match(source, /const health = await verifier\.diagnostics\(\)/);
  assert.match(source, /reference = 'https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/' \+ parsed\.reference/);
});
