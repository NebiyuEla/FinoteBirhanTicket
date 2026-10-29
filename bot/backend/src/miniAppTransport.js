// Telegram.WebApp.sendData works only when opened from a reply KeyboardButton
// web_app. InlineKeyboardButton web_app can display the app but cannot submit
// its selection to the bot as web_app_data.
export function ticketLauncherKeyboard({ url, lang = 'am', seller = false }) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.searchParams.get('transport') !== 'keyboard') {
    throw new Error('Ticket Mini App requires a keyboard-transport HTTPS link.');
  }
  const am = lang !== 'en';
  return {
    keyboard: [
      [{
        text: am ? '🎟 ትኬቶችን ክፈት' : '🎟 Open live tickets',
        web_app: { url }
      }],
      [{
        text: seller ? (am ? '🧾 ትኬት ይሽጡ' : '🧾 Sell Tickets')
          : (am ? '🎟 ትኬት ይግዙ' : '🎟 Buy Ticket')
      }],
      [
        { text: am ? '🎫 የእኔ ትኬቶች' : '🎫 My Tickets' },
        { text: am ? '🏆 ውጤት' : '🏆 Results' }
      ]
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: am ? 'ትኬት ይምረጡ' : 'Choose your ticket'
  };
}
