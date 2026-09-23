# FinoteBirhan Digital Ticket Bot — V5

Telegram bot backend for FinoteBirhan Sunday School digital tickets.

## Ticket pools
- 200 ETB: numbers 001–200
- 100 ETB: numbers 001–200
- 50 ETB: numbers 001–200
- Bundle: 300 ETB for one number in each pool

## Buyer flow
Buyers register with full name + Ethiopian mobile number, choose a ticket in the Mini App, reserve a number, pay the FinoteBirhan account, and submit a transaction reference/link. Verify.et handles supported references automatically. Raw receipt images go to admin review with Ask transaction link / Reject controls.

## Ticket Seller flow
Ticket Sellers are activated only by an admin using `/addseller TELEGRAM_ID` or Admin → Ticket Sellers → Add Ticket Seller.

There is no public seller registration and no seller customer-link flow.

An active Ticket Seller gets:
- `🧾 Sell Tickets` Mini App
- `📈 Seller Stats`
- `💳 Seller Account`

In Sell Tickets the seller enters the buyer full name and phone, chooses whether payment goes to FinoteBirhan or the seller's configured account, chooses package + number, and then manually taps `SOLD` only after payment is confirmed.

After SOLD:
- ticket is issued immediately
- seller receives the digital PNG ticket to forward
- if a registered bot user matches the buyer phone or exact normalized full name, the ticket is linked and delivered automatically
- if the buyer registers later with the matching phone/name, existing paid seller tickets are linked automatically

## Draw notifications
- public results use masked phone numbers
- linked winning buyers receive a separate private winner message
- the Ticket Seller who sold a winning ticket is notified with the buyer details

## DISCloud
Node 20 compatible. Upload the ZIP and configure environment variables in DISCloud.

Required:
- `BOT_TOKEN`
- `ADMIN_TELEGRAM_ID` or `ADMIN_SETUP_CODE`

Recommended:
- `MINI_APP_URL`
- `VERIFY_ET_API_KEY`
- `DEFAULT_PAYMENT_PROVIDER`
- `DEFAULT_PAYMENT_ACCOUNT_NAME`
- `DEFAULT_PAYMENT_ACCOUNT_NUMBER`

The SQLite database is created automatically at `./data/finotebirhan.sqlite` unless `DB_PATH` is changed.

## V6 updates
- Amharic is the default bot and Mini App language; users can switch to English from `🌐 ቋንቋ / Language`.
- `/setprize 100|የአማርኛ ሽልማት|English prize` changes the prize label shown in the Mini App and ticket messages. Valid pools: 200, 100, 50.
- `My Tickets / የእኔ ትኬቶች` sends the actual generated PNG ticket images again, not only a text list.
- Mini App keeps the Continue button visible while only the number grid scrolls internally.


V7 prize defaults: 200 ETB = የSt Mary ምስለ ሰዕል; 100 ETB = በእንጨት የተሰራ መጽሐፍ ቅዱስ; 50 ETB = ነጠላ፣ በኢፖክሲ የተሰራ 4:3 የSt Mary ምስለ ሰዕል እና የዝማሬ ኄራን ቁልፍ መያዣ. Bundle gives one number in each of the three draws.

## Admin force clear
Administrators can use the **🗑 Force Clear Data** button in the admin dashboard or send `/forceclear`.
The bot generates a one-time 6-character confirmation code valid for 5 minutes. The reset runs only after the admin sends `/forceclear CODE`.
It clears customers (except administrator profiles), Ticket Sellers, purchases/payment history, issued tickets, draw runs/winners, sessions, pending states, and old audit logs; it resets all 600 number positions to available. Admin access, payment configuration, and prize configuration are preserved. Sales reopen, winner publication state resets, and the draw date is cleared.


V9 wording update: 200 ETB and 50 ETB prize names use 'St Mary' consistently in Amharic/English. Existing databases migrate only the exact old default wording; admin-custom prize labels are preserved.


## V12 multi-account transfer payments
- Admin → **Transfer Accounts** can add multiple FinoteBirhan bank/wallet destinations without overwriting the existing account.
- Each account can be edited, enabled/disabled, deleted, or made the default.
- `/addpayment provider|account holder|account number` adds another account.
- `/paymentaccounts` opens the account manager.
- `/setpayment ...` now edits only the current default account for backward compatibility.
- When more than one account is active, direct buyers choose the destination after reserving their number; Ticket Sellers using the FinoteBirhan destination also choose the account.
- The selected provider, holder name, and account number are snapshotted onto the purchase before payment instructions are shown. Later admin edits/deletes do not rewrite historical purchases.
- Pre-V12 single-account settings are migrated automatically into the first/default account and are kept synchronized with the default for compatibility.

## V13 updates
- Admin → Transfer Accounts supports multiple FinoteBirhan payment accounts without overwriting existing accounts.
- Admin can add, edit, enable/disable, delete, and set a default account.
- Direct buyers and Ticket Sellers choose from active FinoteBirhan transfer accounts when more than one is available.
- Each purchase snapshots the selected account so payment history remains correct even if an account is edited or deleted later.
- Force Clear preserves configured transfer accounts.
