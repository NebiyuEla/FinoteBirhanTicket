import { TicketDatabase } from './db.js';
import { TelegramBotApi } from './telegram.js';

const PAYMENT_PROOF_STATES = new Set(['awaiting_proof', 'manual_review']);
const OPEN_DIRECT_STATES = "('reserved','awaiting_proof','verification_pending','manual_review')";
const RECOVERY_OPEN_STATES = ['reserved', 'awaiting_proof', 'verification_pending', 'seller_review', 'manual_review'];
const RECOVERY_WINDOW_HOURS = 24 * 7;
const TERMINAL_CALLBACK_PREFIXES = [
  'seller_ok:',
  'seller_no:',
  'admin_pay_ok:',
  'admin_pay_no:',
  'cancel_pay:'
];

const MAIN_MENU_ACTIONS = new Set([
  '🎫 የእኔ ትኬቶች', '🎫 My Tickets',
  '🏆 ውጤት', '🏆 Results',
  '📈 የሽያጭ ሪፖርት', '📈 Seller Stats',
  '💳 የሻጭ አካውንት', '💳 Seller Account',
  '🌐 ቋንቋ', '🌐 Language',
  '🛠 አስተዳዳሪ', '🛠 Admin',
  '🎟 ትኬት ይግዙ', '🎟 Buy Ticket'
]);
const pendingMenuActions = new Set();
const pendingSellerReviewInbox = new Map();
const recoverySummaryChats = new Set();
let activeDb = null;

function recoveryCutoff(hours = RECOVERY_WINDOW_HOURS) {
  return new Date(Date.now() - Math.max(1, Number(hours) || RECOVERY_WINDOW_HOURS) * 60 * 60 * 1000).toISOString();
}

function recoveryStatusRank(status) {
  return ({ manual_review: 0, verification_pending: 1, seller_review: 2, awaiting_proof: 3, reserved: 4, expired: 5 })[status] ?? 9;
}

const originalReleaseExpiredReservations = TicketDatabase.prototype.releaseExpiredReservations;
TicketDatabase.prototype.releaseExpiredReservations = function releaseExpiredReservationsWithRuntimeCapture() {
  activeDb = this;
  return originalReleaseExpiredReservations.call(this);
};

TicketDatabase.prototype.recoveryQueue = function recoveryQueue(limit = 30, expiredHours = RECOVERY_WINDOW_HOURS) {
  activeDb = this;
  this.releaseExpiredReservations();
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const placeholders = RECOVERY_OPEN_STATES.map(() => '?').join(',');
  const rows = this.db.prepare(`SELECT id,status,created_at,submitted_at,reserved_until FROM purchases
    WHERE status IN (${placeholders}) OR (status='expired' AND reserved_until>=?)
    ORDER BY COALESCE(submitted_at,created_at) ASC`).all(...RECOVERY_OPEN_STATES, recoveryCutoff(expiredHours));
  return rows
    .sort((a, b) => recoveryStatusRank(a.status) - recoveryStatusRank(b.status) || String(a.submitted_at || a.created_at).localeCompare(String(b.submitted_at || b.created_at)))
    .slice(0, safeLimit)
    .map((row) => this.getPurchase(row.id));
};

TicketDatabase.prototype.recoveryStats = function recoveryStats(expiredHours = RECOVERY_WINDOW_HOURS) {
  activeDb = this;
  this.releaseExpiredReservations();
  const placeholders = RECOVERY_OPEN_STATES.map(() => '?').join(',');
  const rows = this.db.prepare(`SELECT status,COUNT(*) AS c FROM purchases
    WHERE status IN (${placeholders}) OR (status='expired' AND reserved_until>=?)
    GROUP BY status`).all(...RECOVERY_OPEN_STATES, recoveryCutoff(expiredHours));
  const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.c || 0)]));
  const attention = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return { attention, recentExpired: counts.expired || 0, counts };
};

TicketDatabase.prototype.assessRecoveryPurchase = function assessRecoveryPurchase(purchaseId) {
  activeDb = this;
  const purchase = this.getPurchase(purchaseId);
  if (!purchase) return null;
  const numberStates = (purchase.numbers || []).map((num) => {
    const current = this.db.prepare('SELECT pool,number,status,purchase_id,reserved_until FROM ticket_numbers WHERE pool=? AND number=?').get(num.pool, num.number);
    return current || { pool: num.pool, number: num.number, status: 'missing', purchase_id: null, reserved_until: null };
  });
  const intact = numberStates.length === (purchase.numbers || []).length && numberStates.every((row) => row.status === 'reserved' && row.purchase_id === purchase.id);
  const availableForRestore = numberStates.length === (purchase.numbers || []).length && numberStates.every((row) => row.status === 'available' && !row.purchase_id);
  const conflicts = numberStates.filter((row) => row.status !== 'available' || row.purchase_id).map((row) => `${row.pool} ETB #${String(row.number).padStart(3, '0')} → ${row.status}${row.purchase_id ? ` (${row.purchase_id})` : ''}`);
  const hasEvidence = Boolean(purchase.payment_reference || purchase.payment_file_id || purchase.source === 'seller');
  return { purchase, numberStates, intact, availableForRestore, conflicts, hasEvidence };
};

// A payment flow can finish or expire while user_state still says
// "awaiting_payment". Expire reservations first, then keep that state only when
// the referenced direct purchase can still accept payment proof.
const originalGetUserState = TicketDatabase.prototype.getUserState;
TicketDatabase.prototype.getUserState = function getUserStateWithPaymentGuard(telegramId) {
  activeDb = this;
  const state = originalGetUserState.call(this, telegramId);

  // Reply-keyboard buttons are navigation. If the user taps one while a wizard
  // or payment state is active, let index.js handle the button normally instead
  // of consuming its label as payment proof/account data.
  if (pendingMenuActions.delete(Number(telegramId))) {
    if (state) this.clearUserState(telegramId);
    return null;
  }

  if (state?.state !== 'awaiting_payment') return state;

  this.releaseExpiredReservations();
  const purchaseId = state.data?.purchaseId;
  const purchase = purchaseId ? this.getPurchase(purchaseId) : null;
  if (purchase?.source === 'direct' && PAYMENT_PROOF_STATES.has(purchase.status)) return state;

  this.clearUserState(telegramId);
  return null;
};

const originalSetUserState = TicketDatabase.prototype.setUserState;
TicketDatabase.prototype.setUserState = function setUserStateWithSellerInbox(telegramId, state, data = {}) {
  activeDb = this;
  if (state === 'seller_account_provider') {
    const seller = this.getSellerByTelegram(telegramId);
    if (seller?.status === 'approved') {
      const pending = this.sellerPendingReviews(seller.id, 20);
      if (pending.length) {
        this.clearUserState(telegramId);
        pendingSellerReviewInbox.set(Number(telegramId), pending);
        return;
      }
    }
  }
  return originalSetUserState.call(this, telegramId, state, data);
};

// Only direct buyer purchases should be treated as implicit payment-proof targets.
// Seller-entered sales use the seller decision card instead. Without this guard a
// seller sending any photo while one of their sales is pending could hit the
// buyer payment-proof handler and receive "not awaiting payment proof".
TicketDatabase.prototype.getOpenPurchaseForUser = function getOpenDirectPurchaseForUser(telegramId) {
  activeDb = this;
  this.releaseExpiredReservations();
  const row = this.db.prepare(`SELECT id FROM purchases
    WHERE buyer_telegram_id=? AND source='direct' AND status IN ('awaiting_proof','manual_review')
    ORDER BY created_at DESC LIMIT 1`).get(telegramId);
  return row ? this.getPurchase(row.id) : null;
};

// /cancel is a buyer-payment action. Never let it silently cancel a seller-entered
// sale merely because seller sales store the seller Telegram ID in buyer_telegram_id.
TicketDatabase.prototype.cancelLatestOpenPurchaseForUser = function cancelLatestOpenDirectPurchaseForUser(telegramId, note = 'Cancelled by user') {
  activeDb = this;
  this.releaseExpiredReservations();
  const row = this.db.prepare(`SELECT id FROM purchases
    WHERE buyer_telegram_id=? AND source='direct' AND status IN ${OPEN_DIRECT_STATES}
    ORDER BY created_at DESC LIMIT 1`).get(telegramId);
  return row ? this.cancelPurchase(row.id, telegramId, note) : null;
};

// Do not let a proof upload revive an already-expired reservation during the short
// window before the periodic cleanup timer runs.
const originalSubmitPaymentProof = TicketDatabase.prototype.submitPaymentProof;
TicketDatabase.prototype.submitPaymentProof = function submitPaymentProofWithExpiryGuard(purchaseId, fields) {
  activeDb = this;
  this.releaseExpiredReservations();
  return originalSubmitPaymentProof.call(this, purchaseId, fields);
};

const originalConfirmPurchase = TicketDatabase.prototype.confirmPurchase;

TicketDatabase.prototype.recoverExpiredPurchase = function recoverExpiredPurchase(purchaseId, reviewerId, { note = 'Recovered and approved by administrator.' } = {}) {
  activeDb = this;
  if (!this.isAdmin(reviewerId)) throw new Error('Admin access required for expired-payment recovery.');
  this.releaseExpiredReservations();
  const purchase = this.getPurchase(purchaseId);
  if (!purchase) throw new Error('Purchase not found.');
  if (purchase.status !== 'expired') throw new Error(`Purchase is ${purchase.status}, not expired.`);
  if (purchase.source === 'direct' && !purchase.payment_reference && !purchase.payment_file_id) {
    throw new Error('Expired direct purchase has no stored payment evidence. Ask the buyer for a transaction reference before approval.');
  }
  const assessment = this.assessRecoveryPurchase(purchaseId);
  if (!assessment?.availableForRestore) {
    throw new Error(`Cannot recover: original ticket number${purchase.numbers.length === 1 ? '' : 's'} ${purchase.numbers.length === 1 ? 'is' : 'are'} no longer available.${assessment?.conflicts?.length ? ` ${assessment.conflicts.join('; ')}` : ''}`);
  }

  const restoredUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  this.db.exec('BEGIN IMMEDIATE');
  try {
    const fresh = this.db.prepare('SELECT status FROM purchases WHERE id=?').get(purchaseId);
    if (!fresh || fresh.status !== 'expired') throw new Error('Purchase status changed. Refresh Recovery and try again.');
    for (const num of purchase.numbers) {
      const row = this.db.prepare('SELECT status,purchase_id FROM ticket_numbers WHERE pool=? AND number=?').get(num.pool, num.number);
      if (!row || row.status !== 'available' || row.purchase_id) {
        throw new Error(`${num.pool} ETB #${String(num.number).padStart(3, '0')} is no longer available.`);
      }
      this.db.prepare(`UPDATE ticket_numbers SET status='reserved',purchase_id=?,reserved_until=?,buyer_telegram_id=?,seller_id=? WHERE pool=? AND number=?`)
        .run(purchase.id, restoredUntil, purchase.linked_telegram_id ?? purchase.buyer_telegram_id, purchase.seller_id ?? null, num.pool, num.number);
    }
    this.db.prepare(`UPDATE purchases SET status='manual_review',reserved_until=?,reviewed_by=?,note=TRIM(COALESCE(note,'') || ' [recovery lock restored]') WHERE id=?`)
      .run(restoredUntil, reviewerId, purchaseId);
    this.db.exec('COMMIT');
  } catch (error) {
    this.db.exec('ROLLBACK');
    throw error;
  }

  try {
    const paid = originalConfirmPurchase.call(this, purchaseId, reviewerId, { note });
    this.log(reviewerId, 'purchase.recovered_after_expiry', 'purchase', purchaseId, { originalStatus: 'expired' });
    return paid;
  } catch (error) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL WHERE purchase_id=? AND status='reserved'`).run(purchaseId);
      this.db.prepare(`UPDATE purchases SET status='expired',reserved_until=?,note=TRIM(COALESCE(note,'') || ' [recovery confirmation failed]') WHERE id=?`).run(new Date().toISOString(), purchaseId);
      this.db.exec('COMMIT');
    } catch {
      try { this.db.exec('ROLLBACK'); } catch {}
    }
    throw error;
  }
};

TicketDatabase.prototype.confirmPurchase = function confirmPurchaseWithExpiryGuard(purchaseId, reviewerId, options) {
  activeDb = this;
  this.releaseExpiredReservations();
  const purchase = this.getPurchase(purchaseId);
  if (purchase?.status === 'expired' && reviewerId && this.isAdmin(reviewerId)) {
    return this.recoverExpiredPurchase(purchaseId, reviewerId, options || {});
  }
  return originalConfirmPurchase.call(this, purchaseId, reviewerId, options);
};

const originalRejectPurchase = TicketDatabase.prototype.rejectPurchase;
TicketDatabase.prototype.rejectPurchase = function rejectPurchaseWithRecoveryResolution(purchaseId, reviewerId, note = 'Payment not confirmed') {
  activeDb = this;
  this.releaseExpiredReservations();
  const purchase = this.getPurchase(purchaseId);
  if (purchase?.status === 'expired' && reviewerId && this.isAdmin(reviewerId)) {
    this.db.prepare(`UPDATE purchases SET status='rejected',reviewed_by=?,note=?,reserved_until=? WHERE id=?`).run(reviewerId, note, new Date().toISOString(), purchaseId);
    this.log(reviewerId, 'purchase.recovery_rejected', 'purchase', purchaseId, { previousStatus: 'expired' });
    return this.getPurchase(purchaseId);
  }
  return originalRejectPurchase.call(this, purchaseId, reviewerId, note);
};

const originalDashboardStats = TicketDatabase.prototype.dashboardStats;
TicketDatabase.prototype.dashboardStats = function dashboardStatsWithRecoveryAttention() {
  activeDb = this;
  const stats = originalDashboardStats.call(this);
  const recovery = this.recoveryStats();
  return { ...stats, pending: recovery.attention, recovery };
};

// Admin → Payments is now the recovery inbox: all unresolved transactions plus
// recently expired reservations from the last seven days. Returned objects are
// presentation copies, so synthetic labels never alter stored payment references.
TicketDatabase.prototype.pendingReviews = function pendingRecoveryReviews(limit = 30) {
  activeDb = this;
  recoverySummaryChats.clear();
  return this.recoveryQueue(limit, RECOVERY_WINDOW_HOURS).map((purchase) => {
    const assessment = this.assessRecoveryPurchase(purchase.id);
    const copy = {
      ...purchase,
      numbers: (purchase.numbers || []).map((num) => ({ ...num })),
      seller: purchase.seller ? { ...purchase.seller } : null
    };
    const sourceLabel = purchase.source === 'seller'
      ? `seller${purchase.seller?.display_name ? ` · ${purchase.seller.display_name}` : ''}`
      : 'direct';
    copy.buyer_name = `${purchase.buyer_name}\nStatus: ${String(purchase.status).toUpperCase()} · Source: ${sourceLabel}`;
    const timing = [
      `Created: ${purchase.created_at}`,
      purchase.submitted_at ? `Submitted: ${purchase.submitted_at}` : null,
      `Reserved until: ${purchase.reserved_until}`
    ].filter(Boolean).join('\n');
    const safety = purchase.status === 'expired'
      ? (assessment?.availableForRestore
          ? 'Recovery safety: original number(s) are still available.'
          : `⚠️ Recovery approval blocked: ${assessment?.conflicts?.join('; ') || 'original reservation is not available.'}`)
      : (assessment?.intact ? 'Reservation lock: intact.' : '⚠️ Reservation lock is not intact; inspect before approval.');
    copy.note = [purchase.note, timing, safety].filter(Boolean).join('\n');
    if (!copy.payment_reference && purchase.payment_file_id) copy.payment_reference = '[stored receipt image — tap Inspect]';
    if (!copy.payment_reference && purchase.source === 'seller' && ['seller_review', 'expired'].includes(purchase.status)) {
      copy.payment_reference = '[seller confirmation pending — verify with seller]';
    }
    return copy;
  });
};

async function retireActionCard(bot, query) {
  const chatId = query?.message?.chat?.id;
  const messageId = query?.message?.message_id;
  if (!chatId || !messageId) return;

  try {
    await bot.deleteMessage(chatId, messageId);
    return;
  } catch {}

  // If Telegram no longer allows deleting the message, at least remove the old
  // one-shot buttons so a completed sale/payment decision cannot be submitted again.
  try {
    await bot.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    });
  } catch {}
}

function cloneMarkup(extra = {}) {
  const keyboard = extra?.reply_markup?.inline_keyboard;
  if (!Array.isArray(keyboard)) return extra;
  return {
    ...extra,
    reply_markup: {
      ...extra.reply_markup,
      inline_keyboard: keyboard.map((row) => row.map((button) => ({ ...button })))
    }
  };
}

function recoveryPurchaseIdFromMarkup(extra = {}) {
  const keyboard = extra?.reply_markup?.inline_keyboard || [];
  for (const row of keyboard) {
    for (const button of row) {
      const data = String(button?.callback_data || '');
      const match = data.match(/^admin_pay_(?:ok|no|askref):(.+)$/);
      if (match) return match[1];
    }
  }
  return null;
}

function recoveryActionRows(db, purchase) {
  const assessment = db.assessRecoveryPurchase(purchase.id);
  const rows = [];
  const canApprove = purchase.status !== 'expired'
    ? (Boolean(purchase.payment_reference || purchase.payment_file_id) || purchase.source === 'seller')
    : Boolean(assessment?.availableForRestore && assessment?.hasEvidence);
  if (canApprove) {
    rows.push([{ text: purchase.status === 'expired' ? '♻️ Recover & approve' : '✅ Approve', callback_data: `admin_pay_ok:${purchase.id}` }]);
  }
  if (purchase.source === 'direct' && !purchase.payment_reference) {
    rows.push([{ text: '🔗 Ask link/reference', callback_data: `admin_pay_askref:${purchase.id}` }]);
  }
  rows.push([{ text: purchase.status === 'expired' ? '❌ Resolve as unpaid' : '❌ Reject / release', callback_data: `admin_pay_no:${purchase.id}` }]);
  rows.push([{ text: '🔄 Recovery queue', callback_data: 'admin_payments' }]);
  return rows;
}

async function sendRecoveryInspection(bot, db, query) {
  const adminId = query?.from?.id;
  if (!adminId || !db?.isAdmin(adminId)) {
    try { await bot.answerCallbackQuery(query.id, 'Admin only.', true); } catch {}
    return;
  }
  const purchaseId = String(query?.data || '').split(':').slice(1).join(':');
  const purchase = db.getPurchase(purchaseId);
  if (!purchase) {
    await originalSendMessage.call(bot, adminId, 'Recovery item not found. Refresh the queue.');
    return;
  }
  const assessment = db.assessRecoveryPurchase(purchaseId);
  const numbers = (purchase.numbers || []).map((n) => `${n.pool} ETB #${String(n.number).padStart(3, '0')}`).join(' · ');
  const seller = purchase.seller?.display_name || '-';
  const safety = purchase.status === 'expired'
    ? (assessment?.availableForRestore ? 'SAFE TO RESTORE — original number(s) are currently available.' : `BLOCKED — ${assessment?.conflicts?.join('; ') || 'original number(s) unavailable.'}`)
    : (assessment?.intact ? 'Reservation lock is intact.' : 'WARNING — reservation lock is not intact.');
  const text = `🔎 RECOVERY INSPECT\n\nPurchase: ${purchase.id}\nStatus: ${String(purchase.status).toUpperCase()}\nSource: ${purchase.source}\nBuyer: ${purchase.buyer_name}\nPhone: ${purchase.buyer_phone}\nSeller: ${seller}\nPackage: ${purchase.package_type}\nNumbers: ${numbers || '-'}\nAmount: ${purchase.amount_etb} ETB\nPayment target: ${purchase.payment_target || '-'}\nTransfer: ${purchase.payment_provider || '-'} · ${purchase.payment_account_name || '-'} · ${purchase.payment_account_number || '-'}\nReference: ${purchase.payment_reference || '-'}\nStored receipt: ${purchase.payment_file_id ? 'YES' : 'NO'}\nCreated: ${purchase.created_at}\nSubmitted: ${purchase.submitted_at || '-'}\nReserved until: ${purchase.reserved_until}\n\n${safety}\n\nNote: ${purchase.note || '-'}`;
  await originalSendMessage.call(bot, adminId, text, { reply_markup: { inline_keyboard: recoveryActionRows(db, purchase) } });

  if (purchase.payment_file_id) {
    const caption = `Stored payment proof · ${purchase.buyer_name} · ${purchase.amount_etb} ETB · ${purchase.id}`;
    try {
      await bot.call('sendPhoto', { chat_id: adminId, photo: purchase.payment_file_id, caption });
    } catch {
      try { await bot.call('sendDocument', { chat_id: adminId, document: purchase.payment_file_id, caption }); } catch {}
    }
  }
}

// If Seller Account is opened while unresolved seller sales exist, show those
// actionable confirmations instead of starting account setup. This wrapper also
// upgrades the admin Payments screen into the outage Recovery inbox without
// changing the stable callback names used by index.js.
const originalSendMessage = TelegramBotApi.prototype.sendMessage;
TelegramBotApi.prototype.sendMessage = async function sendMessageWithRuntimeUx(chatId, text, extra = {}) {
  const pending = pendingSellerReviewInbox.get(Number(chatId));
  if (pending?.length && String(text || '').startsWith('💳 Seller payment account')) {
    pendingSellerReviewInbox.delete(Number(chatId));
    let last = await originalSendMessage.call(this, chatId,
      `💳 ${pending.length} payment/sale confirmation${pending.length === 1 ? '' : 's'} waiting. Approve or cancel each one below.`
    );
    for (const purchase of pending) {
      const numbers = (purchase.numbers || []).map((n) => `${n.pool}: #${String(n.number).padStart(3, '0')}`).join(' · ');
      const referenceLine = purchase.payment_reference ? `\nReference: ${String(purchase.payment_reference).slice(0, 100)}` : '';
      last = await originalSendMessage.call(this, chatId,
        `💳 Payment confirmation needed\n\nBuyer: ${purchase.buyer_name}\nPhone: ${purchase.buyer_phone}\nTicket: ${purchase.package_type === 'bundle' ? 'Bundle — one number in each of the 3 draws' : `${purchase.package_type} ETB Ticket`}\nNumbers: ${numbers}\nAmount: ${purchase.amount_etb} ETB${referenceLine}\n\nConfirm only after you see the money in your account.`,
        { reply_markup: { inline_keyboard: [[
          { text: '✅ Payment received', callback_data: `seller_ok:${purchase.id}` },
          { text: '❌ Not received', callback_data: `seller_no:${purchase.id}` }
        ]] } }
      );
    }
    return last;
  }

  let nextText = String(text || '');
  let nextExtra = cloneMarkup(extra);

  if (nextText.includes('🛠 FinoteBirhan Admin') || nextText.includes('🛠 ፍኖተ ብርሃን አስተዳዳሪ')) {
    const recovery = activeDb?.recoveryStats?.() || { attention: 0, recentExpired: 0 };
    nextText = nextText
      .replace(/Pending review:\s*\d+/, `Recovery attention: ${recovery.attention}`)
      .replace(/⏳ ማረጋገጫ የሚጠብቁ:\s*\d+/, `🚨 ሪከቨሪ የሚፈልጉ: ${recovery.attention}`);
    nextText += `\n\n🚨 Recovery includes unresolved transactions + expired reservations from the last 7 days. Recent expired: ${recovery.recentExpired}.`;
    for (const row of nextExtra?.reply_markup?.inline_keyboard || []) {
      for (const button of row) {
        if (button.callback_data === 'admin_payments') button.text = '🚨 Recovery';
      }
    }
  }

  if (nextText === 'No direct payments are waiting for manual review.') {
    nextText = '✅ Recovery queue is clear. No unresolved or recently expired purchases need attention.';
  }

  const recoveryId = recoveryPurchaseIdFromMarkup(nextExtra);
  const isRecoveryCard = Boolean(recoveryId && nextText.includes('\nStatus: '));
  if (isRecoveryCard) {
    if (!recoverySummaryChats.has(Number(chatId))) {
      recoverySummaryChats.add(Number(chatId));
      const stats = activeDb?.recoveryStats?.() || { attention: 0, recentExpired: 0, counts: {} };
      const c = stats.counts || {};
      await originalSendMessage.call(this, chatId,
        `🚨 RECOVERY QUEUE\n\nNeeds attention: ${stats.attention}\nManual review: ${c.manual_review || 0}\nVerification pending: ${c.verification_pending || 0}\nSeller confirmation: ${c.seller_review || 0}\nAwaiting proof/reserved: ${(c.awaiting_proof || 0) + (c.reserved || 0)}\nExpired in last 7 days: ${stats.recentExpired}\n\nInspect uncertain items before approving. Expired purchases can only be restored when their original ticket numbers are still free.`
      );
    }
    nextText = nextText.replace(/^🧾 /, '🚨 ');
    const keyboard = nextExtra?.reply_markup?.inline_keyboard || [];
    if (!keyboard.some((row) => row.some((button) => String(button.callback_data || '').startsWith('admin_recovery_inspect:')))) {
      keyboard.unshift([{ text: '🔎 Inspect', callback_data: `admin_recovery_inspect:${recoveryId}` }]);
    }
  }

  return originalSendMessage.call(this, chatId, nextText, nextExtra);
};

// Seller SOLD / Cancel sale, admin payment decisions, and buyer payment-cancel
// buttons are one-shot actions. Recovery Inspect is handled here and converted to
// a no-op callback so the polling offset still advances in index.js.
const originalGetUpdates = TelegramBotApi.prototype.getUpdates;
TelegramBotApi.prototype.getUpdates = async function getUpdatesWithActionCardCleanup(payload) {
  const updates = await originalGetUpdates.call(this, payload);
  await Promise.all(updates.map(async (update) => {
    const message = update?.message;
    const messageText = String(message?.text || '').trim();
    const telegramId = message?.from?.id;
    if (telegramId && MAIN_MENU_ACTIONS.has(messageText)) pendingMenuActions.add(Number(telegramId));

    const query = update?.callback_query;
    const data = String(query?.data || '');
    if (data.startsWith('admin_recovery_inspect:')) {
      try { await this.answerCallbackQuery(query.id); } catch {}
      await sendRecoveryInspection(this, activeDb, query);
      query.data = 'runtime_recovery_handled';
      return;
    }
    if (!TERMINAL_CALLBACK_PREFIXES.some((prefix) => data.startsWith(prefix))) return;
    await retireActionCard(this, query);
  }));
  return updates;
};
