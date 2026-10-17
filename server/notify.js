import { config } from './config.js';
import { db, logError } from './db.js';
import { notifyOwner } from './tg.js';

const MAX_ATTEMPTS = 12;
const nowIso = () => new Date().toISOString();

function backoffMs(attempts) {
  const base = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3600_000);
  return base;
}

/**
 * Drains the owner-notification queue. Every queued row is bound to a win by a
 * UNIQUE constraint, so a repeated spin or a repeated webhook can never
 * produce a second notification for the same win.
 */
export async function drainQueue({ limit = 20 } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM notify_queue WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY id ASC LIMIT ?`,
    )
    .all(nowIso(), limit);

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const res = await notifyOwner(row.chat_id, row.text);
    if (res.ok) {
      db.prepare(
        `UPDATE notify_queue SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?`,
      ).run(nowIso(), row.id);
      if (res.messageId) {
        db.prepare('UPDATE wins SET telegram_message_id = ? WHERE id = ?').run(String(res.messageId), row.win_id);
      }
      sent += 1;
    } else {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      db.prepare(
        `UPDATE notify_queue SET attempts = ?, next_attempt_at = ?, last_error = ?, status = ?
         WHERE id = ?`,
      ).run(
        attempts,
        new Date(Date.now() + backoffMs(attempts)).toISOString(),
        String(res.error).slice(0, 1000),
        exhausted ? 'failed' : 'pending',
        row.id,
      );
      if (exhausted) logError('notify.exhausted', `Notification for win ${row.win_id} failed ${attempts} times`);
      failed += 1;
    }
  }
  return { sent, failed };
}

export function startNotificationWorker({ intervalMs = 5000 } = {}) {
  if (!config.botToken) {
    return { stop() {} };
  }
  const timer = setInterval(() => {
    drainQueue().catch((err) => logError('notify.worker', err.message, err.stack));
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export function queueStats() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM notify_queue GROUP BY status').all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}