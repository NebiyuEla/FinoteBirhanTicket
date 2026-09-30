import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/runtimeGuards.js';
import { TicketDatabase } from '../src/db.js';
import { TelegramBotApi } from '../src/telegram.js';

test('stale awaiting_payment state is cleared after a purchase is no longer payable', () => {
  let cleared = null;
  const fakeDb = {
    db: { prepare: () => ({ get: () => ({ state: 'awaiting_payment', data_json: '{"purchaseId":"sale-1"}' }) }) },
    getPurchase: () => ({ id: 'sale-1', status: 'cancelled' }),
    clearUserState: (telegramId) => { cleared = telegramId; }
  };

  const state = TicketDatabase.prototype.getUserState.call(fakeDb, 123);
  assert.equal(state, null);
  assert.equal(cleared, 123);
});

test('active awaiting_payment state is preserved while proof can still be submitted', () => {
  let cleared = false;
  const fakeDb = {
    db: { prepare: () => ({ get: () => ({ state: 'awaiting_payment', data_json: '{"purchaseId":"sale-2"}' }) }) },
    getPurchase: () => ({ id: 'sale-2', status: 'awaiting_proof' }),
    clearUserState: () => { cleared = true; }
  };

  const state = TicketDatabase.prototype.getUserState.call(fakeDb, 456);
  assert.equal(state.state, 'awaiting_payment');
  assert.equal(state.data.purchaseId, 'sale-2');
  assert.equal(cleared, false);
});

test('seller SOLD / cancel callback removes the completed sale card', async () => {
  const bot = new TelegramBotApi('test-token');
  const calls = [];
  bot.call = async (method, payload = {}) => {
    calls.push([method, payload]);
    if (method === 'getUpdates') {
      return [{
        update_id: 1,
        callback_query: {
          id: 'callback-1',
          data: 'seller_no:purchase-1',
          from: { id: 123 },
          message: { message_id: 77, chat: { id: 123 } }
        }
      }];
    }
    return true;
  };

  const updates = await bot.getUpdates({ timeout: 0 });
  assert.equal(updates.length, 1);
  assert.ok(calls.some(([method, payload]) => method === 'deleteMessage' && payload.chat_id === 123 && payload.message_id === 77));
});
