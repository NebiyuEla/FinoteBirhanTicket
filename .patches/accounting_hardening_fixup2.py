from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly 1 occurrence, found {count}: {old[:140]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

# Preserve terminal-state validation before the new seller-admin authorization guard.
replace_once(
    'bot/backend/src/db.js',
    "    if (purchase.status === 'paid') return purchase;\n"
    "    if (purchase.source === 'seller' && !this.isAdmin(reviewerId)) {\n"
    "      throw new Error('Seller-originated sales require FinoteBirhan admin payment approval before tickets can be marked sold.');\n"
    "    }\n"
    "    if (!['verification_pending', 'seller_review', 'manual_review', 'awaiting_proof'].includes(purchase.status)) throw new Error(`Purchase cannot be confirmed from status ${purchase.status}.`);\n",
    "    if (purchase.status === 'paid') return purchase;\n"
    "    if (!['verification_pending', 'seller_review', 'manual_review', 'awaiting_proof'].includes(purchase.status)) throw new Error(`Purchase cannot be confirmed from status ${purchase.status}.`);\n"
    "    if (purchase.source === 'seller' && !this.isAdmin(reviewerId)) {\n"
    "      throw new Error('Seller-originated sales require FinoteBirhan admin payment approval before tickets can be marked sold.');\n"
    "    }\n"
)

# Build-version regression expectation.
replace_once(
    'bot/backend/tests/navigationRecoveryCore.test.js',
    "  assert.match(source, /const BOT_BUILD = '1\\.3\\.5';/);\n",
    "  assert.match(source, /const BOT_BUILD = '1\\.3\\.6';/);\n"
)

# Seller-originated ticket-linking fixture now uses the existing admin reviewer.
replace_once(
    'bot/backend/tests/runtimeGuards.test.js',
    "  db.confirmPurchase(sale.id, 2, { note: 'paid' });\n",
    "  db.confirmPurchase(sale.id, 999, { note: 'paid and approved by admin' });\n"
)

# Seller-originated payment proof must go to FinoteBirhan admins, not back to the seller for final approval.
replace_once(
    'bot/backend/src/index.js',
    "    await bot.sendMessage(telegramId, tr(telegramId, `⏳ የክፍያ ማስረጃው ለ${updated.seller.display_name} ተልኳል። ክፍያውን ሲያረጋግጥ ትኬትዎ ይወጣል።`, `⏳ Payment proof sent to ${updated.seller.display_name}. Your ticket will be issued after the seller confirms receiving the payment.`));\n"
    "    await notifySellerReview(updated, message);\n",
    "    await bot.sendMessage(telegramId, tr(telegramId, '⏳ የክፍያ ማስረጃው ለፍኖተ ብርሃን አስተዳዳሪ ተልኳል። ክፍያው እስኪረጋገጥ ድረስ ትኬቱ SOLD አይሆንም።', '⏳ Payment proof sent to a FinoteBirhan administrator. The ticket will not become SOLD until the payment is approved.'));\n"
    "    await notifyAdminsOfReview(updated, message);\n"
)

# Remove misleading seller-owned account copy from the seller stats panel. Legacy data/methods remain readable for audit.
replace_once(
    'bot/backend/src/index.js',
    "    💳 የእርስዎ የክፍያ አካውንት\n"
    "    ${account}\n"
    "    \n"
    "    🧾 የቅርብ ሽያጮች\n",
    "    🏦 ሁሉም አዲስ ሽያጮች ወደ ፍኖተ ብርሃን አካውንት ይመዘገባሉ።\n"
    "    \n"
    "    🧾 የቅርብ ሽያጮች\n"
)

replace_once(
    'bot/backend/src/index.js',
    "    Your payment account\n"
    "    ${account}\n"
    "    \n"
    "    Recent sales\n",
    "    All new seller sales settle to the FinoteBirhan account and require admin approval.\n"
    "    \n"
    "    Recent sales\n"
)

replace_once(
    'bot/backend/src/index.js',
    "    { reply_markup: inlineKeyboard([[{ text: am ? '💳 የክፍያ አካውንት ቀይር' : '💳 Update payment account', callback_data: 'seller_account' }],[{ text: am ? '🔄 አድስ' : '🔄 Refresh', callback_data: 'seller_panel' }]]) }\n",
    "    { reply_markup: inlineKeyboard([[{ text: am ? '🔄 አድስ' : '🔄 Refresh', callback_data: 'seller_panel' }]]) }\n"
)

# Seller list should report sales value, not claim the amount was physically collected.
replace_once(
    'bot/backend/src/index.js',
    "      `Collected: ${seller.revenue} ETB · Pending: ${seller.pending_count}`\n",
    "      `Sales value: ${seller.revenue} ETB · Pending: ${seller.pending_count}`\n"
)

# Seller mini-app: remove seller-owned payment destination from the active UI and payload.
replace_once('app.js', "  const sellerPayAvailable = params.get('sellerpay') === '1';\n", "  const sellerPayAvailable = false;\n")
replace_once(
    'app.js',
    "      paymentDestination:'Where will the buyer pay?', finoteBirhan:'FinoteBirhan', sellerAccount:'My account',\n",
    "      paymentDestination:'Payment destination', finoteBirhan:'FinoteBirhan account', sellerAccount:'Unavailable',\n"
)
replace_once(
    'app.js',
    "      sellerPayNote:'The buyer pays your account. After you see the money, tap SOLD.',\n"
    "      finotePayNote:'The buyer pays the FinoteBirhan account. After payment is confirmed, tap SOLD.',\n",
    "      sellerPayNote:'Seller-owned payment destinations are disabled. All sales settle to FinoteBirhan.',\n"
    "      finotePayNote:'All seller sales settle to the FinoteBirhan account. After the buyer pays, FinoteBirhan admin approval is required before the ticket becomes SOLD.',\n"
)
replace_once(
    'app.js',
    "      paymentDestination:'ክፍያ የት ይገባ?', finoteBirhan:'ፍኖተ ብርሃን', sellerAccount:'የእኔ አካውንት',\n",
    "      paymentDestination:'የክፍያ መድረሻ', finoteBirhan:'ፍኖተ ብርሃን አካውንት', sellerAccount:'አይገኝም',\n"
)
replace_once(
    'app.js',
    "      sellerPayNote:'ገዢው ወደ እርስዎ አካውንት ይከፍላል። ገንዘቡን ካዩ በኋላ “ተሽጧል” ይጫኑ።',\n"
    "      finotePayNote:'ገዢው ወደ ፍኖተ ብርሃን አካውንት ይከፍላል። ክፍያውን ካረጋገጡ በኋላ “ተሽጧል” ይጫኑ።',\n",
    "      sellerPayNote:'የሻጭ የግል አካውንት ለአዲስ ሽያጭ አይጠቀምም። ሁሉም ሽያጭ ወደ ፍኖተ ብርሃን ይመዘገባል።',\n"
    "      finotePayNote:'ሁሉም የሻጭ ሽያጭ ወደ ፍኖተ ብርሃን አካውንት ይመዘገባል። ገዢው ከከፈለ በኋላ ትኬቱ SOLD ከመሆኑ በፊት የፍኖተ ብርሃን አስተዳዳሪ ማረጋገጥ አለበት።',\n"
)
replace_once(
    'app.js',
    "  paySeller.disabled = !sellerPayAvailable;\n",
    "  paySeller.disabled = true;\n"
    "  paySeller.hidden = true;\n"
)
replace_once(
    'app.js',
    "      payload.payment_target = state.paymentTarget;\n",
    "      payload.payment_target = 'finote';\n"
)

# Hide the obsolete destination button in static markup too, before JS runs.
replace_once(
    'index.html',
    '<button id="paySeller" class="pay-option" type="button" data-pay="seller" data-i18n="sellerAccount">የእኔ አካውንት</button>',
    '<button id="paySeller" class="pay-option" type="button" data-pay="seller" data-i18n="sellerAccount" hidden disabled>አይገኝም</button>'
)

print('Remaining accounting hardening regressions and seller settlement UI fixed.')
