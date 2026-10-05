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

# Receipt confirmation must be explicit. Admin identity alone is not proof of receipt.
db_path = 'bot/backend/src/db.js'
db = read(db_path)
db = replace_once(
    db,
    "    const receiptConfirmed = receiptVerified === true || this.isAdmin(reviewerId);\n    const resolvedReceiptMethod = receiptMethod || (this.isAdmin(reviewerId) ? 'admin_approval' : (receiptVerified ? 'system_verification' : null));\n",
    "    const receiptConfirmed = receiptVerified === true;\n    const resolvedReceiptMethod = receiptConfirmed ? (receiptMethod || (this.isAdmin(reviewerId) ? 'admin_payment_confirmation' : 'system_verification')) : null;\n",
    'explicit receipt confirmation'
)
db = replace_once(
    db,
    "  recoverExpiredPurchase(purchaseId, reviewerId, { note = 'Recovered and approved by administrator.' } = {}) {\n",
    "  recoverExpiredPurchase(purchaseId, reviewerId, { note = 'Recovered and approved by administrator.', receiptVerified = false, receiptMethod = null } = {}) {\n",
    'recovery receipt args'
)
db = replace_once(
    db,
    "      const paid = this.confirmPurchase(purchaseId, reviewerId, { note });\n",
    "      const paid = this.confirmPurchase(purchaseId, reviewerId, { note, receiptVerified, receiptMethod });\n",
    'recovery passes receipt state'
)
write(db_path, db)

index_path = 'bot/backend/src/index.js'
index = read(index_path)
index = replace_once(
    index,
    "          const paid = purchase.status === 'expired'\n            ? db.recoverExpiredPurchase(purchaseId, telegramId, { note: 'Recovered and approved manually by admin after outage.' })\n            : db.confirmPurchase(purchaseId, telegramId, { note: 'Approved manually by admin.' });\n",
    "          const paid = purchase.status === 'expired'\n            ? db.recoverExpiredPurchase(purchaseId, telegramId, { note: 'Payment confirmed received; expired ticket recovered by admin.', receiptVerified: true, receiptMethod: 'admin_payment_confirmation' })\n            : db.confirmPurchase(purchaseId, telegramId, { note: 'Payment confirmed received by admin.', receiptVerified: true, receiptMethod: 'admin_payment_confirmation' });\n",
    'admin payment confirmation callback'
)
index = replace_once(
    index,
    "    rows.push([{ text: purchase.status === 'expired' ? '♻️ Recover & approve' : '✅ Approve', callback_data: `admin_pay_ok:${purchase.id}` }]);\n",
    "    rows.push([{ text: purchase.status === 'expired' ? '♻️ Confirm received & recover' : '✅ Confirm received & issue', callback_data: `admin_pay_ok:${purchase.id}` }]);\n",
    'recovery button wording'
)
index = replace_once(
    index,
    "        { text: '✅ Approve manually', callback_data: `admin_pay_ok:${purchase.id}` },\n",
    "        { text: '✅ Confirm received & issue', callback_data: `admin_pay_ok:${purchase.id}` },\n",
    'manual review button wording'
)
write(index_path, index)

# Existing seller-accounting test should model an explicit admin payment confirmation.
seller_test_path = 'bot/backend/tests/sellerCashAccounting.test.js'
seller_test = read(seller_test_path)
seller_test = replace_once(
    seller_test,
    "    const paid = db.confirmPurchase(sale.id, 999, { note: 'admin verified money received' });\n",
    "    const paid = db.confirmPurchase(sale.id, 999, { note: 'admin verified money received', receiptVerified: true, receiptMethod: 'admin_payment_confirmation' });\n",
    'seller accounting explicit receipt verification'
)
write(seller_test_path, seller_test)

# Accuracy test: make only the explicitly verified purchase count as confirmed money.
admin_test_path = 'bot/backend/tests/adminStatsAccuracy.test.js'
admin_test = read(admin_test_path)
admin_test = replace_once(
    admin_test,
    "  db.confirmPurchase(bundle.id, 999, { note: 'confirmed bundle' });\n",
    "  db.confirmPurchase(bundle.id, 999, { note: 'confirmed bundle', receiptVerified: true, receiptMethod: 'admin_payment_confirmation' });\n",
    'admin stats confirmed bundle'
)
admin_test = replace_once(
    admin_test,
    "  db.confirmPurchase(direct100.id, 999, { note: 'confirmed then reconciled not received' });\n",
    "  db.confirmPurchase(direct100.id, 999, { note: 'confirmed then reconciled not received', receiptVerified: true, receiptMethod: 'admin_payment_confirmation' });\n",
    'admin stats not-received seed'
)
admin_test = replace_once(
    admin_test,
    "  db.confirmPurchase(seller.id, 999, { note: 'historical seller sale' });\n",
    "  db.confirmPurchase(seller.id, 999, { note: 'historical seller sale', receiptVerified: true, receiptMethod: 'admin_payment_confirmation' });\n",
    'admin stats seller seed'
)

extra_test = r'''

test('generic admin ticket approval does not count as confirmed money unless receipt is explicitly verified', () => {
  const { db, dir } = makeDb();
  const purchase = db.reservePurchase({ telegramId: 1, packageType: '100', selectedNumbers: { 100: 9 } });
  const paid = db.confirmPurchase(purchase.id, 999, { note: 'ticket issued after manual review only' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.receipt_status, 'unreconciled');
  const stats = db.dashboardStats();
  assert.equal(stats.salesValue, 100);
  assert.equal(stats.confirmedRevenue, 0);
  assert.equal(stats.unreconciledRevenue, 100);
  assert.equal(stats.statisticsOk, true, stats.statsIssues.join('; '));
  close(db, dir);
});
'''
if "generic admin ticket approval does not count as confirmed money" not in admin_test:
    admin_test += extra_test
write(admin_test_path, admin_test)

print('Explicit receipt-confirmation accuracy patch applied.')
