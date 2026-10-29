import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TicketDatabase } from '../src/db.js';
import { parseBuyerTicketDeepLink } from '../src/miniAppTransport.js';
import { deliverReceiptToAdmins } from '../src/adminReceipt.js';

// Integration regression for one complete BUY -> RESERVE -> PAYMENT PROOF ->
// ADMIN RECEIPT -> APPROVAL -> ISSUED TICKET path. Uses a temporary database
// and fake Telegram transport: it does not charge or affect production users.
test('buyer selection through admin-reviewed receipt issues exactly one ticket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-e2e-'));
  const db = new TicketDatabase(path.join(dir, 'test.sqlite'));
  try {
    const buyer = 1001;
    const admin = 9001;
    db.ensureUser(buyer);
    db.setUserName(buyer, 'Test Buyer');
    db.setUserPhone(buyer, '+251911111111');
    db.ensureUser(admin);
    db.addAdmin(admin);

    const account = db.addPaymentAccount({
      provider: 'telebirr', accountName: 'FinoteBirhan', accountNumber: '0911223344'
    }, admin);

    const sessionToken = db.createWebSession(buyer, null, 30);
    assert.ok(db.getUsableWebSession(sessionToken, buyer));
    const purchase = db.reservePurchase({
      telegramId: buyer, packageType: '100', selectedNumbers: { 100: 45 }
    });
    assert.equal(db.availability()[100].includes(45), true);
    db.consumeWebSession(sessionToken, buyer);
    assert.equal(db.getUsableWebSession(sessionToken, buyer), null);
    assert.equal(db.getUsableWebSession(sessionToken, admin), null);

    const selectedAccount = db.assignPaymentAccountToPurchase(purchase.id, account.id, buyer);
    assert.equal(selectedAccount.payment_account_number, '0911223344');
    const proof = db.submitPaymentProof(purchase.id, {
      provider: 'telebirr',
      reference: 'TEST123456789',
      fileId: 'mock-telegram-photo-id'
    });
    assert.equal(proof.status, 'verification_pending');

    const copied = [];
    const delivered = await deliverReceiptToAdmins({
      bot: {
        async copyMessage(...args) { copied.push(args); },
        async call() { throw Error('Unexpected fallback'); }
      },
      adminIds: [admin],
      purchase: proof,
      message: { chat: { id: buyer }, message_id: 50, photo: [{ file_id: 'mock-telegram-photo-id' }] }
    });
    assert.equal(delivered.delivered, 1);
    assert.equal(copied[0][0], admin);
    assert.match(copied[0][3].caption, new RegExp(purchase.id));

    db.markManualReview(purchase.id, 'Mocked verification inconclusive');
    const paid = db.confirmPurchase(purchase.id, admin, { note: 'Mock admin checked receipt' });
    assert.equal(paid.status, 'paid');
    assert.equal(db.ticketsForUser(buyer).length, 1);
    assert.equal(db.ticketsForUser(buyer)[0].number, 45);
    assert.equal(db.availability()[100].includes(45), true);
    assert.throws(() => db.reservePurchase({
      telegramId: buyer, packageType: '100', selectedNumbers: { 100: 45 }
    }), /taken/i);
    assert.equal(db.confirmPurchase(purchase.id, admin).status, 'paid');
    assert.equal(db.ticketsForUser(buyer).length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('in-message Mini App deep-link reserves a bundle only once and only for its owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finote-deeplink-'));
  const db = new TicketDatabase(path.join(dir, 'test.sqlite'));
  try {
    const buyer = 1001;
    const anotherUser = 1002;
    db.ensureUser(buyer);
    db.setUserName(buyer, 'Test Buyer');
    db.setUserPhone(buyer, '+251911111111');
    db.ensureUser(anotherUser);
    db.setUserName(anotherUser, 'Other Buyer');
    db.setUserPhone(anotherUser, '+251922222222');
    const session = db.createWebSession(buyer, null, 30);
    const encoded = 't_' + session + '_b_001077200';
    assert.ok(encoded.length <= 64);
    const chosen = parseBuyerTicketDeepLink(encoded);
    assert.equal(chosen.package, 'bundle');
    assert.equal(db.getUsableWebSession(chosen.session, anotherUser), null);
    assert.ok(db.getUsableWebSession(chosen.session, buyer));
    const reservation = db.reservePurchase({
      telegramId: buyer, packageType: chosen.package, selectedNumbers: chosen.numbers
    });
    db.consumeWebSession(chosen.session, buyer);
    assert.equal(db.getUsableWebSession(chosen.session, buyer), null);
    assert.deepEqual(
      reservation.numbers.map((n) => [Number(n.pool), Number(n.number)]).sort((a,b) => a[0]-b[0]),
      [[50,200],[100,77],[200,1]]
    );
    assert.throws(() => db.reservePurchase({
      telegramId: anotherUser, packageType: chosen.package, selectedNumbers: chosen.numbers
    }), /taken/i);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
