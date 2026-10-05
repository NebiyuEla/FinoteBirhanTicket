import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TicketDatabase } from '../src/db.js';

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-seller-accounting-'));
  const db = new TicketDatabase(path.join(dir, 'test.sqlite'));
  db.ensureUser(1); db.setUserName(1, 'Buyer'); db.setUserPhone(1, '+251911111111');
  db.ensureUser(3); db.setUserName(3, 'Seller'); db.setUserPhone(3, '+251933333333');
  db.addAdmin(999);
  const seller = db.activateSellerRole(3, 999).seller;
  return { db, dir, seller };
}

function insertPaid(db, { id, packageType, amount, sellerId = null, source = 'direct', paymentTarget = 'finote' }) {
  const now = new Date().toISOString();
  db.db.prepare(`INSERT INTO purchases(
    id,buyer_telegram_id,buyer_name,buyer_phone,package_type,amount_etb,seller_id,source,status,
    reserved_until,created_at,paid_at,linked_telegram_id,payment_target
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, 1, 'Buyer', '+251911111111', packageType, amount, sellerId, source, 'paid',
    now, now, now, 1, paymentTarget
  );
}

test('Revenue matches all paid ticket sales while seller cash stays separately visible for legacy audit', () => {
  const { db, dir, seller } = makeDb();
  try {
    insertPaid(db, { id: 'DIRECT-200', packageType: '200', amount: 200 });
    insertPaid(db, { id: 'SELLER-FINOTE-200', packageType: '200', amount: 200, sellerId: seller.id, source: 'seller', paymentTarget: 'finote' });
    insertPaid(db, { id: 'SELLER-CASH-BUNDLE', packageType: 'bundle', amount: 300, sellerId: seller.id, source: 'seller', paymentTarget: 'seller' });
    insertPaid(db, { id: 'SELLER-CASH-100-A', packageType: '100', amount: 100, sellerId: seller.id, source: 'seller', paymentTarget: 'seller' });
    insertPaid(db, { id: 'SELLER-CASH-100-B', packageType: '100', amount: 100, sellerId: seller.id, source: 'seller', paymentTarget: 'seller' });
    insertPaid(db, { id: 'SELLER-CASH-50', packageType: '50', amount: 50, sellerId: seller.id, source: 'seller', paymentTarget: 'seller' });

    const dashboard = db.dashboardStats();
    assert.equal(dashboard.grossSalesValue, 950);
    assert.equal(dashboard.salesValue, 950);
    assert.equal(dashboard.revenue, 0);
    assert.equal(dashboard.unreconciledRevenue, 950);
    assert.equal(dashboard.platformRevenue, 400);
    assert.equal(dashboard.platformPaidCount, 2);
    assert.equal(dashboard.sellerCashRevenue, 550);
    assert.equal(dashboard.sellerCashCount, 4);
    db.setReceiptReconciliation('DIRECT-200', 999, 'confirmed');
    db.setReceiptReconciliation('SELLER-FINOTE-200', 999, 'confirmed');
    db.setReceiptReconciliation('SELLER-CASH-BUNDLE', 999, 'not_received');
    db.setReceiptReconciliation('SELLER-CASH-100-A', 999, 'not_received');
    db.setReceiptReconciliation('SELLER-CASH-100-B', 999, 'not_received');
    db.setReceiptReconciliation('SELLER-CASH-50', 999, 'not_received');
    const reconciled = db.dashboardStats();
    assert.equal(reconciled.revenue, 400);
    assert.equal(reconciled.confirmedReceiptCount, 2);
    assert.equal(reconciled.notReceivedRevenue, 550);
    assert.equal(reconciled.unreconciledRevenue, 0);
    assert.deepEqual(
      dashboard.paidPackages.map((row) => [row.package_type, row.sales, row.amount]).sort(),
      [['100', 2, 200], ['200', 2, 400], ['50', 1, 50], ['bundle', 1, 300]].sort()
    );
    assert.deepEqual(
      dashboard.sellerCashPackages.map((row) => [row.package_type, row.sales, row.amount]).sort(),
      [['100', 2, 200], ['50', 1, 50], ['bundle', 1, 300]].sort()
    );

    const sellerStats = db.sellerStats(seller.id);
    assert.equal(sellerStats.paidCount, 5);
    assert.equal(sellerStats.salesValue, 750);
    assert.equal(sellerStats.sellerCashRevenue, 550);
    assert.equal(sellerStats.sellerCashCount, 4);
    assert.equal(sellerStats.finotePaidRevenue, 200);
    assert.equal(sellerStats.finotePaidCount, 1);
    assert.deepEqual(
      sellerStats.packages.map((row) => [row.package_type, row.sales, row.amount]).sort(),
      [['100', 2, 200], ['200', 1, 200], ['50', 1, 50], ['bundle', 1, 300]].sort()
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seller sale cannot become paid until an admin approves it and seller target is normalized to FinoteBirhan', () => {
  const { db, dir, seller } = makeDb();
  try {
    db.addAdmin(999);
    const sale = db.reserveSellerSale({
      sellerTelegramId: 3,
      buyerName: 'Cash Buyer',
      buyerPhone: '0912345678',
      packageType: 'bundle',
      selectedNumbers: { 200: 11, 100: 12, 50: 13 },
      paymentTarget: 'seller'
    });
    assert.equal(sale.payment_target, 'finote');
    assert.equal(sale.amount_etb, 300);
    assert.throws(() => db.confirmPurchase(sale.id, seller.telegram_id, { note: 'seller self-confirm' }), /admin payment approval/i);
    assert.equal(db.getPurchase(sale.id).status, 'seller_review');
    const paid = db.confirmPurchase(sale.id, 999, { note: 'admin verified money received' });
    assert.equal(paid.status, 'paid');
    assert.equal(db.ticketsForPurchase(sale.id).length, 3);
    const dashboard = db.dashboardStats();
    assert.equal(dashboard.revenue, 300);
    assert.equal(dashboard.salesValue, 300);
    assert.equal(dashboard.confirmedReceiptCount, 1);
    assert.deepEqual(dashboard.paidPackages.map((r) => [r.package_type, r.sales, r.amount]), [['bundle', 1, 300]]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical package amount migration fixes malformed historical amounts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-canonical-prices-'));
  const dbPath = path.join(dir, 'test.sqlite');
  let db = new TicketDatabase(dbPath);
  try {
    db.ensureUser(1); db.setUserName(1, 'Buyer'); db.setUserPhone(1, '+251911111111');
    insertPaid(db, { id: 'BAD-BUNDLE', packageType: 'bundle', amount: 350 });
    assert.equal(db.getPurchase('BAD-BUNDLE').amount_etb, 350);
    db.close();
    db = new TicketDatabase(dbPath);
    assert.equal(db.getPurchase('BAD-BUNDLE').amount_etb, 300);
    assert.equal(db.dashboardStats().salesValue, 300);
    assert.equal(db.dashboardStats().revenue, 0);
    assert.equal(db.dashboardStats().unreconciledRevenue, 300);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default ticket reservation timeout is 60 minutes', () => {
  const { db, dir } = makeDb();
  try {
    assert.equal(db.reservationMinutes, 60);
    assert.equal(db.manualReviewMinutes, 60);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('submitted payment does not auto-expire or release its number while awaiting review', () => {
  const { db, dir } = makeDb();
  try {
    const purchase = db.reservePurchase({ telegramId: 1, packageType: '50', selectedNumbers: { 50: 77 } });
    const submitted = db.submitPaymentProof(purchase.id, { reference: 'TX-KEEP-LOCKED' });
    assert.ok(submitted.submitted_at);
    const past = new Date(Date.now() - 60_000).toISOString();
    db.db.prepare('UPDATE purchases SET reserved_until=? WHERE id=?').run(past, purchase.id);
    db.db.prepare("UPDATE ticket_numbers SET reserved_until=? WHERE purchase_id=? AND status='reserved'").run(past, purchase.id);
    db.releaseExpiredReservations();
    assert.equal(db.getPurchase(purchase.id).status, 'verification_pending');
    const number = db.getTicketNumberDetails(50, 77);
    assert.equal(number.status, 'reserved');
    assert.equal(number.purchase_id, purchase.id);
    db.rejectPurchase(purchase.id, 999, 'not received');
    assert.equal(db.getTicketNumberDetails(50, 77).status, 'available');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seller Buyer paid claim is protected from auto-expiry until admin decision', () => {
  const { db, dir } = makeDb();
  try {
    const sale = db.reserveSellerSale({
      sellerTelegramId: 3,
      buyerName: 'Protected Buyer',
      buyerPhone: '0912345678',
      packageType: '50',
      selectedNumbers: { 50: 88 }
    });
    const claimed = db.markSellerPaymentClaimed(sale.id, 3);
    assert.equal(claimed.status, 'manual_review');
    assert.ok(claimed.submitted_at);
    const past = new Date(Date.now() - 60_000).toISOString();
    db.db.prepare('UPDATE purchases SET reserved_until=? WHERE id=?').run(past, sale.id);
    db.db.prepare("UPDATE ticket_numbers SET reserved_until=? WHERE purchase_id=? AND status='reserved'").run(past, sale.id);
    db.releaseExpiredReservations();
    assert.equal(db.getPurchase(sale.id).status, 'manual_review');
    assert.equal(db.getTicketNumberDetails(50, 88).status, 'reserved');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
