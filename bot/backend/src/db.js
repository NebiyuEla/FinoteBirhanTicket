import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
let DatabaseCtor;
try {
  const { DatabaseSync } = await import('node:sqlite');
  DatabaseCtor = DatabaseSync;
} catch (error) {
  if (error?.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
  const module = await import('better-sqlite3');
  DatabaseCtor = module.default;
}
import { addMinutesIso, amountForPackage, formatNumber, normalizeNameForCompare, normalizePhone, nowIso, packagePools, randomToken, sha256, shortCode } from './utils.js';

export class TicketDatabase {
  constructor(dbPath, { reservationMinutes = 10, manualReviewMinutes = 30 } = {}) {
    this.dbPath = dbPath;
    this.reservationMinutes = reservationMinutes;
    this.manualReviewMinutes = manualReviewMinutes;
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseCtor(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
    this.seedNumbers();
  }

  close() { this.db.close(); }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        full_name TEXT,
        phone TEXT,
        registration_state TEXT NOT NULL DEFAULT 'new',
        active_seller_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admins (
        telegram_id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sellers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        payment_provider TEXT NOT NULL,
        account_name TEXT NOT NULL,
        account_number TEXT NOT NULL,
        seller_code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','suspended')),
        created_at TEXT NOT NULL,
        approved_at TEXT,
        approved_by INTEGER,
        FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
      );

      CREATE TABLE IF NOT EXISTS payment_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        account_name TEXT NOT NULL,
        account_number TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by INTEGER,
        updated_by INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS payment_accounts_one_default
      ON payment_accounts(is_default) WHERE is_default=1;

      CREATE UNIQUE INDEX IF NOT EXISTS payment_accounts_provider_number_unique
      ON payment_accounts(lower(provider),account_number);

      CREATE TABLE IF NOT EXISTS seller_invites (
        telegram_id INTEGER PRIMARY KEY,
        invited_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
      );

      CREATE TABLE IF NOT EXISTS ticket_numbers (
        pool INTEGER NOT NULL CHECK(pool IN (50,100,200)),
        number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 200),
        status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','reserved','sold')),
        purchase_id TEXT,
        reserved_until TEXT,
        buyer_telegram_id INTEGER,
        seller_id INTEGER,
        sold_at TEXT,
        PRIMARY KEY(pool, number)
      );

      CREATE TABLE IF NOT EXISTS purchases (
        id TEXT PRIMARY KEY,
        buyer_telegram_id INTEGER NOT NULL,
        buyer_name TEXT NOT NULL,
        buyer_phone TEXT NOT NULL,
        package_type TEXT NOT NULL CHECK(package_type IN ('bundle','200','100','50')),
        amount_etb INTEGER NOT NULL,
        seller_id INTEGER,
        source TEXT NOT NULL CHECK(source IN ('direct','seller')),
        status TEXT NOT NULL CHECK(status IN ('reserved','awaiting_proof','verification_pending','seller_review','manual_review','paid','rejected','expired','cancelled')),
        payment_provider TEXT,
        payment_reference TEXT,
        payment_file_id TEXT,
        verify_request_id TEXT,
        verification_payload TEXT,
        reserved_until TEXT NOT NULL,
        created_at TEXT NOT NULL,
        submitted_at TEXT,
        paid_at TEXT,
        reviewed_by INTEGER,
        note TEXT,
        FOREIGN KEY(buyer_telegram_id) REFERENCES users(telegram_id),
        FOREIGN KEY(seller_id) REFERENCES sellers(id)
      );

      CREATE TABLE IF NOT EXISTS purchase_numbers (
        purchase_id TEXT NOT NULL,
        pool INTEGER NOT NULL,
        number INTEGER NOT NULL,
        PRIMARY KEY(purchase_id, pool),
        UNIQUE(pool, number, purchase_id),
        FOREIGN KEY(purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS purchases_unique_reference
      ON purchases(payment_reference) WHERE payment_reference IS NOT NULL AND payment_reference <> '';

      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        purchase_id TEXT NOT NULL,
        pool INTEGER NOT NULL,
        number INTEGER NOT NULL,
        owner_telegram_id INTEGER NOT NULL,
        owner_name TEXT NOT NULL,
        owner_phone TEXT NOT NULL,
        seller_id INTEGER,
        issued_at TEXT NOT NULL,
        UNIQUE(pool, number),
        FOREIGN KEY(purchase_id) REFERENCES purchases(id)
      );

      CREATE TABLE IF NOT EXISTS web_sessions (
        token TEXT PRIMARY KEY,
        telegram_id INTEGER NOT NULL,
        seller_id INTEGER,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_state (
        telegram_id INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by INTEGER
      );

      CREATE TABLE IF NOT EXISTS draw_runs (
        id TEXT PRIMARY KEY,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        published_at TEXT
      );

      CREATE TABLE IF NOT EXISTS winners (
        pool INTEGER PRIMARY KEY,
        draw_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        purchase_id TEXT NOT NULL,
        winner_telegram_id INTEGER NOT NULL,
        winner_name TEXT NOT NULL,
        winner_phone TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        candidate_count INTEGER NOT NULL,
        drawn_at TEXT NOT NULL,
        published_at TEXT,
        FOREIGN KEY(draw_id) REFERENCES draw_runs(id),
        FOREIGN KEY(ticket_id) REFERENCES tickets(id)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_telegram_id INTEGER,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);

    this.ensureColumn('users', 'language', "TEXT NOT NULL DEFAULT 'am'");
    const addedPurchaseLink = this.ensureColumn('purchases', 'linked_telegram_id', 'INTEGER');
    this.ensureColumn('purchases', 'payment_target', "TEXT NOT NULL DEFAULT 'finote'");
    this.ensureColumn('purchases', 'payment_account_id', 'INTEGER');
    this.ensureColumn('purchases', 'payment_account_name', 'TEXT');
    this.ensureColumn('purchases', 'payment_account_number', 'TEXT');
    const addedTicketLink = this.ensureColumn('tickets', 'linked_telegram_id', 'INTEGER');
    // V4 and earlier seller purchases belonged to the buyer Telegram account.
    // Backfill only on the one-time schema upgrade so existing tickets stay attached.
    if (addedPurchaseLink) this.db.exec(`UPDATE purchases SET linked_telegram_id=buyer_telegram_id WHERE linked_telegram_id IS NULL`);
    if (addedTicketLink) this.db.exec(`UPDATE tickets SET linked_telegram_id=owner_telegram_id WHERE linked_telegram_id IS NULL`);

    const defaults = [
      ['sales_open', 'true'],
      ['payment_provider', ''],
      ['payment_account_name', ''],
      ['payment_account_number', ''],
      ['draw_at', ''],
      ['winners_published', 'false'],
      ['prize_200_am', 'የቅድስት ማርያም ምስለ ሰዕል'],
      ['prize_200_en', 'St Mary icon'],
      ['prize_100_am', 'በእንጨት የተደጎሰ መጽሐፍ ቅዱስ'],
      ['prize_100_en', 'Handcrafted Wooden Bible'],
      ['prize_50_am', 'ነጠላ፣ በኢፖክሲ የተሰራ 4:3 የቅድስት ማርያም ምስለ ሰዕል እና የዝማሬ ኄራን ቁልፍ መያዣ'],
      ['prize_50_en', 'Netela, 4:3 epoxy St Mary icon and Zemare Heran keychain']
    ];
    const insert = this.db.prepare('INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)');
    const now = nowIso();
    for (const [key, value] of defaults) insert.run(key, value, now);

    // Upgrade only legacy default prize labels; preserve any admin-customized values.
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_200_am' AND value='ዋና ሽልማት'`).run('የቅድስት ማርያም ምስለ ሰዕል', now);
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_200_en' AND value='Grand Prize'`).run('St Mary icon', now);
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_100_en' AND value='Wooden Bible'`).run('Handcrafted Wooden Bible', now);
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_100_am' AND value IN ('የእንጨት መጽሐፍ ቅዱስ','በእንጨት የተሰራ መጽሐፍ ቅዱስ')`).run('በእንጨት የተደጎሰ መጽሐፍ ቅዱስ', now);
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_50_am' AND value='የSt Mary ምስል + ቁልፍ ማንጠልጠያ'`).run('ነጠላ፣ በኢፖክሲ የተሰራ 4:3 የቅድስት ማርያም ምስለ ሰዕል እና የዝማሬ ኄራን ቁልፍ መያዣ', now);
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_50_en' AND value='St Mary icon + keychain'`).run('Netela, 4:3 epoxy St Mary icon and Zemare Heran keychain', now);
    // V10 Amharic terminology migration: use ቅድስት ማርያም while preserving English 'St Mary'.
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_200_am' AND value='የSt Mary ምስለ ሰዕል'`).run('የቅድስት ማርያም ምስለ ሰዕል', now);
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_50_am' AND value='ነጠላ፣ በኢፖክሲ የተሰራ 4:3 የSt Mary ምስለ ሰዕል እና የዝማሬ ኄራን ቁልፍ መያዣ'`).run('ነጠላ፣ በኢፖክሲ የተሰራ 4:3 የቅድስት ማርያም ምስለ ሰዕል እና የዝማሬ ኄራን ቁልፍ መያዣ', now);
    // V9 St Mary wording migration: only migrate exact previous defaults, preserving admin custom values.
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_200_am' AND value='የእምቤታችን ምስለ ሰዕል'`).run('የቅድስት ማርያም ምስለ ሰዕል', now);
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_200_en' AND value='Icon of Our Lady'`).run('St Mary icon', now);
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_50_am' AND value='ነጠላ፣ በኢፖክሲ የተሰራ 4:3 የእመቤታችን ምስለ ሰዕል እና የዝማሬ ኄራን ቁልፍ መያዣ'`).run('ነጠላ፣ በኢፖክሲ የተሰራ 4:3 የቅድስት ማርያም ምስለ ሰዕል እና የዝማሬ ኄራን ቁልፍ መያዣ', now);
    this.db.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key='prize_50_en' AND value='Netela, 4:3 epoxy icon of Our Lady and Zemare Heran keychain'`).run('Netela, 4:3 epoxy St Mary icon and Zemare Heran keychain', now);

    // Preserve the pre-V12 single FinoteBirhan payment destination as the
    // first/default account. This is additive: the legacy settings stay in
    // place for compatibility and no configured account is overwritten.
    this.ensureLegacyPaymentAccount(null);
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => row.name === column)) return false;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }

  seedNumbers() {
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM ticket_numbers').get().c;
    if (count === 600) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare('INSERT OR IGNORE INTO ticket_numbers(pool,number,status) VALUES(?,?,\'available\')');
      for (const pool of [200, 100, 50]) for (let n = 1; n <= 200; n += 1) stmt.run(pool, n);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  log(actorTelegramId, action, targetType = null, targetId = null, metadata = {}) {
    this.db.prepare(`INSERT INTO audit_logs(actor_telegram_id,action,target_type,target_id,metadata_json,created_at)
      VALUES(?,?,?,?,?,?)`).run(actorTelegramId ?? null, action, targetType, targetId, JSON.stringify(metadata), nowIso());
  }

  getUser(telegramId) {
    return this.db.prepare('SELECT * FROM users WHERE telegram_id=?').get(telegramId) ?? null;
  }

  ensureUser(telegramId) {
    const now = nowIso();
    this.db.prepare(`INSERT OR IGNORE INTO users(telegram_id,created_at,updated_at) VALUES(?,?,?)`).run(telegramId, now, now);
    return this.getUser(telegramId);
  }

  getUserLanguage(telegramId) {
    const user = this.getUser(telegramId);
    return user?.language === 'en' ? 'en' : 'am';
  }

  setUserLanguage(telegramId, language) {
    this.ensureUser(telegramId);
    const value = language === 'en' ? 'en' : 'am';
    this.db.prepare('UPDATE users SET language=?, updated_at=? WHERE telegram_id=?').run(value, nowIso(), telegramId);
    return value;
  }

  setUserName(telegramId, fullName) {
    this.ensureUser(telegramId);
    this.db.prepare(`UPDATE users SET full_name=?, registration_state='awaiting_phone', updated_at=? WHERE telegram_id=?`).run(fullName, nowIso(), telegramId);
  }

  setUserPhone(telegramId, phone) {
    this.ensureUser(telegramId);
    this.db.prepare(`UPDATE users SET phone=?, registration_state='complete', updated_at=? WHERE telegram_id=?`).run(phone, nowIso(), telegramId);
  }

  setActiveSeller(telegramId, sellerId) {
    this.ensureUser(telegramId);
    this.db.prepare('UPDATE users SET active_seller_id=?, updated_at=? WHERE telegram_id=?').run(sellerId, nowIso(), telegramId);
  }

  clearActiveSeller(telegramId) {
    this.db.prepare('UPDATE users SET active_seller_id=NULL, updated_at=? WHERE telegram_id=?').run(nowIso(), telegramId);
  }

  isAdmin(telegramId) {
    return Boolean(this.db.prepare('SELECT 1 FROM admins WHERE telegram_id=?').get(telegramId));
  }

  adminCount() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  }

  listAdmins() {
    return this.db.prepare('SELECT telegram_id FROM admins ORDER BY created_at').all().map((r) => r.telegram_id);
  }

  addAdmin(telegramId) {
    this.ensureUser(telegramId);
    this.db.prepare('INSERT OR IGNORE INTO admins(telegram_id,created_at) VALUES(?,?)').run(telegramId, nowIso());
    this.log(telegramId, 'admin.claimed', 'admin', String(telegramId));
  }

  inviteSeller(telegramId, adminId) {
    this.ensureUser(telegramId);
    const existing = this.getSellerByTelegram(telegramId);
    if (existing?.status === 'approved') return { alreadyApproved: true, seller: existing };
    this.db.prepare(`INSERT INTO seller_invites(telegram_id,invited_by,created_at) VALUES(?,?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET invited_by=excluded.invited_by,created_at=excluded.created_at`)
      .run(telegramId, adminId, nowIso());
    this.log(adminId, 'seller.invited', 'seller_invite', String(telegramId));
    return { alreadyApproved: false, invite: this.getSellerInvite(telegramId) };
  }

  activateSellerRole(telegramId, adminId) {
    this.ensureUser(telegramId);
    const user = this.getUser(telegramId);
    if (!user || user.registration_state !== 'complete' || !user.full_name || !user.phone) {
      return this.inviteSeller(telegramId, adminId);
    }
    let seller = this.getSellerByTelegram(telegramId);
    if (!seller) {
      let sellerCode;
      do { sellerCode = shortCode(7); } while (this.db.prepare('SELECT 1 FROM sellers WHERE seller_code=?').get(sellerCode));
      this.db.prepare(`INSERT INTO sellers(telegram_id,display_name,phone,payment_provider,account_name,account_number,seller_code,status,created_at,approved_at,approved_by)
        VALUES(?,?,?,?,?,?,?,'approved',?,?,?)`)
        .run(telegramId, user.full_name, user.phone, '', '', '', sellerCode, nowIso(), nowIso(), adminId);
    } else {
      this.db.prepare(`UPDATE sellers SET display_name=?,phone=?,status='approved',approved_at=?,approved_by=? WHERE telegram_id=?`)
        .run(user.full_name, user.phone, nowIso(), adminId, telegramId);
    }
    this.clearSellerInvite(telegramId);
    seller = this.getSellerByTelegram(telegramId);
    this.log(adminId, 'seller.activated', 'seller', String(seller.id), { telegramId });
    return { alreadyApproved: false, seller, activated: true };
  }

  activateSellerIfInvited(telegramId) {
    const invite = this.getSellerInvite(telegramId);
    if (!invite) return null;
    const result = this.activateSellerRole(telegramId, invite.invited_by);
    return result?.seller ?? null;
  }

  getSellerInvite(telegramId) {
    return this.db.prepare('SELECT * FROM seller_invites WHERE telegram_id=?').get(telegramId) ?? null;
  }

  isSellerInvited(telegramId) {
    return Boolean(this.getSellerInvite(telegramId));
  }

  clearSellerInvite(telegramId) {
    this.db.prepare('DELETE FROM seller_invites WHERE telegram_id=?').run(telegramId);
  }

  listSellerInvites(limit = 100) {
    return this.db.prepare(`SELECT i.*,u.full_name,u.phone FROM seller_invites i LEFT JOIN users u ON u.telegram_id=i.telegram_id ORDER BY i.created_at DESC LIMIT ?`).all(limit);
  }

  getSellerByTelegram(telegramId) {
    return this.db.prepare('SELECT * FROM sellers WHERE telegram_id=?').get(telegramId) ?? null;
  }

  getSellerByCode(code) {
    return this.db.prepare(`SELECT * FROM sellers WHERE seller_code=? AND status='approved'`).get(String(code || '').toUpperCase()) ?? null;
  }

  getSellerById(id) {
    return this.db.prepare('SELECT * FROM sellers WHERE id=?').get(id) ?? null;
  }

  createSeller({ telegramId, displayName, phone, paymentProvider, accountName, accountNumber }) {
    const existing = this.getSellerByTelegram(telegramId);
    if (existing && ['pending', 'approved', 'suspended'].includes(existing.status)) return existing;
    let sellerCode;
    do { sellerCode = shortCode(7); } while (this.db.prepare('SELECT 1 FROM sellers WHERE seller_code=?').get(sellerCode));
    if (existing) {
      this.db.prepare(`UPDATE sellers SET display_name=?,phone=?,payment_provider=?,account_name=?,account_number=?,seller_code=?,status='pending',created_at=?,approved_at=NULL,approved_by=NULL WHERE telegram_id=?`)
        .run(displayName, phone, paymentProvider, accountName, accountNumber, sellerCode, nowIso(), telegramId);
    } else {
      this.db.prepare(`INSERT INTO sellers(telegram_id,display_name,phone,payment_provider,account_name,account_number,seller_code,status,created_at)
        VALUES(?,?,?,?,?,?,?,'pending',?)`).run(telegramId, displayName, phone, paymentProvider, accountName, accountNumber, sellerCode, nowIso());
    }
    const seller = this.getSellerByTelegram(telegramId);
    this.log(telegramId, 'seller.registered', 'seller', String(seller.id));
    return seller;
  }

  listPendingSellers(limit = 20) {
    return this.db.prepare(`SELECT * FROM sellers WHERE status='pending' ORDER BY created_at ASC LIMIT ?`).all(limit);
  }

  setSellerStatus(sellerId, status, adminId) {
    if (!['approved', 'rejected', 'suspended'].includes(status)) throw new Error('Invalid seller status');
    const now = nowIso();
    const approvedAt = status === 'approved' ? now : null;
    this.db.prepare('UPDATE sellers SET status=?,approved_at=?,approved_by=? WHERE id=?').run(status, approvedAt, adminId, sellerId);
    this.log(adminId, `seller.${status}`, 'seller', String(sellerId));
    return this.db.prepare('SELECT * FROM sellers WHERE id=?').get(sellerId) ?? null;
  }

  getApprovedSellers(limit = 100) {
    return this.db.prepare(`SELECT * FROM sellers WHERE status='approved' ORDER BY display_name LIMIT ?`).all(limit);
  }

  updateSellerAccount(telegramId, { paymentProvider, accountName, accountNumber }) {
    this.db.prepare(`UPDATE sellers SET payment_provider=?,account_name=?,account_number=? WHERE telegram_id=? AND status='approved'`)
      .run(paymentProvider, accountName, accountNumber, telegramId);
    this.log(telegramId, 'seller.account_updated', 'seller', String(telegramId));
    return this.getSellerByTelegram(telegramId);
  }

  sellerHasPaymentAccount(sellerId) {
    const seller = this.getSellerById(sellerId);
    return Boolean(seller?.payment_provider && seller?.account_name && seller?.account_number);
  }

  ensureLegacyPaymentAccount(adminId = null) {
    const existing = this.db.prepare('SELECT COUNT(*) AS c FROM payment_accounts').get().c;
    if (existing > 0) return this.getDefaultPaymentAccount();
    const provider = String(this.getSetting('payment_provider') || '').trim();
    const accountName = String(this.getSetting('payment_account_name') || '').trim();
    const accountNumber = String(this.getSetting('payment_account_number') || '').trim();
    if (!provider || !accountName || !accountNumber) return null;
    const now = nowIso();
    this.db.prepare(`INSERT INTO payment_accounts(provider,account_name,account_number,is_active,is_default,created_at,updated_at,created_by,updated_by)
      VALUES(?,?,?,1,1,?,?,?,?)`).run(provider, accountName, accountNumber, now, now, adminId, adminId);
    return this.getDefaultPaymentAccount();
  }

  listPaymentAccounts({ activeOnly = false } = {}) {
    return this.db.prepare(`SELECT * FROM payment_accounts ${activeOnly ? 'WHERE is_active=1' : ''} ORDER BY is_default DESC,is_active DESC,id ASC`).all();
  }

  getPaymentAccount(id) {
    return this.db.prepare('SELECT * FROM payment_accounts WHERE id=?').get(Number(id)) ?? null;
  }

  getDefaultPaymentAccount() {
    return this.db.prepare(`SELECT * FROM payment_accounts WHERE is_active=1 ORDER BY is_default DESC,id ASC LIMIT 1`).get() ?? null;
  }

  validatePaymentAccountFields({ provider, accountName, accountNumber }) {
    const clean = {
      provider: String(provider || '').trim(),
      accountName: String(accountName || '').trim(),
      accountNumber: String(accountNumber || '').trim()
    };
    if (clean.provider.length < 2 || clean.provider.length > 30) throw new Error('Payment provider must be 2–30 characters.');
    if (clean.accountName.length < 2 || clean.accountName.length > 80) throw new Error('Account holder name must be 2–80 characters.');
    if (clean.accountNumber.length < 4 || clean.accountNumber.length > 50) throw new Error('Account number must be 4–50 characters.');
    return clean;
  }

  addPaymentAccount(fields, adminId, { makeDefault = false } = {}) {
    const clean = this.validatePaymentAccountFields(fields);
    const duplicate = this.db.prepare(`SELECT id FROM payment_accounts WHERE lower(provider)=lower(?) AND account_number=?`).get(clean.provider, clean.accountNumber);
    if (duplicate) throw new Error('That transfer account already exists.');
    const hasActive = Boolean(this.db.prepare('SELECT 1 FROM payment_accounts WHERE is_active=1 LIMIT 1').get());
    const shouldDefault = Boolean(makeDefault || !hasActive);
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (shouldDefault) this.db.prepare('UPDATE payment_accounts SET is_default=0,updated_at=?,updated_by=?').run(now, adminId ?? null);
      const result = this.db.prepare(`INSERT INTO payment_accounts(provider,account_name,account_number,is_active,is_default,created_at,updated_at,created_by,updated_by)
        VALUES(?,?,?,1,?,?,?,?,?)`).run(clean.provider, clean.accountName, clean.accountNumber, shouldDefault ? 1 : 0, now, now, adminId ?? null, adminId ?? null);
      const account = this.getPaymentAccount(Number(result.lastInsertRowid));
      if (shouldDefault) this.syncLegacyPaymentSettings(account, adminId);
      this.db.exec('COMMIT');
      this.log(adminId, 'payment_account.added', 'payment_account', String(account.id), { provider: account.provider, isDefault: Boolean(account.is_default) });
      return account;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updatePaymentAccount(id, fields, adminId) {
    const account = this.getPaymentAccount(id);
    if (!account) throw new Error('Transfer account not found.');
    const clean = this.validatePaymentAccountFields(fields);
    const duplicate = this.db.prepare(`SELECT id FROM payment_accounts WHERE lower(provider)=lower(?) AND account_number=? AND id<>?`).get(clean.provider, clean.accountNumber, account.id);
    if (duplicate) throw new Error('That transfer account already exists.');
    this.db.prepare(`UPDATE payment_accounts SET provider=?,account_name=?,account_number=?,updated_at=?,updated_by=? WHERE id=?`)
      .run(clean.provider, clean.accountName, clean.accountNumber, nowIso(), adminId ?? null, account.id);
    const updated = this.getPaymentAccount(account.id);
    if (updated.is_default) this.syncLegacyPaymentSettings(updated, adminId);
    this.log(adminId, 'payment_account.updated', 'payment_account', String(account.id), { provider: updated.provider });
    return updated;
  }

  setDefaultPaymentAccount(id, adminId) {
    const account = this.getPaymentAccount(id);
    if (!account) throw new Error('Transfer account not found.');
    if (!account.is_active) throw new Error('Enable this account before making it the default.');
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE payment_accounts SET is_default=0,updated_at=?,updated_by=? WHERE is_default=1').run(now, adminId ?? null);
      this.db.prepare('UPDATE payment_accounts SET is_default=1,updated_at=?,updated_by=? WHERE id=?').run(now, adminId ?? null, account.id);
      const updated = this.getPaymentAccount(account.id);
      this.syncLegacyPaymentSettings(updated, adminId);
      this.db.exec('COMMIT');
      this.log(adminId, 'payment_account.default_changed', 'payment_account', String(account.id));
      return updated;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setPaymentAccountActive(id, active, adminId) {
    const account = this.getPaymentAccount(id);
    if (!account) throw new Error('Transfer account not found.');
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE payment_accounts SET is_active=?,is_default=CASE WHEN ?=0 THEN 0 ELSE is_default END,updated_at=?,updated_by=? WHERE id=?')
        .run(active ? 1 : 0, active ? 1 : 0, now, adminId ?? null, account.id);
      let defaultAccount = this.getDefaultPaymentAccount();
      if (defaultAccount && !defaultAccount.is_default) {
        this.db.prepare('UPDATE payment_accounts SET is_default=1,updated_at=?,updated_by=? WHERE id=?').run(now, adminId ?? null, defaultAccount.id);
        defaultAccount = this.getPaymentAccount(defaultAccount.id);
      }
      this.syncLegacyPaymentSettings(defaultAccount, adminId);
      this.db.exec('COMMIT');
      const updated = this.getPaymentAccount(account.id);
      this.log(adminId, active ? 'payment_account.enabled' : 'payment_account.disabled', 'payment_account', String(account.id));
      return updated;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deletePaymentAccount(id, adminId) {
    const account = this.getPaymentAccount(id);
    if (!account) throw new Error('Transfer account not found.');
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM payment_accounts WHERE id=?').run(account.id);
      let defaultAccount = this.getDefaultPaymentAccount();
      if (defaultAccount && !defaultAccount.is_default) {
        this.db.prepare('UPDATE payment_accounts SET is_default=1,updated_at=?,updated_by=? WHERE id=?').run(now, adminId ?? null, defaultAccount.id);
        defaultAccount = this.getPaymentAccount(defaultAccount.id);
      }
      if (account.is_default || !defaultAccount) this.syncLegacyPaymentSettings(defaultAccount, adminId);
      this.db.exec('COMMIT');
      this.log(adminId, 'payment_account.deleted', 'payment_account', String(account.id), { provider: account.provider });
      return account;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updateDefaultPaymentAccount(fields, adminId) {
    const current = this.getDefaultPaymentAccount();
    if (!current) return this.addPaymentAccount(fields, adminId, { makeDefault: true });
    return this.updatePaymentAccount(current.id, fields, adminId);
  }

  syncLegacyPaymentSettings(account, adminId = null) {
    const now = nowIso();
    const values = account
      ? [['payment_provider', account.provider], ['payment_account_name', account.account_name], ['payment_account_number', account.account_number]]
      : [['payment_provider', ''], ['payment_account_name', ''], ['payment_account_number', '']];
    const stmt = this.db.prepare(`INSERT INTO settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`);
    for (const [key, value] of values) stmt.run(key, value, now, adminId ?? null);
  }

  assignPaymentAccountToPurchase(purchaseId, accountId, actorId = null) {
    this.releaseExpiredReservations();
    const purchase = this.getPurchase(purchaseId);
    if (!purchase) throw new Error('Purchase not found.');
    if (!['awaiting_proof', 'seller_review'].includes(purchase.status)) throw new Error('This purchase can no longer change payment account.');
    if (purchase.payment_target !== 'finote') throw new Error('This purchase uses the seller payment account.');
    const account = this.getPaymentAccount(accountId);
    if (!account || !account.is_active) throw new Error('That transfer account is not available.');
    this.db.prepare(`UPDATE purchases SET payment_account_id=?,payment_provider=?,payment_account_name=?,payment_account_number=? WHERE id=?`)
      .run(account.id, account.provider, account.account_name, account.account_number, purchase.id);
    this.log(actorId, 'purchase.payment_account_selected', 'purchase', purchase.id, { paymentAccountId: account.id, provider: account.provider });
    return this.getPurchase(purchase.id);
  }

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? '';
  }

  setSetting(key, value, adminId) {
    this.db.prepare(`INSERT INTO settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(key, String(value), nowIso(), adminId ?? null);
    this.log(adminId, 'setting.updated', 'setting', key, { value: key.includes('account_number') ? '***' : String(value) });
    if (['payment_provider', 'payment_account_name', 'payment_account_number'].includes(key)) this.ensureLegacyPaymentAccount(adminId);
  }

  salesOpen() { return this.getSetting('sales_open') === 'true'; }

  releaseExpiredReservations() {
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const expired = this.db.prepare(`SELECT id FROM purchases WHERE status IN ('reserved','awaiting_proof','verification_pending','seller_review','manual_review') AND reserved_until < ?`).all(now);
      for (const row of expired) {
        this.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL WHERE purchase_id=? AND status='reserved'`).run(row.id);
        this.db.prepare(`UPDATE purchases SET status='expired', note=COALESCE(note,'') || ' [auto-expired]' WHERE id=?`).run(row.id);
      }
      this.db.exec('COMMIT');
      return expired.length;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  availability() {
    this.releaseExpiredReservations();
    const out = { 200: [], 100: [], 50: [] };
    const rows = this.db.prepare(`SELECT pool,number FROM ticket_numbers WHERE status<>'available' ORDER BY pool,number`).all();
    for (const row of rows) out[row.pool].push(row.number);
    return out;
  }

  createWebSession(telegramId, sellerId = null, ttlMinutes = 30) {
    const token = randomToken(18);
    const now = nowIso();
    this.db.prepare('INSERT INTO web_sessions(token,telegram_id,seller_id,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(token, telegramId, sellerId, addMinutesIso(ttlMinutes), now);
    return token;
  }

  consumeWebSession(token, telegramId) {
    const row = this.db.prepare('SELECT * FROM web_sessions WHERE token=?').get(token);
    if (!row || row.telegram_id !== telegramId || row.used_at || row.expires_at < nowIso()) return null;
    this.db.prepare('UPDATE web_sessions SET used_at=? WHERE token=?').run(nowIso(), token);
    return row;
  }

  reservePurchase({ telegramId, packageType, selectedNumbers, sellerId = null }) {
    if (!this.salesOpen()) throw new Error('Sales are currently closed.');
    const pools = packagePools(packageType);
    const amount = amountForPackage(packageType);
    if (!pools.length || !amount) throw new Error('Invalid ticket package.');
    const user = this.getUser(telegramId);
    if (!user || user.registration_state !== 'complete' || !user.full_name || !user.phone) throw new Error('Complete registration first.');
    const normalized = {};
    for (const pool of pools) {
      const n = Number(selectedNumbers?.[String(pool)] ?? selectedNumbers?.[pool]);
      if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error(`Choose a valid ${pool} ETB number.`);
      normalized[pool] = n;
    }
    const seller = sellerId ? this.db.prepare(`SELECT * FROM sellers WHERE id=? AND status='approved'`).get(sellerId) : null;
    if (sellerId && !seller) throw new Error('This seller is not available.');

    const id = cryptoRandomId();
    const now = nowIso();
    const reservedUntil = addMinutesIso(this.reservationMinutes);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.releaseExpiredReservationsInCurrentTransaction(now);
      for (const pool of pools) {
        const row = this.db.prepare('SELECT status FROM ticket_numbers WHERE pool=? AND number=?').get(pool, normalized[pool]);
        if (!row || row.status !== 'available') throw new Error(`#${formatNumber(normalized[pool])} in the ${pool} ETB draw was just taken.`);
      }
      this.db.prepare(`INSERT INTO purchases(id,buyer_telegram_id,buyer_name,buyer_phone,package_type,amount_etb,seller_id,source,status,reserved_until,created_at,linked_telegram_id,payment_target)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, telegramId, user.full_name, user.phone, packageType, amount, null,
          'direct', 'awaiting_proof', reservedUntil, now, telegramId, 'finote'
        );
      for (const pool of pools) {
        const n = normalized[pool];
        this.db.prepare('INSERT INTO purchase_numbers(purchase_id,pool,number) VALUES(?,?,?)').run(id, pool, n);
        this.db.prepare(`UPDATE ticket_numbers SET status='reserved',purchase_id=?,reserved_until=?,buyer_telegram_id=?,seller_id=? WHERE pool=? AND number=?`)
          .run(id, reservedUntil, telegramId, null, pool, n);
      }
      this.db.exec('COMMIT');
      this.log(telegramId, 'purchase.reserved', 'purchase', id, { packageType, selectedNumbers: normalized, sellerId: null });
      return this.getPurchase(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reserveSellerSale({ sellerTelegramId, buyerName, buyerPhone, packageType, selectedNumbers, paymentTarget = 'finote' }) {
    if (!this.salesOpen()) throw new Error('Sales are currently closed.');
    const seller = this.db.prepare(`SELECT * FROM sellers WHERE telegram_id=? AND status='approved'`).get(sellerTelegramId);
    if (!seller) throw new Error('Ticket seller access is not active.');
    const cleanName = String(buyerName || '').trim().replace(/\s+/g, ' ');
    const cleanPhone = normalizePhone(buyerPhone);
    if (cleanName.length < 3 || cleanName.length > 80) throw new Error('Enter the buyer full name.');
    if (!cleanPhone) throw new Error('Enter a valid Ethiopian buyer phone number.');
    if (!['finote', 'seller'].includes(paymentTarget)) throw new Error('Choose a valid payment destination.');
    if (paymentTarget === 'seller' && !this.sellerHasPaymentAccount(seller.id)) throw new Error('Set your payment account first.');

    const pools = packagePools(packageType);
    const amount = amountForPackage(packageType);
    if (!pools.length || !amount) throw new Error('Invalid ticket package.');
    const normalized = {};
    for (const pool of pools) {
      const n = Number(selectedNumbers?.[String(pool)] ?? selectedNumbers?.[pool]);
      if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error(`Choose a valid ${pool} ETB number.`);
      normalized[pool] = n;
    }

    const matched = this.findRegisteredBuyer(cleanName, cleanPhone);
    const id = cryptoRandomId();
    const now = nowIso();
    const reservedUntil = addMinutesIso(this.manualReviewMinutes);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.releaseExpiredReservationsInCurrentTransaction(now);
      for (const pool of pools) {
        const row = this.db.prepare('SELECT status FROM ticket_numbers WHERE pool=? AND number=?').get(pool, normalized[pool]);
        if (!row || row.status !== 'available') throw new Error(`#${formatNumber(normalized[pool])} in the ${pool} ETB draw was just taken.`);
      }
      const provider = paymentTarget === 'seller' ? seller.payment_provider : null;
      const accountName = paymentTarget === 'seller' ? seller.account_name : null;
      const accountNumber = paymentTarget === 'seller' ? seller.account_number : null;
      this.db.prepare(`INSERT INTO purchases(id,buyer_telegram_id,buyer_name,buyer_phone,package_type,amount_etb,seller_id,source,status,payment_provider,payment_account_name,payment_account_number,reserved_until,created_at,linked_telegram_id,payment_target)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, sellerTelegramId, cleanName, cleanPhone, packageType, amount, seller.id, 'seller', 'seller_review', provider || null, accountName || null, accountNumber || null, reservedUntil, now, matched?.telegram_id ?? null, paymentTarget
        );
      for (const pool of pools) {
        const n = normalized[pool];
        this.db.prepare('INSERT INTO purchase_numbers(purchase_id,pool,number) VALUES(?,?,?)').run(id, pool, n);
        this.db.prepare(`UPDATE ticket_numbers SET status='reserved',purchase_id=?,reserved_until=?,buyer_telegram_id=?,seller_id=? WHERE pool=? AND number=?`)
          .run(id, reservedUntil, matched?.telegram_id ?? sellerTelegramId, seller.id, pool, n);
      }
      this.db.exec('COMMIT');
      this.log(sellerTelegramId, 'seller_sale.reserved', 'purchase', id, { buyerName: cleanName, buyerPhone: cleanPhone, packageType, selectedNumbers: normalized, paymentTarget });
      return this.getPurchase(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  findRegisteredBuyer(buyerName, buyerPhone) {
    const phone = normalizePhone(buyerPhone);
    if (phone) {
      const byPhone = this.db.prepare(`SELECT * FROM users WHERE registration_state='complete' AND phone=? ORDER BY updated_at DESC LIMIT 1`).get(phone);
      if (byPhone) return byPhone;
    }
    const target = normalizeNameForCompare(buyerName);
    if (!target) return null;
    const rows = this.db.prepare(`SELECT * FROM users WHERE registration_state='complete' AND full_name IS NOT NULL ORDER BY updated_at DESC`).all();
    return rows.find((row) => normalizeNameForCompare(row.full_name) === target) ?? null;
  }

  releaseExpiredReservationsInCurrentTransaction(now) {
    const expired = this.db.prepare(`SELECT id FROM purchases WHERE status IN ('reserved','awaiting_proof','verification_pending','seller_review','manual_review') AND reserved_until < ?`).all(now);
    for (const row of expired) {
      this.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL WHERE purchase_id=? AND status='reserved'`).run(row.id);
      this.db.prepare(`UPDATE purchases SET status='expired', note=COALESCE(note,'') || ' [auto-expired]' WHERE id=?`).run(row.id);
    }
  }

  getPurchase(id) {
    const purchase = this.db.prepare('SELECT * FROM purchases WHERE id=?').get(id);
    if (!purchase) return null;
    purchase.numbers = this.db.prepare('SELECT pool,number FROM purchase_numbers WHERE purchase_id=? ORDER BY pool DESC').all(id);
    if (purchase.seller_id) purchase.seller = this.db.prepare('SELECT * FROM sellers WHERE id=?').get(purchase.seller_id) ?? null;
    return purchase;
  }

  getOpenPurchaseForUser(telegramId) {
    this.releaseExpiredReservations();
    const row = this.db.prepare(`SELECT id FROM purchases WHERE buyer_telegram_id=? AND status IN ('awaiting_proof','verification_pending','seller_review','manual_review') ORDER BY created_at DESC LIMIT 1`).get(telegramId);
    return row ? this.getPurchase(row.id) : null;
  }

  submitPaymentProof(purchaseId, { provider = null, reference = null, fileId = null } = {}) {
    const purchase = this.getPurchase(purchaseId);
    if (!purchase || !['awaiting_proof', 'manual_review'].includes(purchase.status)) throw new Error('This reservation is not awaiting payment proof.');
    const nextStatus = purchase.source === 'seller' ? 'seller_review' : 'verification_pending';
    const extended = addMinutesIso(this.manualReviewMinutes);
    try {
      this.db.prepare(`UPDATE purchases SET status=?,payment_provider=COALESCE(?,payment_provider),payment_reference=COALESCE(?,payment_reference),payment_file_id=COALESCE(?,payment_file_id),submitted_at=?,reserved_until=? WHERE id=?`)
        .run(nextStatus, provider, reference, fileId, nowIso(), extended, purchaseId);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new Error('That transaction reference has already been used.');
      throw error;
    }
    this.db.prepare('UPDATE ticket_numbers SET reserved_until=? WHERE purchase_id=? AND status=\'reserved\'').run(extended, purchaseId);
    this.log(purchase.buyer_telegram_id, 'payment.submitted', 'purchase', purchaseId, { hasReference: Boolean(reference), hasFile: Boolean(fileId), source: purchase.source });
    return this.getPurchase(purchaseId);
  }

  setVerificationPending(purchaseId, requestId, payload) {
    const extended = addMinutesIso(this.manualReviewMinutes);
    this.db.prepare(`UPDATE purchases SET status='verification_pending',verify_request_id=?,verification_payload=?,reserved_until=? WHERE id=?`)
      .run(requestId ?? null, JSON.stringify(payload ?? {}), extended, purchaseId);
    this.db.prepare('UPDATE ticket_numbers SET reserved_until=? WHERE purchase_id=? AND status=\'reserved\'').run(extended, purchaseId);
  }

  markManualReview(purchaseId, note, payload = null) {
    const extended = addMinutesIso(this.manualReviewMinutes);
    this.db.prepare(`UPDATE purchases SET status='manual_review',note=?,verification_payload=COALESCE(?,verification_payload),reserved_until=? WHERE id=?`)
      .run(note || 'Manual review required', payload ? JSON.stringify(payload) : null, extended, purchaseId);
    this.db.prepare('UPDATE ticket_numbers SET reserved_until=? WHERE purchase_id=? AND status=\'reserved\'').run(extended, purchaseId);
    return this.getPurchase(purchaseId);
  }

  confirmPurchase(purchaseId, reviewerId, { verificationPayload = null, note = null } = {}) {
    const purchase = this.getPurchase(purchaseId);
    if (!purchase) throw new Error('Purchase not found.');
    if (purchase.status === 'paid') return purchase;
    if (!['verification_pending', 'seller_review', 'manual_review', 'awaiting_proof'].includes(purchase.status)) throw new Error(`Purchase cannot be confirmed from status ${purchase.status}.`);
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const locks = this.db.prepare('SELECT pool,number,status,purchase_id FROM ticket_numbers WHERE purchase_id=?').all(purchaseId);
      if (locks.length !== purchase.numbers.length || locks.some((r) => r.status !== 'reserved' || r.purchase_id !== purchaseId)) {
        throw new Error('Reservation is no longer intact. Admin intervention is required.');
      }
      this.db.prepare(`UPDATE purchases SET status='paid',paid_at=?,reviewed_by=?,verification_payload=COALESCE(?,verification_payload),note=COALESCE(?,note) WHERE id=?`)
        .run(now, reviewerId ?? null, verificationPayload ? JSON.stringify(verificationPayload) : null, note, purchaseId);
      this.db.prepare(`UPDATE ticket_numbers SET status='sold',reserved_until=NULL,sold_at=? WHERE purchase_id=?`).run(now, purchaseId);
      const insertTicket = this.db.prepare(`INSERT INTO tickets(id,purchase_id,pool,number,owner_telegram_id,owner_name,owner_phone,seller_id,issued_at,linked_telegram_id) VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const num of purchase.numbers) {
        const ticketId = makeTicketId(num.pool, num.number);
        const ownerTelegramId = purchase.linked_telegram_id ?? purchase.buyer_telegram_id;
        insertTicket.run(ticketId, purchaseId, num.pool, num.number, ownerTelegramId, purchase.buyer_name, purchase.buyer_phone, purchase.seller_id ?? null, now, purchase.linked_telegram_id ?? null);
      }
      this.db.exec('COMMIT');
      this.log(reviewerId ?? purchase.buyer_telegram_id, 'purchase.confirmed', 'purchase', purchaseId, { source: purchase.source });
      return this.getPurchase(purchaseId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }


  cancelPurchase(purchaseId, reviewerId = null, note = 'Cancelled by user') {
    const purchase = this.getPurchase(purchaseId);
    if (!purchase) throw new Error('Purchase not found.');
    if (['paid', 'rejected', 'expired', 'cancelled'].includes(purchase.status)) return purchase;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL WHERE purchase_id=? AND status='reserved'`).run(purchaseId);
      this.db.prepare(`UPDATE purchases SET status='cancelled',reviewed_by=?,note=?,reserved_until=? WHERE id=?`).run(reviewerId ?? null, note, nowIso(), purchaseId);
      this.db.exec('COMMIT');
      this.log(reviewerId ?? purchase.buyer_telegram_id, 'purchase.cancelled', 'purchase', purchaseId, { note });
      return this.getPurchase(purchaseId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cancelLatestOpenPurchaseForUser(telegramId, note = 'Cancelled by user') {
    this.releaseExpiredReservations();
    const row = this.db.prepare(`SELECT id FROM purchases WHERE buyer_telegram_id=? AND status IN ('reserved','awaiting_proof','verification_pending','seller_review','manual_review') ORDER BY created_at DESC LIMIT 1`).get(telegramId);
    return row ? this.cancelPurchase(row.id, telegramId, note) : null;
  }

  rejectPurchase(purchaseId, reviewerId, note = 'Payment not confirmed') {
    const purchase = this.getPurchase(purchaseId);
    if (!purchase) throw new Error('Purchase not found.');
    if (['paid', 'rejected', 'expired', 'cancelled'].includes(purchase.status)) return purchase;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE ticket_numbers SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL WHERE purchase_id=? AND status='reserved'`).run(purchaseId);
      this.db.prepare(`UPDATE purchases SET status='rejected',reviewed_by=?,note=? WHERE id=?`).run(reviewerId ?? null, note, purchaseId);
      this.db.exec('COMMIT');
      this.log(reviewerId, 'purchase.rejected', 'purchase', purchaseId, { note });
      return this.getPurchase(purchaseId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ticketsForUser(telegramId) {
    return this.db.prepare(`SELECT t.* FROM tickets t JOIN purchases p ON p.id=t.purchase_id
      WHERE (p.source='direct' AND t.owner_telegram_id=?) OR t.linked_telegram_id=?
      ORDER BY t.issued_at DESC`).all(telegramId, telegramId);
  }

  linkSellerTicketsForUser(telegramId) {
    const user = this.getUser(telegramId);
    if (!user || user.registration_state !== 'complete' || !user.full_name || !user.phone) return [];
    const rows = this.db.prepare(`SELECT * FROM purchases WHERE source='seller' AND status='paid' AND linked_telegram_id IS NULL ORDER BY paid_at ASC`).all();
    const targetPhone = normalizePhone(user.phone);
    const targetName = normalizeNameForCompare(user.full_name);
    const linked = [];
    for (const row of rows) {
      const phoneMatch = targetPhone && normalizePhone(row.buyer_phone) === targetPhone;
      const nameMatch = targetName && normalizeNameForCompare(row.buyer_name) === targetName;
      if (!phoneMatch && !nameMatch) continue;
      this.db.prepare(`UPDATE purchases SET linked_telegram_id=? WHERE id=? AND linked_telegram_id IS NULL`).run(telegramId, row.id);
      this.db.prepare(`UPDATE tickets SET linked_telegram_id=?,owner_telegram_id=? WHERE purchase_id=?`).run(telegramId, telegramId, row.id);
      linked.push(row.id);
      this.log(telegramId, 'seller_sale.linked_to_buyer', 'purchase', row.id, { matchedBy: phoneMatch ? 'phone' : 'name' });
    }
    return linked;
  }

  winnerForPurchase(purchaseId) {
    return this.db.prepare(`SELECT * FROM winners WHERE purchase_id=? LIMIT 1`).get(purchaseId) ?? null;
  }

  ticketsForPurchase(purchaseId) {
    return this.db.prepare('SELECT * FROM tickets WHERE purchase_id=? ORDER BY pool DESC').all(purchaseId);
  }

  pendingReviews(limit = 20) {
    return this.db.prepare(`SELECT * FROM purchases WHERE status='manual_review' ORDER BY submitted_at ASC LIMIT ?`).all(limit).map((p) => this.getPurchase(p.id));
  }

  sellerPendingReviews(sellerId, limit = 20) {
    return this.db.prepare(`SELECT id FROM purchases WHERE seller_id=? AND status='seller_review' ORDER BY submitted_at ASC LIMIT ?`).all(sellerId, limit).map((p) => this.getPurchase(p.id));
  }

  forceClearOperationalData(adminId) {
    if (!this.isAdmin(adminId)) throw new Error('Admin access required.');

    this.releaseExpiredReservations();
    const before = {
      users: this.db.prepare(`SELECT COUNT(*) AS c FROM users WHERE registration_state='complete'`).get().c,
      sellers: this.db.prepare(`SELECT COUNT(*) AS c FROM sellers`).get().c,
      purchases: this.db.prepare(`SELECT COUNT(*) AS c FROM purchases`).get().c,
      tickets: this.db.prepare(`SELECT COUNT(*) AS c FROM tickets`).get().c,
      winners: this.db.prepare(`SELECT COUNT(*) AS c FROM winners`).get().c
    };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        DELETE FROM winners;
        DELETE FROM draw_runs;
        DELETE FROM tickets;
        DELETE FROM purchase_numbers;
        DELETE FROM purchases;
        DELETE FROM web_sessions;
        DELETE FROM user_state;
        DELETE FROM seller_invites;
        DELETE FROM sellers;
        UPDATE users SET active_seller_id=NULL;
        DELETE FROM users WHERE telegram_id NOT IN (SELECT telegram_id FROM admins);
        UPDATE ticket_numbers
          SET status='available',purchase_id=NULL,reserved_until=NULL,buyer_telegram_id=NULL,seller_id=NULL,sold_at=NULL;
        DELETE FROM audit_logs;
        DELETE FROM sqlite_sequence WHERE name IN ('sellers','audit_logs');
      `);
      const now = nowIso();
      this.db.prepare(`UPDATE settings SET value='true',updated_at=?,updated_by=? WHERE key='sales_open'`).run(now, adminId);
      this.db.prepare(`UPDATE settings SET value='false',updated_at=?,updated_by=? WHERE key='winners_published'`).run(now, adminId);
      this.db.prepare(`UPDATE settings SET value='',updated_at=?,updated_by=? WHERE key='draw_at'`).run(now, adminId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    this.log(adminId, 'admin.force_clear', 'system', 'all_operational_data', before);
    return before;
  }

  dashboardStats() {
    this.releaseExpiredReservations();
    const users = this.db.prepare(`SELECT COUNT(*) AS c FROM users WHERE registration_state='complete'`).get().c;
    const paid = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue FROM purchases WHERE status='paid'`).get();
    const direct = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue FROM purchases WHERE status='paid' AND source='direct'`).get();
    const seller = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_etb),0) AS revenue FROM purchases WHERE status='paid' AND source='seller'`).get();
    const pending = this.db.prepare(`SELECT COUNT(*) AS c FROM purchases WHERE status IN ('verification_pending','seller_review','manual_review')`).get().c;
    const sellers = this.db.prepare(`SELECT COUNT(*) AS c FROM sellers WHERE status='approved'`).get().c;
    const pools = this.db.prepare(`SELECT pool,
      SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) AS sold,
      SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END) AS reserved,
      SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) AS available
      FROM ticket_numbers GROUP BY pool ORDER BY pool DESC`).all();
    return { users, paidCount: paid.c, revenue: paid.revenue, directCount: direct.c, directRevenue: direct.revenue, sellerCount: seller.c, sellerRevenue: seller.revenue, pending, sellers, pools };
  }

  sellerStats(sellerId) {
    const seller = this.db.prepare('SELECT * FROM sellers WHERE id=?').get(sellerId);
    if (!seller) return null;
    const paid = this.db.prepare(`SELECT COUNT(*) AS c,COALESCE(SUM(amount_etb),0) AS revenue FROM purchases WHERE seller_id=? AND status='paid'`).get(sellerId);
    const pending = this.db.prepare(`SELECT COUNT(*) AS c FROM purchases WHERE seller_id=? AND status IN ('awaiting_proof','seller_review','manual_review')`).get(sellerId).c;
    const tickets = this.db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE seller_id=?`).get(sellerId).c;
    const customers = this.db.prepare(`SELECT COUNT(DISTINCT buyer_phone) AS c FROM purchases WHERE seller_id=? AND status='paid'`).get(sellerId).c;
    return { seller, paidCount: paid.c, revenue: paid.revenue, pending, tickets, customers };
  }


  recentSellerSales(sellerId, limit = 8) {
    return this.db.prepare(`SELECT p.*,GROUP_CONCAT(pn.pool || ':' || printf('%03d',pn.number), ' · ') AS numbers
      FROM purchases p LEFT JOIN purchase_numbers pn ON pn.purchase_id=p.id
      WHERE p.seller_id=? GROUP BY p.id ORDER BY p.created_at DESC LIMIT ?`).all(sellerId, limit);
  }

  getTicketNumberDetails(pool, number) {
    const row = this.db.prepare(`SELECT tn.*, p.status AS purchase_status,p.buyer_name,p.buyer_phone,p.amount_etb,p.source,p.payment_reference,
      s.display_name AS seller_name FROM ticket_numbers tn
      LEFT JOIN purchases p ON p.id=tn.purchase_id
      LEFT JOIN sellers s ON s.id=tn.seller_id
      WHERE tn.pool=? AND tn.number=?`).get(pool, number);
    return row ?? null;
  }

  searchUsers(query, limit = 20) {
    const q = String(query || '').trim();
    if (!q) return [];
    if (/^\d+$/.test(q)) {
      const byId = this.db.prepare('SELECT * FROM users WHERE telegram_id=?').get(Number(q));
      if (byId) return [byId];
    }
    const like = `%${q.replace(/[%_]/g, '')}%`;
    return this.db.prepare(`SELECT * FROM users WHERE full_name LIKE ? OR phone LIKE ? ORDER BY updated_at DESC LIMIT ?`).all(like, like, limit);
  }

  listAudit(limit = 20) {
    return this.db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
  }

  approvedSellerStats(limit = 100) {
    return this.db.prepare(`SELECT s.*,
      COUNT(DISTINCT CASE WHEN p.status='paid' THEN p.id END) AS paid_count,
      COUNT(DISTINCT CASE WHEN p.status='paid' THEN p.buyer_phone END) AS customers,
      COUNT(DISTINCT CASE WHEN p.status IN ('awaiting_proof','seller_review','manual_review','verification_pending') THEN p.id END) AS pending_count,
      COALESCE(SUM(CASE WHEN p.status='paid' THEN p.amount_etb ELSE 0 END),0) AS revenue,
      (SELECT COUNT(*) FROM tickets t WHERE t.seller_id=s.id) AS tickets_issued
      FROM sellers s LEFT JOIN purchases p ON p.seller_id=s.id
      WHERE s.status='approved' GROUP BY s.id ORDER BY revenue DESC, s.display_name LIMIT ?`).all(limit);
  }

  listUsersForBroadcast() {
    return this.db.prepare(`SELECT telegram_id FROM users WHERE registration_state='complete' ORDER BY telegram_id`).all().map((r) => r.telegram_id);
  }

  exportPurchases() {
    return this.db.prepare(`SELECT p.*, GROUP_CONCAT(pn.pool || ':' || printf('%03d',pn.number), ' | ') AS numbers,
      s.display_name AS seller_name,s.seller_code
      FROM purchases p
      LEFT JOIN purchase_numbers pn ON pn.purchase_id=p.id
      LEFT JOIN sellers s ON s.id=p.seller_id
      GROUP BY p.id ORDER BY p.created_at DESC`).all();
  }

  setUserState(telegramId, state, data = {}) {
    this.db.prepare(`INSERT INTO user_state(telegram_id,state,data_json,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET state=excluded.state,data_json=excluded.data_json,updated_at=excluded.updated_at`)
      .run(telegramId, state, JSON.stringify(data), nowIso());
  }

  getUserState(telegramId) {
    const row = this.db.prepare('SELECT * FROM user_state WHERE telegram_id=?').get(telegramId);
    if (!row) return null;
    try { row.data = JSON.parse(row.data_json || '{}'); } catch { row.data = {}; }
    return row;
  }

  clearUserState(telegramId) {
    this.db.prepare('DELETE FROM user_state WHERE telegram_id=?').run(telegramId);
  }

  drawWinners(adminId) {
    if (this.salesOpen()) throw new Error('Close sales before drawing winners.');
    const existing = this.db.prepare('SELECT COUNT(*) AS c FROM winners').get().c;
    if (existing > 0) throw new Error('Winners have already been drawn.');
    const snapshot = {};
    for (const pool of [200, 100, 50]) {
      const candidates = this.db.prepare(`SELECT t.*,p.source,p.linked_telegram_id AS purchase_linked_telegram_id FROM tickets t JOIN purchases p ON p.id=t.purchase_id WHERE t.pool=? ORDER BY t.id`).all(pool);
      if (!candidates.length) throw new Error(`No paid tickets exist in the ${pool} ETB draw.`);
      snapshot[pool] = candidates.map((c) => ({ id: c.id, purchase_id: c.purchase_id, number: c.number, owner_telegram_id: c.owner_telegram_id, linked_telegram_id: c.linked_telegram_id ?? c.purchase_linked_telegram_id ?? null, seller_id: c.seller_id ?? null }));
    }
    const snapshotJson = JSON.stringify(snapshot);
    const drawId = `DRAW-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${shortCode(5)}`;
    const hash = sha256(snapshotJson);
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO draw_runs(id,created_by,created_at,snapshot_hash,snapshot_json) VALUES(?,?,?,?,?)').run(drawId, adminId, now, hash, snapshotJson);
      const insert = this.db.prepare(`INSERT INTO winners(pool,draw_id,ticket_id,purchase_id,winner_telegram_id,winner_name,winner_phone,ticket_number,candidate_count,drawn_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`);
      const chosen = [];
      for (const pool of [200, 100, 50]) {
        const candidates = this.db.prepare(`SELECT t.*,p.source,p.linked_telegram_id AS purchase_linked_telegram_id FROM tickets t JOIN purchases p ON p.id=t.purchase_id WHERE t.pool=? ORDER BY t.id`).all(pool);
        const winner = candidates[cryptoRandomIndex(candidates.length)];
        insert.run(pool, drawId, winner.id, winner.purchase_id, winner.linked_telegram_id ?? winner.purchase_linked_telegram_id ?? winner.owner_telegram_id, winner.owner_name, winner.owner_phone, winner.number, candidates.length, now);
        chosen.push({ pool, ...winner, candidate_count: candidates.length });
      }
      this.db.exec('COMMIT');
      this.log(adminId, 'draw.completed', 'draw', drawId, { snapshotHash: hash });
      return { drawId, snapshotHash: hash, winners: chosen };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  publishWinners(adminId) {
    const now = nowIso();
    this.db.prepare('UPDATE winners SET published_at=? WHERE published_at IS NULL').run(now);
    this.db.prepare('UPDATE draw_runs SET published_at=? WHERE published_at IS NULL').run(now);
    this.setSetting('winners_published', 'true', adminId);
    this.log(adminId, 'draw.published', 'draw', 'current');
  }

  getWinners({ publishedOnly = true } = {}) {
    return this.db.prepare(`SELECT * FROM winners ${publishedOnly ? 'WHERE published_at IS NOT NULL' : ''} ORDER BY pool DESC`).all();
  }
}

function cryptoRandomId() {
  return `P-${Date.now().toString(36).toUpperCase()}-${shortCode(8)}`;
}

function cryptoRandomIndex(length) {
  if (!Number.isInteger(length) || length <= 0) throw new Error('Invalid candidate length');
  return crypto.randomInt(length);
}

function makeTicketId(pool, number) {
  return `FB-${pool}-${formatNumber(number)}-${shortCode(6)}`;
}
