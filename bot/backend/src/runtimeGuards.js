import { TicketDatabase } from './db.js';
import { TelegramBotApi } from './telegram.js';

const PAYMENT_PROOF_STATES = new Set(['awaiting_proof', 'manual_review']);

// A payment flow can end from a callback (cancel, seller decision, expiry) while
// user_state still says "awaiting_payment". Treat that state as stale so normal
// menu buttons are not mistaken for payment references on the next message.
const originalGetUserState = TicketDatabase.prototype.getUserState;
TicketDatabase.prototype.getUserState = function getUserStateWithPaymentGuard(telegramId) {
  const state = originalGetUserState.call(this, telegramId);
  if (state?.state !== 'awaiting_payment') return state;

  const purchaseId = state.data?.purchaseId;
  const purchase = purchaseId ? this.getPurchase(purchaseId) : null;
  if (purchase && PAYMENT_PROOF_STATES.has(purchase.status)) return state;

  this.clearUserState(telegramId);
  return null;
};

// Seller decision cards are one-shot actions. Remove the old ticket-sale card as
// soon as SOLD / Cancel sale is tapped so stale action buttons cannot be pressed
// again and the chat does not keep completed sale cards around.
const originalGetUpdates = TelegramBotApi.prototype.getUpdates;
TelegramBotApi.prototype.getUpdates = async function getUpdatesWithSellerCardCleanup(payload) {
  const updates = await originalGetUpdates.call(this, payload);
  await Promise.all(updates.map(async (update) => {
    const query = update?.callback_query;
    const data = String(query?.data || '');
    if (!data.startsWith('seller_ok:') && !data.startsWith('seller_no:')) return;

    const chatId = query?.message?.chat?.id;
    const messageId = query?.message?.message_id;
    if (!chatId || !messageId) return;

    try { await this.deleteMessage(chatId, messageId); } catch {}
  }));
  return updates;
};
