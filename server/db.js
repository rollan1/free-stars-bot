import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const dir = path.dirname(config.dbPath);
fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id               INTEGER PRIMARY KEY,
  username            TEXT,
  first_name          TEXT,
  last_name           TEXT,
  language_code       TEXT,
  is_premium          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  free_spin_day       TEXT,
  streak_count        INTEGER NOT NULL DEFAULT 0,
  streak_last_day     TEXT,
  series_gift_won     INTEGER NOT NULL DEFAULT 0,
  guarantee_claimed   INTEGER NOT NULL DEFAULT 0,
  spins_total         INTEGER NOT NULL DEFAULT 0,
  wins_total          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS spins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('free','paid','guarantee')),
  outcome       TEXT NOT NULL CHECK (outcome IN ('bear','heart','cake','none')),
  roll          REAL,
  probabilities TEXT NOT NULL,
  win_code      TEXT,
  payment_id    INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spins_user   ON spins(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_spins_time   ON spins(created_at);
CREATE INDEX IF NOT EXISTS idx_spins_kind   ON spins(kind);

CREATE TABLE IF NOT EXISTS payments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_payload    TEXT NOT NULL UNIQUE,
  telegram_charge_id TEXT UNIQUE,
  user_id            INTEGER NOT NULL,
  amount             INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'XTR',
  status             TEXT NOT NULL CHECK (status IN ('created','paid','failed','refunded')),
  spin_id            INTEGER,
  failure_reason     TEXT,
  raw                TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  paid_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_payments_time ON payments(created_at);

CREATE TABLE IF NOT EXISTS wins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  win_code      TEXT NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL,
  gift          TEXT NOT NULL CHECK (gift IN ('bear','heart','cake')),
  kind          TEXT NOT NULL CHECK (kind IN ('free','paid','guarantee')),
  spin_id       INTEGER,
  payment_id    INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','cancelled')),
  cancel_reason TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  delivered_at  TEXT,
  delivered_by  INTEGER,
  telegram_gift_sent INTEGER NOT NULL DEFAULT 0,
  telegram_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_wins_user   ON wins(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_wins_status ON wins(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_wins_code   ON wins(win_code);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probability_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  old_value  TEXT NOT NULL,
  new_value  TEXT NOT NULL,
  changed_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER NOT NULL,
  action     TEXT NOT NULL,
  details    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  win_id          INTEGER NOT NULL,
  chat_id         INTEGER NOT NULL,
  text            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  sent_at         TEXT,
  UNIQUE (win_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_notify_pending ON notify_queue(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS error_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  message    TEXT NOT NULL,
  details    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_log_time ON error_log(created_at);
`);

/**
 * Older builds had UNIQUE(win_id) on notify_queue, which silently suppressed
 * notifications for the second owner. Rebuild the table with UNIQUE(win_id, chat_id).
 */
(function migrateNotifyQueueUniqueness() {
  const indexes = db.prepare('PRAGMA index_list(notify_queue)').all();
  const needsRebuild = indexes.some((idx) => {
    if (idx.origin !== 'u') return false;
    const cols = db.prepare(`PRAGMA index_info('${String(idx.name).replace(/'/g, "''")}')`).all();
    return cols.length === 1 && cols[0].name === 'win_id';
  });
  if (!needsRebuild) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE notify_queue_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        win_id          INTEGER NOT NULL,
        chat_id         INTEGER NOT NULL,
        text            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error      TEXT,
        created_at      TEXT NOT NULL,
        sent_at         TEXT,
        UNIQUE (win_id, chat_id)
      );
      INSERT OR IGNORE INTO notify_queue_new (id, win_id, chat_id, text, status, attempts, next_attempt_at, last_error, created_at, sent_at)
        SELECT id, win_id, chat_id, text, status, attempts, next_attempt_at, last_error, created_at, sent_at FROM notify_queue;
      DROP TABLE notify_queue;
      ALTER TABLE notify_queue_new RENAME TO notify_queue;
      CREATE INDEX IF NOT EXISTS idx_notify_pending ON notify_queue(status, next_attempt_at);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    logError('db.migrate', `notify_queue migration failed: ${err.message}`);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
})();

/** Adds a column to an existing table if it is not there yet. */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.length || cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

ensureColumn('users', 'blocked', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'notes', 'TEXT');
ensureColumn('users', 'bonus_spins', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('spins', 'is_bonus', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'referred_by', 'INTEGER');

// Таблица рефералов
db.exec(`
CREATE TABLE IF NOT EXISTS referrals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id  INTEGER NOT NULL,
  referee_id   INTEGER NOT NULL UNIQUE,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
`);

const defaultSettings = {
  probabilities: JSON.stringify({ cake: 0.5, bear: 1, heart: 1, none: 97.5 }),
  guarantee_days: String(config.guaranteeDays),
  guarantee_gift: config.guaranteeGift,
  series_bonus_every: String(config.seriesBonusEvery),
  paid_spins_enabled: '1',
  all_spins_enabled: '1',
  gift_costs: JSON.stringify(config.giftCostStars),
  spin_price_stars: String(config.spinPriceStars),
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaultSettings)) insertSetting.run(k, v);

// Автоматическая выдача 100 бонусных спинов для пользователя 6902045311
(function seedSpecialUserBonusSpins() {
  try {
    const targetId = 6902045311;
    const user = db.prepare('SELECT tg_id, bonus_spins FROM users WHERE tg_id = ?').get(targetId);
    if (user) {
      if ((user.bonus_spins ?? 0) < 100) {
        db.prepare('UPDATE users SET bonus_spins = 100 WHERE tg_id = ?').run(targetId);
        console.log(`[freestars] Пользователю ${targetId} установлено 100 бонусных спинов`);
      }
    } else {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO users (tg_id, username, first_name, created_at, last_seen_at, bonus_spins)
        VALUES (?, 'mr_rollan1', '🌹Ｒσℓℓαη🌹', ?, ?, 100)
      `).run(targetId, now, now);
      console.log(`[freestars] Пользователь ${targetId} создан со 100 бонусными спинами`);
    }
  } catch (err) {
    console.warn(`[freestars] seedSpecialUserBonusSpins warning: ${err.message}`);
  }
})();

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function getSettingJson(key, fallback) {
  const raw = getSetting(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Runs `fn` inside an IMMEDIATE transaction. Nested calls reuse the outer one. */
let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth += 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the transaction was already aborted */
    }
    throw err;
  } finally {
    txDepth -= 1;
  }
}

export function logError(scope, message, details = null) {
  try {
    db.prepare('INSERT INTO error_log (scope, message, details, created_at) VALUES (?, ?, ?, ?)').run(
      scope,
      String(message),
      details ? String(details).slice(0, 4000) : null,
      new Date().toISOString(),
    );
  } catch {
    /* logging must never throw */
  }
}

export function writeAudit(adminId, action, details) {
  db.prepare('INSERT INTO admin_log (admin_id, action, details, created_at) VALUES (?, ?, ?, ?)').run(
    adminId,
    action,
    details ? String(details).slice(0, 2000) : null,
    new Date().toISOString(),
  );
}