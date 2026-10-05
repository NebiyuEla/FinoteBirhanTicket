from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}: {old[:180]!r}')
    write(path, text.replace(old, new, 1))


def regex_once(path, pattern, replacement, flags=0):
    text = read(path)
    out, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{path}: regex expected one match, found {count}: {pattern[:180]!r}')
    write(path, out)


# Version bump.
replace_once('bot/backend/package.json', '"version": "1.3.6"', '"version": "1.3.7"')
replace_once('bot/backend/src/index.js', "const BOT_BUILD = '1.3.6';", "const BOT_BUILD = '1.3.7';")

# Give users a longer unpaid selection/payment window. Submitted payments are protected separately below.
replace_once(
    'bot/backend/src/config.js',
    "  reservationMinutes: Math.max(30, asInt('RESERVATION_MINUTES', 30)),\n  manualReviewMinutes: asInt('MANUAL_REVIEW_MINUTES', 30),",
    "  reservationMinutes: Math.max(60, asInt('RESERVATION_MINUTES', 60)),\n  manualReviewMinutes: Math.max(60, asInt('MANUAL_REVIEW_MINUTES', 60)),"
)
replace_once('bot/backend/.env.example', 'RESERVATION_MINUTES=30\nMANUAL_REVIEW_MINUTES=30', 'RESERVATION_MINUTES=60\nMANUAL_REVIEW_MINUTES=60')
replace_once('bot/backend/src/db.js', 'constructor(dbPath, { reservationMinutes = 30, manualReviewMinutes = 30 } = {})', 'constructor(dbPath, { reservationMinutes = 60, manualReviewMinutes = 60 } = {})')
replace_once('bot/backend/src/db.js', 'createWebSession(telegramId, sellerId = null, ttlMinutes = 30)', 'createWebSession(telegramId, sellerId = null, ttlMinutes = 60)')

# Receipt reconciliation fields: historical paid/sold rows are intentionally not assumed to be cash received.
replace_once(
    'bot/backend/src/db.js',
    "    this.ensureColumn('purchases', 'payment_account_number', 'TEXT');\n    // Canonicalize historical purchase amounts from the package type.",
    "    this.ensureColumn('purchases', 'payment_account_number', 'TEXT');\n    this.ensureColumn('purchases', 'receipt_status', \"TEXT NOT NULL DEFAULT 'unreconciled'\");\n    this.ensureColumn('purchases', 'receipt_verified_at', 'TEXT');\n    this.ensureColumn('purchases', 'receipt_verified_by', 'INTEGER');\n    this.ensureColumn('purchases', 'receipt_verification_method', 'TEXT');\n    this.db.exec(`UPDATE purchases SET receipt_status='unreconciled' WHERE receipt_status IS NULL OR receipt_status NOT IN ('confirmed','not_received','unreconciled')`);\n    // Canonicalize historical purchase amounts from the package type."
)

# Replace expiry cleanup with lock reconciliation. Paid tickets are repaired to SOLD; terminal unpaid locks are released;
# only genuinely unpaid/unsubmitted purchases may auto-expire.
regex_once(
    'bot/backend/src/db.js',
    r"  releaseExpiredReservations\(\) \{.*?\n  \}\n\n  availability\(\) \{",
    '''  reconcileReservationLocksInCurrentTransaction(now = nowIso()) {
    // A paid purchase must never remain as a temporary reservation.
    this.db.prepare(`UPDATE ticket_numbers
      SET status='sold', reserved_until=NULL,
          sold_at=COALESCE(sold_at,(SELECT paid_at FROM purchases p WHERE p.id=ticket_numbers.purchase_id))
      WHERE status='reserved' AND purchase_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM purchases p WHERE p.id=ticket_numbers.purchase_id AND p.status='paid')`).run();

    // Release orphaned locks and locks belonging to terminal unpaid purchases.
    this.db.prepare(`UPDATE ticket_numbers
      SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL,sold_at=NULL
      WHERE status='reserved' AND (
        purchase_id IS NULL OR
        NOT EXISTS (SELECT 1 FROM purchases p WHERE p.id=ticket_numbers.purchase_id) OR
        EXISTS (SELECT 1 FROM purchases p WHERE p.id=ticket_numbers.purchase_id AND p.status IN ('expired','rejected','cancelled'))
      )`).run();

    // Payment evidence or a seller's "Buyer paid" claim protects the number until an admin resolves it.
    const expired = this.db.prepare(`SELECT id FROM purchases
      WHERE status IN ('reserved','awaiting_proof','verification_pending','seller_review','manual_review')
        AND submitted_at IS NULL
        AND reserved_until < ?`).all(now);
    for (const row of expired) {
      this.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL,sold_at=NULL WHERE purchase_id=? AND status='reserved'`).run(row.id);
      this.db.prepare(`UPDATE purchases SET status='expired', note=TRIM(COALESCE(note,'') || ' [auto-expired unpaid reservation]') WHERE id=?`).run(row.id);
    }
    return expired.length;
  }

  releaseExpiredReservations() {
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const released = this.reconcileReservationLocksInCurrentTransaction(now);
      this.db.exec('COMMIT');
      return released;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  availability() {''',
    flags=re.S
)

regex_once(
    'bot/backend/src/db.js',
    r"  releaseExpiredReservationsInCurrentTransaction\(now\) \{.*?\n  \}\n\n  getPurchase\(id\) \{",
    '''  releaseExpiredReservationsInCurrentTransaction(now) {
    return this.reconcileReservationLocksInCurrentTransaction(now);
  }

  getPurchase(id) {''',
    flags=re.S
)

# Seller payment claim becomes a protected manual-review state instead of being able to time out behind the admin.
replace_once(
    'bot/backend/src/db.js',
    "  findRegisteredBuyer(buyerName, buyerPhone) {",
    '''  markSellerPaymentClaimed(purchaseId, sellerTelegramId) {
    const seller = this.db.prepare(`SELECT * FROM sellers WHERE telegram_id=? AND status='approved'`).get(sellerTelegramId);
    const purchase = this.getPurchase(purchaseId);
    if (!seller || !purchase || purchase.seller_id !== seller.id || purchase.source !== 'seller') throw new Error('Seller sale not found.');
    if (purchase.status === 'paid') return purchase;
    if (!['seller_review','awaiting_proof','manual_review'].includes(purchase.status)) throw new Error(`Sale cannot be submitted from status ${purchase.status}.`);
    const now = nowIso();
    const protectedUntil = addMinutesIso(this.manualReviewMinutes);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const locks = this.db.prepare(`SELECT status,purchase_id FROM ticket_numbers WHERE purchase_id=?`).all(purchaseId);
      if (locks.length !== purchase.numbers.length || locks.some((row) => row.status !== 'reserved' || row.purchase_id !== purchaseId)) {
        throw new Error('Reservation is no longer intact. Ask an administrator to inspect Recovery.');
      }
      this.db.prepare(`UPDATE purchases SET status='manual_review',submitted_at=COALESCE(submitted_at,?),reserved_until=?,note=TRIM(COALESCE(note,'') || ' [seller reported buyer paid]') WHERE id=?`)
        .run(now, protectedUntil, purchaseId);
      this.db.prepare(`UPDATE ticket_numbers SET reserved_until=? WHERE purchase_id=? AND status='reserved'`).run(protectedUntil, purchaseId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.log(sellerTelegramId, 'seller_sale.payment_claimed', 'purchase', purchaseId, {});
    return this.getPurchase(purchaseId);
  }

  findRegisteredBuyer(buyerName, buyerPhone) {'''
)

# Receipt verification is explicit. Admin approvals count as confirmed receipts; Verify.et can opt in explicitly.
replace_once(
    'bot/backend/src/db.js',
    "  confirmPurchase(purchaseId, reviewerId, { verificationPayload = null, note = null } = {}) {",
    "  confirmPurchase(purchaseId, reviewerId, { verificationPayload = null, note = null, receiptVerified = false, receiptMethod = null } = {}) {"
)
replace_once(
    'bot/backend/src/db.js',
    "    const now = nowIso();\n    this.db.exec('BEGIN IMMEDIATE');\n    try {\n      const locks = this.db.prepare('SELECT pool,number,status,purchase_id FROM ticket_numbers WHERE purchase_id=?').all(purchaseId);",
    "    const now = nowIso();\n    const receiptConfirmed = receiptVerified === true || this.isAdmin(reviewerId);\n    const resolvedReceiptMethod = receiptMethod || (this.isAdmin(reviewerId) ? 'admin_approval' : (receiptVerified ? 'system_verification' : null));\n    this.db.exec('BEGIN IMMEDIATE');\n    try {\n      const locks = this.db.prepare('SELECT pool,number,status,purchase_id FROM ticket_numbers WHERE purchase_id=?').all(purchaseId);"
)
replace_once(
    'bot/backend/src/db.js',
    "      this.db.prepare(`UPDATE purchases SET status='paid',paid_at=?,reviewed_by=?,verification_payload=COALESCE(?,verification_payload),note=COALESCE(?,note) WHERE id=?`)\n        .run(now, reviewerId ?? null, verificationPayload ? JSON.stringify(verificationPayload) : null, note, purchaseId);\n      this.db.prepare(`UPDATE ticket_numbers SET status='sold',reserved_until=NULL,sold_at=? WHERE purchase_id=?`).run(now, purchaseId);",
    "      this.db.prepare(`UPDATE purchases SET status='paid',paid_at=?,reviewed_by=?,verification_payload=COALESCE(?,verification_payload),note=COALESCE(?,note) WHERE id=?`)\n        .run(now, reviewerId ?? null, verificationPayload ? JSON.stringify(verificationPayload) : null, note, purchaseId);\n      if (receiptConfirmed) {\n        this.db.prepare(`UPDATE purchases SET receipt_status='confirmed',receipt_verified_at=?,receipt_verified_by=?,receipt_verification_method=? WHERE id=?`)\n          .run(now, reviewerId ?? null, resolvedReceiptMethod, purchaseId);\n      }\n      this.db.prepare(`UPDATE ticket_numbers SET status='sold',reserved_until=NULL,sold_at=? WHERE purchase_id=?`).run(now, purchaseId);"
)

# Receipt reconciliation API for historical paid/sold rows.
replace_once(
    'bot/backend/src/db.js',
    "  dashboardStats() {",
    '''  setReceiptReconciliation(purchaseId, adminId, receiptStatus) {
    if (!this.isAdmin(adminId)) throw new Error('Admin access required.');
    if (!['confirmed','not_received','unreconciled'].includes(receiptStatus)) throw new Error('Invalid receipt status.');
    const purchase = this.getPurchase(purchaseId);
    if (!purchase) throw new Error('Purchase not found.');
    if (purchase.status !== 'paid') throw new Error('Only paid/sold purchases can be reconciled.');
    const now = nowIso();
    if (receiptStatus === 'confirmed') {
      this.db.prepare(`UPDATE purchases SET receipt_status='confirmed',receipt_verified_at=?,receipt_verified_by=?,receipt_verification_method='admin_reconciliation' WHERE id=?`)
        .run(now, adminId, purchaseId);
    } else {
      this.db.prepare(`UPDATE purchases SET receipt_status=?,receipt_verified_at=NULL,receipt_verified_by=?,receipt_verification_method='admin_reconciliation' WHERE id=?`)
        .run(receiptStatus, adminId, purchaseId);
    }
    this.log(adminId, 'purchase.receipt_reconciled', 'purchase', purchaseId, { receiptStatus });
    return this.getPurchase(purchaseId);
  }

  unreconciledPaidPurchases(limit = 12) {
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 12));
    return this.db.prepare(`SELECT p.*, GROUP_CONCAT(pn.pool || ':' || printf('%03d',pn.number), ' · ') AS numbers,
      s.display_name AS seller_name
      FROM purchases p
      LEFT JOIN purchase_numbers pn ON pn.purchase_id=p.id
      LEFT JOIN sellers s ON s.id=p.seller_id
      WHERE p.status='paid' AND COALESCE(p.receipt_status,'unreconciled')='unreconciled'
      GROUP BY p.id ORDER BY COALESCE(p.paid_at,p.created_at) ASC LIMIT ?`).all(safeLimit);
  }

  dashboardStats() {'''
)

# Dashboard distinguishes sold value from confirmed cash received.
replace_once(
    'bot/backend/src/db.js',
    "    const paid = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue FROM purchases WHERE status='paid'`).get();\n    const direct =",
    "    const paid = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue FROM purchases WHERE status='paid'`).get();\n    const confirmedReceipts = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue FROM purchases WHERE status='paid' AND receipt_status='confirmed'`).get();\n    const unreconciledReceipts = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue FROM purchases WHERE status='paid' AND COALESCE(receipt_status,'unreconciled')='unreconciled'`).get();\n    const notReceivedReceipts = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue FROM purchases WHERE status='paid' AND receipt_status='not_received'`).get();\n    const direct ="
)
replace_once(
    'bot/backend/src/db.js',
    "      grossSalesValue: paid.revenue,\n      revenue: paid.revenue,\n      platformRevenue: platform.revenue,",
    "      grossSalesValue: paid.revenue,\n      salesValue: paid.revenue,\n      revenue: confirmedReceipts.revenue,\n      confirmedRevenue: confirmedReceipts.revenue,\n      confirmedReceiptCount: confirmedReceipts.c,\n      unreconciledRevenue: unreconciledReceipts.revenue,\n      unreconciledCount: unreconciledReceipts.c,\n      notReceivedRevenue: notReceivedReceipts.revenue,\n      notReceivedCount: notReceivedReceipts.c,\n      platformRevenue: platform.revenue,"
)

# Automatic Verify.et approval is a verified receipt.
replace_once(
    'bot/backend/src/index.js',
    "    db.confirmPurchase(purchase.id, null, { verificationPayload: result.payload, note: result.reason });",
    "    db.confirmPurchase(purchase.id, null, { verificationPayload: result.payload, note: result.reason, receiptVerified: true, receiptMethod: 'verify.et' });"
)

# Seller must lock the payment claim for admin review before the original unpaid timeout can expire.
replace_once(
    'bot/backend/src/index.js',
    "    if (data.startsWith('seller_ok:')) {\n      const numbers = purchase.numbers.map((n) => `${n.pool} ETB #${formatNumber(n.number)}`).join(' · ');",
    "    if (data.startsWith('seller_ok:')) {\n      let reviewPurchase;\n      try { reviewPurchase = db.markSellerPaymentClaimed(purchaseId, telegramId); }\n      catch (error) { return bot.sendMessage(telegramId, `⚠️ ${error.message}`); }\n      const numbers = reviewPurchase.numbers.map((n) => `${n.pool} ETB #${formatNumber(n.number)}`).join(' · ');"
)
# Remove the old unreachable self-confirm block after the seller notification.
regex_once(
    'bot/backend/src/index.js',
    r"(      await bot\.sendMessage\(telegramId, tr\(telegramId, '⏳ ክፍያው ለአስተዳዳሪ ማረጋገጫ ተልኳል። እስኪፈቀድ ድረስ ትኬቱ SOLD አይሆንም።', '⏳ Sent for FinoteBirhan admin payment approval\. The ticket will not become SOLD until approved\.'\)\);\n      return;)\n      try \{.*?\n      \} catch \(error\) \{\n        await bot\.sendMessage\(telegramId, `⚠️ \$\{error\.message\}`\);\n      \}",
    r"\1",
    flags=re.S
)

# Seller/direct review copy must name the administrator as the final approver.
replace_once(
    'bot/backend/src/index.js',
    "    ? (am ? `ማስረጃውን ከላኩ በኋላ ${sellerName} ክፍያውን ያረጋግጣል።` : `After you send proof, ${sellerName} will confirm the payment.`)",
    "    ? (am ? 'ማስረጃውን ከላኩ በኋላ የፍኖተ ብርሃን አስተዳዳሪ ክፍያውን ያረጋግጣል።' : 'After you send proof, a FinoteBirhan administrator will confirm the payment.')"
)

# Admin dashboard: cash received is no longer inferred from SOLD state.
replace_once(
    'bot/backend/src/index.js',
    "💰 የተሸጡ ትኬቶች ጠቅላላ ዋጋ: ${s.revenue} ብር\n✅ የተከፈሉ ግዢዎች: ${s.paidCount}",
    "💵 የተረጋገጠ የገባ ገንዘብ: ${s.revenue} ብር (${s.confirmedReceiptCount})\n🎟 የተሸጡ ትኬቶች ጠቅላላ ዋጋ: ${s.salesValue} ብር (${s.paidCount})\n⚠️ ገንዘቡ ያልተመሳከረ: ${s.unreconciledRevenue} ብር (${s.unreconciledCount})\n🚫 እንዳልገባ የተመዘገበ: ${s.notReceivedRevenue} ብር (${s.notReceivedCount})"
)
replace_once(
    'bot/backend/src/index.js',
    "ℹ️ ገቢው የሚቆጠረው በጥቅል ዋጋ ነው፤ Bundle = 300 ብር። የ200/100/50 ዕጣ ቁጥሮችን ደምሮ ገቢ አይቆጠርም።",
    "ℹ️ SOLD ዋጋ በጥቅል ዋጋ ይቆጠራል፤ Bundle = 300 ብር። ነገር ግን ገቢ ውስጥ የሚገባው በVerify.et ወይም በአስተዳዳሪ በእውነት እንደደረሰ የተረጋገጠ ገንዘብ ብቻ ነው።"
)
replace_once(
    'bot/backend/src/index.js',
    "Ticket sales value: ${s.revenue} ETB\nPaid purchases: ${s.paidCount}",
    "Confirmed money received: ${s.revenue} ETB (${s.confirmedReceiptCount})\nSold ticket value: ${s.salesValue} ETB (${s.paidCount})\nNeeds receipt reconciliation: ${s.unreconciledRevenue} ETB (${s.unreconciledCount})\nMarked not received: ${s.notReceivedRevenue} ETB (${s.notReceivedCount})"
)
replace_once(
    'bot/backend/src/index.js',
    "Revenue uses the package price only (Bundle = 300 ETB). Draw/pool face values are inventory, not revenue.",
    "Sold value uses the package price only (Bundle = 300 ETB). Confirmed money received counts only receipts verified by Verify.et or an administrator; historical SOLD rows remain unreconciled until checked."
)

# Add reconciliation navigation button.
replace_once(
    'bot/backend/src/index.js',
    "      [{ text: am ? '📊 ትኬት ቁጥሮች' : '📊 Pools', callback_data: 'admin_pools' }, { text: '🚨 Recovery', callback_data: 'admin_payments' }],",
    "      [{ text: am ? '💵 ገቢ አረጋግጥ' : '💵 Reconcile Revenue', callback_data: 'admin_revenue_reconcile' }],\n      [{ text: am ? '📊 ትኬት ቁጥሮች' : '📊 Pools', callback_data: 'admin_pools' }, { text: '🚨 Recovery', callback_data: 'admin_payments' }],"
)

# Admin callbacks for receipt reconciliation.
replace_once(
    'bot/backend/src/index.js',
    "    if (data === 'admin_dashboard') return showAdminDashboard(telegramId);\n    if (data === 'admin_payment_accounts') return showPaymentAccounts(telegramId);",
    "    if (data === 'admin_dashboard') return showAdminDashboard(telegramId);\n    if (data === 'admin_revenue_reconcile') return showRevenueReconciliation(telegramId);\n    if (data.startsWith('admin_receipt_yes:') || data.startsWith('admin_receipt_no:')) {\n      const purchaseId = data.split(':').slice(1).join(':');\n      const status = data.startsWith('admin_receipt_yes:') ? 'confirmed' : 'not_received';\n      try {\n        const updated = db.setReceiptReconciliation(purchaseId, telegramId, status);\n        await bot.sendMessage(telegramId, status === 'confirmed'\n          ? `✅ Receipt confirmed: ${updated.amount_etb} ETB · ${updated.id}`\n          : `🚫 Marked as not received: ${updated.amount_etb} ETB · ${updated.id}`);\n      } catch (error) {\n        await bot.sendMessage(telegramId, `⚠️ ${error.message}`);\n      }\n      return showRevenueReconciliation(telegramId);\n    }\n    if (data === 'admin_payment_accounts') return showPaymentAccounts(telegramId);"
)

# Reconciliation screen inserted before payment-account administration.
replace_once(
    'bot/backend/src/index.js',
    "async function showPaymentAccounts(telegramId) {",
    '''async function showRevenueReconciliation(telegramId) {
  if (!db.isAdmin(telegramId)) return bot.sendMessage(telegramId, 'Admin access required.');
  const am = langOf(telegramId) !== 'en';
  const s = db.dashboardStats();
  const queue = db.unreconciledPaidPurchases(8);
  await bot.sendMessage(telegramId, am
    ? `💵 የገቢ ማረጋገጫ\n\n✅ በእውነት እንደገባ የተረጋገጠ: ${s.confirmedRevenue} ብር (${s.confirmedReceiptCount})\n⚠️ ገና ያልተመሳከረ: ${s.unreconciledRevenue} ብር (${s.unreconciledCount})\n🚫 እንዳልገባ የተመዘገበ: ${s.notReceivedRevenue} ብር (${s.notReceivedCount})\n\nSOLD መሆኑ ብቻ ገንዘቡ ገብቷል ማለት አይደለም። ያረጋገጡትን ብቻ ✅ ይጫኑ።`
    : `💵 Revenue reconciliation\n\nConfirmed received: ${s.confirmedRevenue} ETB (${s.confirmedReceiptCount})\nUnreconciled historical SOLD: ${s.unreconciledRevenue} ETB (${s.unreconciledCount})\nMarked not received: ${s.notReceivedRevenue} ETB (${s.notReceivedCount})\n\nA SOLD ticket is not proof that money reached FinoteBirhan. Confirm only transactions you can verify in the real account/cash records.`,
    { reply_markup: inlineKeyboard([[{ text: am ? '⬅️ ዳሽቦርድ' : '⬅️ Dashboard', callback_data: 'admin_dashboard' }]]) }
  );
  if (!queue.length) return;
  for (const purchase of queue) {
    const source = purchase.source === 'seller' ? `Seller${purchase.seller_name ? ` · ${purchase.seller_name}` : ''}` : 'Direct bot';
    await bot.sendMessage(telegramId,
      `#${purchase.id}\n${purchase.amount_etb} ETB · ${packageLabel(purchase.package_type)}\n${source}\nBuyer: ${purchase.buyer_name}\nNumbers: ${purchase.numbers || '-'}\nPaid/SOLD at: ${purchase.paid_at || purchase.created_at}\n\nDid FinoteBirhan actually receive this money?`,
      { reply_markup: inlineKeyboard([[
        { text: '✅ Received', callback_data: `admin_receipt_yes:${purchase.id}` },
        { text: '🚫 Not received', callback_data: `admin_receipt_no:${purchase.id}` }
      ]]) }
    );
  }
}

async function showPaymentAccounts(telegramId) {'''
)

# Tests: historical SOLD data is not automatically cash received; admin can reconcile it.
replace_once(
    'bot/backend/tests/sellerCashAccounting.test.js',
    "  const seller = db.activateSellerRole(3, 999).seller;\n  return { db, dir, seller };",
    "  db.addAdmin(999);\n  const seller = db.activateSellerRole(3, 999).seller;\n  return { db, dir, seller };"
)
replace_once(
    'bot/backend/tests/sellerCashAccounting.test.js',
    "    assert.equal(dashboard.grossSalesValue, 950);\n    assert.equal(dashboard.revenue, 950);",
    "    assert.equal(dashboard.grossSalesValue, 950);\n    assert.equal(dashboard.salesValue, 950);\n    assert.equal(dashboard.revenue, 0);\n    assert.equal(dashboard.unreconciledRevenue, 950);"
)
replace_once(
    'bot/backend/tests/sellerCashAccounting.test.js',
    "    assert.equal(dashboard.sellerCashCount, 4);\n    assert.deepEqual(",
    "    assert.equal(dashboard.sellerCashCount, 4);\n    db.setReceiptReconciliation('DIRECT-200', 999, 'confirmed');\n    db.setReceiptReconciliation('SELLER-FINOTE-200', 999, 'confirmed');\n    db.setReceiptReconciliation('SELLER-CASH-BUNDLE', 999, 'not_received');\n    db.setReceiptReconciliation('SELLER-CASH-100-A', 999, 'not_received');\n    db.setReceiptReconciliation('SELLER-CASH-100-B', 999, 'not_received');\n    db.setReceiptReconciliation('SELLER-CASH-50', 999, 'not_received');\n    const reconciled = db.dashboardStats();\n    assert.equal(reconciled.revenue, 400);\n    assert.equal(reconciled.confirmedReceiptCount, 2);\n    assert.equal(reconciled.notReceivedRevenue, 550);\n    assert.equal(reconciled.unreconciledRevenue, 0);\n    assert.deepEqual("
)
replace_once(
    'bot/backend/tests/sellerCashAccounting.test.js',
    "    assert.equal(dashboard.revenue, 300);\n    assert.deepEqual(dashboard.paidPackages.map((r) => [r.package_type, r.sales, r.amount]), [['bundle', 1, 300]]);",
    "    assert.equal(dashboard.revenue, 300);\n    assert.equal(dashboard.salesValue, 300);\n    assert.equal(dashboard.confirmedReceiptCount, 1);\n    assert.deepEqual(dashboard.paidPackages.map((r) => [r.package_type, r.sales, r.amount]), [['bundle', 1, 300]]);"
)
replace_once(
    'bot/backend/tests/sellerCashAccounting.test.js',
    "    assert.equal(db.dashboardStats().revenue, 300);",
    "    assert.equal(db.dashboardStats().salesValue, 300);\n    assert.equal(db.dashboardStats().revenue, 0);\n    assert.equal(db.dashboardStats().unreconciledRevenue, 300);"
)
replace_once(
    'bot/backend/tests/sellerCashAccounting.test.js',
    "test('default ticket reservation timeout is 30 minutes', () => {\n  const { db, dir } = makeDb();\n  try {\n    assert.equal(db.reservationMinutes, 30);",
    "test('default ticket reservation timeout is 60 minutes', () => {\n  const { db, dir } = makeDb();\n  try {\n    assert.equal(db.reservationMinutes, 60);\n    assert.equal(db.manualReviewMinutes, 60);"
)

# New expiry regression: submitted evidence stays locked even if the old deadline is in the past.
with (ROOT / 'bot/backend/tests/sellerCashAccounting.test.js').open('a', encoding='utf-8') as f:
    f.write(r'''

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
''')

# Update build-version regression.
replace_once(
    'bot/backend/tests/navigationRecoveryCore.test.js',
    "  assert.match(source, /const BOT_BUILD = '1\\.3\\.6';/);",
    "  assert.match(source, /const BOT_BUILD = '1\\.3\\.7';/);"
)

# Add release note used as a packaging trigger/documentation.
write('bot/backend/BUILD-v1.3.7.md', '''# FinoteBirhan v1.3.7 revenue reconciliation and reservation safety\n\n- Dashboard `Confirmed money received` counts only receipts explicitly verified by Verify.et or an administrator.\n- Historical SOLD rows are `unreconciled` by default and are not assumed to be cash received.\n- Admin `Reconcile Revenue` lets verified historical receipts be marked Received or Not received without deleting tickets.\n- Sold ticket value remains a separate operational figure and Bundle remains 300 ETB.\n- Unpaid reservations have a minimum 60-minute window.\n- Once payment proof is submitted or a seller taps Buyer paid, the ticket number no longer auto-expires while awaiting admin review.\n- Stale reserved locks for expired/rejected/cancelled purchases are released; paid reservations are repaired to SOLD rather than released.\n''')

print('Revenue reconciliation and reservation expiry safety patch applied.')
