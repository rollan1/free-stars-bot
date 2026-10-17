/**
 * Инструменты владельца над любым пользователем.
 * Доступны только через /api/admin/*, где права проверяются по числовому ID.
 * Каждое действие фиксируется в admin_log.
 */
import { db, tx, writeAudit } from './db.js';
import { config } from './config.js';
import { GIFTS, rollOutcome } from './roulette.js';
import {
  SpinError,
  serverDay,
  getProbabilities,
  getGuaranteeDays,
  getGuaranteeGift,
  freeSpinStatus,
  userHistory,
  shapeResult,
  attachWin,
  insertSpin,
} from './game.js';

export class AdminOpError extends Error {
  constructor(message, code = 'admin_op_error', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function ensureUser(userId, profile = {}) {
  if (!Number.isInteger(userId)) throw new AdminOpError('Некорректный Telegram ID', 'bad_user_id');
  const existing = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(userId);
  if (existing) return existing;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (tg_id, username, first_name, last_name, language_code, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, profile.username ?? null, profile.firstName ?? null, profile.lastName ?? null, profile.languageCode ?? null, now, now);
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(userId);
}

function reload(userId) {
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(userId);
}

export function describeUser(userId) {
  const user = reload(userId);
  if (!user) return null;
  return {
    id: user.tg_id,
    username: user.username,
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
    blocked: user.blocked === 1,
    notes: user.notes ?? null,
    createdAt: user.created_at,
    lastSeenAt: user.last_seen_at,
    freeSpinDay: user.free_spin_day,
    streak: { day: user.streak_count, lastDay: user.streak_last_day, guaranteeDays: getGuaranteeDays() },
    seriesGiftWon: user.series_gift_won === 1,
    guaranteeClaimed: user.guarantee_claimed === 1,
    totals: { spins: user.spins_total, wins: user.wins_total },
    bonusSpins: Number(user.bonus_spins ?? 0),
    pendingWins: db.prepare("SELECT COUNT(*) AS n FROM wins WHERE user_id = ? AND status = 'pending'").get(userId).n,
  };
}

/** Принудительный спин за администратора. kind: free | paid | guarantee | normal. */
export function forceSpin(userId, { kind = 'normal', outcome = null } = {}, adminId) {
  return tx(() => {
    const user = ensureUser(userId);
    const probabilities = getProbabilities();

    const finalKind = kind === 'guarantee' || kind === 'paid' || kind === 'free' ? kind : 'free';

    let finalOutcome;
    let roll = null;
    if (finalKind === 'guarantee') {
      finalOutcome = getGuaranteeGift();
    } else if (outcome) {
      if (!GIFTS[outcome] && outcome !== 'none') {
        throw new AdminOpError(`Неизвестный подарок: ${outcome}`, 'bad_gift');
      }
      finalOutcome = outcome;
    } else {
      const drawn = rollOutcome(probabilities);
      finalOutcome = drawn.outcome;
      roll = drawn.roll;
    }

    const { spinId, createdAt } = insertSpin({
      userId,
      kind: finalKind,
      outcome: finalOutcome,
      roll,
      probabilities,
      paymentId: null,
    });

    let winCode = null;
    if (finalOutcome !== 'none') {
      winCode = attachWin({ user, spinId, outcome: finalOutcome, kind: finalKind, paymentId: null, createdAt }).winCode;
      db.prepare('UPDATE users SET series_gift_won = 1 WHERE tg_id = ?').run(userId);
      if (finalKind === 'guarantee') db.prepare('UPDATE users SET guarantee_claimed = 1 WHERE tg_id = ?').run(userId);
    }

    writeAudit(adminId, 'user.force_spin', `${userId}: kind=${finalKind} outcome=${finalOutcome} win=${winCode ?? '-'}`);
    return {
      ...shapeResult({ kind: finalKind, outcome: finalOutcome, roll, createdAt, winCode }),
      forcedByAdmin: true,
    };
  });
}

/** Возвращает пользователю бесплатный спин на сегодня. */
export function grantFreeSpin(userId, adminId) {
  return tx(() => {
    const user = ensureUser(userId);
    db.prepare('UPDATE users SET free_spin_day = NULL WHERE tg_id = ?').run(userId);
    writeAudit(adminId, 'user.grant_free_spin', String(userId));
    return describeUser(userId);
  });
}

/** Выдаёт N дополнительных дней серии (прогресс гарантии). */
export function addStreakDays(userId, days, adminId) {
  const delta = Number(days);
  if (!Number.isInteger(delta) || delta === 0) throw new AdminOpError('Нужно целое число дней', 'bad_days');
  return tx(() => {
    const user = ensureUser(userId);
    const today = serverDay();
    const max = getGuaranteeDays();
    const next = Math.max(0, Math.min(max + 30, user.streak_count + delta));
    // Серия должна идти подряд: сдвигаем последний день на сегодняшний.
    const lastDay = next === 0 ? null : today;
    db.prepare('UPDATE users SET streak_count = ?, streak_last_day = ? WHERE tg_id = ?').run(next, lastDay, userId);
    writeAudit(adminId, 'user.streak_days', `${userId}: ${user.streak_count} -> ${next}`);
    return describeUser(userId);
  });
}

/** Полный сброс серии и гарантии. */
export function resetStreak(userId, adminId) {
  return tx(() => {
    ensureUser(userId);
    db.prepare(
      'UPDATE users SET streak_count = 0, streak_last_day = NULL, series_gift_won = 0, guarantee_claimed = 0 WHERE tg_id = ?',
    ).run(userId);
    writeAudit(adminId, 'user.reset_streak', String(userId));
    return describeUser(userId);
  });
}

/** Отмечает подарок как выданный или возвращает в «ожидает выдачи». */
export function reopenWin(winId, adminId) {
  return tx(() => {
    const win = db.prepare('SELECT * FROM wins WHERE id = ?').get(winId);
    if (!win) throw new AdminOpError('Выигрыш не найден', 'not_found', 404);
    db.prepare('UPDATE wins SET status = ?, delivered_at = NULL, delivered_by = NULL, updated_at = ? WHERE id = ?').run(
      'pending',
      new Date().toISOString(),
      winId,
    );
    writeAudit(adminId, 'win.reopen', win.win_code);
    return { ok: true, winCode: win.win_code, status: 'pending' };
  });
}

/** Блокировка пользователя: не может крутить колесо. */
export function setBlocked(userId, blocked, adminId) {
  return tx(() => {
    ensureUser(userId);
    db.prepare('UPDATE users SET blocked = ? WHERE tg_id = ?').run(blocked ? 1 : 0, userId);
    writeAudit(adminId, 'user.block', `${userId}: ${blocked ? 'blocked' : 'unblocked'}`);
    return describeUser(userId);
  });
}

/** Заметка владельца о пользователе. */
export function setNotes(userId, notes, adminId) {
  const text = typeof notes === 'string' ? notes.slice(0, 500) : null;
  return tx(() => {
    ensureUser(userId);
    db.prepare('UPDATE users SET notes = ? WHERE tg_id = ?').run(text, userId);
    writeAudit(adminId, 'user.notes', `${userId}: ${text ?? ''}`);
    return describeUser(userId);
  });
}

/**
 * Полный сброс пользователя: история выигрышей остаётся (её нельзя терять),
 * но прогресс, серия и счётчики обнуляются.
 */
export function resetUserProgress(userId, adminId) {
  return tx(() => {
    ensureUser(userId);
    db.prepare(
      `UPDATE users SET free_spin_day = NULL, streak_count = 0, streak_last_day = NULL,
         series_gift_won = 0, guarantee_claimed = 0, spins_total = 0, wins_total = 0 WHERE tg_id = ?`,
    ).run(userId);
    db.prepare("UPDATE wins SET status = 'cancelled', cancel_reason = 'Сброшено владельцем', updated_at = ? WHERE user_id = ? AND status = 'pending'").run(
      new Date().toISOString(),
      userId,
    );
    writeAudit(adminId, 'user.reset_progress', String(userId));
    return describeUser(userId);
  });
}

/** Выдаёт подарок напрямую, без спина. */
export function grantWin(userId, gift, adminId) {
  if (!GIFTS[gift]) throw new AdminOpError(`Неизвестный подарок: ${gift}`, 'bad_gift');
  const result = forceSpin(userId, { kind: 'normal', outcome: gift }, adminId);
  writeAudit(adminId, 'user.grant_win', `${userId}: ${gift} → ${result.win?.code ?? '-'}`);
  return result;
}

/** Выдаёт N бонусных спинов: тратятся вместо ежедневной попытки, серию не двигают. */
export function grantBonusSpins(userId, count, adminId) {
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0 || n > 10000) throw new AdminOpError('Нужно целое число от 1 до 10000', 'bad_count');
  return tx(() => {
    ensureUser(userId);
    db.prepare('UPDATE users SET bonus_spins = bonus_spins + ? WHERE tg_id = ?').run(n, userId);
    writeAudit(adminId, 'user.bonus_spins', `${userId}: +${n}`);
    return describeUser(userId);
  });
}

export function setBonusSpins(userId, count, adminId) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new AdminOpError('Нужно целое число от 0 до 10000', 'bad_count');
  return tx(() => {
    ensureUser(userId);
    db.prepare('UPDATE users SET bonus_spins = ? WHERE tg_id = ?').run(n, userId);
    writeAudit(adminId, 'user.bonus_spins_set', `${userId}: ${n}`);
    return describeUser(userId);
  });
}

export function userSnapshot(userId) {
  const user = reload(userId);
  if (!user) return null;
  return {
    ...describeUser(userId),
    spin: freeSpinStatus(user),
    history: userHistory(userId, 20),
  };
}

export const OWNER_IDS = config.ownerIds;