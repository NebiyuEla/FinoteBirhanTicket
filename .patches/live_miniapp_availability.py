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

# ---- backend bot ---------------------------------------------------------
index_path = 'bot/backend/src/index.js'
index = read(index_path)
index = replace_once(index, "const BOT_BUILD = '1.3.7';", "const BOT_BUILD = '1.3.8';", 'bot build')

index = replace_once(
    index,
    "  ['🎟 ትኬት ይግዙ', 'buy'], ['🎟 Buy Ticket', 'buy']\n",
    "  ['🎟 ትኬት ይግዙ', 'buy'], ['🎟 Buy Ticket', 'buy'],\n  ['🧾 ትኬት ይሽጡ', 'sell'], ['🧾 Sell Tickets', 'sell']\n",
    'menu navigation sell route'
)

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
index = replace_once(index, old_buy, new_buy, 'fresh launcher navigation')

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
  // Keep persistent reply-keyboard buttons as plain text. A Web App URL baked into
  // the keyboard is a stale availability snapshot and can be reopened much later.
  // The text button reaches the bot first, which creates a fresh one-time launcher.
  rows.push([{ text: buyText }]);
  rows.push([{ text: am ? '🎫 የእኔ ትኬቶች' : '🎫 My Tickets' }, { text: am ? '🏆 ውጤት' : '🏆 Results' }]);
  rows.push([{ text: am ? '🌐 ቋንቋ' : '🌐 Language' }]);
  if (seller?.status === 'approved') {
    rows.push([{ text: am ? '🧾 ትኬት ይሽጡ' : '🧾 Sell Tickets' }]);
    rows.push([{ text: am ? '📈 የሽያጭ ሪፖርት' : '📈 Seller Stats' }]);
  }
"""
index = replace_once(index, old_menu, new_menu, 'plain persistent menu')

anchor = """function addMiniAppContext(url, telegramId) {
"""
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
    buttonText = am ? '🧾 የቀጥታ ሽያጭ ክፈት' : '🧾 Open live seller tickets';
  } else {
    url = buildMiniAppUrl(telegramId);
    buttonText = am ? '🎟 አዲስ የትኬት ዝርዝር ክፈት' : '🎟 Open fresh ticket list';
  }

  return bot.sendMessage(telegramId,
    am
      ? '🔄 የትኬት ቁጥሮች አሁን ካለው ዳታ ተዘምነዋል። የተያዙ እና SOLD የሆኑ ቁጥሮች አይታዩም። ይህን አዲስ ገጽ አሁን ይክፈቱ።'
      : '🔄 Ticket availability was refreshed from the current database. Reserved and SOLD numbers are hidden. Open this fresh page now.',
    { reply_markup: inlineKeyboard([[{ text: buttonText, web_app: { url } }]]) }
  );
}

"""
if helper.strip() not in index:
    index = replace_once(index, anchor, helper + anchor, 'fresh launcher helper')

index = replace_once(
    index,
    "  const session = db.createWebSession(telegramId, null);\n",
    "  const session = db.createWebSession(telegramId, null, 5);\n",
    'buyer session ttl'
)
index = replace_once(
    index,
    "  const session = db.createWebSession(seller.telegram_id, seller.id);\n",
    "  const session = db.createWebSession(seller.telegram_id, seller.id, 5);\n",
    'seller session ttl'
)
# Both URL builders get a server-generated freshness timestamp.
needle = "  url.searchParams.set('s', session);\n"
if index.count(needle) != 2:
    raise SystemExit(f'fresh timestamp: expected 2 session URL matches, found {index.count(needle)}')
index = index.replace(needle, "  url.searchParams.set('s', session);\n  url.searchParams.set('at', String(Date.now()));\n")

old_expired = """  const session = db.consumeWebSession(payload.session, telegramId);
  if (!session) {
    await bot.sendMessage(telegramId, tr(telegramId, 'ይህ የትኬት ገጽ ጊዜው አልፏል። ከታች አዲስ ገጽ ይክፈቱ።', 'That ticket page expired. Open a fresh one below.'));
    return sendMainMenu(telegramId);
  }
"""
new_expired = """  const launcherType = payload.type === 'seller_sale_selection' ? 'seller' : 'buyer';
  const session = db.consumeWebSession(payload.session, telegramId);
  if (!session) {
    await bot.sendMessage(telegramId, tr(telegramId, 'ይህ የትኬት ገጽ አርጅቷል። ከአሁኑ ዳታ ጋር አዲስ ገጽ ከታች ተዘጋጅቷል።', 'That ticket page is stale. A fresh page using the current availability is ready below.'));
    return sendFreshMiniAppLauncher(telegramId, launcherType);
  }
"""
index = replace_once(index, old_expired, new_expired, 'expired session refresh')

old_catch = """  } catch (error) {
    await bot.sendMessage(telegramId, tr(telegramId, `⚠️ ${error.message}\\
\\
ክፍያ አልተጠየቀም። እንደገና ይምረጡ።`, `⚠️ ${error.message}\\
\\
No payment was requested. Please choose again.`));
    await sendMainMenu(telegramId);
  }
}
"""
new_catch = """  } catch (error) {
    await bot.sendMessage(telegramId, tr(telegramId, `⚠️ ${error.message}\\
\\
ክፍያ አልተጠየቀም። ቁጥሩን ሌላ ሰው ከያዘው ወይም ከተሸጠ የተዘመነ ዝርዝር ከታች ይከፈታል።`, `⚠️ ${error.message}\\
\\
No payment was requested. If the number was reserved or sold by someone else, open the refreshed list below.`));
    await sendFreshMiniAppLauncher(telegramId, launcherType);
  }
}
"""
index = replace_once(index, old_catch, new_catch, 'reservation conflict refresh')
write(index_path, index)

# ---- package version -----------------------------------------------------
package_path = 'bot/backend/package.json'
package = read(package_path)
package = replace_once(package, '"version": "1.3.7"', '"version": "1.3.8"', 'package version')
write(package_path, package)

# ---- existing version test ---------------------------------------------
test_path = 'bot/backend/tests/navigationRecoveryCore.test.js'
test = read(test_path)
test = replace_once(test, "/const BOT_BUILD = '1\\.3\\.7';/", "/const BOT_BUILD = '1\\.3\\.8';/", 'version regression test')
write(test_path, test)

# ---- frontend ------------------------------------------------------------
app_path = 'app.js'
app = read(app_path)
app = replace_once(
    app,
    "  const sellerPayAvailable = false;\n  let lang = normalizeLang(params.get('lang') || localStorage.getItem('finote_lang') || 'am');\n",
    "  const sellerPayAvailable = false;\n  const snapshotAt = Number(params.get('at') || 0);\n  const SNAPSHOT_MAX_AGE_MS = 5 * 60_000;\n  let lang = normalizeLang(params.get('lang') || localStorage.getItem('finote_lang') || 'am');\n",
    'frontend freshness state'
)
app = replace_once(
    app,
    "  if (!session || !tg?.sendData) show('error');\n  else show(mode === 'seller' ? 'sellerCustomer' : 'ticket');\n",
    "  if (!session || !tg?.sendData || !snapshotIsFresh()) show('error');\n  else show(mode === 'seller' ? 'sellerCustomer' : 'ticket');\n",
    'initial freshness guard'
)
app = replace_once(
    app,
    "  ticketGrid.addEventListener('click', (event) => {\n    const card = event.target.closest('[data-ticket]');\n",
    "  ticketGrid.addEventListener('click', (event) => {\n    if (!snapshotIsFresh()) return show('error');\n    const card = event.target.closest('[data-ticket]');\n",
    'ticket-open freshness guard'
)
app = replace_once(
    app,
    "  confirmBtn.addEventListener('click', () => {\n    if (!complete()) return;\n",
    "  confirmBtn.addEventListener('click', () => {\n    if (!snapshotIsFresh()) return show('error');\n    if (!complete()) return;\n",
    'confirm freshness guard'
)
old_render = """      if (unavailable[state.activePool].has(number)) {
        button.disabled = true;
        button.classList.add('taken');
      } else if (state.numbers[state.activePool] === number) button.classList.add('selected');
      fragment.appendChild(button);
"""
new_render = """      // Unavailable means reserved OR sold in the current server snapshot.
      // Do not merely disable it: omit it so another buyer never sees it as selectable inventory.
      if (unavailable[state.activePool].has(number)) continue;
      if (state.numbers[state.activePool] === number) button.classList.add('selected');
      fragment.appendChild(button);
"""
app = replace_once(app, old_render, new_render, 'hide unavailable numbers')
app = replace_once(
    app,
    "  function alertMini(text) { if (tg?.showAlert) tg.showAlert(text); else window.alert(text); }\n",
    "  function snapshotIsFresh() {\n    if (!Number.isFinite(snapshotAt) || snapshotAt <= 0) return false;\n    const age = Date.now() - snapshotAt;\n    return age >= -30_000 && age <= SNAPSHOT_MAX_AGE_MS;\n  }\n\n  function alertMini(text) { if (tg?.showAlert) tg.showAlert(text); else window.alert(text); }\n",
    'snapshot freshness helper'
)
write(app_path, app)

# ---- HTML: remove taken legend + bust frontend cache --------------------
html_path = 'index.html'
html = read(html_path)
html = replace_once(
    html,
    '<span><i class="dot taken"></i><span data-i18n="taken">የተወሰደ</span></span>',
    '',
    'remove taken legend'
)
html = re.sub(r'<script src="\./app\.js\?v=[^"]+"></script>', '<script src="./app.js?v=20261005-live-availability"></script>', html, count=1)
if 'app.js?v=20261005-live-availability' not in html:
    raise SystemExit('frontend cache-bust replacement failed')
write(html_path, html)

# ---- new regression tests ----------------------------------------------
live_test_path = ROOT / 'bot/backend/tests/liveMiniAppAvailability.test.js'
live_test_path.write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TicketDatabase } from '../src/db.js';

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-live-availability-'));
  const db = new TicketDatabase(path.join(dir, 'test.sqlite'));
  db.ensureUser(1); db.setUserName(1, 'Buyer One'); db.setUserPhone(1, '+251911111111');
  db.ensureUser(2); db.setUserName(2, 'Buyer Two'); db.setUserPhone(2, '+251922222222');
  db.ensureUser(999); db.setUserName(999, 'Admin'); db.setUserPhone(999, '+251933333333'); db.addAdmin(999);
  return { db, dir };
}

function close(db, dir) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('availability excludes both reserved and sold numbers and atomic reserve blocks duplicates', () => {
  const { db, dir } = makeDb();
  try {
    const first = db.reservePurchase({ telegramId: 1, packageType: '100', selectedNumbers: { 100: 5 } });
    assert.ok(db.availability()[100].includes(5), 'reserved #005 must be unavailable');
    assert.throws(
      () => db.reservePurchase({ telegramId: 2, packageType: '100', selectedNumbers: { 100: 5 } }),
      /taken|available|reserved/i
    );
    const paid = db.confirmPurchase(first.id, 999, { note: 'test approval' });
    assert.equal(paid.status, 'paid');
    assert.ok(db.availability()[100].includes(5), 'sold #005 must remain unavailable');
  } finally {
    close(db, dir);
  }
});

test('persistent menu never embeds stale Mini App URLs and fresh launchers are short-lived', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /sendFreshMiniAppLauncher/);
  assert.match(source, /createWebSession\(telegramId, null, 5\)/);
  assert.match(source, /createWebSession\(seller\.telegram_id, seller\.id, 5\)/);
  assert.match(source, /url\.searchParams\.set\('at', String\(Date\.now\(\)\)\)/);
  assert.match(source, /\['🧾 Sell Tickets', 'sell'\]/);
  assert.doesNotMatch(source, /rows\.push\(\[\{ text: buyText, web_app:/);
  assert.doesNotMatch(source, /rows\.push\(\[\{ text: am \? '🧾 ትኬት ይሽጡ' : '🧾 Sell Tickets', web_app:/);
});

test('Mini App hides unavailable numbers and rejects stale availability snapshots', () => {
  const app = fs.readFileSync(new URL('../../../app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
  assert.match(app, /SNAPSHOT_MAX_AGE_MS = 5 \* 60_000/);
  assert.match(app, /if \(!session \|\| !tg\?\.sendData \|\| !snapshotIsFresh\(\)\) show\('error'\)/);
  assert.match(app, /if \(unavailable\[state\.activePool\]\.has\(number\)\) continue/);
  assert.doesNotMatch(html, /dot taken/);
  assert.match(html, /app\.js\?v=20261005-live-availability/);
});
''', encoding='utf-8')

print('Live Mini App availability patch applied.')
