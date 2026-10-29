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
