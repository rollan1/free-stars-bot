import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const TEST_BOT_TOKEN = '1234567890:TEST-token-for-automated-suite-abcdefghij';

/** Sets env before any server module is imported, then imports the server. */
export async function bootServer(name) {
  const dbDir = path.join(os.tmpdir(), 'freestars-tests', `${name}-${crypto.randomInt(1e9)}`);
  process.env.BOT_TOKEN = TEST_BOT_TOKEN;
  process.env.OWNER_TELEGRAM_IDS = '777000111';
  process.env.DB_PATH = path.join(dbDir, 'test.db');
  process.env.SERVER_TZ_OFFSET_HOURS = '0';
  process.env.SPIN_PRICE_STARS = '5';

  const config = await import('../server/config.js');
  const dbModule = await import('../server/db.js');
  const auth = await import('../server/auth.js');
  const game = await import('../server/game.js');
  const payments = await import('../server/payments.js');
  const finance = await import('../server/finance.js');

  return { config, db: dbModule.db, dbModule, auth, game, payments, finance };
}

/** Moves the server "today" forward by whole days. */
export function advanceDays(config, days) {
  config.config.serverTzOffsetHours += days * 24;
}

export function makeUser(auth, id, username = `user${id}`) {
  return auth.buildInitDataForTest({
    id,
    username,
    first_name: 'Test',
    last_name: 'User',
    language_code: 'ru',
  });
}

/** Plays one free spin per day for `days` consecutive days. */
export function playFreeSpins(game, userId, days) {
  const results = [];
  for (let i = 0; i < days; i += 1) results.push(game.spinFree(userId));
  return results;
}