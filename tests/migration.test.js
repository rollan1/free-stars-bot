import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const dir = path.join(os.tmpdir(), 'freestars-tests', `migrate-${crypto.randomInt(1e9)}`);
fs.mkdirSync(dir, { recursive: true });
const dbPath = path.join(dir, 'legacy.db');

// Старая схема: UNIQUE(win_id) — вторая запись для другого владельца молча терялась.
const legacy = new DatabaseSync(dbPath);
legacy.exec(`
  CREATE TABLE notify_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    win_id          INTEGER NOT NULL UNIQUE,
    chat_id         INTEGER NOT NULL,
    text            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    sent_at         TEXT
  );
  CREATE INDEX idx_notify_pending ON notify_queue(status, next_attempt_at);
`);
legacy
  .prepare(
    `INSERT INTO notify_queue (win_id, chat_id, text, status, attempts, next_attempt_at, created_at)
     VALUES (42, 111, 'старое уведомление', 'pending', 0, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
  )
  .run();
legacy.close();

process.env.BOT_TOKEN = '1234567890:TEST-token-for-automated-suite-abcdefghij';
process.env.OWNER_TELEGRAM_IDS = '777000111';
process.env.DB_PATH = dbPath;

const { db } = await import('../server/db.js');
const { enqueueOwnerNotification } = await import('../server/game.js');

test('миграция перестраивает notify_queue и сохраняет данные', () => {
  const rows = db.prepare('SELECT * FROM notify_queue').all();
  assert.equal(rows.length, 1, 'существующие уведомления сохранены');
  assert.equal(rows[0].text, 'старое уведомление');

  const indexes = db.prepare('PRAGMA index_list(notify_queue)').all();
  const single = indexes.filter((i) => {
    if (i.origin !== 'u') return false;
    const cols = db.prepare(`PRAGMA index_info('${i.name}')`).all();
    return cols.length === 1 && cols[0].name === 'win_id';
  });
  assert.equal(single.length, 0, 'уникальности только по win_id больше нет');
});

test('после миграции один выигрыш уходит нескольким владельцам', () => {
  enqueueOwnerNotification(42, 777000111, 'владелец 1');
  enqueueOwnerNotification(42, 999000222, 'владелец 2');
  enqueueOwnerNotification(42, 999000222, 'дубль владельца 2');

  const rows = db.prepare('SELECT chat_id FROM notify_queue WHERE win_id = 42 ORDER BY chat_id').all();
  assert.deepEqual(rows.map((r) => r.chat_id), [111, 777000111, 999000222]);
});

test.after(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});