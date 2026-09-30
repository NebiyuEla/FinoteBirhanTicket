import { TicketDatabase } from './db.js';
import { TelegramBotApi } from './telegram.js';

const PAYMENT_PROOF_STATES = new Set(['awaiting_proof', 'manual_review']);
const OPEN_DIRECT_STATES = "('reserved','awaiting_proof','verification_pending','manual_review')";
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

// A payment flow can finish or expire while user_state still says
// "awaiting_payment". Expire reservations first, then keep that state only when
// the referenced direct purchase can still accept payment proof.
const originalGetUserState = TicketDatabase.prototype.getUserState;
TicketDatabase.prototype.getUserState = function getUserStateWithPaymentGuard(telegramId) {
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
  this.releaseExpiredReservations();
  const row = this.db.prepare(`SELECT id FROM purchases
    WHERE buyer_telegram_id=? AND source='direct' AND status IN ('awaiting_proof','manual_review')
    ORDER BY created_at DESC LIMIT 1`).get(telegramId);
  return row ? this.getPurchase(row.id) : null;
};

// /cancel is a buyer-payment action. Never let it silently cancel a seller-entered
// sale merely because seller sales store the seller Telegram ID in buyer_telegram_id.
TicketDatabase.prototype.cancelLatestOpenPurchaseForUser = function cancelLatestOpenDirectPurchaseForUser(telegramId, note = 'Cancelled by user') {
  this.releaseExpiredReservations();
  const row = this.db.prepare(`SELECT id FROM purchases
    WHERE buyer_telegram_id=? AND source='direct' AND status IN ${OPEN_DIRECT_STATES}
    ORDER BY created_at DESC LIMIT 1`).get(telegramId);
  return row ? this.cancelPurchase(row.id, telegramId, note) : null;
};

// Do not let a proof upload or a manual confirmation revive an already-expired
// reservation during the short window before the periodic cleanup timer runs.
const originalSubmitPaymentProof = TicketDatabase.prototype.submitPaymentProof;
TicketDatabase.prototype.submitPaymentProof = function submitPaymentProofWithExpiryGuard(purchaseId, fields) {
  this.releaseExpiredReservations();
  return originalSubmitPaymentProof.call(this, purchaseId, fields);
};

const originalConfirmPurchase = TicketDatabase.prototype.confirmPurchase;
TicketDatabase.prototype.confirmPurchase = function confirmPurchaseWithExpiryGuard(purchaseId, reviewerId, options) {
  this.releaseExpiredReservations();
  return originalConfirmPurchase.call(this, purchaseId, reviewerId, options);
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

// If Seller Account is opened while unresolved seller sales exist, show those
// actionable confirmations instead of starting account setup.
const originalSendMessage = TelegramBotApi.prototype.sendMessage;
TelegramBotApi.prototype.sendMessage = async function sendMessageWithSellerInbox(chatId, text, extra = {}) {
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
  return originalSendMessage.call(this, chatId, text, extra);
};

// Seller SOLD / Cancel sale, admin payment decisions, and buyer payment-cancel
// buttons are one-shot actions. Retire the source card immediately when tapped.
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
    if (!TERMINAL_CALLBACK_PREFIXES.some((prefix) => data.startsWith(prefix))) return;
    await retireActionCard(this, query);
  }));
  return updates;
};
