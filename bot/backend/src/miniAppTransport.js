// Telegram WebApp.sendData requires a reply-keyboard web_app launch.
// Keep the original bot menu intact: this is a temporary one-button launcher,
// not a replacement navigation menu. sendMainMenu restores the original rows.
export function ticketLauncherKeyboard({ url, lang = 'am', seller = false }) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.searchParams.get('transport') !== 'keyboard') {
    throw new Error('Ticket Mini App requires a keyboard-transport HTTPS link.');
  }
  const am = lang !== 'en';
  return {
    keyboard: [[{
      text: seller ? (am ? '🧾 ትኬቶችን ክፈት' : '🧾 Open live tickets')
        : (am ? '🎟 ትኬቶችን ክፈት' : '🎟 Open live tickets'),
      web_app: { url }
    }]],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

/**
 * Buyer Mini Apps open from the original in-message button. Telegram does not
 * deliver sendData() from inline launches, so buyer selection returns to the
 * bot through an authenticated, short /start deep-link payload.
 */
export function ticketLauncherInline({ url, lang = 'am' }) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.searchParams.get('transport') !== 'inline' ||
      !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(parsed.searchParams.get('bot') || '')) {
    throw new Error('Ticket inline launcher requires a verified bot username.');
  }
  return {
    inline_keyboard: [[{
      text: lang === 'en' ? '🎟 Open live tickets' : '🎟 ትኬቶችን ክፈት',
      web_app: { url }
    }]]
  };
}

/** Only ASCII bot deep-link parameters; Telegram allows up to 64 chars. */
export function parseBuyerTicketDeepLink(parameter) {
  const match = /^t_([A-Za-z0-9_-]{24})_([215b])_([0-9]{3}|[0-9]{9})$/.exec(String(parameter || ''));
  if (!match) return null;
  const [, session, code, digits] = match;
  const bundle = code === 'b';
  if (digits.length !== (bundle ? 9 : 3)) return null;
  const pools = bundle ? [200, 100, 50] : [code === '2' ? 200 : code === '1' ? 100 : 50];
  const numbers = {};
  for (let i = 0; i < pools.length; i++) {
    const number = Number(digits.slice(i * 3, i * 3 + 3));
    if (number < 1 || number > 200) return null;
    numbers[String(pools[i])] = number;
  }
  return { type: 'ticket_selection', session, package: bundle ? 'bundle' : String(pools[0]), numbers };
}
