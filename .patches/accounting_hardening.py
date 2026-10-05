from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly 1 occurrence, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


def append_once(path, marker, addition):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if addition.strip() in text:
        return
    if marker not in text:
        raise SystemExit(f'{path}: marker not found: {marker[:120]!r}')
    p.write_text(text.replace(marker, marker + addition, 1), encoding='utf-8')

# ---------------------------------------------------------------------------
# DB: canonical package prices, force seller sales to FinoteBirhan settlement,
# require admin approval for every seller-originated sale, and expose a trusted
# package breakdown for the dashboard.
# ---------------------------------------------------------------------------
replace_once(
    'bot/backend/src/db.js',
    "    this.ensureColumn('purchases', 'payment_account_number', 'TEXT');\n",
    "    this.ensureColumn('purchases', 'payment_account_number', 'TEXT');\n"
    "    // Canonicalize historical purchase amounts from the package type. Revenue must\n"
    "    // never be reconstructed by summing sold draw/pool face values because a\n"
    "    // 300 ETB bundle issues 200 + 100 + 50 draw numbers (350 nominal).\n"
    "    this.db.exec(`UPDATE purchases SET amount_etb = CASE package_type\n"
    "      WHEN 'bundle' THEN 300 WHEN '200' THEN 200 WHEN '100' THEN 100 WHEN '50' THEN 50\n"
    "      ELSE amount_etb END`);\n"
)

replace_once(
    'bot/backend/src/db.js',
    "    if (!['finote', 'seller'].includes(paymentTarget)) throw new Error('Choose a valid payment destination.');\n"
    "    if (paymentTarget === 'seller' && !this.sellerHasPaymentAccount(seller.id)) throw new Error('Set your payment account first.');\n",
    "    // Every seller sale belongs to FinoteBirhan. If a buyer pays cash, the seller\n"
    "    // still settles that cash to FinoteBirhan; a seller-owned destination must not\n"
    "    // create a separate revenue bucket or allow self-confirmation.\n"
    "    const normalizedPaymentTarget = 'finote';\n"
)

replace_once(
    'bot/backend/src/db.js',
    "      const provider = paymentTarget === 'seller' ? seller.payment_provider : null;\n"
    "      const accountName = paymentTarget === 'seller' ? seller.account_name : null;\n"
    "      const accountNumber = paymentTarget === 'seller' ? seller.account_number : null;\n",
    "      const provider = null;\n"
    "      const accountName = null;\n"
    "      const accountNumber = null;\n"
)

replace_once(
    'bot/backend/src/db.js',
    "          id, sellerTelegramId, cleanName, cleanPhone, packageType, amount, seller.id, 'seller', 'seller_review', provider || null, accountName || null, accountNumber || null, reservedUntil, now, matched?.telegram_id ?? null, paymentTarget\n",
    "          id, sellerTelegramId, cleanName, cleanPhone, packageType, amount, seller.id, 'seller', 'seller_review', provider || null, accountName || null, accountNumber || null, reservedUntil, now, matched?.telegram_id ?? null, normalizedPaymentTarget\n"
)

replace_once(
    'bot/backend/src/db.js',
    "      this.log(sellerTelegramId, 'seller_sale.reserved', 'purchase', id, { buyerName: cleanName, buyerPhone: cleanPhone, packageType, selectedNumbers: normalized, paymentTarget });\n",
    "      this.log(sellerTelegramId, 'seller_sale.reserved', 'purchase', id, { buyerName: cleanName, buyerPhone: cleanPhone, packageType, selectedNumbers: normalized, requestedPaymentTarget: paymentTarget, paymentTarget: normalizedPaymentTarget });\n"
)

replace_once(
    'bot/backend/src/db.js',
    "    if (purchase.status === 'paid') return purchase;\n"
    "    if (!['verification_pending', 'seller_review', 'manual_review', 'awaiting_proof'].includes(purchase.status)) throw new Error(`Purchase cannot be confirmed from status ${purchase.status}.`);\n",
    "    if (purchase.status === 'paid') return purchase;\n"
    "    if (purchase.source === 'seller' && !this.isAdmin(reviewerId)) {\n"
    "      throw new Error('Seller-originated sales require FinoteBirhan admin payment approval before tickets can be marked sold.');\n"
    "    }\n"
    "    if (!['verification_pending', 'seller_review', 'manual_review', 'awaiting_proof'].includes(purchase.status)) throw new Error(`Purchase cannot be confirmed from status ${purchase.status}.`);\n"
)

replace_once(
    'bot/backend/src/db.js',
    "    const seller = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue FROM purchases WHERE status='paid' AND source='seller'`).get();\n"
    "    const sellerCash = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue\n",
    "    const seller = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue FROM purchases WHERE status='paid' AND source='seller'`).get();\n"
    "    const paidPackages = this.db.prepare(`SELECT package_type, COUNT(*) AS sales, COALESCE(SUM(amount_etb),0) AS amount\n"
    "      FROM purchases WHERE status='paid' GROUP BY package_type`).all();\n"
    "    const sellerCash = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue\n"
)

replace_once(
    'bot/backend/src/db.js',
    "      sellerRevenue: seller.revenue,\n"
    "      sellerCashCount: sellerCash.c,\n",
    "      sellerRevenue: seller.revenue,\n"
    "      paidPackages,\n"
    "      sellerCashCount: sellerCash.c,\n"
)

# ---------------------------------------------------------------------------
# Bot UI: display trusted sales value/package totals, stop claiming payment-target
# fields equal money received, and route seller confirmations to admins.
# ---------------------------------------------------------------------------
replace_once('bot/backend/src/index.js', "const BOT_BUILD = '1.3.5';", "const BOT_BUILD = '1.3.6';")

replace_once(
    'bot/backend/src/index.js',
    "  const sellerCashBreakdown = formatPackageBreakdown(s.sellerCashPackages, am);\n",
    "  const salesBreakdown = formatPackageBreakdown(s.paidPackages, am);\n"
)

replace_once(
    'bot/backend/src/index.js',
    "💰 ገቢ: ${s.revenue} ብር\n",
    "💰 የተሸጡ ትኬቶች ጠቅላላ ዋጋ: ${s.revenue} ብር\n"
)

replace_once(
    'bot/backend/src/index.js',
    "🏦 ፍኖተ ብርሃን የተቀበለው: ${s.platformRevenue} ብር (${s.platformPaidCount})\n"
    "💵 በሻጭ/ጥሬ ገንዘብ የተሰበሰበ: ${s.sellerCashRevenue} ብር (${s.sellerCashCount}) — በገቢ አይቆጠርም\n"
    "📦 የሻጭ ጥሬ ገንዘብ ሽያጭ በጥቅል: ${sellerCashBreakdown}\n",
    "🌐 በቦት በቀጥታ የተሸጠ: ${s.directRevenue} ብር (${s.directCount})\n"
    "🧾 በሻጮች የተመዘገበ: ${s.sellerRevenue} ብር (${s.sellerCount})\n"
    "📦 ሽያጭ በጥቅል: ${salesBreakdown}\n"
    "ℹ️ ገቢው የሚቆጠረው በጥቅል ዋጋ ነው፤ Bundle = 300 ብር። የ200/100/50 ዕጣ ቁጥሮችን ደምሮ ገቢ አይቆጠርም።\n"
)

replace_once(
    'bot/backend/src/index.js',
    "Revenue: ${s.revenue} ETB\n",
    "Ticket sales value: ${s.revenue} ETB\n"
)

replace_once(
    'bot/backend/src/index.js',
    "Received by FinoteBirhan: ${s.platformRevenue} ETB (${s.platformPaidCount})\n"
    "Seller/cash collected: ${s.sellerCashRevenue} ETB (${s.sellerCashCount}) — excluded from Revenue\n"
    "Seller cash sales by package: ${sellerCashBreakdown}\n",
    "Direct bot sales: ${s.directRevenue} ETB (${s.directCount})\n"
    "Seller-entered sales: ${s.sellerRevenue} ETB (${s.sellerCount})\n"
    "Sales by package: ${salesBreakdown}\n"
    "Revenue uses the package price only (Bundle = 300 ETB). Draw/pool face values are inventory, not revenue.\n"
)

replace_once(
    'bot/backend/src/index.js',
    "💵 በሻጭ/ጥሬ ገንዘብ የተሰበሰበ: ${stats.sellerCashRevenue} ብር (${stats.sellerCashCount})\n"
    "🏦 ወደ ፍኖተ ብርሃን የተከፈለ: ${stats.finotePaidRevenue} ብር (${stats.finotePaidCount})\n"
    "📦 ሽያጭ በጥቅል: ${packageBreakdown}\n",
    "💰 የተሸጡ ትኬቶች ዋጋ: ${stats.salesValue} ብር\n"
    "📦 ሽያጭ በጥቅል: ${packageBreakdown}\n"
)

replace_once(
    'bot/backend/src/index.js',
    "Seller/cash collected: ${stats.sellerCashRevenue} ETB (${stats.sellerCashCount})\n"
    "Paid to FinoteBirhan: ${stats.finotePaidRevenue} ETB (${stats.finotePaidCount})\n"
    "Sales by package: ${packageBreakdown}\n",
    "Sales value: ${stats.salesValue} ETB\n"
    "Sales by package: ${packageBreakdown}\n"
)

replace_once(
    'bot/backend/src/index.js',
    "Only tap SOLD after the buyer has paid.",
    "For cash, first settle the money to FinoteBirhan. Tap Buyer paid only after payment is complete; an admin must approve before the ticket becomes SOLD."
)

replace_once(
    'bot/backend/src/index.js',
    "{ text: am ? '✅ ተሽጧል' : '✅ SOLD', callback_data: `seller_ok:${purchase.id}` }",
    "{ text: am ? '✅ ገዢው ከፍሏል' : '✅ Buyer paid', callback_data: `seller_ok:${purchase.id}` }"
)

replace_once(
    'bot/backend/src/index.js',
    "    if (data.startsWith('seller_ok:')) {\n"
    "      try {\n",
    "    if (data.startsWith('seller_ok:')) {\n"
    "      const numbers = purchase.numbers.map((n) => `${n.pool} ETB #${formatNumber(n.number)}`).join(' · ');\n"
    "      await notifyAdmins(`💳 SELLER SALE PAYMENT REVIEW\\n\\nSeller: ${seller.display_name}\\nBuyer: ${purchase.buyer_name}\\nPhone: ${purchase.buyer_phone}\\nPackage: ${purchase.package_type}\\nAmount: ${purchase.amount_etb} ETB\\nNumbers: ${numbers || '-'}\\n\\nSeller says the buyer paid. Confirm only after FinoteBirhan has actually received/verified the money.`, inlineKeyboard([[\n"
    "        { text: '✅ Approve payment', callback_data: `admin_pay_ok:${purchase.id}` },\n"
    "        { text: '❌ Reject', callback_data: `admin_pay_no:${purchase.id}` }\n"
    "      ]]));\n"
    "      await bot.sendMessage(telegramId, tr(telegramId, '⏳ ክፍያው ለአስተዳዳሪ ማረጋገጫ ተልኳል። እስኪፈቀድ ድረስ ትኬቱ SOLD አይሆንም።', '⏳ Sent for FinoteBirhan admin payment approval. The ticket will not become SOLD until approved.'));\n"
    "      return;\n"
    "      try {\n"
)

# Hide the obsolete seller-owned settlement control from the normal seller menu.
replace_once(
    'bot/backend/src/index.js',
    "    rows.push([{ text: am ? '📈 የሽያጭ ሪፖርት' : '📈 Seller Stats' }, { text: am ? '💳 የሻጭ አካውንት' : '💳 Seller Account' }]);\n",
    "    rows.push([{ text: am ? '📈 የሽያጭ ሪፖርት' : '📈 Seller Stats' }]);\n"
)

replace_once(
    'bot/backend/src/index.js',
    "Open /start. You will now see 🧾 Sell Tickets and 📈 Seller Stats. You can optionally add your own payment account from 💳 Seller Account.",
    "Open /start. You will now see 🧾 Sell Tickets and 📈 Seller Stats. All seller sales settle to the FinoteBirhan account and require admin payment approval."
)

# ---------------------------------------------------------------------------
# Tests: update old seller-self-confirm assumptions and add explicit accounting
# regression coverage.
# ---------------------------------------------------------------------------
replace_once(
    'bot/backend/tests/core.test.js',
    "  db.confirmPurchase(purchase.id, 3, { note: 'manual SOLD' });\n"
    "  const tickets = db.ticketsForUser(1);\n",
    "  assert.throws(() => db.confirmPurchase(purchase.id, 3, { note: 'manual SOLD' }), /admin payment approval/i);\n"
    "  db.addAdmin(999);\n"
    "  db.confirmPurchase(purchase.id, 999, { note: 'approved by admin' });\n"
    "  const tickets = db.ticketsForUser(1);\n"
)

replace_once(
    'bot/backend/tests/core.test.js',
    "  db.confirmPurchase(purchase.id, seller.telegram_id, { note: 'manual SOLD' });\n",
    "  db.confirmPurchase(purchase.id, 999, { note: 'approved by admin' });\n"
)

old_test = """test('seller-owned payment destination is snapshotted independently from FinoteBirhan accounts', () => {
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
"""
new_test = """test('seller sales always settle to FinoteBirhan even if seller destination is requested', () => {
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
  assert.equal(purchase.payment_target, 'finote');
  assert.equal(purchase.payment_provider, null);
  assert.equal(purchase.payment_account_name, null);
  assert.equal(purchase.payment_account_number, null);
  assert.throws(() => db.confirmPurchase(purchase.id, 3, { note: 'seller tried to self-confirm' }), /admin payment approval/i);
  close(db, dir);
});
"""
replace_once('bot/backend/tests/core.test.js', old_test, new_test)

replace_once(
    'bot/backend/tests/sellerCashAccounting.test.js',
    "    assert.equal(dashboard.sellerCashCount, 4);\n",
    "    assert.equal(dashboard.sellerCashCount, 4);\n"
    "    assert.deepEqual(\n"
    "      dashboard.paidPackages.map((row) => [row.package_type, row.sales, row.amount]).sort(),\n"
    "      [['100', 2, 200], ['200', 2, 400], ['50', 1, 50], ['bundle', 1, 300]].sort()\n"
    "    );\n"
)

addition = """

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
    assert.deepEqual(dashboard.paidPackages.map((r) => [r.package_type, r.sales, r.amount]), [['bundle', 1, 300]]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
"""
append_once('bot/backend/tests/sellerCashAccounting.test.js', "\n\ntest('default ticket reservation timeout is 30 minutes'", addition)

# Version + build note.
replace_once('bot/backend/package.json', '"version": "1.3.5"', '"version": "1.3.6"')
(ROOT / 'bot/backend/BUILD-v1.3.6.md').write_text(
    '# FinoteBirhan v1.3.6 accounting hardening\n\n'
    '- Revenue is the canonical package-price sum of paid purchases. Bundle is always 300 ETB.\n'
    '- Admin dashboard shows total sales value, direct sales, seller-entered sales, and package breakdown.\n'
    '- Seller-originated sales always settle to FinoteBirhan; seller-owned destinations are ignored for new sales.\n'
    '- Sellers cannot mark their own sales paid/SOLD. FinoteBirhan admin approval is required.\n'
    '- Existing historical payment-target fields remain for audit, but are no longer presented as proof of money received.\n',
    encoding='utf-8'
)

print('Accounting hardening patch applied.')
