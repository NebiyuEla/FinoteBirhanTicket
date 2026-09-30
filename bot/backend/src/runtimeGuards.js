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

// A payment flow can finish or expire while user_state still says
// "awaiting_payment". Expire reservations first, then keep that state only when
// the referenced direct purchase can still accept payment proof.
const originalGetUserState = TicketDatabase.prototype.getUserState;
TicketDatabase.prototype.getUserState = function getUserStateWithPaymentGuard(telegramId) {
  const state = originalGetUserState.call(this, telegramId);
  if (state?.state !== 'awaiting_payment') return state;

  this.releaseExpiredReservations();
  const purchaseId = state.data?.purchaseId;
  const purchase = purchaseId ? this.getPurchase(purchaseId) : null;
  if (purchase?.source === 'direct' && PAYMENT_PROOF_STATES.has(purchase.status)) return state;

  this.clearUserState(telegramId);
  return null;
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

// Seller SOLD / Cancel sale, admin payment decisions, and buyer payment-cancel
// buttons are one-shot actions. Retire the source card immediately when tapped.
const originalGetUpdates = TelegramBotApi.prototype.getUpdates;
TelegramBotApi.prototype.getUpdates = async function getUpdatesWithActionCardCleanup(payload) {
  const updates = await originalGetUpdates.call(this, payload);
  await Promise.all(updates.map(async (update) => {
    const query = update?.callback_query;
    const data = String(query?.data || '');
    if (!TERMINAL_CALLBACK_PREFIXES.some((prefix) => data.startsWith(prefix))) return;
    await retireActionCard(this, query);
  }));
  return updates;
};
