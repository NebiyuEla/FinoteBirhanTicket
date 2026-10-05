import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/runtimeGuards.js';
import { TicketDatabase } from '../src/db.js';
import { TelegramBotApi } from '../src/telegram.js';

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-recovery-'));
  const db = new TicketDatabase(path.join(dir, 'test.sqlite'), { reservationMinutes: 10, manualReviewMinutes: 30 });
  db.ensureUser(1); db.setUserName(1, 'Buyer One'); db.setUserPhone(1, '+251911111111');
  db.ensureUser(2); db.setUserName(2, 'Seller One'); db.setUserPhone(2, '+251922222222');
  db.ensureUser(3); db.setUserName(3, 'Buyer Two'); db.setUserPhone(3, '+251944444444');
  db.ensureUser(999); db.setUserName(999, 'Admin'); db.setUserPhone(999, '+251933333333'); db.addAdmin(999);
  db.setSetting('payment_provider', 'cbe', 999);
  db.setSetting('payment_account_name', 'Finote Birhan', 999);
  db.setSetting('payment_account_number', '1000376307623', 999);
  const seller = db.activateSellerRole(2, 999).seller;
  return { db, dir, seller };
}

function close(db, dir) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function expire(db, purchaseId) {
  const justExpired = new Date(Date.now() - 60_000).toISOString();
  db.db.prepare('UPDATE purchases SET reserved_until=? WHERE id=?').run(justExpired, purchaseId);
  db.db.prepare('UPDATE ticket_numbers SET reserved_until=? WHERE purchase_id=?').run(justExpired, purchaseId);
  db.releaseExpiredReservations();
}

test('Recovery queue includes unresolved seller reviews and recently expired payments', () => {
  const { db, dir } = makeDb();
  const direct = db.reservePurchase({ telegramId: 1, packageType: '200', selectedNumbers: { 200: 61 } });
  expire(db, direct.id);

  const sellerSale = db.reserveSellerSale({
    sellerTelegramId: 2,
    buyerName: 'Offline Buyer',
    buyerPhone: '0915555555',
    packageType: '100',
    selectedNumbers: { 100: 62 },
    paymentTarget: 'finote'
  });

  const queue = db.recoveryQueue();
  assert.ok(queue.some((item) => item.id === direct.id && item.status === 'expired'));
  assert.ok(queue.some((item) => item.id === sellerSale.id && item.status === 'seller_review'));
  const stats = db.recoveryStats();
  assert.equal(stats.recentExpired, 1);
  assert.ok(stats.attention >= 2);
  close(db, dir);
});

test('Admin can safely recover and approve an expired payment when the original number is still free', () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '50', selectedNumbers: { 50: 63 } });
  db.submitPaymentProof(purchase.id, { reference: 'RECOVERY-REF-63' });
  const legacyExpiredAt = new Date().toISOString();
  db.db.prepare(`UPDATE purchases SET status='expired',reserved_until=? WHERE id=?`).run(legacyExpiredAt, purchase.id);
  db.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL WHERE purchase_id=?`).run(purchase.id);

  const before = db.assessRecoveryPurchase(purchase.id);
  assert.equal(before.availableForRestore, true);
  const paid = db.recoverExpiredPurchase(purchase.id, 999, { note: 'Approved from Recovery after outage.' });
  assert.equal(paid.status, 'paid');
  assert.equal(db.ticketsForPurchase(purchase.id).length, 1);
  const number = db.getTicketNumberDetails(50, 63);
  assert.equal(number.status, 'sold');
  close(db, dir);
});

test('Recovery approval is blocked if the expired number was taken by another purchase', () => {
  const { db, dir } = makeDb();
  const first = db.reservePurchase({ telegramId: 1, packageType: '50', selectedNumbers: { 50: 64 } });
  db.submitPaymentProof(first.id, { reference: 'RECOVERY-REF-64' });
  const legacyExpiredAt = new Date().toISOString();
  db.db.prepare(`UPDATE purchases SET status='expired',reserved_until=? WHERE id=?`).run(legacyExpiredAt, first.id);
  db.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL WHERE purchase_id=?`).run(first.id);

  const second = db.reservePurchase({ telegramId: 3, packageType: '50', selectedNumbers: { 50: 64 } });
  assert.throws(() => db.recoverExpiredPurchase(first.id, 999, { note: 'Should be blocked' }), /no longer available|cannot recover/i);
  assert.equal(db.getPurchase(first.id).status, 'expired');
  assert.equal(db.getPurchase(second.id).status, 'awaiting_proof');
  const number = db.getTicketNumberDetails(50, 64);
  assert.equal(number.purchase_id, second.id);
  assert.equal(number.status, 'reserved');
  close(db, dir);
});

test('Admin rejection resolves an expired recovery item without touching the released number', () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '100', selectedNumbers: { 100: 65 } });
  expire(db, purchase.id);
  assert.equal(db.getPurchase(purchase.id).status, 'expired');
  const rejected = db.rejectPurchase(purchase.id, 999, 'No payment evidence after outage.');
  assert.equal(rejected.status, 'rejected');
  assert.equal(db.getTicketNumberDetails(100, 65).status, 'available');
  assert.equal(db.recoveryQueue().some((item) => item.id === purchase.id), false);
  close(db, dir);
});

test('Recovery presentation exposes status and synthetic evidence labels without mutating stored references', () => {
  const { db, dir, seller } = makeDb();
  const sale = db.reserveSellerSale({
    sellerTelegramId: 2,
    buyerName: 'Seller Recovery Buyer',
    buyerPhone: '0916666666',
    packageType: '200',
    selectedNumbers: { 200: 66 },
    paymentTarget: 'finote'
  });
  assert.equal(db.getPurchase(sale.id).payment_reference, null);
  const rows = db.pendingReviews();
  const presented = rows.find((row) => row.id === sale.id);
  assert.ok(presented);
  assert.match(presented.buyer_name, /Status: SELLER_REVIEW/);
  assert.match(presented.payment_reference, /seller confirmation pending/i);
  assert.equal(db.getPurchase(sale.id).payment_reference, null);
  assert.equal(db.sellerPendingReviews(seller.id).length, 1);
  close(db, dir);
});

test('Admin dashboard UI is upgraded from Payments to Recovery', async () => {
  const { db, dir } = makeDb();
  db.dashboardStats();
  const bot = new TelegramBotApi('test-token');
  const calls = [];
  bot.call = async (method, payload = {}) => {
    calls.push([method, payload]);
    return { message_id: calls.length };
  };
  await bot.sendMessage(999, '🛠 FinoteBirhan Admin\n\nPending review: 0', {
    reply_markup: { inline_keyboard: [[{ text: '🧾 Payments', callback_data: 'admin_payments' }]] }
  });
  const sent = calls.find(([method]) => method === 'sendMessage')?.[1];
  assert.ok(sent);
  assert.match(sent.text, /Recovery attention:/);
  assert.match(sent.text, /expired reservations from the last 7 days/i);
  assert.equal(sent.reply_markup.inline_keyboard[0][0].text, '🚨 Recovery');
  close(db, dir);
});

test('Recovery Inspect callback is handled without losing the Telegram update offset', async () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '50', selectedNumbers: { 50: 67 } });
  db.submitPaymentProof(purchase.id, { reference: 'RECOVERY-REF-67' });
  db.dashboardStats();

  const bot = new TelegramBotApi('test-token');
  const calls = [];
  bot.call = async (method, payload = {}) => {
    calls.push([method, payload]);
    if (method === 'getUpdates') {
      return [{ update_id: 777, callback_query: { id: 'inspect-1', data: `admin_recovery_inspect:${purchase.id}`, from: { id: 999 }, message: { message_id: 90, chat: { id: 999 } } } }];
    }
    return { message_id: calls.length };
  };

  const updates = await bot.getUpdates({ timeout: 0 });
  assert.equal(updates[0].update_id, 777);
  assert.equal(updates[0].callback_query.data, 'runtime_recovery_handled');
  const inspect = calls.find(([method, payload]) => method === 'sendMessage' && String(payload.text || '').includes('RECOVERY INSPECT'));
  assert.ok(inspect);
  close(db, dir);
});
