import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/runtimeGuards.js';
import { TicketDatabase } from '../src/db.js';
import { TelegramBotApi } from '../src/telegram.js';
import { normalizeNameForCompare } from '../src/utils.js';

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-runtime-'));
  const db = new TicketDatabase(path.join(dir, 'test.sqlite'), { reservationMinutes: 10, manualReviewMinutes: 30 });
  db.ensureUser(1); db.setUserName(1, 'Buyer One'); db.setUserPhone(1, '+251911111111');
  db.ensureUser(2); db.setUserName(2, 'Seller One'); db.setUserPhone(2, '+251922222222');
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

test('stale awaiting_payment state is cleared after a purchase is no longer payable', () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '200', selectedNumbers: { 200: 21 } });
  db.setUserState(1, 'awaiting_payment', { purchaseId: purchase.id });
  db.cancelPurchase(purchase.id, 1, 'cancelled');
  assert.equal(db.getUserState(1), null);
  close(db, dir);
});

test('active awaiting_payment state is preserved while proof can still be submitted', () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '200', selectedNumbers: { 200: 22 } });
  db.setUserState(1, 'awaiting_payment', { purchaseId: purchase.id });
  const state = db.getUserState(1);
  assert.equal(state.state, 'awaiting_payment');
  assert.equal(state.data.purchaseId, purchase.id);
  close(db, dir);
});

test('seller review is never mistaken for buyer payment proof', () => {
  const { db, dir } = makeDb();
  const sale = db.reserveSellerSale({ sellerTelegramId: 2, buyerName: 'Buyer One', buyerPhone: '0911111111', packageType: '100', selectedNumbers: { 100: 23 }, paymentTarget: 'finote' });
  assert.equal(sale.status, 'seller_review');
  assert.equal(db.getOpenPurchaseForUser(2), null);
  close(db, dir);
});

test('/cancel helper does not cancel a seller-entered sale', () => {
  const { db, dir } = makeDb();
  const sale = db.reserveSellerSale({ sellerTelegramId: 2, buyerName: 'Buyer One', buyerPhone: '0911111111', packageType: '50', selectedNumbers: { 50: 24 }, paymentTarget: 'finote' });
  assert.equal(db.cancelLatestOpenPurchaseForUser(2, 'generic cancel'), null);
  assert.equal(db.getPurchase(sale.id).status, 'seller_review');
  close(db, dir);
});

test('/cancel helper still cancels a direct buyer purchase', () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '50', selectedNumbers: { 50: 25 } });
  const cancelled = db.cancelLatestOpenPurchaseForUser(1, 'buyer cancel');
  assert.equal(cancelled.id, purchase.id);
  assert.equal(cancelled.status, 'cancelled');
  close(db, dir);
});

test('expired direct reservation cannot be revived by late payment proof', () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '200', selectedNumbers: { 200: 26 } });
  db.db.prepare("UPDATE purchases SET reserved_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(purchase.id);
  db.db.prepare("UPDATE ticket_numbers SET reserved_until='2000-01-01T00:00:00.000Z' WHERE purchase_id=?").run(purchase.id);
  assert.throws(() => db.submitPaymentProof(purchase.id, { reference: 'LATE-PROOF' }), /not awaiting payment proof/i);
  assert.equal(db.getPurchase(purchase.id).status, 'expired');
  close(db, dir);
});

test('expired seller reservation cannot be marked SOLD', () => {
  const { db, dir } = makeDb();
  const sale = db.reserveSellerSale({ sellerTelegramId: 2, buyerName: 'Buyer One', buyerPhone: '0911111111', packageType: '100', selectedNumbers: { 100: 27 }, paymentTarget: 'finote' });
  db.db.prepare("UPDATE purchases SET reserved_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(sale.id);
  db.db.prepare("UPDATE ticket_numbers SET reserved_until='2000-01-01T00:00:00.000Z' WHERE purchase_id=?").run(sale.id);
  assert.throws(() => db.confirmPurchase(sale.id, 2, { note: 'late sold' }), /cannot be confirmed from status expired/i);
  assert.equal(db.getPurchase(sale.id).status, 'expired');
  close(db, dir);
});

test('expired awaiting_payment state is cleared immediately', () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '50', selectedNumbers: { 50: 28 } });
  db.setUserState(1, 'awaiting_payment', { purchaseId: purchase.id });
  db.db.prepare("UPDATE purchases SET reserved_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(purchase.id);
  db.db.prepare("UPDATE ticket_numbers SET reserved_until='2000-01-01T00:00:00.000Z' WHERE purchase_id=?").run(purchase.id);
  assert.equal(db.getUserState(1), null);
  assert.equal(db.getPurchase(purchase.id).status, 'expired');
  close(db, dir);
});

test('Amharic buyer names remain comparable for later ticket linking', () => {
  const { db, dir } = makeDb();
  const buyerName = 'ሚኪያስ አቢዩ';
  assert.equal(normalizeNameForCompare(buyerName), normalizeNameForCompare('  ሚኪያስ   አቢዩ  '));
  assert.ok(normalizeNameForCompare(buyerName).length > 0);
  const sale = db.reserveSellerSale({ sellerTelegramId: 2, buyerName, buyerPhone: '0914444444', packageType: '50', selectedNumbers: { 50: 29 }, paymentTarget: 'finote' });
  db.confirmPurchase(sale.id, 2, { note: 'paid' });
  db.ensureUser(4); db.setUserName(4, buyerName); db.setUserPhone(4, '+251955555555');
  const linked = db.linkSellerTicketsForUser(4);
  assert.deepEqual(linked, [sale.id]);
  assert.equal(db.ticketsForUser(4)[0].number, 29);
  close(db, dir);
});

test('terminal seller/admin/payment-cancel callbacks retire their source cards', async () => {
  const bot = new TelegramBotApi('test-token');
  const calls = [];
  bot.call = async (method, payload = {}) => {
    calls.push([method, payload]);
    if (method === 'getUpdates') return [
      { update_id: 1, callback_query: { id: 'a', data: 'seller_ok:p1', from: { id: 2 }, message: { message_id: 10, chat: { id: 2 } } } },
      { update_id: 2, callback_query: { id: 'b', data: 'admin_pay_no:p2', from: { id: 999 }, message: { message_id: 11, chat: { id: 999 } } } },
      { update_id: 3, callback_query: { id: 'c', data: 'cancel_pay:p3', from: { id: 1 }, message: { message_id: 12, chat: { id: 1 } } } }
    ];
    return true;
  };
  await bot.getUpdates({ timeout: 0 });
  const deleted = calls.filter(([method]) => method === 'deleteMessage').map(([, payload]) => `${payload.chat_id}:${payload.message_id}`);
  assert.deepEqual(deleted.sort(), ['1:12', '2:10', '999:11']);
});

test('action card buttons are removed when Telegram refuses message deletion', async () => {
  const bot = new TelegramBotApi('test-token');
  const calls = [];
  bot.call = async (method, payload = {}) => {
    calls.push([method, payload]);
    if (method === 'getUpdates') return [{ update_id: 1, callback_query: { id: 'a', data: 'seller_no:p1', from: { id: 2 }, message: { message_id: 20, chat: { id: 2 } } } }];
    if (method === 'deleteMessage') throw new Error('message cannot be deleted');
    return true;
  };
  await bot.getUpdates({ timeout: 0 });
  const fallback = calls.find(([method]) => method === 'editMessageReplyMarkup');
  assert.ok(fallback);
  assert.deepEqual(fallback[1].reply_markup, { inline_keyboard: [] });
});
