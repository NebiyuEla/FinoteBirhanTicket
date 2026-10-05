from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}: {old[:180]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

# Recovery queue still covers genuinely unpaid expirations. Submitted evidence is now protected and must not auto-expire.
replace_once(
    'bot/backend/tests/recovery.test.js',
    "  const direct = db.reservePurchase({ telegramId: 1, packageType: '200', selectedNumbers: { 200: 61 } });\n  db.submitPaymentProof(direct.id, { reference: 'RECOVERY-REF-61' });\n  expire(db, direct.id);",
    "  const direct = db.reservePurchase({ telegramId: 1, packageType: '200', selectedNumbers: { 200: 61 } });\n  expire(db, direct.id);"
)

# Historical/outage recovery is tested by simulating a legacy row that had already expired after evidence was stored.
replace_once(
    'bot/backend/tests/recovery.test.js',
    "  db.submitPaymentProof(purchase.id, { reference: 'RECOVERY-REF-63' });\n  expire(db, purchase.id);\n\n  const before = db.assessRecoveryPurchase(purchase.id);\n  assert.equal(before.availableForRestore, true);\n  const paid = db.confirmPurchase(purchase.id, 999, { note: 'Approved from Recovery after outage.' });",
    "  db.submitPaymentProof(purchase.id, { reference: 'RECOVERY-REF-63' });\n  const legacyExpiredAt = new Date().toISOString();\n  db.db.prepare(`UPDATE purchases SET status='expired',reserved_until=? WHERE id=?`).run(legacyExpiredAt, purchase.id);\n  db.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL WHERE purchase_id=?`).run(purchase.id);\n\n  const before = db.assessRecoveryPurchase(purchase.id);\n  assert.equal(before.availableForRestore, true);\n  const paid = db.recoverExpiredPurchase(purchase.id, 999, { note: 'Approved from Recovery after outage.' });"
)

replace_once(
    'bot/backend/tests/recovery.test.js',
    "  db.submitPaymentProof(first.id, { reference: 'RECOVERY-REF-64' });\n  expire(db, first.id);\n\n  const second = db.reservePurchase({ telegramId: 3, packageType: '50', selectedNumbers: { 50: 64 } });\n  assert.throws(() => db.confirmPurchase(first.id, 999, { note: 'Should be blocked' }), /no longer available|cannot recover/i);",
    "  db.submitPaymentProof(first.id, { reference: 'RECOVERY-REF-64' });\n  const legacyExpiredAt = new Date().toISOString();\n  db.db.prepare(`UPDATE purchases SET status='expired',reserved_until=? WHERE id=?`).run(legacyExpiredAt, first.id);\n  db.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL WHERE purchase_id=?`).run(first.id);\n\n  const second = db.reservePurchase({ telegramId: 3, packageType: '50', selectedNumbers: { 50: 64 } });\n  assert.throws(() => db.recoverExpiredPurchase(first.id, 999, { note: 'Should be blocked' }), /no longer available|cannot recover/i);"
)

replace_once(
    'bot/backend/tests/navigationRecoveryCore.test.js',
    "  db.submitPaymentProof(purchase.id, { reference: 'CORE-RECOVERY-87' });\n  db.db.prepare(\"UPDATE purchases SET reserved_until='2000-01-01T00:00:00.000Z' WHERE id=?\").run(purchase.id);\n  db.db.prepare(\"UPDATE ticket_numbers SET reserved_until='2000-01-01T00:00:00.000Z' WHERE purchase_id=?\").run(purchase.id);\n  db.releaseExpiredReservations();\n  db.db.prepare('UPDATE purchases SET reserved_until=? WHERE id=?').run(new Date().toISOString(), purchase.id);\n\n  assert.ok(db.recoveryQueue().some((row) => row.id === purchase.id && row.status === 'expired'));",
    "  db.submitPaymentProof(purchase.id, { reference: 'CORE-RECOVERY-87' });\n  const legacyExpiredAt = new Date().toISOString();\n  db.db.prepare(`UPDATE purchases SET status='expired',reserved_until=? WHERE id=?`).run(legacyExpiredAt, purchase.id);\n  db.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL WHERE purchase_id=?`).run(purchase.id);\n\n  assert.ok(db.recoveryQueue().some((row) => row.id === purchase.id && row.status === 'expired'));"
)

print('Recovery regressions aligned with protected submitted-payment semantics.')
