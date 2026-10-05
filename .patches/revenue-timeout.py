from pathlib import Path

# Revenue = actual value of every paid/sold purchase, regardless of who collected payment.
db_path = Path('bot/backend/src/db.js')
db = db_path.read_text()
db = db.replace(
    "constructor(dbPath, { reservationMinutes = 10, manualReviewMinutes = 30 } = {})",
    "constructor(dbPath, { reservationMinutes = 30, manualReviewMinutes = 30 } = {})",
    1,
)
old = """      grossSalesValue: paid.revenue,
      revenue: platform.revenue,
      platformPaidCount: platform.c,
"""
new = """      grossSalesValue: paid.revenue,
      revenue: paid.revenue,
      platformRevenue: platform.revenue,
      platformPaidCount: platform.c,
"""
assert old in db, 'dashboard revenue block not found'
db = db.replace(old, new, 1)
db_path.write_text(db)

# Enforce at least a 30-minute normal ticket reservation even if an old deployment env still says 10.
config_path = Path('bot/backend/src/config.js')
config = config_path.read_text()
old = "reservationMinutes: asInt('RESERVATION_MINUTES', 10),"
new = "reservationMinutes: Math.max(30, asInt('RESERVATION_MINUTES', 30)),"
assert old in config, 'reservation config not found'
config_path.write_text(config.replace(old, new, 1))

env_path = Path('bot/backend/.env.example')
env = env_path.read_text()
assert 'RESERVATION_MINUTES=10' in env, 'env reservation value not found'
env_path.write_text(env.replace('RESERVATION_MINUTES=10', 'RESERVATION_MINUTES=30', 1))

# Dashboard keeps FinoteBirhan receipts separate from sales revenue.
index_path = Path('bot/backend/src/index.js')
index = index_path.read_text()
old_am = "🏦 ፍኖተ ብርሃን የተቀበለው: ${s.revenue} ብር (${s.platformPaidCount})"
new_am = "🏦 ፍኖተ ብርሃን የተቀበለው: ${s.platformRevenue} ብር (${s.platformPaidCount})"
old_en = "Received by FinoteBirhan: ${s.revenue} ETB (${s.platformPaidCount})"
new_en = "Received by FinoteBirhan: ${s.platformRevenue} ETB (${s.platformPaidCount})"
assert old_am in index, 'Amharic platform revenue line not found'
assert old_en in index, 'English platform revenue line not found'
index = index.replace(old_am, new_am, 1).replace(old_en, new_en, 1)
index_path.write_text(index)

# Regression coverage: total Revenue must match all paid sales, while platform receipts stay separate.
test_path = Path('bot/backend/tests/sellerCashAccounting.test.js')
test = test_path.read_text()
test = test.replace(
    "test('seller-collected cash is excluded from platform Revenue and counted by package', () => {",
    "test('Revenue matches all paid ticket sales while seller cash stays separately visible', () => {",
    1,
)
old = """    assert.equal(dashboard.grossSalesValue, 950);
    assert.equal(dashboard.revenue, 400);
    assert.equal(dashboard.platformPaidCount, 2);
"""
new = """    assert.equal(dashboard.grossSalesValue, 950);
    assert.equal(dashboard.revenue, 950);
    assert.equal(dashboard.platformRevenue, 400);
    assert.equal(dashboard.platformPaidCount, 2);
"""
assert old in test, 'accounting assertions not found'
test = test.replace(old, new, 1)
insert = """

test('default ticket reservation timeout is 30 minutes', () => {
  const { db, dir } = makeDb();
  try {
    assert.equal(db.reservationMinutes, 30);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
"""
test_path.write_text(test + insert)
