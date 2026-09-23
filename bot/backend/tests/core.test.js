import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TicketDatabase } from '../src/db.js';
import { decodeUnavailableBitset, normalizePhone, encodeUnavailableBitset } from '../src/utils.js';
import { buildVerificationPayload, VerifyEtClient } from '../src/verifyEt.js';
import { generateTicketPng } from '../src/ticketImage.js';

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-v6-'));
  const db = new TicketDatabase(path.join(dir, 'test.sqlite'), { reservationMinutes: 10, manualReviewMinutes: 30 });
  db.ensureUser(1); db.setUserName(1, 'Test Buyer'); db.setUserPhone(1, '+251911111111');
  db.ensureUser(2); db.setUserName(2, 'Other Buyer'); db.setUserPhone(2, '+251922222222');
  db.setSetting('payment_provider', 'cbe', 999);
  db.setSetting('payment_account_name', 'Eyerusalem Fikadu', 999);
  db.setSetting('payment_account_number', '1000376307623', 999);
  return { db, dir };
}
function close(db, dir) { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }

test('seeds exactly 600 ticket positions', () => {
  const { db, dir } = makeDb();
  const stats = db.dashboardStats();
  assert.equal(stats.pools.reduce((sum, p) => sum + p.available, 0), 600);
  close(db, dir);
});

test('language defaults to Amharic and can switch to English', () => {
  const { db, dir } = makeDb();
  assert.equal(db.getUserLanguage(1), 'am');
  db.setUserLanguage(1, 'en');
  assert.equal(db.getUserLanguage(1), 'en');
  db.setUserLanguage(1, 'anything');
  assert.equal(db.getUserLanguage(1), 'am');
  close(db, dir);
});

test('prize labels have Amharic and English defaults', () => {
  const { db, dir } = makeDb();
  assert.ok(db.getSetting('prize_200_am'));
  assert.equal(db.getSetting('prize_200_am'), 'የቅድስት ማርያም ምስለ ሰዕል');
  assert.equal(db.getSetting('prize_100_en'), 'Handcrafted Wooden Bible');
  assert.match(db.getSetting('prize_50_am'), /ነጠላ/);
  assert.match(db.getSetting('prize_50_am'), /ቅድስት ማርያም/);
  close(db, dir);
});

test('direct purchase reserves and cancellation releases a number', () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '200', selectedNumbers: { 200: 77 } });
  assert.equal(db.availability()[200].includes(77), true);
  db.cancelPurchase(purchase.id, 1, 'cancelled');
  assert.equal(db.availability()[200].includes(77), false);
  const replacement = db.reservePurchase({ telegramId: 2, packageType: '200', selectedNumbers: { 200: 77 } });
  assert.equal(replacement.numbers[0].number, 77);
  close(db, dir);
});

test('ticket seller can manually sell a ticket and buyer is linked by phone', () => {
  const { db, dir } = makeDb();
  db.ensureUser(3); db.setUserName(3, 'Seller One'); db.setUserPhone(3, '+251933333333');
  const seller = db.activateSellerRole(3, 999).seller;
  const purchase = db.reserveSellerSale({
    sellerTelegramId: 3,
    buyerName: 'Test Buyer',
    buyerPhone: '0911111111',
    packageType: '100',
    selectedNumbers: { 100: 44 },
    paymentTarget: 'finote'
  });
  assert.equal(purchase.source, 'seller');
  assert.equal(purchase.linked_telegram_id, 1);
  db.confirmPurchase(purchase.id, 3, { note: 'manual SOLD' });
  const tickets = db.ticketsForUser(1);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].number, 44);
  assert.equal(db.sellerStats(seller.id).paidCount, 1);
  close(db, dir);
});

test('availability bitset round-trips', () => {
  const encoded = encodeUnavailableBitset([1, 2, 17, 99, 200]);
  assert.deepEqual([...decodeUnavailableBitset(encoded)], [1, 2, 17, 99, 200]);
});

test('Verify.et CBE payload is normalized correctly', () => {
  assert.deepEqual(buildVerificationPayload({ provider: 'CBE/Telebirr', reference: 'FT123', accountNumber: '1000376307623' }), {
    bank: 'cbe', referenceNumber: 'FT123', accountSuffix: '76307623'
  });
});

test('digital ticket generator emits a valid PNG', () => {
  const png = generateTicketPng({ id: 'FB-100-044-ABC123', pool: 100, number: 44, owner_name: 'Test Buyer' }, { drawAt: '2026-10-01T18:00:00+03:00' });
  assert.deepEqual([...png.subarray(0,8)], [137,80,78,71,13,10,26,10]);
  assert.ok(png.length > 1000);
});

test('admin force clear resets operational data but preserves admins and settings', () => {
  const { db, dir } = makeDb();
  db.ensureUser(999); db.setUserName(999, 'Main Admin'); db.setUserPhone(999, '+251944444444'); db.addAdmin(999);
  db.ensureUser(3); db.setUserName(3, 'Seller One'); db.setUserPhone(3, '+251933333333');
  const seller = db.activateSellerRole(3, 999).seller;
  const purchase = db.reserveSellerSale({
    sellerTelegramId: 3, buyerName: 'Test Buyer', buyerPhone: '0911111111', packageType: '100',
    selectedNumbers: { 100: 44 }, paymentTarget: 'finote'
  });
  db.confirmPurchase(purchase.id, seller.telegram_id, { note: 'manual SOLD' });
  db.setSetting('draw_at', '2026-10-01T18:00:00+03:00', 999);

  const before = db.forceClearOperationalData(999);
  assert.equal(before.purchases, 1);
  assert.equal(before.tickets, 1);
  assert.equal(db.isAdmin(999), true);
  assert.equal(db.getUser(999).full_name, 'Main Admin');
  assert.equal(db.getSetting('payment_account_number'), '1000376307623');
  assert.equal(db.getSetting('prize_100_en'), 'Handcrafted Wooden Bible');
  assert.equal(db.getSetting('draw_at'), '');
  assert.equal(db.salesOpen(), true);
  const stats = db.dashboardStats();
  assert.equal(stats.paidCount, 0);
  assert.equal(stats.sellers, 0);
  assert.equal(stats.users, 1);
  assert.equal(stats.pools.reduce((sum, pool) => sum + pool.available, 0), 600);
  assert.equal(db.listAudit(10)[0].action, 'admin.force_clear');
  close(db, dir);
});



test('legacy single payment settings are migrated into one default transfer account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-v12-legacy-'));
  const dbPath = path.join(dir, 'test.sqlite');
  let db = new TicketDatabase(dbPath);
  db.db.prepare('DELETE FROM payment_accounts').run();
  db.db.prepare(`UPDATE settings SET value='cbe' WHERE key='payment_provider'`).run();
  db.db.prepare(`UPDATE settings SET value='Legacy Holder' WHERE key='payment_account_name'`).run();
  db.db.prepare(`UPDATE settings SET value='100000000001' WHERE key='payment_account_number'`).run();
  db.close();

  db = new TicketDatabase(dbPath);
  const accounts = db.listPaymentAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].provider, 'cbe');
  assert.equal(accounts[0].account_name, 'Legacy Holder');
  assert.equal(accounts[0].account_number, '100000000001');
  assert.equal(accounts[0].is_active, 1);
  assert.equal(accounts[0].is_default, 1);
  close(db, dir);
});

test('admin can add another transfer account without overwriting the existing one', () => {
  const { db, dir } = makeDb();
  const first = db.getDefaultPaymentAccount();
  const second = db.addPaymentAccount({
    provider: 'telebirr',
    accountName: 'Finote Birhan',
    accountNumber: '0911223344'
  }, 999);

  const accounts = db.listPaymentAccounts();
  assert.equal(accounts.length, 2);
  assert.equal(db.getPaymentAccount(first.id).account_number, '1000376307623');
  assert.equal(second.account_number, '0911223344');
  assert.equal(db.getDefaultPaymentAccount().id, first.id);
  close(db, dir);
});

test('changing the default account keeps all accounts and synchronizes legacy settings', () => {
  const { db, dir } = makeDb();
  const first = db.getDefaultPaymentAccount();
  const second = db.addPaymentAccount({ provider: 'M-Pesa', accountName: 'Finote Birhan', accountNumber: '0711223344' }, 999);
  db.setDefaultPaymentAccount(second.id, 999);

  assert.equal(db.listPaymentAccounts().length, 2);
  assert.equal(db.getPaymentAccount(first.id).is_default, 0);
  assert.equal(db.getPaymentAccount(second.id).is_default, 1);
  assert.equal(db.getSetting('payment_provider'), 'M-Pesa');
  assert.equal(db.getSetting('payment_account_name'), 'Finote Birhan');
  assert.equal(db.getSetting('payment_account_number'), '0711223344');
  close(db, dir);
});

test('purchase snapshots the selected transfer account and history survives account edits and deletion', () => {
  const { db, dir } = makeDb();
  const second = db.addPaymentAccount({ provider: 'telebirr', accountName: 'Finote Birhan', accountNumber: '0911223344' }, 999);
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '200', selectedNumbers: { 200: 88 } });
  const assigned = db.assignPaymentAccountToPurchase(purchase.id, second.id, 1);
  assert.equal(assigned.payment_account_id, second.id);
  assert.equal(assigned.payment_provider, 'telebirr');
  assert.equal(assigned.payment_account_name, 'Finote Birhan');
  assert.equal(assigned.payment_account_number, '0911223344');

  db.updatePaymentAccount(second.id, { provider: 'telebirr', accountName: 'Changed Holder', accountNumber: '0911999999' }, 999);
  db.deletePaymentAccount(second.id, 999);
  const historical = db.getPurchase(purchase.id);
  assert.equal(historical.payment_provider, 'telebirr');
  assert.equal(historical.payment_account_name, 'Finote Birhan');
  assert.equal(historical.payment_account_number, '0911223344');
  const exported = db.exportPurchases().find((row) => row.id === purchase.id);
  assert.equal(exported.payment_provider, 'telebirr');
  assert.equal(exported.payment_account_name, 'Finote Birhan');
  assert.equal(exported.payment_account_number, '0911223344');
  assert.equal(db.getPaymentAccount(second.id), null);
  close(db, dir);
});

test('payment destination cannot be switched after proof is submitted', () => {
  const { db, dir } = makeDb();
  const first = db.getDefaultPaymentAccount();
  const second = db.addPaymentAccount({ provider: 'telebirr', accountName: 'Finote Birhan', accountNumber: '0911223344' }, 999);
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '100', selectedNumbers: { 100: 89 } });
  db.assignPaymentAccountToPurchase(purchase.id, second.id, 1);
  db.submitPaymentProof(purchase.id, { reference: 'TX-ACCOUNT-LOCK' });
  assert.throws(() => db.assignPaymentAccountToPurchase(purchase.id, first.id, 1), /can no longer change payment account/i);
  assert.equal(db.getPurchase(purchase.id).payment_account_id, second.id);
  close(db, dir);
});

test('disabling the default account promotes another active account and force clear preserves transfer accounts', () => {
  const { db, dir } = makeDb();
  db.ensureUser(999); db.setUserName(999, 'Main Admin'); db.setUserPhone(999, '+251944444444'); db.addAdmin(999);
  const first = db.getDefaultPaymentAccount();
  const second = db.addPaymentAccount({ provider: 'M-Pesa', accountName: 'Finote Birhan', accountNumber: '0711223344' }, 999);
  db.setPaymentAccountActive(first.id, false, 999);
  assert.equal(db.getDefaultPaymentAccount().id, second.id);
  assert.deepEqual(db.listPaymentAccounts({ activeOnly: true }).map((a) => a.id), [second.id]);

  db.forceClearOperationalData(999);
  assert.equal(db.listPaymentAccounts().length, 2);
  assert.equal(db.getDefaultPaymentAccount().id, second.id);
  assert.equal(db.getSetting('payment_account_number'), '0711223344');
  close(db, dir);
});

test('seller-owned payment destination is snapshotted independently from FinoteBirhan accounts', () => {
  const { db, dir } = makeDb();
  db.ensureUser(3); db.setUserName(3, 'Seller One'); db.setUserPhone(3, '+251933333333');
  const seller = db.activateSellerRole(3, 999).seller;
  db.updateSellerAccount(3, { paymentProvider: 'telebirr', accountName: 'Seller One', accountNumber: '0933333333' });
  const purchase = db.reserveSellerSale({
    sellerTelegramId: 3,
    buyerName: 'Other Buyer',
    buyerPhone: '0922222222',
    packageType: '50',
    selectedNumbers: { 50: 90 },
    paymentTarget: 'seller'
  });
  assert.equal(purchase.seller_id, seller.id);
  assert.equal(purchase.payment_target, 'seller');
  assert.equal(purchase.payment_provider, 'telebirr');
  assert.equal(purchase.payment_account_name, 'Seller One');
  assert.equal(purchase.payment_account_number, '0933333333');
  close(db, dir);
});

test('normalizePhone accepts Ethio telecom and Safaricom Ethiopian mobile contacts', () => {
  assert.equal(normalizePhone('0912345678'), '+251912345678');
  assert.equal(normalizePhone('+251912345678'), '+251912345678');
  assert.equal(normalizePhone('0712345678'), '+251712345678');
  assert.equal(normalizePhone('+251712345678'), '+251712345678');
  assert.equal(normalizePhone('251712345678'), '+251712345678');
});


test('Verify.et completed POST response reads amount from data array', () => {
  const client = new VerifyEtClient({ apiKey: 'test' });
  const result = client.assess({
    success: true,
    message: 'Verification completed.',
    data: [{ status: 'success', verified: true, amount: 300, currency: 'ETB', receiverName: 'Eyerusalem Fikadu' }]
  }, { expectedAmount: 300, expectedAccountName: 'Eyerusalem Fikadu', requestId: 'req-post' });
  assert.equal(result.outcome, 'approved');
});

test('Verify.et polled status response reads amount from data.result', () => {
  const client = new VerifyEtClient({ apiKey: 'test' });
  const result = client.assess({
    success: true,
    message: 'Verification status.',
    data: {
      requestId: 'req-poll',
      processingStatus: 'completed',
      status: 'success',
      verified: true,
      result: {
        bank: 'cbe',
        status: 'success',
        verified: true,
        amount: 300,
        currency: 'ETB',
        receiverName: 'Eyerusalem Fikadu',
        referenceNumber: 'FT123'
      }
    }
  }, { expectedAmount: 300, expectedAccountName: 'Eyerusalem Fikadu', requestId: 'req-poll' });
  assert.equal(result.outcome, 'approved');
});

test('Verify.et polled status still rejects mismatched amount', () => {
  const client = new VerifyEtClient({ apiKey: 'test' });
  const result = client.assess({
    data: {
      processingStatus: 'completed', status: 'success', verified: true,
      result: { status: 'success', verified: true, amount: '299.00', receiverName: 'Eyerusalem Fikadu' }
    }
  }, { expectedAmount: 300, expectedAccountName: 'Eyerusalem Fikadu', requestId: 'req-mismatch' });
  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason, /299/);
});
