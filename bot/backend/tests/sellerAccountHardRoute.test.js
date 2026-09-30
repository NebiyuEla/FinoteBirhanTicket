import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/runtimeGuards.js';
import '../src/sellerAccountGuard.js';
import { TelegramBotApi } from '../src/telegram.js';

function fakeBot(messageText) {
  const bot = new TelegramBotApi('test-token');
  bot.call = async (method) => {
    if (method === 'getUpdates') {
      return [{
        update_id: 401,
        message: {
          message_id: 88,
          date: 1,
          from: { id: 12345 },
          chat: { id: 12345, type: 'private' },
          text: messageText
        }
      }];
    }
    return true;
  };
  return bot;
}

test('Seller Account reply-keyboard message is routed as callback before state handling', async () => {
  const bot = fakeBot('💳 Seller Account');
  const updates = await bot.getUpdates({ timeout: 0 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].message, undefined);
  assert.equal(updates[0].callback_query.data, 'seller_account');
  assert.equal(updates[0].callback_query.from.id, 12345);
});

test('Seller Account route tolerates emoji variation selector differences', async () => {
  const bot = fakeBot('💳️ Seller Account');
  const updates = await bot.getUpdates({ timeout: 0 });
  assert.equal(updates[0].callback_query.data, 'seller_account');
});

test('ordinary payment-reference text remains a normal message', async () => {
  const bot = fakeBot('FT-123456789');
  const updates = await bot.getUpdates({ timeout: 0 });
  assert.equal(updates[0].message.text, 'FT-123456789');
  assert.equal(updates[0].callback_query, undefined);
});
