import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ticketLauncherKeyboard, ticketLauncherInline, parseBuyerTicketDeepLink } from '../src/miniAppTransport.js';

const replyUrl = 'https://finotebirhan-ticket.vercel.app/?s=test&transport=keyboard';
const inlineUrl = 'https://finotebirhan-ticket.vercel.app/?s=test&transport=inline&bot=FinoteBirhanLotteryBot';

test('buyer opens from original inline button under a Telegram message, not the bottom keyboard', () => {
  const markup = ticketLauncherInline({ url: inlineUrl, lang: 'en' });
  assert.equal(markup.inline_keyboard[0][0].text, '🎟 Open live tickets');
  assert.equal(markup.inline_keyboard[0][0].web_app.url, inlineUrl);
  assert.equal(markup.keyboard, undefined);
  assert.deepEqual(ticketLauncherInline({ url: inlineUrl, lang: 'am' }).inline_keyboard[0][0].text, '🎟 ትኬቶችን ክፈት');
});

test('seller still uses Telegram keyboard launch supported by sendData', () => {
  const markup = ticketLauncherKeyboard({ url: replyUrl, lang: 'am', seller: true });
  assert.equal(markup.keyboard[0][0].text, '🧾 ትኬቶችን ክፈት');
  assert.equal(markup.keyboard[0][0].web_app.url, replyUrl);
  assert.equal(markup.inline_keyboard, undefined);
  assert.equal(markup.one_time_keyboard, true);
});

test('rejects malformed inline launchers and insecure URLs', () => {
  assert.throws(() => ticketLauncherInline({ url: replyUrl }), /inline launcher/);
  assert.throws(() => ticketLauncherInline({ url: 'http://evil.example/?transport=inline&bot=FinoteBirhanLotteryBot' }), /inline launcher/);
  assert.throws(() => ticketLauncherInline({ url: 'https://example.com/?transport=inline&bot=bad-url' }), /inline launcher/);
  assert.throws(() => ticketLauncherKeyboard({ url: inlineUrl }), /keyboard/);
});

test('deep link parses valid buyer packages and bundle', () => {
  const session = 'aBcdefghijklmnopqrstUVWX';
  assert.equal(session.length, 24);
  for (const [code, digits, pkg, numbers] of [
    ['2', '017', '200', { '200': 17 }],
    ['1', '200', '100', { '100': 200 }],
    ['5', '001', '50', { '50': 1 }],
    ['b', '001077200', 'bundle', { '200': 1, '100': 77, '50': 200 }]
  ]) {
    const parsed = parseBuyerTicketDeepLink('t_' + session + '_' + code + '_' + digits);
    assert.deepEqual(parsed, { type: 'ticket_selection', session, package: pkg, numbers });
  }
});

test('deep link rejects invalid, oversized, expired-format and non-ticket payloads', () => {
  const session = 'abcdefghijklmnopqrstuvwx';
  for (const payload of [
    't_abc_2_123', 't_' + session + '_2_999',
    't_' + session + '_2_000', 't_' + session + '_b_001002',
    't_' + session + '_b_001002999', 't_' + session + '_1_001002003',
    't_' + session + '_x_001', 't_' + session + '_2_001_extra'
  ]) assert.equal(parseBuyerTicketDeepLink(payload), null, payload);
});

test('backend uses inline buyer launcher and routes /start through existing authenticated reservation', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /url\.searchParams\.set\('transport', 'inline'\)/);
  assert.match(source, /url\.searchParams\.set\('bot', botInfo\.username\)/);
  assert.match(source, /ticketLauncherInline\(\{ url: url\.toString\(\)/);
  assert.match(source, /parseBuyerTicketDeepLink\(args\)/);
  assert.match(source, /getUsableWebSession\(payload\.session, telegramId\)/);
  assert.match(source, /consumeWebSession\(payload\.session, telegramId\)/);
});

test('Mini App uses Telegram deep-link for inline buyers, sendData only for keyboard launch', () => {
  const source = fs.readFileSync(new URL('../../../app.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("confirmBtn.addEventListener('click'"));
  assert.match(handler, /inlineTransport && mode === 'buyer'/);
  assert.match(handler, /'https:\/\/t\.me\/' \+ botUsername \+ '\?start='/);
  assert.match(handler, /tg\.openTelegramLink\(link\)/);
  assert.match(handler, /tg\.sendData\(JSON\.stringify\(payload\)\)/);
  assert.match(handler, /confirmBtn\.disabled = false/);
});

test('legacy unsupported launch method is refused without locking the button', () => {
  const source = fs.readFileSync(new URL('../../../app.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("confirmBtn.addEventListener('click'"));
  const guard = handler.indexOf("if (!((inlineTransport && mode === 'buyer') || (keyboardTransport && typeof tg?.sendData === 'function')))"); 
  assert.ok(guard >= 0 && handler.indexOf('confirmBtn.disabled = true') > guard);
});
