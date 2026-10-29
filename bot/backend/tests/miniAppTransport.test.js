import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ticketLauncherKeyboard } from '../src/miniAppTransport.js';

const url = 'https://finotebirhan-ticket.vercel.app/?s=test&transport=keyboard';
test('buyer Mini App launches through a reply keyboard that supports sendData', () => {
  const keyboard = ticketLauncherKeyboard({ url, lang: 'en', seller: false });
  assert.ok(keyboard.keyboard[0][0].web_app);
  assert.equal(keyboard.keyboard[0][0].web_app.url, url);
  assert.equal(keyboard.inline_keyboard, undefined);
  assert.equal(keyboard.keyboard[1][0].text, '🎟 Buy Ticket');
  assert.equal(keyboard.keyboard[2].length, 2);
});
test('seller Mini App also uses supported keyboard transport', () => {
  const keyboard = ticketLauncherKeyboard({ url, lang: 'am', seller: true });
  assert.equal(keyboard.keyboard[1][0].text, '🧾 ትኬት ይሽጡ');
  assert.equal(keyboard.keyboard[0][0].web_app.url, url);
});
test('legacy inline transport and insecure URLs cannot generate launcher', () => {
  assert.throws(() => ticketLauncherKeyboard({ url: 'https://finotebirhan-ticket.vercel.app/?s=test' }), /keyboard/);
  assert.throws(() => ticketLauncherKeyboard({ url: 'http://finotebirhan-ticket.vercel.app/?transport=keyboard' }), /HTTPS/);
});
test('backend issues transport-verified reply keyboards, never inline webapp buttons', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /url\.searchParams\.set\('transport', 'keyboard'\)/);
  assert.match(source, /reply_markup: ticketLauncherKeyboard\(\{ url/);
  assert.doesNotMatch(source, /reply_markup: inlineKeyboard\(\[\[\{ text: buttonText, web_app:/);
});
test('browser blocks stale inline launches before sendData is called', () => {
  const source = fs.readFileSync(new URL('../../../app.js', import.meta.url), 'utf8');
  assert.match(source, /params\.get\('transport'\) === 'keyboard'/);
  assert.match(source, /!keyboardTransport/);
  assert.match(source, /tg\.sendData\(JSON\.stringify\(payload\)\)/);
});
