import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/runtimeGuards.js';
import { TicketDatabase } from '../src/db.js';
import { TelegramBotApi } from '../src/telegram.js';

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-seller-account-'));
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

test('Seller Account menu action is never consumed as payment proof', async () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '50', selectedNumbers: { 50: 41 } });
  db.setUserState(1, 'awaiting_payment', { purchaseId: purchase.id });

  const bot = new TelegramBotApi('test-token');
  bot.call = async (method) => {
    if (method === 'getUpdates') {
      return [{ update_id: 1, message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '💳 Seller Account' } }];
    }
    return true;
  };

  await bot.getUpdates({ timeout: 0 });
  assert.equal(db.getUserState(1), null);
  assert.equal(db.getPurchase(purchase.id).status, 'awaiting_proof');
  close(db, dir);
});

test('Seller Account shows pending approve/cancel cards before account setup', async () => {
  const { db, dir, seller } = makeDb();
  const sale = db.reserveSellerSale({
    sellerTelegramId: 2,
    buyerName: 'Mickeyas Abiyu',
    buyerPhone: '0914444444',
    packageType: '100',
    selectedNumbers: { 100: 42 },
    paymentTarget: 'finote'
  });
  assert.equal(db.sellerPendingReviews(seller.id).length, 1);

  db.setUserState(2, 'seller_account_provider', {});
  assert.equal(db.getUserState(2), null);

  const bot = new TelegramBotApi('test-token');
  const calls = [];
  bot.call = async (method, payload = {}) => {
    calls.push([method, payload]);
    return { message_id: calls.length };
  };

  await bot.sendMessage(2, `💳 Seller payment account\n\nThis is optional. Buyers can always pay the main FinoteBirhan account.\n\nSend your payment provider (for example CBE or Telebirr).`);

  const sent = calls.filter(([method, payload]) => method === 'sendMessage' && payload.chat_id === 2).map(([, payload]) => payload);
  assert.ok(sent.some((payload) => String(payload.text).includes('payment/sale confirmation')));
  const card = sent.find((payload) => String(payload.text).includes('Payment confirmation needed'));
  assert.ok(card);
  const callbacks = card.reply_markup.inline_keyboard[0].map((button) => button.callback_data);
  assert.deepEqual(callbacks, [`seller_ok:${sale.id}`, `seller_no:${sale.id}`]);

  close(db, dir);
});
