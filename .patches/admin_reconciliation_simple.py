from pathlib import Path
import re

path = Path('bot/backend/src/index.js')
text = path.read_text(encoding='utf-8')

replacement = r'''async function showRevenueReconciliation(telegramId) {
  if (!db.isAdmin(telegramId)) return bot.sendMessage(telegramId, 'Admin access required.');
  const am = langOf(telegramId) !== 'en';
  const s = db.dashboardStats();
  const next = db.unreconciledPaidPurchases(1)[0] || null;

  const summary = am
    ? `💵 የክፍያ ማረጋገጫ\n\n✅ በእውነት የገባ: ${s.confirmedRevenue} ብር · ${s.confirmedReceiptCount}\n⚠️ ማረጋገጥ የሚፈልግ: ${s.unreconciledRevenue} ብር · ${s.unreconciledCount}\n🚫 እንዳልገባ የተመዘገበ: ${s.notReceivedRevenue} ብር · ${s.notReceivedCount}\n🎟 SOLD ግዢዎች ዋጋ: ${s.salesValue} ብር\n\nSOLD መሆኑ ብቻ ገንዘቡ ገብቷል ማለት አይደለም።`
    : `💵 Payment Reconciliation\n\n✅ Confirmed received: ${s.confirmedRevenue} ETB · ${s.confirmedReceiptCount}\n⚠️ Needs checking: ${s.unreconciledRevenue} ETB · ${s.unreconciledCount}\n🚫 Marked not received: ${s.notReceivedRevenue} ETB · ${s.notReceivedCount}\n🎟 Sold purchase value: ${s.salesValue} ETB\n\nSOLD does not automatically mean the money was received.`;

  if (!next) {
    return bot.sendMessage(telegramId,
      `${summary}\n\n${am ? '✅ ሁሉም SOLD ግዢዎች ተመሳክረዋል።' : '✅ Every SOLD purchase has been reconciled.'}`,
      { reply_markup: inlineKeyboard([[{ text: am ? '⬅️ ዳሽቦርድ' : '⬅️ Dashboard', callback_data: 'admin_dashboard' }]]) }
    );
  }

  const source = next.source === 'seller'
    ? `${am ? 'ሻጭ' : 'Seller'}${next.seller_name ? ` · ${next.seller_name}` : ''}`
    : (am ? 'በቦት ቀጥታ' : 'Direct bot');
  const proof = next.payment_reference
    ? `${am ? 'ማጣቀሻ' : 'Reference'}: ${truncate(next.payment_reference, 120)}`
    : next.payment_file_id
      ? (am ? 'ማስረጃ: የደረሰኝ ምስል ተቀምጧል' : 'Proof: receipt image stored')
      : (am ? 'ማስረጃ: ምንም አልተቀመጠም' : 'Proof: none stored');

  return bot.sendMessage(telegramId,
    `${summary}\n\n──────────\n${am ? 'ቀጣይ ማረጋገጫ' : 'NEXT TO CHECK'}\n${next.amount_etb} ETB · ${packageLabel(next.package_type)}\n${source}\n${am ? 'ገዢ' : 'Buyer'}: ${next.buyer_name}\n${am ? 'ቁጥሮች' : 'Numbers'}: ${next.numbers || '-'}\n${proof}\n${am ? 'SOLD የሆነበት' : 'Marked SOLD'}: ${next.paid_at || next.created_at}\n\n${am ? 'ፍኖተ ብርሃን ይህን ገንዘብ በእውነት ተቀብሏል?' : 'Did FinoteBirhan actually receive this money?'}`,
    { reply_markup: inlineKeyboard([
      [{ text: am ? '✅ ገብቷል' : '✅ Received', callback_data: `admin_receipt_yes:${next.id}` }, { text: am ? '🚫 አልገባም' : '🚫 Not received', callback_data: `admin_receipt_no:${next.id}` }],
      [{ text: am ? '⬅️ ዳሽቦርድ' : '⬅️ Dashboard', callback_data: 'admin_dashboard' }]
    ]) }
  );
}

async function showPaymentAccounts(telegramId) {'''

text, count = re.subn(
    r"async function showRevenueReconciliation\(telegramId\) \{.*?\n\}\n\nasync function showPaymentAccounts\(telegramId\) \{",
    replacement,
    text,
    count=1,
    flags=re.S
)
if count != 1:
    raise SystemExit(f'simple reconciliation: expected 1 function match, found {count}')

path.write_text(text, encoding='utf-8')
print('Simple one-at-a-time reconciliation flow applied.')
