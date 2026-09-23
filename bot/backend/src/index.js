import { config, assertRuntimeConfig } from './config.js';
import { TicketDatabase } from './db.js';
import { TelegramBotApi, inlineKeyboard, replyKeyboard, removeKeyboard } from './telegram.js';
import { VerifyEtClient } from './verifyEt.js';
import { generateTicketPng } from './ticketImage.js';
import {
  amountForPackage, csvEscape, encodeUnavailableBitset, formatNumber, htmlEscape,
  maskPhone, normalizePhone, packagePools, safeJsonParse, shortCode, truncate
} from './utils.js';

assertRuntimeConfig();

const db = new TicketDatabase(config.dbPath, {
  reservationMinutes: config.reservationMinutes,
  manualReviewMinutes: config.manualReviewMinutes
});
const bot = new TelegramBotApi(config.botToken);
const verifier = new VerifyEtClient({
  apiKey: config.verifyEtApiKey,
  baseUrl: config.verifyEtBaseUrl,
  pollTimeoutSeconds: config.pollTimeoutSeconds
});

bootstrapRuntimeSettings();

function langOf(telegramId) { return db.getUserLanguage(telegramId); }
function tr(telegramId, am, en) { return langOf(telegramId) === 'en' ? en : am; }
function prizeSetting(pool, lang) { return db.getSetting(`prize_${pool}_${lang === 'en' ? 'en' : 'am'}`) || ''; }

let botInfo = null;
let stopping = false;
let offset = 0;

main().catch((error) => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});

async function main() {
  botInfo = await bot.getMe();
  console.log(`[boot] @${botInfo.username} (${botInfo.id})`);
  db.releaseExpiredReservations();
  setInterval(() => {
    try { db.releaseExpiredReservations(); } catch (error) { console.error('[cleanup]', error); }
  }, 60_000).unref();

  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  while (!stopping) {
    try {
      const updates = await bot.getUpdates({
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query']
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (error) {
          console.error('[update]', update.update_id, error);
          const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
          if (chatId) await safeSend(chatId, 'Something went wrong. Please try again.');
        }
      }
    } catch (error) {
      if (!stopping) {
        console.error('[poll]', error.message);
        await sleep(1800);
      }
    }
  }
}

function stop() {
  stopping = true;
  try { db.close(); } catch {}
}

function bootstrapRuntimeSettings() {
  if (config.adminTelegramId && !db.isAdmin(config.adminTelegramId)) {
    db.addAdmin(config.adminTelegramId);
  }

  const hasDefaultPayment =
    config.defaultPaymentProvider &&
    config.defaultPaymentAccountName &&
    config.defaultPaymentAccountNumber;

  if (hasDefaultPayment) {
    const currentProvider = db.getSetting('payment_provider');
    if (!currentProvider) {
      db.setSetting('payment_provider', config.defaultPaymentProvider, config.adminTelegramId);
    } else {
      const compact = String(currentProvider).toLowerCase().replace(/[^a-z0-9]/g, '');
      const defaultCompact = String(config.defaultPaymentProvider).toLowerCase().replace(/[^a-z0-9]/g, '');
      // Earlier builds allowed labels such as "CBE/Telebirr". That is not a valid
      // Verify.et bank identifier. Normalize the FinoteBirhan bank account to CBE.
      if (compact.includes('cbe') && compact.includes('telebirr') && defaultCompact === 'cbe') {
        db.setSetting('payment_provider', 'cbe', config.adminTelegramId);
      }
    }
    if (!db.getSetting('payment_account_name')) {
      db.setSetting('payment_account_name', config.defaultPaymentAccountName, config.adminTelegramId);
    }
    if (!db.getSetting('payment_account_number')) {
      db.setSetting('payment_account_number', config.defaultPaymentAccountNumber, config.adminTelegramId);
    }
  }

  const defaultAccount = db.ensureLegacyPaymentAccount(config.adminTelegramId);
  if (defaultAccount && hasDefaultPayment) {
    const compact = String(defaultAccount.provider || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const defaultCompact = String(config.defaultPaymentProvider || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // Keep the V10 provider normalization effective after the legacy account is
    // migrated into the V12 multi-account table.
    if (compact.includes('cbe') && compact.includes('telebirr') && defaultCompact === 'cbe') {
      db.updatePaymentAccount(defaultAccount.id, {
        provider: 'cbe',
        accountName: defaultAccount.account_name,
        accountNumber: defaultAccount.account_number
      }, config.adminTelegramId);
    }
  }
}

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  const message = update.message;
  if (!message || message.chat?.type !== 'private') return;

  const telegramId = message.from?.id;
  if (!telegramId) return;
  db.ensureUser(telegramId);

  if (message.web_app_data?.data) return handleWebAppData(message);

  const text = String(message.text || '').trim();
  if (text.startsWith('/')) {
    const handled = await handleCommand(message, text);
    if (handled) return;
  }

  const user = db.getUser(telegramId);
  if (!user || user.registration_state !== 'complete') {
    return handleRegistrationMessage(message);
  }

  const state = db.getUserState(telegramId);
  if (state) {
    const handled = await handleStateMessage(message, state);
    if (handled) return;
  }

  if (message.photo?.length || message.document) {
    const purchase = db.getOpenPurchaseForUser(telegramId);
    if (purchase) return handlePaymentProof(message, purchase);
  }

  switch (text) {
    case '🎫 የእኔ ትኬቶች': case '🎫 My Tickets': return showMyTickets(telegramId);
    case '🏆 ውጤት': case '🏆 Results': return showResults(telegramId);
    case '📈 የሽያጭ ሪፖርት': case '📈 Seller Stats': return showSellerPanel(telegramId);
    case '💳 የሻጭ አካውንት': case '💳 Seller Account': return startSellerAccountSetup(telegramId);
    case '🌐 ቋንቋ': case '🌐 Language': return showLanguagePicker(telegramId);
    case '🛠 አስተዳዳሪ': case '🛠 Admin': return showAdminDashboard(telegramId);
    case '🎟 ትኬት ይግዙ': case '🎟 Buy Ticket':
      if (!config.miniAppUrl) return bot.sendMessage(telegramId, tr(telegramId, 'የMini App ሊንክ አልተዘጋጀም።', 'The Mini App URL is not configured yet.'));
      return sendMainMenu(telegramId);
    default:
      return sendMainMenu(telegramId);
  }
}

async function handleCommand(message, text) {
  const telegramId = message.from.id;
  const [rawCmd, ...parts] = text.split(/\s+/);
  const cmd = rawCmd.split('@')[0].toLowerCase();
  const args = parts.join(' ').trim();

  if (cmd === '/start') {
    const user = db.getUser(telegramId);
    if (!user?.full_name || user.registration_state === 'new') {
      db.setUserState(telegramId, 'register_name');
      await bot.sendMessage(telegramId,
        tr(telegramId,
          '✝️ ወደ ፍኖተ ብርሃን ሰንበት ትምህርት ቤት ዲጂታል ዕጣ እንኳን ደህና መጡ።\n\nእባክዎ ሙሉ ስምዎን ይላኩ።',
          '✝️ Welcome to FinoteBirhan Sunday School Digital Tickets.\n\nPlease send your full name.'),
        { reply_markup: inlineKeyboard([[{ text: 'አማርኛ', callback_data: 'lang:am' }, { text: 'English', callback_data: 'lang:en' }]]) }
      );
      return true;
    }
    if (!user.phone || user.registration_state !== 'complete') {
      db.setUserState(telegramId, 'register_phone');
      await askForPhone(telegramId);
      return true;
    }
    const activatedSeller = db.activateSellerIfInvited(telegramId);
    const linkedPurchases = db.linkSellerTicketsForUser(telegramId);
    if (linkedPurchases.length) {
      await bot.sendMessage(telegramId, tr(telegramId, `🎫 በስምዎ ወይም በስልክዎ የተመዘገቡ ${linkedPurchases.length} ትኬት(ዎች) ከአካውንትዎ ጋር ተገናኙ።`, `🎫 We linked ${linkedPurchases.length} ticket purchase${linkedPurchases.length === 1 ? '' : 's'} matching your name or phone number.`));
      for (const purchaseId of linkedPurchases) {
        await sendIssuedTickets(telegramId, purchaseId);
        const winner = db.winnerForPurchase(purchaseId);
        if (winner) await sendPersonalWinnerMessage(telegramId, winner);
      }
    }
    await sendMainMenu(telegramId, activatedSeller ? tr(telegramId, 'የትኬት ሻጭ ፈቃድዎ ነቅቷል።', 'Ticket Seller access is now active.') : tr(telegramId, 'ወደ ፍኖተ ብርሃን ዲጂታል ዕጣ እንኳን ደህና መጡ።', 'Welcome to FinoteBirhan Digital Tickets.'));
    return true;
  }

  if (cmd === '/cancel') {
    db.clearUserState(telegramId);
    const cancelled = db.cancelLatestOpenPurchaseForUser(telegramId, 'Cancelled by user from /cancel');
    await sendMainMenu(telegramId, cancelled ? tr(telegramId, 'ተሰርዟል። የተያዘው ቁጥር እንደገና ነፃ ሆኗል።', 'Cancelled. Your reserved number was released.') : tr(telegramId, 'ተሰርዟል።', 'Cancelled.'));
    return true;
  }

  if (cmd === '/claimadmin') {
    if (db.adminCount() > 0) {
      await bot.sendMessage(telegramId, 'The first administrator has already been claimed.');
      return true;
    }
    if (!args || args !== config.adminSetupCode) {
      await bot.sendMessage(telegramId, 'Invalid setup code.');
      return true;
    }
    db.addAdmin(telegramId);
    await bot.sendMessage(telegramId, '✅ You are now the FinoteBirhan ticket administrator.');
    await showAdminDashboard(telegramId);
    return true;
  }

  if (cmd === '/mytickets') { await showMyTickets(telegramId); return true; }
  if (cmd === '/results') { await showResults(telegramId); return true; }
  if (cmd === '/language' || cmd === '/lang') { await showLanguagePicker(telegramId); return true; }
  if (cmd === '/sellerpanel' || cmd === '/sellerstats') { await showSellerPanel(telegramId); return true; }

  if (cmd === '/admin') { await showAdminDashboard(telegramId); return true; }

  if (['/setpayment','/addpayment','/paymentaccounts','/setdraw','/setprize','/sales','/broadcast','/export','/draw','/publish','/addadmin','/addseller','/sellerlist','/suspendseller','/approveseller','/ticket','/customer','/audit','/forceclear'].includes(cmd)) {
    if (!db.isAdmin(telegramId)) {
      await bot.sendMessage(telegramId, 'Admin access required.');
      return true;
    }
    if (cmd === '/setpayment') return adminSetPayment(telegramId, args).then(() => true);
    if (cmd === '/addpayment') return adminAddPayment(telegramId, args).then(() => true);
    if (cmd === '/paymentaccounts') { await showPaymentAccounts(telegramId); return true; }
    if (cmd === '/setdraw') return adminSetDraw(telegramId, args).then(() => true);
    if (cmd === '/setprize') return adminSetPrize(telegramId, args).then(() => true);
    if (cmd === '/sales') return adminSetSales(telegramId, args).then(() => true);
    if (cmd === '/broadcast') return adminBroadcast(telegramId, args).then(() => true);
    if (cmd === '/export') { await adminExport(telegramId); return true; }
    if (cmd === '/draw') { await adminDraw(telegramId); return true; }
    if (cmd === '/publish') { await adminPublish(telegramId); return true; }
    if (cmd === '/addadmin') {
      const id = Number(args);
      if (!Number.isSafeInteger(id)) await bot.sendMessage(telegramId, 'Usage: /addadmin TELEGRAM_NUMERIC_ID');
      else { db.addAdmin(id); await bot.sendMessage(telegramId, `Admin added: ${id}`); }
      return true;
    }
    if (cmd === '/addseller') {
      await adminAddSeller(telegramId, args);
      return true;
    }
    if (cmd === '/sellerlist') { await adminSellerList(telegramId); return true; }
    if (cmd === '/suspendseller' || cmd === '/approveseller') {
      const id = Number(args);
      if (!Number.isInteger(id)) await bot.sendMessage(telegramId, `Usage: ${cmd} SELLER_ID`);
      else { const seller = db.setSellerStatus(id, cmd === '/approveseller' ? 'approved' : 'suspended', telegramId); await bot.sendMessage(telegramId, seller ? `${seller.display_name}: ${seller.status}` : 'Seller not found.'); }
      return true;
    }
    if (cmd === '/ticket') { await adminTicketLookup(telegramId, args); return true; }
    if (cmd === '/customer') { await adminCustomerLookup(telegramId, args); return true; }
    if (cmd === '/forceclear') { await adminForceClearCommand(telegramId, args); return true; }
    if (cmd === '/audit') { await adminAudit(telegramId, args); return true; }
  }

  return false;
}

async function handleRegistrationMessage(message) {
  const telegramId = message.from.id;
  const state = db.getUserState(telegramId);
  if (!state || !['register_name','register_phone'].includes(state.state)) {
    db.setUserState(telegramId, 'register_name');
    await bot.sendMessage(telegramId, tr(telegramId, 'እባክዎ መጀመሪያ ሙሉ ስምዎን ይላኩ።', 'Please send your full name first.'));
    return;
  }

  if (state.state === 'register_name') {
    const name = String(message.text || '').trim().replace(/\s+/g, ' ');
    if (name.length < 3 || name.length > 80) {
      await bot.sendMessage(telegramId, tr(telegramId, 'እባክዎ ትክክለኛ ሙሉ ስም ይላኩ።', 'Please send a valid full name.'));
      return;
    }
    db.setUserName(telegramId, name);
    db.setUserState(telegramId, 'register_phone');
    await askForPhone(telegramId);
    return;
  }

  const rawPhone = message.contact?.phone_number || message.text || '';
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    await bot.sendMessage(telegramId, tr(telegramId, 'እባክዎ ትክክለኛ የኢትዮጵያ ሞባይል ቁጥር ይላኩ፤ ለምሳሌ 0912345678 ወይም 0712345678።', 'Please send a valid Ethiopian mobile number such as 0912345678 or 0712345678.'));
    return;
  }
  if (message.contact?.user_id && message.contact.user_id !== telegramId) {
    await bot.sendMessage(telegramId, tr(telegramId, 'እባክዎ የራስዎን ስልክ ቁጥር ያጋሩ።', 'Please share your own phone number.'));
    return;
  }
  db.setUserPhone(telegramId, phone);
  db.clearUserState(telegramId);
  const activatedSeller = db.activateSellerIfInvited(telegramId);
  const linkedPurchases = db.linkSellerTicketsForUser(telegramId);
  await bot.sendMessage(telegramId, activatedSeller
    ? tr(telegramId, '✅ ምዝገባዎ ተጠናቋል። የትኬት ሻጭ ፈቃድዎ ነቅቷል።', '✅ Registration complete. Ticket Seller access is now active.')
    : tr(telegramId, '✅ ምዝገባዎ ተጠናቋል።', '✅ Registration complete.'), { reply_markup: removeKeyboard() });
  if (linkedPurchases.length) {
    await bot.sendMessage(telegramId, tr(telegramId, `🎫 በስምዎ ወይም በስልክዎ የተመዘገቡ ${linkedPurchases.length} ትኬት(ዎች) አግኝተን ከአካውንትዎ ጋር አገናኘናቸው።`, `🎫 We found ${linkedPurchases.length} ticket purchase${linkedPurchases.length === 1 ? '' : 's'} matching your name or phone number and linked them to your account.`));
    for (const purchaseId of linkedPurchases) {
      await sendIssuedTickets(telegramId, purchaseId);
      const winner = db.winnerForPurchase(purchaseId);
      if (winner) await sendPersonalWinnerMessage(telegramId, winner);
    }
  }
  await sendMainMenu(telegramId, tr(telegramId, 'ወደ ፍኖተ ብርሃን ዲጂታል ዕጣ እንኳን ደህና መጡ።', 'Welcome to FinoteBirhan Digital Tickets.'));
}

async function askForPhone(chatId) {
  const am = langOf(chatId) !== 'en';
  await bot.sendMessage(chatId,
    am ? 'አሁን ስልክ ቁጥርዎን ይላኩ ወይም ከታች ያለውን ቁልፍ ይጫኑ።' : 'Now send your phone number or use the button below.', {
      reply_markup: replyKeyboard([[{ text: am ? '📱 ስልኬን አጋራ' : '📱 Share my phone', request_contact: true }]], { oneTime: true, placeholder: '09XXXXXXXX' })
    }
  );
}

async function showLanguagePicker(chatId) {
  await bot.sendMessage(chatId, '🌐 ቋንቋ / Language', {
    reply_markup: inlineKeyboard([[{ text: '🇪🇹 አማርኛ', callback_data: 'lang:am' }, { text: '🇬🇧 English', callback_data: 'lang:en' }]])
  });
}

async function sendMainMenu(chatId, intro = '') {
  const user = db.getUser(chatId);
  if (!user || user.registration_state !== 'complete') return;
  const seller = db.getSellerByTelegram(chatId);
  const am = langOf(chatId) !== 'en';
  const rows = [];
  const buyText = am ? '🎟 ትኬት ይግዙ' : '🎟 Buy Ticket';
  if (config.miniAppUrl) rows.push([{ text: buyText, web_app: { url: buildMiniAppUrl(chatId) } }]);
  else rows.push([{ text: buyText }]);
  rows.push([{ text: am ? '🎫 የእኔ ትኬቶች' : '🎫 My Tickets' }, { text: am ? '🏆 ውጤት' : '🏆 Results' }]);
  rows.push([{ text: am ? '🌐 ቋንቋ' : '🌐 Language' }]);
  if (seller?.status === 'approved') {
    if (config.miniAppUrl) rows.push([{ text: am ? '🧾 ትኬት ይሽጡ' : '🧾 Sell Tickets', web_app: { url: buildSellerMiniAppUrl(seller) } }]);
    rows.push([{ text: am ? '📈 የሽያጭ ሪፖርት' : '📈 Seller Stats' }, { text: am ? '💳 የሻጭ አካውንት' : '💳 Seller Account' }]);
  }
  if (db.isAdmin(chatId)) rows.push([{ text: am ? '🛠 አስተዳዳሪ' : '🛠 Admin' }]);

  await bot.sendMessage(chatId, `${intro ? `${intro}

` : ''}${am ? 'ከታች አንዱን ይምረጡ።' : 'Choose an option below.'}`, {
    reply_markup: replyKeyboard(rows, { placeholder: am ? 'አንዱን ይምረጡ' : 'Choose an option' })
  });
}

function addMiniAppContext(url, telegramId) {
  const lang = langOf(telegramId);
  url.searchParams.set('lang', lang);
  for (const pool of [200,100,50]) {
    url.searchParams.set(`p${pool}am`, prizeSetting(pool, 'am'));
    url.searchParams.set(`p${pool}en`, prizeSetting(pool, 'en'));
  }
}

function buildMiniAppUrl(telegramId) {
  const url = new URL(config.miniAppUrl);
  const session = db.createWebSession(telegramId, null);
  const availability = db.availability();
  url.searchParams.set('s', session);
  addMiniAppContext(url, telegramId);
  url.searchParams.set('a200', encodeUnavailableBitset(availability[200]));
  url.searchParams.set('a100', encodeUnavailableBitset(availability[100]));
  url.searchParams.set('a50', encodeUnavailableBitset(availability[50]));
  return url.toString();
}

function buildSellerMiniAppUrl(seller) {
  const url = new URL(config.miniAppUrl);
  const session = db.createWebSession(seller.telegram_id, seller.id);
  const availability = db.availability();
  url.searchParams.set('s', session);
  url.searchParams.set('mode', 'seller');
  url.searchParams.set('seller', seller.display_name.slice(0, 35));
  url.searchParams.set('sellerpay', db.sellerHasPaymentAccount(seller.id) ? '1' : '0');
  addMiniAppContext(url, seller.telegram_id);
  url.searchParams.set('a200', encodeUnavailableBitset(availability[200]));
  url.searchParams.set('a100', encodeUnavailableBitset(availability[100]));
  url.searchParams.set('a50', encodeUnavailableBitset(availability[50]));
  return url.toString();
}

async function handleWebAppData(message) {
  const telegramId = message.from.id;
  const payload = safeJsonParse(message.web_app_data.data, null);
  if (payload?.lang === 'am' || payload?.lang === 'en') db.setUserLanguage(telegramId, payload.lang);
  if (!payload || !['ticket_selection', 'seller_sale_selection'].includes(payload.type)) {
    await bot.sendMessage(telegramId, tr(telegramId, 'የትኬት ምርጫው ትክክል አይደለም። እንደገና ይሞክሩ።', 'Invalid ticket selection. Please try again.'));
    return sendMainMenu(telegramId);
  }
  const session = db.consumeWebSession(payload.session, telegramId);
  if (!session) {
    await bot.sendMessage(telegramId, tr(telegramId, 'ይህ የትኬት ገጽ ጊዜው አልፏል። ከታች አዲስ ገጽ ይክፈቱ።', 'That ticket page expired. Open a fresh one below.'));
    return sendMainMenu(telegramId);
  }

  try {
    if (payload.type === 'seller_sale_selection') {
      const seller = db.getSellerByTelegram(telegramId);
      if (!seller || seller.status !== 'approved' || Number(session.seller_id) !== Number(seller.id)) {
        throw new Error('Ticket seller access is not active.');
      }
      const purchase = db.reserveSellerSale({
        sellerTelegramId: telegramId,
        buyerName: payload.buyer_name,
        buyerPhone: payload.buyer_phone,
        packageType: payload.package,
        selectedNumbers: payload.numbers,
        paymentTarget: payload.payment_target || 'finote'
      });
      await beginSellerPaymentAccountSelection(telegramId, purchase);
      return;
    }

    const purchase = db.reservePurchase({
      telegramId,
      packageType: payload.package,
      selectedNumbers: payload.numbers
    });
    await beginDirectPaymentAccountSelection(telegramId, purchase);
  } catch (error) {
    await bot.sendMessage(telegramId, tr(telegramId, `⚠️ ${error.message}\n\nክፍያ አልተጠየቀም። እንደገና ይምረጡ።`, `⚠️ ${error.message}\n\nNo payment was requested. Please choose again.`));
    await sendMainMenu(telegramId);
  }
}

function paymentAccountButtonLabel(account) {
  const provider = String(account.provider || '').trim();
  const raw = String(account.account_number || '').replace(/\s+/g, '');
  const suffix = raw.length > 4 ? raw.slice(-4) : raw;
  return `${provider}${suffix ? ` · ••••${suffix}` : ''}`.slice(0, 55);
}

async function beginDirectPaymentAccountSelection(chatId, purchase) {
  const accounts = db.listPaymentAccounts({ activeOnly: true });
  if (!accounts.length) {
    db.cancelPurchase(purchase.id, chatId, 'FinoteBirhan payment account not configured');
    await bot.sendMessage(chatId, tr(chatId,
      'የክፍያ አካውንት ለጊዜው አልተዘጋጀም። ቁጥርዎ ተለቋል፤ ክፍያ አልተጠየቀም።',
      'Payment setup is temporarily unavailable. Your numbers were released; you were not charged.'));
    return notifyAdmins(`⚠️ Direct sale blocked because no active FinoteBirhan transfer account is configured. Purchase ${purchase.id}.`);
  }
  if (accounts.length === 1) {
    const assigned = db.assignPaymentAccountToPurchase(purchase.id, accounts[0].id, chatId);
    return sendPaymentInstructions(chatId, assigned);
  }
  await bot.sendMessage(chatId, tr(chatId,
    '🏦 ክፍያዎን የሚልኩበትን አካውንት ይምረጡ።',
    '🏦 Choose the transfer account you want to pay.'), {
    reply_markup: inlineKeyboard(accounts.map((account) => [{
      text: `${account.is_default ? '★ ' : ''}${paymentAccountButtonLabel(account)}`,
      callback_data: `payacct:${purchase.id}:${account.id}`
    }]))
  });
}

async function beginSellerPaymentAccountSelection(sellerTelegramId, purchase) {
  if (purchase.payment_target === 'seller') return sendSellerSaleCheckout(sellerTelegramId, purchase);
  const accounts = db.listPaymentAccounts({ activeOnly: true });
  if (!accounts.length) {
    db.cancelPurchase(purchase.id, sellerTelegramId, 'FinoteBirhan payment account not configured');
    return bot.sendMessage(sellerTelegramId, tr(sellerTelegramId,
      '⚠️ የፍኖተ ብርሃን የክፍያ አካውንት አልተዘጋጀም። የተያዘው ቁጥር ተለቋል።',
      '⚠️ No active FinoteBirhan transfer account is configured. The reserved number was released.'));
  }
  if (accounts.length === 1) {
    const assigned = db.assignPaymentAccountToPurchase(purchase.id, accounts[0].id, sellerTelegramId);
    return sendSellerSaleCheckout(sellerTelegramId, assigned);
  }
  await bot.sendMessage(sellerTelegramId, tr(sellerTelegramId,
    '🏦 ገዢው ወደ የትኛው የፍኖተ ብርሃን አካውንት እንዲከፍል ይምረጡ።',
    '🏦 Choose which FinoteBirhan transfer account the buyer will pay.'), {
    reply_markup: inlineKeyboard(accounts.map((account) => [{
      text: `${account.is_default ? '★ ' : ''}${paymentAccountButtonLabel(account)}`,
      callback_data: `seller_payacct:${purchase.id}:${account.id}`
    }]))
  });
}

async function sendSellerSaleCheckout(sellerTelegramId, purchase) {
  const seller = purchase.seller;
  const am = langOf(sellerTelegramId) !== 'en';
  const numbers = purchase.numbers.map((n) => `${n.pool} ${am ? 'ብር' : 'ETB'}: #${formatNumber(n.number)}`).join(' · ');
  const useSellerAccount = purchase.payment_target === 'seller';
  const provider = purchase.payment_provider || (useSellerAccount ? seller.payment_provider : '');
  const accountName = purchase.payment_account_name || (useSellerAccount ? seller.account_name : '');
  const accountNumber = purchase.payment_account_number || (useSellerAccount ? seller.account_number : '');
  if (!provider || !accountName || !accountNumber) {
    db.cancelPurchase(purchase.id, sellerTelegramId, 'Selected payment account is not configured');
    return bot.sendMessage(sellerTelegramId, am ? '⚠️ የተመረጠው የክፍያ አካውንት አልተዘጋጀም። ቁጥሩ እንደገና ነፃ ሆኗል።' : '⚠️ The selected payment account is not configured. The ticket number was released.');
  }
  const linked = purchase.linked_telegram_id
    ? (am ? `
✅ ገዢው ቦቱን ተመዝግቧል፤ “ተሽጧል” ሲጫኑ ትኬቱ በቀጥታ ይላካል።` : `
✅ Buyer already has the bot — the ticket will be delivered automatically after you mark it sold.`)
    : (am ? `
ℹ️ ገዢው ገና ከቦቱ ጋር አልተገናኘም። በዚሁ ስም ወይም ስልክ ሲመዘገብ ትኬቱ በራሱ ይገናኛል።` : `
ℹ️ Buyer is not linked yet. If they register later with the same phone or full name, the ticket will attach automatically.`);
  await bot.sendMessage(sellerTelegramId, am
    ? `🧾 አዲስ የትኬት ሽያጭ

👤 ገዢ: ${purchase.buyer_name}
📱 ${purchase.buyer_phone}
🎟 ${packageLabel(purchase.package_type)}
${numbers}
💰 ${purchase.amount_etb} ብር

🏦 ክፍያ ወደ: ${useSellerAccount ? 'የእርስዎ አካውንት' : 'ፍኖተ ብርሃን'}
${provider}
${accountName}
${accountNumber}${linked}

ገንዘቡ ከገባ በኋላ ብቻ “✅ ተሽጧል” ይጫኑ።`
    : `🧾 NEW TICKET SALE

Buyer: ${purchase.buyer_name}
Phone: ${purchase.buyer_phone}
Ticket: ${packageLabel(purchase.package_type)}
${numbers}
Amount: ${purchase.amount_etb} ETB

Payment to: ${useSellerAccount ? 'YOUR ACCOUNT' : 'FINOTE BIRHAN'}
${provider}
${accountName}
${accountNumber}${linked}

Only tap SOLD after the buyer has paid.`,
    { reply_markup: inlineKeyboard([[{ text: am ? '✅ ተሽጧል' : '✅ SOLD', callback_data: `seller_ok:${purchase.id}` }, { text: am ? '❌ ሽያጩን ሰርዝ' : '❌ Cancel sale', callback_data: `seller_no:${purchase.id}` }]]) }
  );
}

async function sendPaymentInstructions(chatId, purchase) {
  const am = langOf(chatId) !== 'en';
  const numbers = purchase.numbers.map((n) => `${n.pool} ${am ? 'ብር' : 'ETB'}: #${formatNumber(n.number)}`).join('\n');
  let provider = purchase.payment_provider || '';
  let accountName = purchase.payment_account_name || '';
  let accountNumber = purchase.payment_account_number || '';
  let sellerName = '';
  if (purchase.source === 'seller') sellerName = purchase.seller?.display_name || '';
  if (!provider || !accountName || !accountNumber) {
    const fallback = purchase.payment_target === 'seller' ? purchase.seller : db.getDefaultPaymentAccount();
    provider ||= fallback?.payment_provider || fallback?.provider || '';
    accountName ||= fallback?.account_name || '';
    accountNumber ||= fallback?.account_number || '';
  }
  if (!provider || !accountName || !accountNumber) {
    db.cancelPurchase(purchase.id, null, 'Selected payment account is not configured');
    await bot.sendMessage(chatId, am ? 'የክፍያ አካውንት ለጊዜው አልተዘጋጀም። ቁጥርዎ ተለቋል፤ ክፍያ አልተጠየቀም።' : 'Payment setup is temporarily unavailable. Your numbers were released; you were not charged.');
    return notifyAdmins(`⚠️ Sale blocked because the selected transfer account is not configured. Purchase ${purchase.id}.`);
  }
  const reviewText = purchase.source === 'seller'
    ? (am ? `ማስረጃውን ከላኩ በኋላ ${sellerName} ክፍያውን ያረጋግጣል።` : `After you send proof, ${sellerName} will confirm the payment.`)
    : verifier.enabled
      ? (am ? 'የግብይት ሊንክ/ማጣቀሻ ሲልኩ Verify.et በራሱ ያረጋግጣል።' : 'After you send the transaction reference, the payment will be verified automatically when supported.')
      : (am ? 'ማስረጃ ከላኩ በኋላ አስተዳዳሪ ያረጋግጣል።' : 'After you send proof, an administrator will review the payment.');
  db.setUserState(chatId, 'awaiting_payment', { purchaseId: purchase.id });
  await bot.sendMessage(chatId, am
    ? `✅ ቁጥርዎ ${config.reservationMinutes} ደቂቃ ተይዟል።

🎟 ${packageLabel(purchase.package_type)}
${numbers}

💰 መጠን: ${purchase.amount_etb} ብር
🏦 ክፍያ: ${provider}
👤 የአካውንት ስም: ${accountName}
🔢 አካውንት: ${accountNumber}

በትክክል ${purchase.amount_etb} ብር ያስተላልፉ፣ ከዚያ የግብይት ሊንክ/ማጣቀሻ ወይም የደረሰኝ ምስል ይላኩ።

${reviewText}`
    : `✅ Your number${purchase.numbers.length > 1 ? 's are' : ' is'} reserved for ${config.reservationMinutes} minutes.

🎟 ${packageLabel(purchase.package_type)}
${numbers}

💰 Amount: ${purchase.amount_etb} ETB
🏦 Payment: ${provider}
👤 Account name: ${accountName}
🔢 Account: ${accountNumber}

Transfer exactly ${purchase.amount_etb} ETB, then send the transaction reference/link or a receipt image here.

${reviewText}`,
    { reply_markup: inlineKeyboard([[{ text: am ? '❌ ክፍያውን ሰርዝ እና ቁጥሩን ልቀቅ' : '❌ Cancel payment & release number', callback_data: `cancel_pay:${purchase.id}` }]]) }
  );
}

async function handleStateMessage(message, state) {
  const telegramId = message.from.id;
  if (state.state === 'awaiting_payment') {
    const purchase = db.getPurchase(state.data.purchaseId);
    if (!purchase) { db.clearUserState(telegramId); return false; }
    return handlePaymentProof(message, purchase).then(() => true);
  }
  if (state.state.startsWith('seller_account_')) {
    await handleSellerAccountState(message, state);
    return true;
  }
  if (state.state.startsWith('admin_payment_account_')) {
    await handleAdminPaymentAccountState(message, state);
    return true;
  }
  if (state.state === 'admin_add_seller_id') {
    if (!db.isAdmin(telegramId)) { db.clearUserState(telegramId); return true; }
    const sellerTelegramId = Number(String(message.text || '').trim());
    if (!Number.isSafeInteger(sellerTelegramId) || sellerTelegramId <= 0) {
      await bot.sendMessage(telegramId, 'Send the seller Telegram numeric ID only. Example: 123456789');
      return true;
    }
    const result = db.activateSellerRole(sellerTelegramId, telegramId);
    db.clearUserState(telegramId);
    if (result.seller) {
      await bot.sendMessage(telegramId, `✅ Ticket Seller activated: #${result.seller.id} ${result.seller.display_name}.`);
      await safeSend(sellerTelegramId, `✅ Ticket Seller access is active.

Open /start. You will now see 🧾 Sell Tickets and 📈 Seller Stats. You can optionally add your own payment account from 💳 Seller Account.`);
    } else {
      await bot.sendMessage(telegramId, `✅ Telegram ID ${sellerTelegramId} added as a Ticket Seller. They must finish normal bot registration first; access will activate automatically.`);
      await safeSend(sellerTelegramId, `✅ You were added as a FinoteBirhan Ticket Seller.

Open /start and complete your normal name + phone registration. Seller access will activate automatically.`);
    }
    return showPendingSellers(telegramId);
  }
  return false;
}

async function handlePaymentProof(message, purchase) {
  const telegramId = message.from.id;
  if (purchase.buyer_telegram_id !== telegramId) return;
  const text = String(message.text || message.caption || '').trim();
  const photo = message.photo?.at(-1)?.file_id || null;
  const document = message.document?.file_id || null;
  const fileId = photo || document;
  const reference = text && !text.startsWith('/') ? text.slice(0, 300) : null;
  if (!reference && !fileId) {
    await bot.sendMessage(telegramId, tr(telegramId, 'የግብይት ሊንክ/ማጣቀሻ ይላኩ ወይም የደረሰኝ ምስል ያስገቡ።', 'Send the transaction reference/link or upload a receipt image.'));
    return;
  }

  let updated;
  try {
    updated = db.submitPaymentProof(purchase.id, {
      provider: purchase.payment_provider || purchase.seller?.payment_provider || db.getDefaultPaymentAccount()?.provider || null,
      reference,
      fileId
    });
  } catch (error) {
    await bot.sendMessage(telegramId, `⚠️ ${error.message}`);
    return;
  }

  db.clearUserState(telegramId);

  if (updated.source === 'seller') {
    await bot.sendMessage(telegramId, tr(telegramId, `⏳ የክፍያ ማስረጃው ለ${updated.seller.display_name} ተልኳል። ክፍያውን ሲያረጋግጥ ትኬትዎ ይወጣል።`, `⏳ Payment proof sent to ${updated.seller.display_name}. Your ticket will be issued after the seller confirms receiving the payment.`));
    await notifySellerReview(updated, message);
    return sendMainMenu(telegramId);
  }

  if (!reference) {
    db.markManualReview(updated.id, 'Screenshot/receipt image has no transaction link or reference for Verify.et.');
    await bot.sendMessage(telegramId, tr(telegramId, '⏳ የደረሰኝ ምስል ደርሷል። Verify.et ምስሉን ብቻ ማረጋገጥ አይችልም፤ የግብይት ሊንክ/ማጣቀሻ ያስፈልገዋል። አስተዳዳሪው ካስፈለገ እዚህ ይጠይቅዎታል።', '⏳ Receipt image received. Verify.et needs a transaction link/reference rather than the image itself. An administrator can request that detail from you here.'));
    await notifyAdminsOfReview(db.getPurchase(updated.id), message);
    return sendMainMenu(telegramId);
  }

  await bot.sendMessage(telegramId, tr(telegramId, '🔎 ክፍያዎን በማረጋገጥ ላይ…', '🔎 Verifying your payment…'));
  await verifyDirectPayment(updated, telegramId, message);
  await sendMainMenu(telegramId);
}

async function verifyDirectPayment(purchase, telegramId, proofMessage) {
  let result;
  try {
    const fallback = db.getDefaultPaymentAccount();
    result = await verifier.verify({
      provider: purchase.payment_provider || fallback?.provider || '',
      reference: purchase.payment_reference,
      accountNumber: purchase.payment_account_number || fallback?.account_number || '',
      expectedAmount: purchase.amount_etb,
      expectedAccountName: purchase.payment_account_name || fallback?.account_name || ''
    });
  } catch (error) {
    const reason = `Verify.et request failed: ${error?.message || String(error)}`;
    const review = db.markManualReview(purchase.id, reason);
    await bot.sendMessage(telegramId, tr(telegramId, '⏳ ራስ-ሰር ማረጋገጫው ለጊዜው አልተሳካም። አስተዳዳሪ ይመለከተዋል፤ ቁጥርዎ እስከዚያ ድረስ ተይዞ ይቆያል።', '⏳ Automatic verification is temporarily unavailable. An administrator will review your payment. Your number stays reserved during review.'));
    await notifyAdminsOfReview(review, proofMessage);
    return;
  }

  if (result.requestId) db.setVerificationPending(purchase.id, result.requestId, result.payload || result);

  if (result.outcome === 'approved') {
    db.confirmPurchase(purchase.id, null, { verificationPayload: result.payload, note: result.reason });
    await bot.sendMessage(telegramId, tr(telegramId, '✅ ክፍያዎ ተረጋግጧል። ዲጂታል ትኬትዎ ዝግጁ ነው።', '✅ Payment verified. Your digital ticket is ready.'));
    await sendIssuedTickets(telegramId, purchase.id);
    return;
  }

  if (result.outcome === 'rejected') {
    db.rejectPurchase(purchase.id, null, result.reason);
    await bot.sendMessage(telegramId, tr(telegramId, `❌ ክፍያው ሊረጋገጥ አልቻለም: ${result.reason}\n\nየተያዘው ቁጥር ተለቋል።`, `❌ Payment could not be approved: ${result.reason}\n\nThe reserved number has been released.`));
    return;
  }

  const review = db.markManualReview(purchase.id, result.reason, result.payload);
  await bot.sendMessage(telegramId, tr(telegramId, `⏳ ${result.reason}\nአስተዳዳሪ ይመለከተዋል። ቁጥርዎ እስከዚያ ተይዞ ይቆያል።`, `⏳ ${result.reason}\nAn administrator will review it. Your number remains reserved during review.`));
  await notifyAdminsOfReview(review, proofMessage);
}

async function notifySellerReview(purchase, proofMessage) {
  const seller = purchase.seller;
  const numbers = purchase.numbers.map((n) => `${n.pool}: #${formatNumber(n.number)}`).join(' · ');
  const referenceLine = purchase.payment_reference ? `\nReference: ${truncate(purchase.payment_reference, 100)}` : '';
  await bot.sendMessage(seller.telegram_id,
    `💳 Payment confirmation needed\n\nBuyer: ${purchase.buyer_name}\nPhone: ${purchase.buyer_phone}\nTicket: ${packageLabel(purchase.package_type)}\nNumbers: ${numbers}\nAmount: ${purchase.amount_etb} ETB${referenceLine}\n\nConfirm only after you see the money in your account.`,
    { reply_markup: inlineKeyboard([[
      { text: '✅ Payment received', callback_data: `seller_ok:${purchase.id}` },
      { text: '❌ Not received', callback_data: `seller_no:${purchase.id}` }
    ]]) }
  );
  if (proofMessage.photo?.length || proofMessage.document) {
    try { await bot.copyMessage(seller.telegram_id, proofMessage.chat.id, proofMessage.message_id); } catch {}
  }
}

async function notifyAdminsOfReview(purchase, proofMessage = null) {
  const numbers = purchase.numbers.map((n) => `${n.pool}: #${formatNumber(n.number)}`).join(' · ');
  const hasReference = Boolean(purchase.payment_reference);
  const buttons = hasReference
    ? [[
        { text: '✅ Approve manually', callback_data: `admin_pay_ok:${purchase.id}` },
        { text: '🔗 Ask link/reference', callback_data: `admin_pay_askref:${purchase.id}` }
      ], [
        { text: '❌ Reject', callback_data: `admin_pay_no:${purchase.id}` }
      ]]
    : [[
        { text: '🔗 Ask transaction link', callback_data: `admin_pay_askref:${purchase.id}` },
        { text: '❌ Reject', callback_data: `admin_pay_no:${purchase.id}` }
      ]];

  for (const adminId of db.listAdmins()) {
    await safeSend(adminId,
      `🧾 Payment needs admin action\n\nBuyer: ${purchase.buyer_name}\nPhone: ${purchase.buyer_phone}\nAmount: ${purchase.amount_etb} ETB\nNumbers: ${numbers}\nTransfer account: ${purchase.payment_provider || 'legacy/unknown'}${purchase.payment_account_name ? ` · ${purchase.payment_account_name}` : ''}${purchase.payment_account_number ? ` · ${purchase.payment_account_number}` : ''}\nReference: ${purchase.payment_reference || 'screenshot only'}\nReason: ${purchase.note || 'Verify.et could not process this automatically'}`,
      { reply_markup: inlineKeyboard(buttons) }
    );
    if (proofMessage && (proofMessage.photo?.length || proofMessage.document)) {
      try { await bot.copyMessage(adminId, proofMessage.chat.id, proofMessage.message_id); } catch {}
    }
  }
}

async function sendIssuedTickets(chatId, purchaseId) {
  const purchase = db.getPurchase(purchaseId);
  const tickets = db.ticketsForPurchase(purchaseId);
  const drawAt = db.getSetting('draw_at');
  const sellerName = purchase?.seller?.display_name || '';
  const am = langOf(chatId) !== 'en';
  for (const ticket of tickets) {
    const png = generateTicketPng(ticket, { drawAt, sellerName });
    const prize = prizeSetting(ticket.pool, am ? 'am' : 'en');
    const dateLine = drawAt
      ? (am ? `📅 ዕጣ: ${formatDrawDate(drawAt)}` : `Draw: ${formatDrawDate(drawAt)}`)
      : (am ? '📅 የዕጣ ቀን: በቅርቡ' : 'Draw date: To be announced');
    const caption = am
      ? `🎟 የፍኖተ ብርሃን ዲጂታል ትኬት
${ticket.pool} ብር · #${formatNumber(ticket.number)}
🏆 ሽልማት: ${prize}
👤 ${ticket.owner_name}
🆔 ${ticket.id}
${dateLine}`
      : `🎟 FinoteBirhan Digital Ticket
${ticket.pool} ETB Draw · #${formatNumber(ticket.number)}
🏆 Prize: ${prize}
Name: ${ticket.owner_name}
Ticket ID: ${ticket.id}
${dateLine}`;
    await bot.sendPhoto(chatId, png, `${ticket.id}.png`, caption);
  }
}

async function showMyTickets(chatId) {
  const tickets = db.ticketsForUser(chatId);
  const am = langOf(chatId) !== 'en';
  if (!tickets.length) {
    await bot.sendMessage(chatId, am ? 'እስካሁን የተከፈለ ትኬት የለዎትም።' : 'You do not have any paid tickets yet.');
    return sendMainMenu(chatId);
  }
  const drawAt = db.getSetting('draw_at');
  const drawLine = drawAt ? `
${am ? '📅 ዕጣ' : 'Draw'}: ${formatDrawDate(drawAt)}` : '';
  await bot.sendMessage(chatId, am
    ? `🎫 የእኔ ትኬቶች (${tickets.length})

የእያንዳንዱ ትኬት ምስል ከታች ተልኳል።${drawLine}`
    : `🎫 Your tickets (${tickets.length})

Each digital ticket image is sent below.${drawLine}`);
  const purchases = [...new Set(tickets.map((t) => t.purchase_id))];
  for (const purchaseId of purchases) await sendIssuedTickets(chatId, purchaseId);
  await sendMainMenu(chatId);
}

async function showResults(chatId) {
  const winners = db.getWinners({ publishedOnly: true });
  const am = langOf(chatId) !== 'en';
  if (!winners.length) {
    await bot.sendMessage(chatId, am ? '🏆 አሸናፊዎች ገና አልታተሙም።' : '🏆 Winners have not been published yet.');
    return sendMainMenu(chatId);
  }
  const lines = winners.map((w) => am
    ? `🏆 ${w.pool} ብር — ${prizeSetting(w.pool,'am')}
#${formatNumber(w.ticket_number)} · ${firstName(w.winner_name)} · ${maskPhone(w.winner_phone)}`
    : `🏆 ${w.pool} ETB — ${prizeSetting(w.pool,'en')}
#${formatNumber(w.ticket_number)} · ${firstName(w.winner_name)} · ${maskPhone(w.winner_phone)}`);
  await bot.sendMessage(chatId, `${am ? '🏆 የፍኖተ ብርሃን አሸናፊዎች' : '🏆 FinoteBirhan Winners'}

${lines.join('\n\n')}`);
  await sendMainMenu(chatId);
}

async function startSellerAccountSetup(telegramId) {
  const seller = db.getSellerByTelegram(telegramId);
  if (!seller || seller.status !== 'approved') return bot.sendMessage(telegramId, 'Ticket Seller access is not active.');
  db.setUserState(telegramId, 'seller_account_provider', {});
  await bot.sendMessage(telegramId,
    `💳 Seller payment account

This is optional. Buyers can always pay the main FinoteBirhan account.

Send your payment provider (for example CBE or Telebirr).`,
    { reply_markup: removeKeyboard() }
  );
}

async function handleSellerAccountState(message, state) {
  const telegramId = message.from.id;
  const seller = db.getSellerByTelegram(telegramId);
  if (!seller || seller.status !== 'approved') {
    db.clearUserState(telegramId);
    await bot.sendMessage(telegramId, 'Ticket Seller access is not active.');
    return;
  }
  const text = String(message.text || '').trim();
  const data = state.data || {};
  if (state.state === 'seller_account_provider') {
    if (text.length < 2 || text.length > 30) return bot.sendMessage(telegramId, 'Send a valid provider name, for example CBE or Telebirr.');
    data.paymentProvider = text;
    db.setUserState(telegramId, 'seller_account_name', data);
    return bot.sendMessage(telegramId, 'Send the account holder name.');
  }
  if (state.state === 'seller_account_name') {
    if (text.length < 2 || text.length > 80) return bot.sendMessage(telegramId, 'Send a valid account holder name.');
    data.accountName = text;
    db.setUserState(telegramId, 'seller_account_number', data);
    return bot.sendMessage(telegramId, 'Send the account number or wallet phone number.');
  }
  if (state.state === 'seller_account_number') {
    if (text.length < 4 || text.length > 40) return bot.sendMessage(telegramId, 'Send a valid account number.');
    const updated = db.updateSellerAccount(telegramId, {
      paymentProvider: data.paymentProvider,
      accountName: data.accountName,
      accountNumber: text
    });
    db.clearUserState(telegramId);
    await bot.sendMessage(telegramId, `✅ Seller payment account saved.

${updated.payment_provider}
${updated.account_name}
${updated.account_number}`);
    return sendMainMenu(telegramId);
  }
}

async function showSellerPanel(telegramId) {
  const seller = db.getSellerByTelegram(telegramId);
  const am = langOf(telegramId) !== 'en';
  if (!seller || seller.status !== 'approved') return bot.sendMessage(telegramId, am ? 'የትኬት ሻጭ ፈቃድ በአስተዳዳሪ ብቻ ይሰጣል።' : 'Ticket Seller access is assigned by an administrator.');
  const stats = db.sellerStats(seller.id);
  const recent = db.recentSellerSales(seller.id, 6);
  const account = db.sellerHasPaymentAccount(seller.id)
    ? `${seller.payment_provider}
${seller.account_name}
${seller.account_number}`
    : (am ? 'አልተዘጋጀም — ገዢዎች ወደ ፍኖተ ብርሃን አካውንት መክፈል ይችላሉ።' : 'Not set — buyers can still pay the FinoteBirhan account.');
  const recentText = recent.length
    ? recent.map((r) => `• ${r.buyer_name} · ${r.amount_etb} ${am ? 'ብር' : 'ETB'} · ${r.numbers || '-'} · ${String(r.status).toUpperCase()}`).join('\n')
    : (am ? 'እስካሁን ሽያጭ የለም።' : 'No sales yet.');
  await bot.sendMessage(telegramId, am
    ? `📈 የትኬት ሻጭ · #${seller.id}

${seller.display_name}
${seller.phone}

👥 ገዢዎች: ${stats.customers}
✅ የተከፈሉ ሽያጮች: ${stats.paidCount}
🎟 የወጡ ትኬቶች: ${stats.tickets}
💰 ጠቅላላ ሽያጭ: ${stats.revenue} ብር
⏳ በመጠባበቅ ላይ: ${stats.pending}

💳 የእርስዎ የክፍያ አካውንት
${account}

🧾 የቅርብ ሽያጮች
${recentText}`
    : `📈 Ticket Seller · #${seller.id}

${seller.display_name}
${seller.phone}

Buyers: ${stats.customers}
Sales: ${stats.paidCount}
Tickets issued: ${stats.tickets}
Collected: ${stats.revenue} ETB
Pending: ${stats.pending}

Your payment account
${account}

Recent sales
${recentText}`,
    { reply_markup: inlineKeyboard([[{ text: am ? '💳 የክፍያ አካውንት ቀይር' : '💳 Update payment account', callback_data: 'seller_account' }],[{ text: am ? '🔄 አድስ' : '🔄 Refresh', callback_data: 'seller_panel' }]]) }
  );
  await sendMainMenu(telegramId);
}

async function handleCallback(query) {
  const telegramId = query.from.id;
  const data = String(query.data || '');
  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === 'lang:am' || data === 'lang:en') {
    const language = db.setUserLanguage(telegramId, data.endsWith(':en') ? 'en' : 'am');
    const user = db.getUser(telegramId);
    const state = db.getUserState(telegramId);
    await bot.sendMessage(telegramId, language === 'en' ? '✅ Language changed to English.' : '✅ ቋንቋው ወደ አማርኛ ተቀይሯል።');
    if (!user?.full_name || state?.state === 'register_name') {
      db.setUserState(telegramId, 'register_name');
      await bot.sendMessage(telegramId, language === 'en' ? 'Please send your full name.' : 'እባክዎ ሙሉ ስምዎን ይላኩ።');
      return;
    }
    if (!user.phone || state?.state === 'register_phone') return askForPhone(telegramId);
    return sendMainMenu(telegramId);
  }

  if (data === 'seller_panel') return showSellerPanel(telegramId);
  if (data === 'seller_account') return startSellerAccountSetup(telegramId);

  if (data.startsWith('payacct:')) {
    const [, purchaseId, accountIdRaw] = data.split(':');
    const purchase = db.getPurchase(purchaseId);
    if (!purchase || purchase.source !== 'direct' || purchase.buyer_telegram_id !== telegramId) {
      return bot.answerCallbackQuery(query.id, 'Not allowed.', true).catch(() => {});
    }
    try {
      const assigned = db.assignPaymentAccountToPurchase(purchaseId, Number(accountIdRaw), telegramId);
      return sendPaymentInstructions(telegramId, assigned);
    } catch (error) {
      return bot.sendMessage(telegramId, `⚠️ ${error.message}`);
    }
  }

  if (data.startsWith('seller_payacct:')) {
    const [, purchaseId, accountIdRaw] = data.split(':');
    const seller = db.getSellerByTelegram(telegramId);
    const purchase = db.getPurchase(purchaseId);
    if (!seller || seller.status !== 'approved' || !purchase || purchase.seller_id !== seller.id || purchase.payment_target !== 'finote') {
      return bot.answerCallbackQuery(query.id, 'Not allowed.', true).catch(() => {});
    }
    try {
      const assigned = db.assignPaymentAccountToPurchase(purchaseId, Number(accountIdRaw), telegramId);
      return sendSellerSaleCheckout(telegramId, assigned);
    } catch (error) {
      return bot.sendMessage(telegramId, `⚠️ ${error.message}`);
    }
  }

  if (data.startsWith('cancel_pay:')) {
    const purchaseId = data.split(':')[1];
    const purchase = db.getPurchase(purchaseId);
    if (!purchase || purchase.buyer_telegram_id !== telegramId) {
      return bot.answerCallbackQuery(query.id, 'Not allowed.', true).catch(() => {});
    }
    const cancelled = db.cancelPurchase(purchaseId, telegramId, 'Cancelled by buyer');
    db.clearUserState(telegramId);
    await bot.sendMessage(telegramId, cancelled?.status === 'cancelled'
      ? tr(telegramId, '❌ ክፍያው ተሰርዟል። የተያዘው ቁጥር ተለቋል እና እንደገና ይገኛል።', '❌ Payment cancelled. Your reserved number has been released and is available again.')
      : tr(telegramId, 'ይህን ክፍያ ከእንግዲህ መሰረዝ አይቻልም።', 'This payment can no longer be cancelled.'));
    return sendMainMenu(telegramId);
  }

  if (data.startsWith('seller_ok:') || data.startsWith('seller_no:')) {
    const purchaseId = data.split(':')[1];
    const seller = db.getSellerByTelegram(telegramId);
    const purchase = db.getPurchase(purchaseId);
    if (!seller || seller.status !== 'approved' || !purchase || purchase.seller_id !== seller.id) {
      return bot.answerCallbackQuery(query.id, 'Not allowed.', true).catch(() => {});
    }
    if (data.startsWith('seller_ok:')) {
      try {
        const paid = db.confirmPurchase(purchaseId, telegramId, { note: `Marked SOLD by ticket seller ${seller.display_name}` });
        await bot.sendMessage(telegramId, tr(telegramId, `✅ ተሽጧል — ${paid.buyer_name}\n${paid.buyer_phone}\n\nዲጂታል ትኬቱ ከታች ነው። ለገዢው ማስተላለፍ ይችላሉ።`, `✅ SOLD — ${paid.buyer_name}\n${paid.buyer_phone}\n\nThe digital ticket is below. You can forward it to the buyer.`));
        await sendIssuedTickets(telegramId, purchaseId);
        if (paid.linked_telegram_id && paid.linked_telegram_id !== telegramId) {
          await safeSend(paid.linked_telegram_id, `✅ Your FinoteBirhan ticket bought through ${seller.display_name} has been confirmed and linked to your account.`);
          await sendIssuedTickets(paid.linked_telegram_id, purchaseId);
        }
      } catch (error) {
        await bot.sendMessage(telegramId, `⚠️ ${error.message}`);
      }
    } else {
      db.cancelPurchase(purchaseId, telegramId, `Cancelled by ticket seller ${seller.display_name}`);
      await bot.sendMessage(telegramId, tr(telegramId, '❌ ሽያጩ ተሰርዟል። የተያዘው ቁጥር እንደገና ይገኛል።', '❌ Sale cancelled. The reserved number is available again.'));
      if (purchase.linked_telegram_id && purchase.linked_telegram_id !== telegramId) {
        await safeSend(purchase.linked_telegram_id, '❌ A pending ticket sale was cancelled before payment confirmation. No ticket was issued.');
      }
    }
    return;
  }

  if (data.startsWith('admin_')) {
    if (!db.isAdmin(telegramId)) return bot.answerCallbackQuery(query.id, 'Admin only.', true).catch(() => {});

    if (data === 'admin_dashboard') return showAdminDashboard(telegramId);
    if (data === 'admin_payment_accounts') return showPaymentAccounts(telegramId);
    if (data === 'admin_payment_add') return startAdminPaymentAccountAdd(telegramId);
    if (data.startsWith('admin_payment_edit:')) return startAdminPaymentAccountEdit(telegramId, Number(data.split(':')[1]));
    if (data.startsWith('admin_payment_default:')) {
      try { db.setDefaultPaymentAccount(Number(data.split(':')[1]), telegramId); }
      catch (error) { await bot.sendMessage(telegramId, `⚠️ ${error.message}`); }
      return showPaymentAccounts(telegramId);
    }
    if (data.startsWith('admin_payment_toggle:')) {
      const id = Number(data.split(':')[1]);
      const account = db.getPaymentAccount(id);
      if (!account) await bot.sendMessage(telegramId, 'Transfer account not found.');
      else {
        try { db.setPaymentAccountActive(id, !account.is_active, telegramId); }
        catch (error) { await bot.sendMessage(telegramId, `⚠️ ${error.message}`); }
      }
      return showPaymentAccounts(telegramId);
    }
    if (data.startsWith('admin_payment_delete_confirm:')) {
      const id = Number(data.split(':')[1]);
      const account = db.getPaymentAccount(id);
      if (!account) return bot.sendMessage(telegramId, 'Transfer account not found.');
      return bot.sendMessage(telegramId, `Delete this transfer account?\n\n${account.provider}\n${account.account_name}\n${account.account_number}\n\nHistorical purchases keep their saved payment details.`, {
        reply_markup: inlineKeyboard([[{ text: '🗑 Delete', callback_data: `admin_payment_delete_yes:${id}` }, { text: 'Cancel', callback_data: 'admin_payment_accounts' }]])
      });
    }
    if (data.startsWith('admin_payment_delete_yes:')) {
      try { db.deletePaymentAccount(Number(data.split(':')[1]), telegramId); }
      catch (error) { await bot.sendMessage(telegramId, `⚠️ ${error.message}`); }
      return showPaymentAccounts(telegramId);
    }
    if (data === 'admin_sellers') return showPendingSellers(telegramId);
    if (data === 'admin_seller_add') {
      db.setUserState(telegramId, 'admin_add_seller_id', {});
      await bot.sendMessage(telegramId, `➕ Add Ticket Seller\n\nSend their Telegram numeric ID. If they are already registered, Sell Tickets appears immediately. If not, it activates automatically after their normal name + phone registration.`);
      return;
    }
    if (data === 'admin_payments') return showPendingPayments(telegramId);
    if (data === 'admin_pools') return showPoolStatus(telegramId);
    if (data === 'admin_draw') return showDrawControls(telegramId);
    if (data === 'admin_export') return adminExport(telegramId);
    if (data === 'admin_help') return showAdminHelp(telegramId);
    if (data === 'admin_forceclear') return beginForceClear(telegramId);
    if (data === 'admin_sales_open') { db.setSetting('sales_open', 'true', telegramId); return showDrawControls(telegramId); }
    if (data === 'admin_sales_close') { db.setSetting('sales_open', 'false', telegramId); return showDrawControls(telegramId); }
    if (data === 'admin_draw_now') return adminDraw(telegramId);
    if (data === 'admin_publish') return adminPublish(telegramId);

    if (data.startsWith('admin_seller_ok:') || data.startsWith('admin_seller_no:')) {
      const sellerId = Number(data.split(':')[1]);
      const status = data.startsWith('admin_seller_ok:') ? 'approved' : 'rejected';
      const seller = db.setSellerStatus(sellerId, status, telegramId);
      if (seller) {
        await bot.sendMessage(telegramId, `${status === 'approved' ? '✅ Approved' : '❌ Rejected'} seller ${seller.display_name}.`);
        await safeSend(seller.telegram_id,
          status === 'approved'
            ? `✅ Your FinoteBirhan Ticket Seller access is approved. Open /start to sell tickets.`
            : 'Your FinoteBirhan seller registration was not approved.'
        );
      }
      return;
    }

    if (data.startsWith('admin_pay_askref:')) {
      const purchaseId = data.split(':')[1];
      const purchase = db.getPurchase(purchaseId);
      if (!purchase) return;
      db.setUserState(purchase.buyer_telegram_id, 'awaiting_payment', { purchaseId });
      await safeSend(purchase.buyer_telegram_id,
        `🔗 Please send the transaction link or transaction/reference number for your ${purchase.amount_etb} ETB payment.\n\nDo not send another screenshot. Once you send the link/reference, Verify.et will check it automatically.`
      );
      await bot.sendMessage(telegramId, `Requested a transaction link/reference from ${purchase.buyer_name}.`);
      return;
    }

    if (data.startsWith('admin_pay_ok:') || data.startsWith('admin_pay_no:')) {
      const purchaseId = data.split(':')[1];
      const purchase = db.getPurchase(purchaseId);
      if (!purchase) return;
      if (data.startsWith('admin_pay_ok:')) {
        try {
          db.confirmPurchase(purchaseId, telegramId, { note: 'Approved manually by admin.' });
          await bot.sendMessage(telegramId, '✅ Payment approved and ticket issued.');
          await safeSend(purchase.buyer_telegram_id, '✅ Your payment was approved. Your digital ticket is ready.');
          await sendIssuedTickets(purchase.buyer_telegram_id, purchaseId);
        } catch (error) {
          await bot.sendMessage(telegramId, `⚠️ ${error.message}`);
        }
      } else {
        db.rejectPurchase(purchaseId, telegramId, 'Rejected by administrator.');
        await bot.sendMessage(telegramId, 'Payment rejected and the number released.');
        await safeSend(purchase.buyer_telegram_id, '❌ Your payment could not be confirmed. The reserved number has been released.');
      }
      return;
    }
  }
}

async function showAdminDashboard(telegramId) {
  const am = langOf(telegramId) !== 'en';
  if (!db.isAdmin(telegramId)) return bot.sendMessage(telegramId, am ? 'የአስተዳዳሪ ፈቃድ ያስፈልጋል።' : 'Admin access required.');
  const s = db.dashboardStats();
  const poolLines = s.pools.map((p) => am ? `${p.pool} ብር: ${p.sold}/200 ተሽጧል · ${p.reserved} ተይዟል` : `${p.pool} ETB: ${p.sold}/200 sold · ${p.reserved} reserved`).join('\n');
  await bot.sendMessage(telegramId, am
    ? `🛠 ፍኖተ ብርሃን አስተዳዳሪ

💰 ገቢ: ${s.revenue} ብር
✅ የተከፈሉ ግዢዎች: ${s.paidCount}
👥 ተጠቃሚዎች: ${s.users}
⏳ ማረጋገጫ የሚጠብቁ: ${s.pending}
🧾 ትኬት ሻጮች: ${s.sellers}

ቀጥታ ሽያጭ: ${s.directRevenue} ብር (${s.directCount})
በሻጭ የተመዘገበ: ${s.sellerRevenue} ብር (${s.sellerCount})

${poolLines}`
    : `🛠 FinoteBirhan Admin

Revenue: ${s.revenue} ETB
Paid purchases: ${s.paidCount}
Customers: ${s.users}
Pending review: ${s.pending}
Ticket sellers: ${s.sellers}

Direct: ${s.directRevenue} ETB (${s.directCount})
Seller-entered sales: ${s.sellerRevenue} ETB (${s.sellerCount})

${poolLines}`,
    { reply_markup: inlineKeyboard([
      [{ text: am ? '📊 ትኬት ቁጥሮች' : '📊 Pools', callback_data: 'admin_pools' }, { text: am ? '🧾 ክፍያዎች' : '🧾 Payments', callback_data: 'admin_payments' }],
      [{ text: am ? '🤝 ሻጮች' : '🤝 Sellers', callback_data: 'admin_sellers' }, { text: am ? '🏆 ዕጣ' : '🏆 Draw', callback_data: 'admin_draw' }],
      [{ text: am ? '💳 የክፍያ አካውንቶች' : '💳 Transfer Accounts', callback_data: 'admin_payment_accounts' }],
      [{ text: am ? '📤 ላክ' : '📤 Export', callback_data: 'admin_export' }, { text: am ? '⚙️ ትዕዛዞች' : '⚙️ Commands', callback_data: 'admin_help' }],
      [{ text: am ? '🗑 ሁሉንም ዳታ አጥፋ' : '🗑 Force Clear Data', callback_data: 'admin_forceclear' }]
    ]) }
  );
}

async function showPaymentAccounts(telegramId) {
  if (!db.isAdmin(telegramId)) return bot.sendMessage(telegramId, 'Admin access required.');
  const am = langOf(telegramId) !== 'en';
  const accounts = db.listPaymentAccounts();
  const activeCount = accounts.filter((account) => account.is_active).length;
  await bot.sendMessage(telegramId,
    am
      ? `💳 የፍኖተ ብርሃን የክፍያ አካውንቶች\n\nጠቅላላ: ${accounts.length} · ንቁ: ${activeCount}\nአዲስ አካውንት ሲጨምሩ ያለው አይተካም።`
      : `💳 FinoteBirhan Transfer Accounts\n\nTotal: ${accounts.length} · Active: ${activeCount}\nAdding another account does not replace the existing ones.`,
    { reply_markup: inlineKeyboard([
      [{ text: am ? '➕ የክፍያ አካውንት ጨምር' : '➕ Add Transfer Account', callback_data: 'admin_payment_add' }],
      [{ text: am ? '🔄 አድስ' : '🔄 Refresh', callback_data: 'admin_payment_accounts' }, { text: am ? '⬅️ ዳሽቦርድ' : '⬅️ Dashboard', callback_data: 'admin_dashboard' }]
    ]) }
  );

  if (!accounts.length) {
    return bot.sendMessage(telegramId, am ? 'ምንም የክፍያ አካውንት አልተዘጋጀም።' : 'No transfer accounts are configured.');
  }

  for (const account of accounts) {
    const status = account.is_active ? (am ? 'ንቁ' : 'ACTIVE') : (am ? 'ዝግ' : 'DISABLED');
    const defaultLine = account.is_default ? (am ? '\n★ ዋና አካውንት' : '\n★ DEFAULT') : '';
    const rows = [];
    if (!account.is_default && account.is_active) rows.push([{ text: am ? '★ ዋና አድርግ' : '★ Set Default', callback_data: `admin_payment_default:${account.id}` }]);
    rows.push([
      { text: account.is_active ? (am ? '⏸ አጥፋ' : '⏸ Disable') : (am ? '▶️ አንቃ' : '▶️ Enable'), callback_data: `admin_payment_toggle:${account.id}` },
      { text: am ? '✏️ ቀይር' : '✏️ Edit', callback_data: `admin_payment_edit:${account.id}` }
    ]);
    rows.push([{ text: am ? '🗑 አጥፋ' : '🗑 Delete', callback_data: `admin_payment_delete_confirm:${account.id}` }]);
    await bot.sendMessage(telegramId,
      `#${account.id} · ${status}${defaultLine}\n\n${account.provider}\n${account.account_name}\n${account.account_number}`,
      { reply_markup: inlineKeyboard(rows) }
    );
  }
}

async function startAdminPaymentAccountAdd(adminId) {
  if (!db.isAdmin(adminId)) return bot.sendMessage(adminId, 'Admin access required.');
  db.setUserState(adminId, 'admin_payment_account_provider', { mode: 'add' });
  await bot.sendMessage(adminId, '➕ Add Transfer Account\n\nSend the payment provider/bank name (for example CBE, Telebirr, M-Pesa).', { reply_markup: removeKeyboard() });
}

async function startAdminPaymentAccountEdit(adminId, accountId) {
  if (!db.isAdmin(adminId)) return bot.sendMessage(adminId, 'Admin access required.');
  const account = db.getPaymentAccount(accountId);
  if (!account) return bot.sendMessage(adminId, 'Transfer account not found.');
  db.setUserState(adminId, 'admin_payment_account_provider', { mode: 'edit', accountId: account.id });
  await bot.sendMessage(adminId, `✏️ Edit Transfer Account #${account.id}\n\nCurrent provider: ${account.provider}\n\nSend the provider/bank name.`, { reply_markup: removeKeyboard() });
}

async function handleAdminPaymentAccountState(message, state) {
  const adminId = message.from.id;
  if (!db.isAdmin(adminId)) {
    db.clearUserState(adminId);
    return bot.sendMessage(adminId, 'Admin access required.');
  }
  const text = String(message.text || '').trim();
  const data = { ...(state.data || {}) };
  if (!['add', 'edit'].includes(data.mode)) {
    db.clearUserState(adminId);
    return bot.sendMessage(adminId, 'Transfer account setup expired. Open Admin → Transfer Accounts again.');
  }

  if (state.state === 'admin_payment_account_provider') {
    if (text.length < 2 || text.length > 30) return bot.sendMessage(adminId, 'Send a valid provider/bank name (2–30 characters).');
    data.paymentProvider = text;
    db.setUserState(adminId, 'admin_payment_account_name', data);
    const current = data.mode === 'edit' ? db.getPaymentAccount(data.accountId) : null;
    return bot.sendMessage(adminId, `Send the account holder name.${current ? `\nCurrent: ${current.account_name}` : ''}`);
  }

  if (state.state === 'admin_payment_account_name') {
    if (text.length < 2 || text.length > 80) return bot.sendMessage(adminId, 'Send a valid account holder name (2–80 characters).');
    data.accountName = text;
    db.setUserState(adminId, 'admin_payment_account_number', data);
    const current = data.mode === 'edit' ? db.getPaymentAccount(data.accountId) : null;
    return bot.sendMessage(adminId, `Send the account number or wallet phone number.${current ? `\nCurrent: ${current.account_number}` : ''}`);
  }

  if (state.state === 'admin_payment_account_number') {
    if (text.length < 4 || text.length > 50) return bot.sendMessage(adminId, 'Send a valid account number (4–50 characters).');
    try {
      const fields = { provider: data.paymentProvider, accountName: data.accountName, accountNumber: text };
      const account = data.mode === 'edit'
        ? db.updatePaymentAccount(data.accountId, fields, adminId)
        : db.addPaymentAccount(fields, adminId);
      db.clearUserState(adminId);
      await bot.sendMessage(adminId,
        `${data.mode === 'edit' ? '✅ Transfer account updated.' : '✅ Transfer account added. Existing accounts were kept.'}\n\n#${account.id} ${account.provider}\n${account.account_name}\n${account.account_number}${account.is_default ? '\n★ Default' : ''}`);
      return showPaymentAccounts(adminId);
    } catch (error) {
      db.clearUserState(adminId);
      await bot.sendMessage(adminId, `⚠️ ${error.message}`);
      return showPaymentAccounts(adminId);
    }
  }
}

async function showPendingSellers(telegramId) {
  const approved = db.approvedSellerStats();
  const invites = db.listSellerInvites();

  await bot.sendMessage(telegramId,
    `🧾 Ticket Sellers

Active: ${approved.length}
Waiting for registration: ${invites.length}`,
    { reply_markup: inlineKeyboard([[{ text: '➕ Add Ticket Seller', callback_data: 'admin_seller_add' }],[{ text: '🔄 Refresh', callback_data: 'admin_sellers' }]]) }
  );

  if (approved.length) {
    const text = approved.map((seller) =>
      `#${seller.id} ${seller.display_name}
` +
      `Telegram: ${seller.telegram_id}
Phone: ${seller.phone}
` +
      `Buyers: ${seller.customers} · Sales: ${seller.paid_count} · Tickets: ${seller.tickets_issued}
` +
      `Collected: ${seller.revenue} ETB · Pending: ${seller.pending_count}`
    ).join('\n');
    await bot.sendMessage(telegramId, `Active Ticket Sellers

${text}`);
  }

  if (invites.length) {
    const text = invites.map((invite) => `• Telegram ${invite.telegram_id} · waiting for /start registration`).join('\n');
    await bot.sendMessage(telegramId, `Waiting for registration

${text}`);
  }
}

async function showPendingPayments(telegramId) {
  const rows = db.pendingReviews();
  if (!rows.length) return bot.sendMessage(telegramId, 'No direct payments are waiting for manual review.');
  for (const purchase of rows) {
    await bot.sendMessage(telegramId,
      `🧾 ${purchase.buyer_name}\n${purchase.amount_etb} ETB\n${purchase.numbers.map(n => `${n.pool}: #${formatNumber(n.number)}`).join(' · ')}\nTransfer account: ${purchase.payment_provider || 'legacy/unknown'}${purchase.payment_account_name ? ` · ${purchase.payment_account_name}` : ''}${purchase.payment_account_number ? ` · ${purchase.payment_account_number}` : ''}\nReference: ${purchase.payment_reference || 'receipt only'}\n${purchase.note || ''}`,
      { reply_markup: inlineKeyboard(purchase.payment_reference ? [[
        { text: '✅ Approve manually', callback_data: `admin_pay_ok:${purchase.id}` },
        { text: '🔗 Ask link/reference', callback_data: `admin_pay_askref:${purchase.id}` }
      ], [
        { text: '❌ Reject', callback_data: `admin_pay_no:${purchase.id}` }
      ]] : [[
        { text: '🔗 Ask transaction link', callback_data: `admin_pay_askref:${purchase.id}` },
        { text: '❌ Reject', callback_data: `admin_pay_no:${purchase.id}` }
      ]]) }
    );
  }
}

async function showPoolStatus(telegramId) {
  const s = db.dashboardStats();
  const lines = s.pools.map((p) => `🎟 ${p.pool} ETB\nSold: ${p.sold}\nReserved: ${p.reserved}\nAvailable: ${p.available}`).join('\n\n');
  await bot.sendMessage(telegramId, lines);
}

async function showDrawControls(telegramId) {
  const salesOpen = db.salesOpen();
  const winners = db.getWinners({ publishedOnly: false });
  const drawAt = db.getSetting('draw_at');
  await bot.sendMessage(telegramId,
    `🏆 Draw Control\n\nSales: ${salesOpen ? 'OPEN' : 'CLOSED'}\nDraw date: ${drawAt ? formatDrawDate(drawAt) : 'Not set'}\nWinners drawn: ${winners.length ? 'YES' : 'NO'}\nPublished: ${db.getSetting('winners_published') === 'true' ? 'YES' : 'NO'}\n\nThe draw only uses paid tickets.`,
    { reply_markup: inlineKeyboard([
      [{ text: salesOpen ? '🔒 Close sales' : '🔓 Open sales', callback_data: salesOpen ? 'admin_sales_close' : 'admin_sales_open' }],
      [{ text: '🎲 Draw winners', callback_data: 'admin_draw_now' }, { text: '📣 Publish', callback_data: 'admin_publish' }],
      [{ text: '⬅️ Dashboard', callback_data: 'admin_dashboard' }]
    ]) }
  );
}

async function showAdminHelp(telegramId) {
  await bot.sendMessage(telegramId,
    `Admin commands\n\n` +
    `/paymentaccounts  — list/manage transfer accounts\n` +
    `/addpayment provider|account holder|account number  — add without replacing existing accounts\n` +
    `/setpayment provider|account holder|account number  — update only the default account\n` +
    `Example: /addpayment telebirr|FinoteBirhan Sunday School|0912345678\n\n` +
    `/setdraw YYYY-MM-DD HH:MM\n` +
    `Time is treated as Ethiopia time (+03:00).\n\n` +
    `/sales open or /sales closed\n` +
    `/broadcast message\n` +
    `/export\n/draw\n/publish\n/addadmin TELEGRAM_ID\n` +
    `/addseller TELEGRAM_ID  — activate Ticket Seller role\n/sellerlist\n/suspendseller SELLER_ID\n/approveseller SELLER_ID\n` +
    `/ticket POOL NUMBER\n/customer NAME_OR_PHONE\n/audit [COUNT]\n/forceclear  — destructive reset with confirmation code`
  );
}

async function beginForceClear(adminId) {
  if (!db.isAdmin(adminId)) return bot.sendMessage(adminId, 'Admin access required.');
  const code = shortCode(6);
  const expiresAt = Date.now() + 5 * 60_000;
  db.setUserState(adminId, 'admin_force_clear_confirm', { code, expiresAt });
  const am = langOf(adminId) !== 'en';
  await bot.sendMessage(adminId, am
    ? `⚠️ የዳታ ሙሉ ማጥፋት\n\nይህ የሚያጠፋው:\n• ሁሉንም ደንበኞች (አስተዳዳሪዎች ይቀራሉ)\n• ሻጮችን\n• ግዢዎችን እና ክፍያ ታሪክን\n• የተሰጡ ትኬቶችን\n• ዕጣ ውጤቶችን/አሸናፊዎችን\n• ሴሽኖችን እና audit log\n\n001–200 ቁጥሮች በሶስቱም ዕጣዎች እንደገና ነፃ ይሆናሉ።\nየክፍያ አካውንት እና prize settings አይጠፉም።\n\nለማረጋገጥ በ5 ደቂቃ ውስጥ ይህን ይላኩ:\n/forceclear ${code}`
    : `⚠️ FORCE CLEAR ALL OPERATIONAL DATA\n\nThis deletes:\n• all customers except administrators\n• all Ticket Sellers\n• purchases and payment history\n• issued tickets\n• draw runs and winners\n• sessions and audit history\n\nAll 001–200 numbers in all three pools become available again. Payment account and prize configuration are preserved.\n\nTo confirm, send this within 5 minutes:\n/forceclear ${code}`);
}

async function adminForceClearCommand(adminId, args) {
  if (!db.isAdmin(adminId)) return bot.sendMessage(adminId, 'Admin access required.');
  const state = db.getUserState(adminId);
  const code = String(args || '').trim().toUpperCase();
  if (!code) return beginForceClear(adminId);
  if (!state || state.state !== 'admin_force_clear_confirm') {
    return bot.sendMessage(adminId, 'No active force-clear confirmation. Send /forceclear to start.');
  }
  const expected = String(state.data?.code || '').toUpperCase();
  const expiresAt = Number(state.data?.expiresAt || 0);
  if (!expected || code !== expected) {
    return bot.sendMessage(adminId, '❌ Confirmation code is incorrect. Nothing was deleted. Send /forceclear for a new code.');
  }
  if (!expiresAt || Date.now() > expiresAt) {
    db.clearUserState(adminId);
    return bot.sendMessage(adminId, '⌛ Confirmation expired. Nothing was deleted. Send /forceclear again.');
  }

  const before = db.forceClearOperationalData(adminId);
  await bot.sendMessage(adminId,
    `✅ FORCE CLEAR COMPLETE\n\nDeleted operational records:\nCustomers: ${before.users}\nSellers: ${before.sellers}\nPurchases: ${before.purchases}\nIssued tickets: ${before.tickets}\nWinners: ${before.winners}\n\nAll 600 ticket-number positions are available again. Admin access, payment settings and prize settings were preserved.`);
  return showAdminDashboard(adminId);
}

async function adminSetPayment(adminId, args) {
  const [provider, accountName, accountNumber] = args.split('|').map((x) => x?.trim());
  if (!provider || !accountName || !accountNumber) {
    return bot.sendMessage(adminId, 'Usage: /setpayment provider|account holder|account number');
  }
  const updated = db.updateDefaultPaymentAccount({ provider, accountName, accountNumber }, adminId);
  await bot.sendMessage(adminId, `✅ Default transfer account updated. Other accounts were kept.\n\n#${updated.id} ${updated.provider}\n${updated.account_name}\n${updated.account_number}`);
}

async function adminAddPayment(adminId, args) {
  const [provider, accountName, accountNumber] = args.split('|').map((x) => x?.trim());
  if (!provider || !accountName || !accountNumber) {
    return bot.sendMessage(adminId, 'Usage: /addpayment provider|account holder|account number');
  }
  try {
    const added = db.addPaymentAccount({ provider, accountName, accountNumber }, adminId);
    await bot.sendMessage(adminId, `✅ Transfer account added without replacing existing accounts.\n\n#${added.id} ${added.provider}\n${added.account_name}\n${added.account_number}${added.is_default ? '\n★ Default' : ''}`);
  } catch (error) {
    await bot.sendMessage(adminId, `⚠️ ${error.message}`);
  }
}

async function adminSetDraw(adminId, args) {
  const match = args.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return bot.sendMessage(adminId, 'Usage: /setdraw YYYY-MM-DD HH:MM');
  const [, y, m, d, hh, mm] = match;
  const iso = `${y}-${m}-${d}T${String(hh).padStart(2,'0')}:${mm}:00+03:00`;
  if (Number.isNaN(new Date(iso).getTime())) return bot.sendMessage(adminId, 'Invalid date/time.');
  db.setSetting('draw_at', iso, adminId);
  await bot.sendMessage(adminId, `✅ Draw date set to ${formatDrawDate(iso)}.`);
}

async function adminSetPrize(adminId, args) {
  const [poolRaw, amRaw, enRaw] = String(args || '').split('|').map((x) => x?.trim());
  const pool = Number(poolRaw);
  if (![50,100,200].includes(pool) || !amRaw || !enRaw) {
    return bot.sendMessage(adminId, 'Usage: /setprize 100|የአማርኛ ሽልማት|English prize');
  }
  db.setSetting(`prize_${pool}_am`, amRaw.slice(0, 80), adminId);
  db.setSetting(`prize_${pool}_en`, enRaw.slice(0, 80), adminId);
  await bot.sendMessage(adminId, `✅ ${pool} ብር prize updated.
AM: ${amRaw}
EN: ${enRaw}`);
}

async function adminSetSales(adminId, args) {
  const value = args.toLowerCase();
  if (!['open','closed','close'].includes(value)) return bot.sendMessage(adminId, 'Usage: /sales open or /sales closed');
  db.setSetting('sales_open', value === 'open' ? 'true' : 'false', adminId);
  await bot.sendMessage(adminId, `Sales are now ${value === 'open' ? 'OPEN' : 'CLOSED'}.`);
}

async function adminBroadcast(adminId, message) {
  if (!message) return bot.sendMessage(adminId, 'Usage: /broadcast your message');
  const ids = db.listUsersForBroadcast();
  let ok = 0, failed = 0;
  for (const id of ids) {
    try { await bot.sendMessage(id, `📣 FinoteBirhan\n\n${message}`); ok += 1; }
    catch { failed += 1; }
    await sleep(35);
  }
  await bot.sendMessage(adminId, `Broadcast complete. Sent: ${ok}. Failed: ${failed}.`);
}

async function adminExport(adminId) {
  const rows = db.exportPurchases();
  const headers = ['id','buyer_name','buyer_phone','package_type','amount_etb','numbers','source','seller_name','seller_code','status','payment_target','payment_account_id','payment_provider','payment_account_name','payment_account_number','payment_reference','created_at','paid_at'];
  const csv = [headers.join(',')].concat(rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))).join('\n');
  await bot.sendDocument(adminId, Buffer.from(csv, 'utf8'), `finotebirhan-sales-${new Date().toISOString().slice(0,10)}.csv`, 'FinoteBirhan ticket sales export');
}

async function adminDraw(adminId) {
  try {
    const result = db.drawWinners(adminId);
    const lines = result.winners.map((w) => `🏆 ${w.pool} ETB · #${formatNumber(w.number)} · ${w.owner_name} · ${w.owner_phone} · ${w.id}`).join('\n');
    const adminWinnerText = `✅ Winners drawn but NOT published.\n\n${lines}\n\nAudit hash:\n${result.snapshotHash}\n\nFull names and phone numbers are shown only to admins and the relevant Ticket Seller.\nUse /publish when ready.`;
    await bot.sendMessage(adminId, adminWinnerText);
    for (const otherAdminId of db.listAdmins()) {
      if (Number(otherAdminId) !== Number(adminId)) await safeSend(otherAdminId, adminWinnerText);
    }

    for (const winner of result.winners) {
      const linkedBuyerId = winner.linked_telegram_id ?? winner.purchase_linked_telegram_id ?? null;
      if (winner.seller_id) {
        const seller = db.getSellerById(winner.seller_id);
        if (seller) {
          await safeSend(seller.telegram_id,
            `🏆 ONE OF YOUR BUYERS WON!

` +
            `Buyer: ${winner.owner_name}
Phone: ${winner.owner_phone}
` +
            `Winning ticket: #${formatNumber(winner.number)}
Draw: ${winner.pool} ETB

` +
            `Please contact the buyer. If they have registered in the bot, they will also receive the winner alert automatically.`
          );
        }
      }
      if (linkedBuyerId) {
        await sendPersonalWinnerMessage(linkedBuyerId, {
          pool: winner.pool,
          ticket_number: winner.number,
          winner_name: winner.owner_name,
          winner_phone: winner.owner_phone
        });
      } else if (!winner.seller_id && winner.owner_telegram_id) {
        await sendPersonalWinnerMessage(winner.owner_telegram_id, {
          pool: winner.pool,
          ticket_number: winner.number,
          winner_name: winner.owner_name,
          winner_phone: winner.owner_phone
        });
      }
    }
  } catch (error) {
    await bot.sendMessage(adminId, `⚠️ ${error.message}`);
  }
}

async function sendPersonalWinnerMessage(chatId, winner) {
  const am = langOf(chatId) !== 'en';
  const prize = prizeSetting(winner.pool, am ? 'am' : 'en');
  await safeSend(chatId, am
    ? `🎉🏆 እንኳን ደስ አለዎት! አሸንፈዋል! 🏆🎉

የፍኖተ ብርሃን ትኬትዎ አሸናፊ ሆኗል።

🎟 አሸናፊ ቁጥር: #${formatNumber(winner.ticket_number)}
🏆 ሽልማት: ${prize}
💳 የትኬት ዋጋ: ${winner.pool} ብር
👤 ${winner.winner_name || ''}

ዲጂታል ትኬትዎን ያስቀምጡ። ፍኖተ ብርሃን ስለ ሽልማት መቀበያው ያነጋግርዎታል።`
    : `🎉🏆 YOU WON! 🏆🎉

Your FinoteBirhan ticket is the winner.

🎟 Winning number: #${formatNumber(winner.ticket_number)}
🏆 Prize: ${prize}
💳 Ticket: ${winner.pool} ETB
👤 ${winner.winner_name || ''}

Keep your digital ticket. FinoteBirhan will contact you with prize collection details.`
  );
}

async function adminPublish(adminId) {
  const winners = db.getWinners({ publishedOnly: false });
  if (!winners.length) return bot.sendMessage(adminId, 'Draw the winners first.');
  db.publishWinners(adminId);
  const publicWinners = db.getWinners({ publishedOnly: true });
  let sent = 0;
  for (const id of db.listUsersForBroadcast()) {
    const am = langOf(id) !== 'en';
    const text = am
      ? `🏆 የፍኖተ ብርሃን አሸናፊዎች

${publicWinners.map((w) => `${w.pool} ብር — ${prizeSetting(w.pool,'am')} — #${formatNumber(w.ticket_number)} — ${firstName(w.winner_name)} — ${maskPhone(w.winner_phone)}`).join('\n')}

እንኳን ደስ አላችሁ!`
      : `🏆 FinoteBirhan Winners

${publicWinners.map((w) => `${w.pool} ETB — ${prizeSetting(w.pool,'en')} — #${formatNumber(w.ticket_number)} — ${firstName(w.winner_name)} — ${maskPhone(w.winner_phone)}`).join('\n')}

Congratulations to the winners.`;
    try { await bot.sendMessage(id, text); sent += 1; } catch {}
    await sleep(35);
  }
  await bot.sendMessage(adminId, `✅ Winners published to ${sent} users.`);
}

async function notifyAdmins(text, replyMarkup = null) {
  for (const id of db.listAdmins()) await safeSend(id, text, replyMarkup ? { reply_markup: replyMarkup } : {});
}

async function safeSend(chatId, text, extra = {}) {
  try { return await bot.sendMessage(chatId, text, extra); } catch (error) { console.error('[send]', chatId, error.message); return null; }
}

function packageLabel(value) {
  if (value === 'bundle') return 'Bundle — one number in each of the 3 draws';
  return `${value} ETB Ticket`;
}

function firstName(full) {
  return String(full || '').trim().split(/\s+/)[0] || 'Winner';
}

function formatDrawDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Addis_Ababa', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(d);
}



async function adminAddSeller(adminId, args) {
  const sellerTelegramId = Number(String(args || '').trim());
  if (!Number.isSafeInteger(sellerTelegramId) || sellerTelegramId <= 0) {
    await bot.sendMessage(adminId, 'Usage: /addseller TELEGRAM_ID');
    return;
  }
  const result = db.activateSellerRole(sellerTelegramId, adminId);
  if (result.seller) {
    await bot.sendMessage(adminId, `✅ Ticket Seller activated

#${result.seller.id} ${result.seller.display_name}
Telegram: ${result.seller.telegram_id}
Phone: ${result.seller.phone}`);
    await safeSend(sellerTelegramId, '✅ You are now a FinoteBirhan Ticket Seller. Open /start to use 🧾 Sell Tickets.');
  } else {
    await bot.sendMessage(adminId, `✅ Telegram ${sellerTelegramId} added. Seller access will activate automatically after they register their normal full name and phone in the bot.`);
    await safeSend(sellerTelegramId, '✅ You were added as a FinoteBirhan Ticket Seller. Open /start and complete your normal registration.');
  }
}

async function adminSellerList(adminId) {
  const rows = db.approvedSellerStats();
  if (!rows.length) return bot.sendMessage(adminId, 'No active Ticket Sellers.');
  const text = rows.map((s) => `#${s.id} ${s.display_name} · ${s.customers} customers · ${s.paid_count} sales · ${s.tickets_issued} tickets · ${s.revenue} ETB`).join('\n');
  await bot.sendMessage(adminId, `Ticket Sellers\n\n${text}`);
}

async function adminTicketLookup(adminId, args) {
  const [poolRaw, numberRaw] = args.split(/\s+/);
  const pool = Number(poolRaw), number = Number(numberRaw);
  if (![50,100,200].includes(pool) || !Number.isInteger(number) || number < 1 || number > 200) {
    return bot.sendMessage(adminId, 'Usage: /ticket 200 74');
  }
  const row = db.getTicketNumberDetails(pool, number);
  if (!row) return bot.sendMessage(adminId, 'Ticket number not found.');
  await bot.sendMessage(adminId,
    `Ticket ${pool} ETB #${formatNumber(number)}\nStatus: ${row.status}\n` +
    `${row.buyer_name ? `Buyer: ${row.buyer_name}\nPhone: ${row.buyer_phone}\n` : ''}` +
    `${row.purchase_id ? `Purchase: ${row.purchase_id}\nPurchase status: ${row.purchase_status}\nAmount: ${row.amount_etb} ETB\nSource: ${row.source}\nSeller: ${row.seller_name || '-'}\nReference: ${row.payment_reference || '-'}\n` : ''}` +
    `${row.reserved_until ? `Reserved until: ${row.reserved_until}` : ''}`
  );
}

async function adminCustomerLookup(adminId, args) {
  if (!args) return bot.sendMessage(adminId, 'Usage: /customer name, phone, or Telegram ID');
  const users = db.searchUsers(args);
  if (!users.length) return bot.sendMessage(adminId, 'No customer found.');
  for (const user of users.slice(0, 10)) {
    const tickets = db.ticketsForUser(user.telegram_id);
    await bot.sendMessage(adminId, `${user.full_name || '-'}\nTelegram ID: ${user.telegram_id}\nPhone: ${user.phone || '-'}\nPaid tickets: ${tickets.length}`);
  }
}

async function adminAudit(adminId, args) {
  const parsed = Number(args || 20);
  const limit = Number.isInteger(parsed) ? Math.min(50, Math.max(1, parsed)) : 20;
  const rows = db.listAudit(limit);
  if (!rows.length) return bot.sendMessage(adminId, 'Audit log is empty.');
  const text = rows.map((r) => `#${r.id} ${r.created_at}\n${r.action} · actor ${r.actor_telegram_id || '-'} · ${r.target_type || '-'} ${r.target_id || ''}`).join('\n\n');
  await bot.sendMessage(adminId, `Audit log\n\n${text}`);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
