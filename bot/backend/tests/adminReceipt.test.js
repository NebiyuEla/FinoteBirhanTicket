import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverReceiptToAdmins, receiptAdminCaption } from '../src/adminReceipt.js';

const purchase = {
  id: 'sample-purchase-1',
  buyer_name: 'Demo Buyer',
  buyer_phone: '+251900000000',
  amount_etb: 300,
  payment_provider: 'cbe',
  payment_account_number: '1000000000000',
  payment_reference: 'https://transactioninfo.ethiotelecom.et/receipt/DJT6FV0G7M',
  numbers: [{ pool: 200, number: 14 }, { pool: 100, number: 20 }, { pool: 50, number: 39 }]
};
const photo = { chat: { id: 101 }, message_id: 44, photo: [{ file_id: 'small' }, { file_id: 'large' }] };

test('receipt evidence is copied to every admin with correct purchase context', async () => {
  const calls = [];
  const bot = {
    async copyMessage(...args) { calls.push(args); },
    async call() { throw new Error('fallback must not run'); }
  };
  const result = await deliverReceiptToAdmins({ bot, adminIds: [501, 502, 501], purchase, message: photo });
  assert.deepEqual(result, { attempted: 2, delivered: 2, failed: [] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [[501, 101, 44], [502, 101, 44]]);
  assert.match(calls[0][3].caption, /sample-purchase-1/);
  assert.match(calls[0][3].caption, /300 ETB/);
  assert.match(calls[0][3].caption, /DJT6FV0G7M/);
  assert.ok(receiptAdminCaption(purchase).length <= 1024);
});

test('receipt delivery falls back to Telegram sendPhoto on copy errors', async () => {
  const calls = [];
  const bot = {
    async copyMessage() { throw new Error('copy failed'); },
    async call(...args) { calls.push(args); }
  };
  const result = await deliverReceiptToAdmins({ bot, adminIds: [501], purchase, message: photo });
  assert.equal(result.delivered, 1);
  assert.equal(calls[0][0], 'sendPhoto');
  assert.equal(calls[0][1].photo, 'large');
  assert.equal(calls[0][1].chat_id, 501);
});

test('image documents also reach admins, even without a QR/reference', async () => {
  const calls = [];
  const bot = {
    async copyMessage() { throw new Error('cannot copy'); },
    async call(...args) { calls.push(args); }
  };
  const result = await deliverReceiptToAdmins({
    bot, adminIds: [501], purchase: { ...purchase, payment_reference: null },
    message: { chat: { id: 101 }, message_id: 44, document: { file_id: 'document-id' } }
  });
  assert.equal(result.delivered, 1);
  assert.equal(calls[0][0], 'sendDocument');
  assert.equal(calls[0][1].document, 'document-id');
});

test('failed admin delivery is logged and does not pretend to succeed', async () => {
  const errors = [];
  const bot = {
    async copyMessage() { throw new Error('bot blocked'); },
    async call() { throw new Error('bot blocked'); }
  };
  const result = await deliverReceiptToAdmins({
    bot, adminIds: [501], purchase, message: photo,
    logger: { error: (...args) => errors.push(args) }
  });
  assert.deepEqual(result, { attempted: 1, delivered: 0, failed: [501] });
  assert.equal(errors.length, 1);
});

test('missing admin configuration is surfaced, not silently swallowed', async () => {
  const errors = [];
  const bot = { async copyMessage() { throw new Error('should not run'); } };
  const result = await deliverReceiptToAdmins({
    bot, adminIds: [], purchase, message: photo,
    logger: { error: (...args) => errors.push(args) }
  });
  assert.equal(result.delivered, 0);
  assert.match(errors[0].join(' '), /No admin recipients/);
});

test('plain reference-only messages do not attempt to forward an image', async () => {
  const bot = { async copyMessage() { throw new Error('should not run'); } };
  const result = await deliverReceiptToAdmins({
    bot, adminIds: [501], purchase, message: { chat: { id: 101 }, message_id: 44, text: 'D1234567' }
  });
  assert.deepEqual(result, { attempted: 0, delivered: 0, failed: [] });
});
