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

test('Revenue matches all paid ticket sales while seller cash stays separately visible', () => {
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
    assert.equal(dashboard.revenue, 950);
    assert.equal(dashboard.platformRevenue, 400);
    assert.equal(dashboard.platformPaidCount, 2);
    assert.equal(dashboard.sellerCashRevenue, 550);
    assert.equal(dashboard.sellerCashCount, 4);
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


test('default ticket reservation timeout is 30 minutes', () => {
  const { db, dir } = makeDb();
  try {
    assert.equal(db.reservationMinutes, 30);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
