import { TelegramBotApi } from './telegram.js';

// Reply-keyboard navigation must never be interpreted as payment proof.
// Route Seller Account as a callback before index.js reads any persisted user_state.
// Normalize variation selectors/whitespace because Telegram clients may serialize
// emoji labels slightly differently.
function normalizeLabel(value) {
  return String(value || '')
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SELLER_ACCOUNT_LABELS = new Set([
  normalizeLabel('💳 Seller Account'),
  normalizeLabel('💳 የሻጭ አካውንት')
]);

const originalGetUpdates = TelegramBotApi.prototype.getUpdates;
TelegramBotApi.prototype.getUpdates = async function getUpdatesWithSellerAccountHardRoute(payload) {
  const updates = await originalGetUpdates.call(this, payload);
  return updates.map((update) => {
    const message = update?.message;
    if (!message?.from?.id || !SELLER_ACCOUNT_LABELS.has(normalizeLabel(message.text))) return update;

    return {
      ...update,
      message: undefined,
      callback_query: {
        id: `seller-account-${update.update_id}`,
        from: message.from,
        message: {
          message_id: message.message_id,
          chat: message.chat,
          date: message.date
        },
        data: 'seller_account'
      }
    };
  });
};
