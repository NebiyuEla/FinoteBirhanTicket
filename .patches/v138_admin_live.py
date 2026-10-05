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
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

# ---------------- backend index ----------------
path = 'bot/backend/src/index.js'
index = read(path)
index = replace_once(index, "const BOT_BUILD = '1.3.7';", "const BOT_BUILD = '1.3.8';", 'build version')
index = replace_once(index,
"  ['🎟 ትኬት ይግዙ', 'buy'], ['🎟 Buy Ticket', 'buy']\n",
"  ['🎟 ትኬት ይግዙ', 'buy'], ['🎟 Buy Ticket', 'buy'],\n  ['🧾 ትኬት ይሽጡ', 'sell'], ['🧾 Sell Tickets', 'sell']\n",
'menu sell route')

old_buy = """  else if (action === 'buy') {
    if (!config.miniAppUrl) {
      await bot.sendMessage(telegramId, tr(telegramId, 'የMini App ሊንክ አልተዘጋጀም።', 'The Mini App URL is not configured yet.'));
    } else {
      await sendMainMenu(telegramId);
    }
  }
"""
new_buy = """  else if (action === 'buy') await sendFreshMiniAppLauncher(telegramId, 'buyer');
  else if (action === 'sell') await sendFreshMiniAppLauncher(telegramId, 'seller');
"""
index = replace_once(index, old_buy, new_buy, 'fresh navigation')

old_menu = """  const buyText = am ? '🎟 ትኬት ይግዙ' : '🎟 Buy Ticket';
  if (config.miniAppUrl) rows.push([{ text: buyText, web_app: { url: buildMiniAppUrl(chatId) } }]);
  else rows.push([{ text: buyText }]);
  rows.push([{ text: am ? '🎫 የእኔ ትኬቶች' : '🎫 My Tickets' }, { text: am ? '🏆 ውጤት' : '🏆 Results' }]);
  rows.push([{ text: am ? '🌐 ቋንቋ' : '🌐 Language' }]);
  if (seller?.status === 'approved') {
    if (config.miniAppUrl) rows.push([{ text: am ? '🧾 ትኬት ይሽጡ' : '🧾 Sell Tickets', web_app: { url: buildSellerMiniAppUrl(seller) } }]);
    rows.push([{ text: am ? '📈 የሽያጭ ሪፖርት' : '📈 Seller Stats' }]);
  }
"""
new_menu = """  const buyText = am ? '🎟 ትኬት ይግዙ' : '🎟 Buy Ticket';
  // Persistent keyboard buttons are plain text so every press creates a fresh
  // availability snapshot from the live database instead of reopening a stale URL.
  rows.push([{ text: buyText }]);
  rows.push([{ text: am ? '🎫 የእኔ ትኬቶች' : '🎫 My Tickets' }, { text: am ? '🏆 ውጤት' : '🏆 Results' }]);
  rows.push([{ text: am ? '🌐 ቋንቋ' : '🌐 Language' }]);
  if (seller?.status === 'approved') {
    rows.push([{ text: am ? '🧾 ትኬት ይሽጡ' : '🧾 Sell Tickets' }]);
    rows.push([{ text: am ? '📈 የሽያጭ ሪፖርት' : '📈 Seller Stats' }]);
  }
"""
index = replace_once(index, old_menu, new_menu, 'plain keyboard')

anchor = "function addMiniAppContext(url, telegramId) {\n"
helper = """async function sendFreshMiniAppLauncher(telegramId, type = 'buyer') {
  if (!config.miniAppUrl) {
    return bot.sendMessage(telegramId, tr(telegramId, 'የMini App ሊንክ አልተዘጋጀም።', 'The Mini App URL is not configured yet.'));
  }
  const am = langOf(telegramId) !== 'en';
  let url;
  let buttonText;
  if (type === 'seller') {
    const seller = db.getSellerByTelegram(telegramId);
    if (!seller || seller.status !== 'approved') {
      return bot.sendMessage(telegramId, am ? 'የትኬት ሻጭ ፈቃድዎ ንቁ አይደለም።' : 'Ticket Seller access is not active.');
    }
    url = buildSellerMiniAppUrl(seller);
    buttonText = am ? '🧾 ትኬቶችን ክፈት' : '🧾 Open live tickets';
  } else {
    url = buildMiniAppUrl(telegramId);
    buttonText = am ? '🎟 ትኬቶችን ክፈት' : '🎟 Open live tickets';
  }
  return bot.sendMessage(telegramId,
    am ? '🔄 የሚታዩት ቁጥሮች ከአሁኑ ዳታ ተዘምነዋል። የተያዙ እና የተሸጡ ቁጥሮች አይታዩም።'
       : '🔄 Availability is refreshed from the live database. Reserved and sold numbers are hidden.',
    { reply_markup: inlineKeyboard([[{ text: buttonText, web_app: { url } }]]) }
  );
}

"""
index = replace_once(index, anchor, helper + anchor, 'fresh launcher helper')

index = replace_once(index, "  const session = db.createWebSession(telegramId, null);\n", "  const session = db.createWebSession(telegramId, null, 5);\n", 'buyer ttl')
index = replace_once(index, "  const session = db.createWebSession(seller.telegram_id, seller.id);\n", "  const session = db.createWebSession(seller.telegram_id, seller.id, 5);\n", 'seller ttl')
needle = "  url.searchParams.set('s', session);\n"
if index.count(needle) != 2:
    raise SystemExit(f'fresh timestamp expected 2 matches, found {index.count(needle)}')
index = index.replace(needle, "  url.searchParams.set('s', session);\n  url.searchParams.set('at', String(Date.now()));\n")

old_session = """  const session = db.consumeWebSession(payload.session, telegramId);
  if (!session) {
    await bot.sendMessage(telegramId, tr(telegramId, 'ይህ የትኬት ገጽ ጊዜው አልፏል። ከታች አዲስ ገጽ ይክፈቱ።', 'That ticket page expired. Open a fresh one below.'));
    return sendMainMenu(telegramId);
  }
"""
new_session = """  const launcherType = payload.type === 'seller_sale_selection' ? 'seller' : 'buyer';
  // Validate first, but consume only after a successful atomic reservation.
  // A race for a just-taken number must not burn the session and turn the retry into "expired".
  const session = db.getUsableWebSession(payload.session, telegramId);
  if (!session) {
    await bot.sendMessage(telegramId, tr(telegramId, 'ይህ የትኬት ገጽ አርጅቷል። አዲስ የቀጥታ ዝርዝር ይክፈቱ።', 'That ticket page is stale. Open a fresh live list.'));
    return sendFreshMiniAppLauncher(telegramId, launcherType);
  }
"""
index = replace_once(index, old_session, new_session, 'non-consuming session validation')

seller_reserve = """      const purchase = db.reserveSellerSale({
        sellerTelegramId: telegramId,
        buyerName: payload.buyer_name,
        buyerPhone: payload.buyer_phone,
        packageType: payload.package,
        selectedNumbers: payload.numbers,
        paymentTarget: payload.payment_target || 'finote'
      });
      await beginSellerPaymentAccountSelection(telegramId, purchase);
"""
seller_reserve_new = seller_reserve.replace("      await beginSellerPaymentAccountSelection", "      db.consumeWebSession(payload.session, telegramId);\n      await beginSellerPaymentAccountSelection")
index = replace_once(index, seller_reserve, seller_reserve_new, 'seller consume after reserve')

direct_reserve = """    const purchase = db.reservePurchase({
      telegramId,
      packageType: payload.package,
      selectedNumbers: payload.numbers
    });
    await beginDirectPaymentAccountSelection(telegramId, purchase);
"""
direct_reserve_new = direct_reserve.replace("    await beginDirectPaymentAccountSelection", "    db.consumeWebSession(payload.session, telegramId);\n    await beginDirectPaymentAccountSelection")
index = replace_once(index, direct_reserve, direct_reserve_new, 'buyer consume after reserve')

old_catch = """  } catch (error) {
    await bot.sendMessage(telegramId, tr(telegramId, `⚠️ ${error.message}\n\nክፍያ አልተጠየቀም። እንደገና ይምረጡ።`, `⚠️ ${error.message}\n\nNo payment was requested. Please choose again.`));
    await sendMainMenu(telegramId);
  }
}
"""
new_catch = """  } catch (error) {
    await bot.sendMessage(telegramId, tr(telegramId, `⚠️ ${error.message}\n\nክፍያ አልተጠየቀም። የተዘመነ ዝርዝር ከታች ይክፈቱ።`, `⚠️ ${error.message}\n\nNo payment was requested. Open the refreshed list below.`));
    await sendFreshMiniAppLauncher(telegramId, launcherType);
  }
}
"""
index = replace_once(index, old_catch, new_catch, 'conflict refresh')

# Replace the admin dashboard with a compact, auditable view.
pattern = re.compile(r"async function showAdminDashboard\(telegramId\) \{.*?\n\}\n\nasync function showPoolStatus", re.S)
match = pattern.search(index)
if not match:
    raise SystemExit('admin dashboard function not found')
admin = r"""async function showAdminDashboard(telegramId) {
  const am = langOf(telegramId) !== 'en';
  if (!db.isAdmin(telegramId)) return bot.sendMessage(telegramId, am ? 'የአስተዳዳሪ ፈቃድ ያስፈልጋል።' : 'Admin access required.');
  const s = db.dashboardStats();
  const recovery = db.recoveryStats();
  const salesBreakdown = formatPackageBreakdown(s.paidPackages, am);
  const classifiedValue = Number(s.confirmedRevenue || 0) + Number(s.unreconciledRevenue || 0) + Number(s.notReceivedRevenue || 0);
  const classifiedCount = Number(s.confirmedReceiptCount || 0) + Number(s.unreconciledCount || 0) + Number(s.notReceivedCount || 0);
  const accountingOk = classifiedValue === Number(s.salesValue || 0) && classifiedCount === Number(s.paidCount || 0);
  const reservedNumbers = s.pools.reduce((sum, row) => sum + Number(row.reserved || 0), 0);
  const availableNumbers = s.pools.reduce((sum, row) => sum + Number(row.available || 0), 0);
  const statusLine = accountingOk ? (am ? '✅ የሂሳብ ማመሳሰያ: ትክክል' : '✅ Accounting check: BALANCED') : (am ? '🚨 የሂሳብ ማመሳሰያ: ልዩነት አለ' : '🚨 Accounting check: MISMATCH');

  const text = am
    ? `🛠 ፍኖተ ብርሃን አስተዳዳሪ · v${BOT_BUILD}\n\n💰 ገንዘብ\n✅ የተረጋገጠ የገባ: ${s.confirmedRevenue} ብር (${s.confirmedReceiptCount})\n🕓 ማረጋገጥ የሚፈልግ: ${s.unreconciledRevenue} ብር (${s.unreconciledCount})\n🚫 አልገባም የተባለ: ${s.notReceivedRevenue} ብር (${s.notReceivedCount})\n\n🎟 ትኬት ሽያጭ\nየተሸጡ ግዢዎች: ${s.paidCount} · ${s.salesValue} ብር\nበቦት: ${s.directCount} · ${s.directRevenue} ብር\nበሻጭ: ${s.sellerCount} · ${s.sellerRevenue} ብር\n${salesBreakdown}\n\n👥 ${s.users} ደንበኞች · ${s.sellers} ሻጮች\n⏳ ${reservedNumbers} ቁጥሮች ተይዘዋል · ${availableNumbers} ነፃ\n🚨 Recovery: ${recovery.attention}\n${statusLine}`
    : `🛠 FinoteBirhan Admin · v${BOT_BUILD}\n\n💰 MONEY\n✅ Confirmed received: ${s.confirmedRevenue} ETB (${s.confirmedReceiptCount})\n🕓 Needs verification: ${s.unreconciledRevenue} ETB (${s.unreconciledCount})\n🚫 Marked not received: ${s.notReceivedRevenue} ETB (${s.notReceivedCount})\n\n🎟 TICKET SALES\nSold purchases: ${s.paidCount} · ${s.salesValue} ETB\nDirect bot: ${s.directCount} · ${s.directRevenue} ETB\nSeller-entered: ${s.sellerCount} · ${s.sellerRevenue} ETB\n${salesBreakdown}\n\n👥 ${s.users} customers · ${s.sellers} sellers\n⏳ ${reservedNumbers} numbers reserved · ${availableNumbers} available\n🚨 Recovery: ${recovery.attention}\n${statusLine}`;

  await bot.sendMessage(telegramId, text, {
    reply_markup: inlineKeyboard([
      [{ text: am ? '💰 ገቢ አረጋግጥ' : '💰 Reconcile', callback_data: 'admin_revenue_reconcile' }, { text: '🚨 Recovery', callback_data: 'admin_payments' }],
      [{ text: am ? '🎟 ትኬቶች' : '🎟 Tickets', callback_data: 'admin_pools' }, { text: am ? '🤝 ሻጮች' : '🤝 Sellers', callback_data: 'admin_sellers' }],
      [{ text: am ? '💳 አካውንቶች' : '💳 Accounts', callback_data: 'admin_payment_accounts' }, { text: am ? '🏆 ዕጣ' : '🏆 Draw', callback_data: 'admin_draw' }],
      [{ text: am ? '📤 ላክ' : '📤 Export', callback_data: 'admin_export' }, { text: am ? '⚙️ ተጨማሪ' : '⚙️ More', callback_data: 'admin_help' }]
    ])
  });
}

async function showPoolStatus"""
index = index[:match.start()] + admin + index[match.end():]
write(path, index)

# ---------------- database session safety ----------------
path = 'bot/backend/src/db.js'
db = read(path)
old_consume = """  consumeWebSession(token, telegramId) {
    const row = this.db.prepare('SELECT * FROM web_sessions WHERE token=?').get(token);
    if (!row || row.telegram_id !== telegramId || row.used_at || row.expires_at < nowIso()) return null;
    this.db.prepare('UPDATE web_sessions SET used_at=? WHERE token=?').run(nowIso(), token);
    return row;
  }
"""
new_consume = """  getUsableWebSession(token, telegramId) {
    const row = this.db.prepare('SELECT * FROM web_sessions WHERE token=?').get(token);
    if (!row || row.telegram_id !== telegramId || row.used_at || row.expires_at < nowIso()) return null;
    return row;
  }

  consumeWebSession(token, telegramId) {
    const row = this.getUsableWebSession(token, telegramId);
    if (!row) return null;
    this.db.prepare('UPDATE web_sessions SET used_at=? WHERE token=? AND used_at IS NULL').run(nowIso(), token);
    return row;
  }
"""
db = replace_once(db, old_consume, new_consume, 'session peek/consume')
write(path, db)

# ---------------- frontend live availability ----------------
path = 'app.js'
app = read(path)
app = replace_once(app,
"  const sellerPayAvailable = false;\n  let lang = normalizeLang(params.get('lang') || localStorage.getItem('finote_lang') || 'am');\n",
"  const sellerPayAvailable = false;\n  const snapshotAt = Number(params.get('at') || 0);\n  const SNAPSHOT_MAX_AGE_MS = 5 * 60_000;\n  let lang = normalizeLang(params.get('lang') || localStorage.getItem('finote_lang') || 'am');\n",
'frontend freshness state')
app = replace_once(app,
"  if (!session || !tg?.sendData) show('error');\n  else show(mode === 'seller' ? 'sellerCustomer' : 'ticket');\n",
"  if (!session || !tg?.sendData || !snapshotIsFresh()) show('error');\n  else show(mode === 'seller' ? 'sellerCustomer' : 'ticket');\n",
'initial freshness')
app = replace_once(app,
"  ticketGrid.addEventListener('click', (event) => {\n    const card = event.target.closest('[data-ticket]');\n",
"  ticketGrid.addEventListener('click', (event) => {\n    if (!snapshotIsFresh()) return show('error');\n    const card = event.target.closest('[data-ticket]');\n",
'ticket freshness')
app = replace_once(app,
"  confirmBtn.addEventListener('click', () => {\n    if (!complete()) return;\n",
"  confirmBtn.addEventListener('click', () => {\n    if (!snapshotIsFresh()) return show('error');\n    if (!complete()) return;\n",
'confirm freshness')
old_render = """      if (unavailable[state.activePool].has(number)) {
        button.disabled = true;
        button.classList.add('taken');
      } else if (state.numbers[state.activePool] === number) button.classList.add('selected');
      fragment.appendChild(button);
"""
new_render = """      // Reserved and sold numbers are never shown as selectable inventory.
      if (unavailable[state.activePool].has(number)) continue;
      if (state.numbers[state.activePool] === number) button.classList.add('selected');
      fragment.appendChild(button);
"""
app = replace_once(app, old_render, new_render, 'hide unavailable')
app = replace_once(app,
"  function alertMini(text) { if (tg?.showAlert) tg.showAlert(text); else window.alert(text); }\n",
"  function snapshotIsFresh() {\n    if (!Number.isFinite(snapshotAt) || snapshotAt <= 0) return false;\n    const age = Date.now() - snapshotAt;\n    return age >= -30_000 && age <= SNAPSHOT_MAX_AGE_MS;\n  }\n\n  function alertMini(text) { if (tg?.showAlert) tg.showAlert(text); else window.alert(text); }\n",
'freshness helper')
write(path, app)

# ---------------- HTML ----------------
path = 'index.html'
html = read(path)
html = replace_once(html, '<span><i class="dot taken"></i><span data-i18n="taken">የተወሰደ</span></span>', '', 'remove taken legend')
html = replace_once(html, '<script src="./app.js?v=20260924-1218"></script>', '<script src="./app.js?v=20261005-v138"></script>', 'cache bust')
write(path, html)

# ---------------- package/test versions ----------------
path = 'bot/backend/package.json'
pkg = read(path)
pkg = replace_once(pkg, '"version": "1.3.7"', '"version": "1.3.8"', 'package version')
write(path, pkg)

path = 'bot/backend/tests/navigationRecoveryCore.test.js'
test = read(path)
test = replace_once(test, "/const BOT_BUILD = '1\\.3\\.7';/", "/const BOT_BUILD = '1\\.3\\.8';/", 'version test')
write(path, test)

# Add focused source-regression tests.
Path('bot/backend/tests/adminLiveV138.test.js').write_text(r"""import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('admin dashboard separates confirmed money from sold value and self-checks accounting', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /Confirmed received:/);
  assert.match(source, /Needs verification:/);
  assert.match(source, /Sold purchases:/);
  assert.match(source, /Accounting check: BALANCED/);
  assert.doesNotMatch(source, /Force Clear Data', callback_data: 'admin_forceclear'/);
});

test('Mini App hides unavailable numbers and uses fresh snapshots', () => {
  const app = fs.readFileSync(new URL('../../../app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
  assert.match(app, /if \(unavailable\[state\.activePool\]\.has\(number\)\) continue;/);
  assert.match(app, /SNAPSHOT_MAX_AGE_MS = 5 \* 60_000/);
  assert.doesNotMatch(html, /dot taken/);
});

test('web session is consumed only after successful reservation', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /getUsableWebSession\(payload\.session, telegramId\)/);
  const reservePos = source.indexOf('const purchase = db.reservePurchase({');
  const consumePos = source.indexOf('db.consumeWebSession(payload.session, telegramId);', reservePos);
  assert.ok(reservePos > 0 && consumePos > reservePos);
});
""", encoding='utf-8')

Path('bot/backend/BUILD-v1.3.8.md').write_text("""# FinoteBirhan v1.3.8

- Simple admin dashboard with separate confirmed cash, unreconciled cash, not-received cash, and sold-ticket ledger.
- Runtime accounting balance check: confirmed + unreconciled + not received must equal sold ledger.
- Reserved and sold numbers are hidden from Mini App inventory.
- Fresh 5-minute availability snapshots are generated for each Buy/Sell request.
- Mini App sessions are consumed only after successful atomic reservation, preventing false expiry after a stale-number race.
""", encoding='utf-8')
