import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('admin dashboard separates confirmed money from sold value and self-checks accounting', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /Confirmed received:/);
  assert.match(source, /Needs verification:/);
  assert.match(source, /Sold purchases:/);
  assert.match(source, /Accounting check: BALANCED/);
  assert.doesNotMatch(source, /Force Clear Data', callback_data: 'admin_forceclear'/);
});

test('Mini App hides unavailable numbers and uses fresh snapshots', () => {
  const app = fs.readFileSync(new URL('../../../app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
  assert.match(app, /if \(unavailable\[state\.activePool\]\.has\(number\)\) continue;/);
  assert.match(app, /SNAPSHOT_MAX_AGE_MS = 5 \* 60_000/);
  assert.doesNotMatch(html, /dot taken/);
});

test('web session is consumed only after successful reservation', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /getUsableWebSession\(payload\.session, telegramId\)/);
  const reservePos = source.indexOf('const purchase = db.reservePurchase({');
  const consumePos = source.indexOf('db.consumeWebSession(payload.session, telegramId);', reservePos);
  assert.ok(reservePos > 0 && consumePos > reservePos);
});
