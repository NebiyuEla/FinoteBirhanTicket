from pathlib import Path
import re

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


def replace_regex(text, pattern, replacement, label, flags=re.S):
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 regex match, found {count}')
    return updated

# ---- version -------------------------------------------------------------
index_path = 'bot/backend/src/index.js'
index = read(index_path)
index = replace_once(index, "const BOT_BUILD = '1.3.8';", "const BOT_BUILD = '1.3.9';", 'bot build')

package_path = 'bot/backend/package.json'
package = read(package_path)
package = replace_once(package, '"version": "1.3.8"', '"version": "1.3.9"', 'package version')
write(package_path, package)

version_test_path = 'bot/backend/tests/navigationRecoveryCore.test.js'
version_test = read(version_test_path)
version_test = replace_once(version_test, "/const BOT_BUILD = '1\\.3\\.8';/", "/const BOT_BUILD = '1\\.3\\.9';/", 'version test')
write(version_test_path, version_test)

# ---- canonical dashboard statistics -------------------------------------
db_path = 'bot/backend/src/db.js'
db = read(db_path)
new_dashboard_stats = r'''  dashboardStats() {
    this.releaseExpiredReservations();
    const users = this.db.prepare(`SELECT COUNT(*) AS c FROM users WHERE registration_state='complete'`).get().c;
    const paid = this.db.prepare(`SELECT
      COUNT(*) AS paid_count,
      COALESCE(SUM(amount_etb),0) AS sales_value,
      COALESCE(SUM(CASE WHEN receipt_status='confirmed' THEN 1 ELSE 0 END),0) AS confirmed_count,
      COALESCE(SUM(CASE WHEN receipt_status='confirmed' THEN amount_etb ELSE 0 END),0) AS confirmed_value,
      COALESCE(SUM(CASE WHEN COALESCE(receipt_status,'unreconciled')='unreconciled' THEN 1 ELSE 0 END),0) AS unreconciled_count,
      COALESCE(SUM(CASE WHEN COALESCE(receipt_status,'unreconciled')='unreconciled' THEN amount_etb ELSE 0 END),0) AS unreconciled_value,
      COALESCE(SUM(CASE WHEN receipt_status='not_received' THEN 1 ELSE 0 END),0) AS not_received_count,
      COALESCE(SUM(CASE WHEN receipt_status='not_received' THEN amount_etb ELSE 0 END),0) AS not_received_value,
      COALESCE(SUM(CASE WHEN source='direct' THEN 1 ELSE 0 END),0) AS direct_count,
      COALESCE(SUM(CASE WHEN source='direct' THEN amount_etb ELSE 0 END),0) AS direct_value,
      COALESCE(SUM(CASE WHEN source='seller' THEN 1 ELSE 0 END),0) AS seller_count,
      COALESCE(SUM(CASE WHEN source='seller' THEN amount_etb ELSE 0 END),0) AS seller_value,
      COALESCE(SUM(CASE WHEN package_type='bundle' THEN 3 ELSE 1 END),0) AS expected_sold_numbers,
      COALESCE(SUM(CASE WHEN amount_etb <> CASE package_type WHEN 'bundle' THEN 300 WHEN '200' THEN 200 WHEN '100' THEN 100 WHEN '50' THEN 50 ELSE amount_etb END THEN 1 ELSE 0 END),0) AS price_mismatch_count
      FROM purchases WHERE status='paid'`).get();
    const platform = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue
      FROM purchases WHERE status='paid' AND COALESCE(payment_target,'finote')='finote'`).get();
    const sellerCash = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue
      FROM purchases WHERE status='paid' AND source='seller' AND payment_target='seller'`).get();
    const paidPackages = this.db.prepare(`SELECT package_type, COUNT(*) AS sales, COALESCE(SUM(amount_etb),0) AS amount
      FROM purchases WHERE status='paid' GROUP BY package_type ORDER BY CASE package_type WHEN 'bundle' THEN 0 WHEN '200' THEN 1 WHEN '100' THEN 2 ELSE 3 END`).all();
    const sellerCashPackages = this.db.prepare(`SELECT package_type, COUNT(*) AS sales, COALESCE(SUM(amount_etb),0) AS amount
      FROM purchases WHERE status='paid' AND source='seller' AND payment_target='seller'
      GROUP BY package_type`).all();
    const open = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='awaiting_proof' THEN 1 ELSE 0 END),0) AS awaiting_proof,
      COALESCE(SUM(CASE WHEN status IN ('verification_pending','seller_review','manual_review') THEN 1 ELSE 0 END),0) AS payment_review,
      COALESCE(SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END),0) AS reserved_purchases
      FROM purchases`).get();
    const sellers = this.db.prepare(`SELECT COUNT(*) AS c FROM sellers WHERE status='approved'`).get().c;
    const issuedTickets = this.db.prepare(`SELECT COUNT(*) AS c FROM tickets`).get().c;
    const pools = this.db.prepare(`SELECT pool,
      SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) AS sold,
      SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END) AS reserved,
      SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) AS available
      FROM ticket_numbers GROUP BY pool ORDER BY pool DESC`).all();

    const paidPackagesCount = paidPackages.reduce((sum, row) => sum + Number(row.sales || 0), 0);
    const paidPackagesValue = paidPackages.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const soldNumberCount = pools.reduce((sum, row) => sum + Number(row.sold || 0), 0);
    const reservedNumberCount = pools.reduce((sum, row) => sum + Number(row.reserved || 0), 0);
    const availableNumberCount = pools.reduce((sum, row) => sum + Number(row.available || 0), 0);
    const receiptCountTotal = Number(paid.confirmed_count) + Number(paid.unreconciled_count) + Number(paid.not_received_count);
    const receiptValueTotal = Number(paid.confirmed_value) + Number(paid.unreconciled_value) + Number(paid.not_received_value);
    const sourceCountTotal = Number(paid.direct_count) + Number(paid.seller_count);
    const sourceValueTotal = Number(paid.direct_value) + Number(paid.seller_value);
    const statsIssues = [];
    if (Number(paid.price_mismatch_count) !== 0) statsIssues.push(`${paid.price_mismatch_count} paid purchase price mismatch(es)`);
    if (receiptCountTotal !== Number(paid.paid_count) || receiptValueTotal !== Number(paid.sales_value)) statsIssues.push('receipt reconciliation totals do not equal paid sales');
    if (sourceCountTotal !== Number(paid.paid_count) || sourceValueTotal !== Number(paid.sales_value)) statsIssues.push('direct + seller totals do not equal paid sales');
    if (paidPackagesCount !== Number(paid.paid_count) || paidPackagesValue !== Number(paid.sales_value)) statsIssues.push('package totals do not equal paid sales');
    if (soldNumberCount !== Number(paid.expected_sold_numbers)) statsIssues.push('sold-number count does not match paid packages');
    if (issuedTickets !== soldNumberCount) statsIssues.push('issued-ticket rows do not match sold numbers');
    if (pools.length !== 3 || pools.some((row) => Number(row.sold) + Number(row.reserved) + Number(row.available) !== 200)) statsIssues.push('ticket pool inventory does not total 200 per pool');

    const paymentReviewCount = Number(open.payment_review || 0);
    const awaitingProofCount = Number(open.awaiting_proof || 0);
    const reservedPurchaseCount = Number(open.reserved_purchases || 0);
    const openPaymentCount = paymentReviewCount + awaitingProofCount + reservedPurchaseCount;

    return {
      users,
      paidCount: Number(paid.paid_count),
      grossSalesValue: Number(paid.sales_value),
      salesValue: Number(paid.sales_value),
      revenue: Number(paid.confirmed_value),
      confirmedRevenue: Number(paid.confirmed_value),
      confirmedReceiptCount: Number(paid.confirmed_count),
      unreconciledRevenue: Number(paid.unreconciled_value),
      unreconciledCount: Number(paid.unreconciled_count),
      notReceivedRevenue: Number(paid.not_received_value),
      notReceivedCount: Number(paid.not_received_count),
      platformRevenue: Number(platform.revenue),
      platformPaidCount: Number(platform.c),
      directCount: Number(paid.direct_count),
      directRevenue: Number(paid.direct_value),
      sellerCount: Number(paid.seller_count),
      sellerRevenue: Number(paid.seller_value),
      paidPackages,
      sellerCashCount: Number(sellerCash.c),
      sellerCashRevenue: Number(sellerCash.revenue),
      sellerCashPackages,
      awaitingProofCount,
      paymentReviewCount,
      reservedPurchaseCount,
      openPaymentCount,
      pending: openPaymentCount,
      sellers,
      pools,
      soldNumberCount,
      reservedNumberCount,
      availableNumberCount,
      issuedTickets,
      expectedSoldNumberCount: Number(paid.expected_sold_numbers),
      statisticsOk: statsIssues.length === 0,
      statsIssues
    };
  }

  sellerStats(sellerId) {'''
db = replace_regex(db, r"  dashboardStats\(\) \{.*?\n  \}\n\n  sellerStats\(sellerId\) \{", new_dashboard_stats, 'dashboardStats')
write(db_path, db)

# ---- simple, unambiguous admin overview ---------------------------------
new_admin = r'''async function showAdminDashboard(telegramId) {
  const am = langOf(telegramId) !== 'en';
  if (!db.isAdmin(telegramId)) return bot.sendMessage(telegramId, am ? 'የአስተዳዳሪ ፈቃድ ያስፈልጋል።' : 'Admin access required.');
  const s = db.dashboardStats();
  const recovery = db.recoveryStats();
  const salesBreakdown = formatPackageBreakdown(s.paidPackages, am);
  const statsHealth = s.statisticsOk
    ? (am ? '✅ ተመጣጣኝ' : '✅ Balanced')
    : (am ? `🚨 የዳታ ስህተት (${s.statsIssues.length})` : `🚨 DATA CHECK (${s.statsIssues.length})`);

  await bot.sendMessage(telegramId, am
    ? `🛠 ፍኖተ ብርሃን አስተዳዳሪ · v${BOT_BUILD}\n\n💰 ገንዘብ\n✅ በእውነት የገባ: ${s.confirmedRevenue} ብር\n⚠️ ማረጋገጥ የሚፈልግ: ${s.unreconciledRevenue} ብር\n🚫 እንዳልገባ የተመዘገበ: ${s.notReceivedRevenue} ብር\n\n🎟 ሽያጭ\nየSOLD ግዢዎች ዋጋ: ${s.salesValue} ብር · ${s.paidCount} ግዢዎች\nበቦት: ${s.directRevenue} ብር · ${s.directCount}\nበሻጭ: ${s.sellerRevenue} ብር · ${s.sellerCount}\nጥቅሎች: ${salesBreakdown}\n\n📍 ቁጥሮች\nSOLD: ${s.soldNumberCount} · ተይዟል: ${s.reservedNumberCount} · ነፃ: ${s.availableNumberCount}\n⏳ ክፍያ ሂደት: ${s.openPaymentCount} · ማስረጃ በመጠባበቅ: ${s.awaitingProofCount} · ማረጋገጫ: ${s.paymentReviewCount}\n\n👥 ደንበኞች: ${s.users} · ሻጮች: ${s.sellers}\n🚨 Recovery: ${recovery.attention}\n📊 ስታቲስቲክስ: ${statsHealth}`
    : `🛠 FinoteBirhan Admin · v${BOT_BUILD}\n\n💰 MONEY\n✅ Confirmed received: ${s.confirmedRevenue} ETB\n⚠️ Needs checking: ${s.unreconciledRevenue} ETB\n🚫 Marked not received: ${s.notReceivedRevenue} ETB\n\n🎟 SALES\nSold purchase value: ${s.salesValue} ETB · ${s.paidCount} purchases\nDirect bot: ${s.directRevenue} ETB · ${s.directCount}\nSeller-entered: ${s.sellerRevenue} ETB · ${s.sellerCount}\nPackages: ${salesBreakdown}\n\n📍 NUMBERS\nSOLD: ${s.soldNumberCount} · Reserved: ${s.reservedNumberCount} · Available: ${s.availableNumberCount}\n⏳ Payment attention: ${s.openPaymentCount} · Awaiting proof: ${s.awaitingProofCount} · In review: ${s.paymentReviewCount}\n\n👥 Customers: ${s.users} · Sellers: ${s.sellers}\n🚨 Recovery: ${recovery.attention}\n📊 Statistics: ${statsHealth}`,
    { reply_markup: inlineKeyboard([
      [{ text: am ? '💵 ክፍያዎች' : '💵 Payments', callback_data: 'admin_revenue_reconcile' }, { text: am ? '🎟 ትኬቶች' : '🎟 Tickets', callback_data: 'admin_pools' }],
      [{ text: '🚨 Recovery', callback_data: 'admin_payments' }, { text: am ? '🤝 ሻጮች' : '🤝 Sellers', callback_data: 'admin_sellers' }],
      [{ text: am ? '🏆 ዕጣ' : '🏆 Draw', callback_data: 'admin_draw' }, { text: am ? '💳 አካውንቶች' : '💳 Accounts', callback_data: 'admin_payment_accounts' }],
      [{ text: am ? '📤 ላክ' : '📤 Export', callback_data: 'admin_export' }, { text: am ? '⚙️ ተጨማሪ' : '⚙️ More', callback_data: 'admin_more' }]
    ]) }
  );

  if (!s.statisticsOk) {
    await bot.sendMessage(telegramId,
      `🚨 STATISTICS CONSISTENCY CHECK FAILED\n\n${s.statsIssues.map((issue) => `• ${issue}`).join('\\n')}\n\nDo not rely on totals until this is resolved.`,
      { reply_markup: inlineKeyboard([[{ text: '🚨 Recovery', callback_data: 'admin_payments' }, { text: '📤 Export', callback_data: 'admin_export' }]]) }
    );
  }
}

async function showAdminMore(telegramId) {
  const am = langOf(telegramId) !== 'en';
  if (!db.isAdmin(telegramId)) return bot.sendMessage(telegramId, 'Admin access required.');
  await bot.sendMessage(telegramId,
    am ? '⚙️ ተጨማሪ የአስተዳዳሪ እቃዎች\n\nአደገኛ የዳታ ማጥፋት ተግባር ከዋናው ዳሽቦርድ ተወግዷል።' : '⚙️ More admin tools\n\nDestructive data actions are intentionally kept away from the main dashboard.',
    { reply_markup: inlineKeyboard([
      [{ text: am ? '⚙️ ትዕዛዞች' : '⚙️ Commands', callback_data: 'admin_help' }],
      [{ text: am ? '🗑 ዳታ አጥፋ' : '🗑 Force Clear Data', callback_data: 'admin_forceclear' }],
      [{ text: am ? '⬅️ ዳሽቦርድ' : '⬅️ Dashboard', callback_data: 'admin_dashboard' }]
    ]) }
  );
}

async function showRevenueReconciliation(telegramId) {'''
index = replace_regex(index, r"async function showAdminDashboard\(telegramId\) \{.*?\n\}\n\nasync function showRevenueReconciliation\(telegramId\) \{", new_admin, 'admin dashboard')

# Route the compact More menu.
index = replace_once(
    index,
    "    if (data === 'admin_dashboard') return showAdminDashboard(telegramId);\n    if (data === 'admin_revenue_reconcile') return showRevenueReconciliation(telegramId);\n",
    "    if (data === 'admin_dashboard') return showAdminDashboard(telegramId);\n    if (data === 'admin_more') return showAdminMore(telegramId);\n    if (data === 'admin_revenue_reconcile') return showRevenueReconciliation(telegramId);\n",
    'admin more callback'
)

# Ticket inventory wording: sold numbers are not the same thing as paid purchases.
old_pool = """async function showPoolStatus(telegramId) {
  const s = db.dashboardStats();
  const lines = s.pools.map((p) => `🎟 ${p.pool} ETB\\nSold: ${p.sold}\\nReserved: ${p.reserved}\\nAvailable: ${p.available}`).join('\\n\\n');
  await bot.sendMessage(telegramId, lines);
}
"""
new_pool = """async function showPoolStatus(telegramId) {
  const s = db.dashboardStats();
  const am = langOf(telegramId) !== 'en';
  const lines = s.pools.map((p) => `🎟 ${p.pool} ETB\\nSOLD numbers: ${p.sold}\\nReserved now: ${p.reserved}\\nAvailable now: ${p.available}\\nCheck: ${Number(p.sold) + Number(p.reserved) + Number(p.available)}/200`).join('\\n\\n');
  await bot.sendMessage(telegramId,
    `${am ? '🎟 የትኬት ቁጥሮች' : '🎟 Ticket Inventory'}\\n\\n${lines}\\n\\n${am ? 'Bundle አንድ ግዢ በሶስቱም pool አንድ አንድ SOLD ቁጥር ይፈጥራል። Mini App ላይ available የሆኑ ቁጥሮች ብቻ ይታያሉ።' : 'A Bundle is one purchase but creates one SOLD number in each pool. The Mini App must show AVAILABLE numbers only.'}\\n\\nTotal SOLD numbers: ${s.soldNumberCount} · Reserved: ${s.reservedNumberCount} · Available: ${s.availableNumberCount}\\nStatistics: ${s.statisticsOk ? '✅ Balanced' : '🚨 CHECK DATA'}`,
    { reply_markup: inlineKeyboard([[{ text: am ? '🔄 አድስ' : '🔄 Refresh', callback_data: 'admin_pools' }, { text: am ? '⬅️ ዳሽቦርድ' : '⬅️ Dashboard', callback_data: 'admin_dashboard' }]]) }
  );
}
"""
index = replace_once(index, old_pool, new_pool, 'pool status')
write(index_path, index)

# ---- regression tests ----------------------------------------------------
test_path = 'bot/backend/tests/adminStatsAccuracy.test.js'
test_text = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TicketDatabase } from '../src/db.js';

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-admin-stats-'));
  const db = new TicketDatabase(path.join(dir, 'test.sqlite'), { reservationMinutes: 60, manualReviewMinutes: 60 });
  for (const [id, name, phone] of [
    [1, 'Buyer One', '+251911111111'],
    [2, 'Buyer Two', '+251922222222'],
    [3, 'Seller One', '+251933333333'],
    [999, 'Admin', '+251944444444']
  ]) {
    db.ensureUser(id); db.setUserName(id, name); db.setUserPhone(id, phone);
  }
  db.addAdmin(999);
  db.activateSellerRole(3, 999);
  return { db, dir };
}

function close(db, dir) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('dashboard statistics reconcile money, purchases, packages and pool inventory', () => {
  const { db, dir } = makeDb();

  const bundle = db.reservePurchase({ telegramId: 1, packageType: 'bundle', selectedNumbers: { 200: 1, 100: 1, 50: 1 } });
  db.confirmPurchase(bundle.id, 999, { note: 'confirmed bundle' });

  const direct100 = db.reservePurchase({ telegramId: 2, packageType: '100', selectedNumbers: { 100: 2 } });
  db.confirmPurchase(direct100.id, 999, { note: 'confirmed then reconciled not received' });
  db.setReceiptReconciliation(direct100.id, 999, 'not_received');

  const seller = db.reserveSellerSale({ sellerTelegramId: 3, buyerName: 'Cash Buyer', buyerPhone: '0911555555', packageType: '50', selectedNumbers: { 50: 3 } });
  db.confirmPurchase(seller.id, 999, { note: 'historical seller sale' });
  db.db.prepare(`UPDATE purchases SET receipt_status='unreconciled',receipt_verified_at=NULL,receipt_verified_by=NULL,receipt_verification_method=NULL WHERE id=?`).run(seller.id);

  db.reservePurchase({ telegramId: 1, packageType: '200', selectedNumbers: { 200: 4 } });

  const stats = db.dashboardStats();
  assert.equal(stats.salesValue, 450);
  assert.equal(stats.paidCount, 3);
  assert.equal(stats.confirmedRevenue, 300);
  assert.equal(stats.unreconciledRevenue, 50);
  assert.equal(stats.notReceivedRevenue, 100);
  assert.equal(stats.directRevenue, 400);
  assert.equal(stats.sellerRevenue, 50);
  assert.equal(stats.soldNumberCount, 5);
  assert.equal(stats.expectedSoldNumberCount, 5);
  assert.equal(stats.issuedTickets, 5);
  assert.equal(stats.reservedNumberCount, 1);
  assert.equal(stats.availableNumberCount, 594);
  assert.equal(stats.awaitingProofCount, 1);
  assert.equal(stats.paymentReviewCount, 0);
  assert.equal(stats.openPaymentCount, 1);
  assert.equal(stats.statisticsOk, true, stats.statsIssues.join('; '));
  assert.deepEqual(stats.statsIssues, []);

  for (const pool of stats.pools) {
    assert.equal(Number(pool.sold) + Number(pool.reserved) + Number(pool.available), 200);
  }
  close(db, dir);
});

test('dashboard consistency flag catches a corrupted sold-number state', () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '100', selectedNumbers: { 100: 5 } });
  db.confirmPurchase(purchase.id, 999, { note: 'paid' });
  db.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,sold_at=NULL WHERE pool=100 AND number=5`).run();

  const stats = db.dashboardStats();
  assert.equal(stats.statisticsOk, false);
  assert.ok(stats.statsIssues.some((issue) => issue.includes('sold-number count')));
  close(db, dir);
});
'''
write(test_path, test_text)

print('Admin dashboard accuracy patch applied.')
