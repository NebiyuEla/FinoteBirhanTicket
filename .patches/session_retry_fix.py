from pathlib import Path

ROOT = Path('.')

def read(path):
    return (ROOT / path).read_text(encoding='utf-8')

def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {count}')
    return text.replace(old, new, 1)

# Keep a Mini App session reusable when a selected number was already taken.
# The session is consumed only after the reservation succeeds.
db_path = 'bot/backend/src/db.js'
db = read(db_path)
old = """  consumeWebSession(token, telegramId) {
    const row = this.db.prepare('SELECT * FROM web_sessions WHERE token=?').get(token);
    if (!row || row.telegram_id !== telegramId || row.used_at || row.expires_at < nowIso()) return null;
    this.db.prepare('UPDATE web_sessions SET used_at=? WHERE token=?').run(nowIso(), token);
    return row;
  }
"""
new = """  peekWebSession(token, telegramId) {
    const row = this.db.prepare('SELECT * FROM web_sessions WHERE token=?').get(token);
    if (!row || row.telegram_id !== telegramId || row.used_at || row.expires_at < nowIso()) return null;
    return row;
  }

  consumeWebSession(token, telegramId) {
    const row = this.peekWebSession(token, telegramId);
    if (!row) return null;
    const result = this.db.prepare('UPDATE web_sessions SET used_at=? WHERE token=? AND used_at IS NULL').run(nowIso(), token);
    return Number(result?.changes ?? 0) === 1 ? row : null;
  }
"""
db = replace_once(db, old, new, 'web session peek/consume')
write(db_path, db)

index_path = 'bot/backend/src/index.js'
index = read(index_path)
index = replace_once(
    index,
    "  const session = db.consumeWebSession(payload.session, telegramId);\n",
    "  const session = db.peekWebSession(payload.session, telegramId);\n",
    'peek before reservation'
)

seller_old = """      const purchase = db.reserveSellerSale({
        sellerTelegramId: telegramId,
        buyerName: payload.buyer_name,
        buyerPhone: payload.buyer_phone,
        packageType: payload.package,
        selectedNumbers: payload.numbers,
        paymentTarget: payload.payment_target || 'finote'
      });
      await beginSellerPaymentAccountSelection(telegramId, purchase);
"""
seller_new = """      const purchase = db.reserveSellerSale({
        sellerTelegramId: telegramId,
        buyerName: payload.buyer_name,
        buyerPhone: payload.buyer_phone,
        packageType: payload.package,
        selectedNumbers: payload.numbers,
        paymentTarget: payload.payment_target || 'finote'
      });
      if (!db.consumeWebSession(payload.session, telegramId)) {
        db.cancelPurchase(purchase.id, telegramId, 'Mini App session expired before seller checkout');
        throw new Error('This ticket page expired before checkout. Open the refreshed list.');
      }
      await beginSellerPaymentAccountSelection(telegramId, purchase);
"""
index = replace_once(index, seller_old, seller_new, 'seller consume after reserve')

direct_old = """    const purchase = db.reservePurchase({
      telegramId,
      packageType: payload.package,
      selectedNumbers: payload.numbers
    });
    await beginDirectPaymentAccountSelection(telegramId, purchase);
"""
direct_new = """    const purchase = db.reservePurchase({
      telegramId,
      packageType: payload.package,
      selectedNumbers: payload.numbers
    });
    if (!db.consumeWebSession(payload.session, telegramId)) {
      db.cancelPurchase(purchase.id, telegramId, 'Mini App session expired before checkout');
      throw new Error('This ticket page expired before checkout. Open the refreshed list.');
    }
    await beginDirectPaymentAccountSelection(telegramId, purchase);
"""
index = replace_once(index, direct_old, direct_new, 'buyer consume after reserve')
write(index_path, index)

# Regression test: failed stale-number attempts must not burn the Mini App session.
test_path = ROOT / 'bot/backend/tests/sessionRetry.test.js'
test_path.write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TicketDatabase } from '../src/db.js';

test('Mini App session can be checked without consuming it, then consumed exactly once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-session-retry-'));
  const db = new TicketDatabase(path.join(dir, 'test.sqlite'));
  try {
    db.ensureUser(123);
    const token = db.createWebSession(123, null, 5);
    assert.ok(db.peekWebSession(token, 123));
    assert.ok(db.peekWebSession(token, 123), 'peek must not burn the session');
    assert.ok(db.consumeWebSession(token, 123));
    assert.equal(db.peekWebSession(token, 123), null);
    assert.equal(db.consumeWebSession(token, 123), null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('web app handler peeks before reservation and consumes only after successful reserve', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const peek = source.indexOf('db.peekWebSession(payload.session, telegramId)');
  const reserve = source.indexOf('db.reservePurchase({', peek);
  const consume = source.indexOf('db.consumeWebSession(payload.session, telegramId)', reserve);
  assert.ok(peek > 0);
  assert.ok(reserve > peek);
  assert.ok(consume > reserve);
});
""", encoding='utf-8')

print('Session retry safety patch applied.')
