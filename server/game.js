import crypto from 'node:crypto';
import { config } from './config.js';
import { db, tx, getSetting, getSettingJson, setSetting } from './db.js';
import { GIFTS, OUTCOME_META, rollOutcome, validateProbabilities } from './roulette.js';

export class SpinError extends Error {
  constructor(message, code = 'spin_error', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function serverNow() {
  return new Date(Date.now() + config.serverTzOffsetHours * 3600_000);
}

/** The calendar day on the server. The client clock is never consulted. */
export function serverDay(date = serverNow()) {
  return date.toISOString().slice(0, 10);
}

/** Start of the next server day, as a real UTC timestamp. */
export function nextDayStart(day = serverDay()) {
  const base = new Date(`${day}T00:00:00.000Z`).getTime() - config.serverTzOffsetHours * 3600_000;
  return base + 24 * 3600_000;
}

export function nextFreeSpinAtIso(user) {
  if (!user.free_spin_day) return null;
  return new Date(nextDayStart(user.free_spin_day)).toISOString();
}

export function dayDiff(fromDay, toDay) {
  const a = Date.parse(`${fromDay}T00:00:00.000Z`);
  const b = Date.parse(`${toDay}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function getProbabilities() {
  return validateProbabilities(getSettingJson('probabilities', { cake: 1, bear: 3, heart: 3, none: 93 }));
}

export function getSpinPrice() {
  const n = Number(getSetting('spin_price_stars'));
  return Number.isFinite(n) && n > 0 ? n : config.spinPriceStars;
}

export function getGuaranteeDays() {
  const n = Number(getSetting('guarantee_days'));
  return Number.isInteger(n) && n > 0 ? n : config.guaranteeDays;
}

export function getGuaranteeGift() {
  const gift = getSetting('guarantee_gift');
  if (gift && GIFTS[gift]) return gift;
  return GIFTS[config.guaranteeGift] ? config.guaranteeGift : 'bear';
}

/** Каждые N дней серии выдаётся дополнительный бесплатный спин. 0 — выключено. */
export function getSeriesBonusEvery() {
  const n = Number(getSetting('series_bonus_every'));
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return Math.max(0, Math.floor(config.seriesBonusEvery));
}

export function getGiftCosts() {
  const stored = getSettingJson('gift_costs', config.giftCostStars);
  return {
    bear: Number(stored.bear) || 0,
    heart: Number(stored.heart) || 0,
    cake: Number(stored.cake) || 0,
  };
}

function flag(name) {
  return getSetting(name) === '1';
}

export function isPaidSpinsEnabled() {
  return flag('all_spins_enabled') && flag('paid_spins_enabled');
}

export function areSpinsEnabled() {
  return flag('all_spins_enabled');
}

function generateWinCode() {
  for (let i = 0; i < 40; i += 1) {
    const code = `FS-${crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')}`;
    const exists = db.prepare('SELECT 1 FROM wins WHERE win_code = ?').get(code);
    if (!exists) return code;
  }
  throw new SpinError('Could not allocate a unique win number', 'win_code_collision', 500);
}

export function enqueueOwnerNotification(winId, chatId, text) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO notify_queue (win_id, chat_id, text, status, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(winId, chatId, text, now, now);
}

export function buildOwnerNotificationText({ gift, user, winCode, kindLabel, createdAt }) {
  const handle = user.username ? `@${user.username}` : '—';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || '—';
  return [
    '🎁 Новый выигрыш Free Stars!',
    '',
    `Подарок: ${gift.emoji} ${gift.title}`,
    `Пользователь: ${handle}`,
    `Имя: ${name}`,
    `Telegram ID: ${user.tg_id}`,
    `Номер выигрыша: ${winCode}`,
    `Тип спина: ${kindLabel}`,
    `Дата и время: ${createdAt}`,
    'Статус: ожидает выдачи',
  ].join('\n');
}

function kindLabel(kind) {
  if (kind === 'paid') return 'платный';
  if (kind === 'guarantee') return 'гарантированный';
  return 'обычный';
}

export function insertSpin({ userId, kind, outcome, roll, probabilities, paymentId = null, isBonus = false }) {
  const createdAt = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO spins (user_id, kind, outcome, roll, probabilities, payment_id, created_at, is_bonus)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, kind, outcome, roll, JSON.stringify(probabilities), paymentId, createdAt, isBonus ? 1 : 0);
  const spinId = Number(res.lastInsertRowid);
  db.prepare('UPDATE users SET spins_total = spins_total + 1 WHERE tg_id = ?').run(userId);
  return { spinId, createdAt };
}

export function attachWin({ user, spinId, outcome, kind, paymentId, createdAt }) {
  const gift = GIFTS[outcome];
  const winCode = generateWinCode();
  const win = db
    .prepare(
      `INSERT INTO wins (win_code, user_id, gift, kind, spin_id, payment_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(winCode, user.tg_id, outcome, kind, spinId, paymentId, createdAt, createdAt);

  db.prepare('UPDATE spins SET win_code = ? WHERE id = ?').run(winCode, spinId);
  db.prepare('UPDATE users SET wins_total = wins_total + 1, series_gift_won = 1 WHERE tg_id = ?').run(user.tg_id);

  const winId = Number(win.lastInsertRowid);
  const text = buildOwnerNotificationText({
    gift,
    user,
    winCode,
    kindLabel: kindLabel(kind),
    createdAt,
  });
  for (const ownerId of config.ownerIds) {
    enqueueOwnerNotification(winId, ownerId, text);
  }
  return { winCode, winId, gift };
}

export function shapeResult({ kind, outcome, roll, createdAt, winCode = null, streak = null, guaranteeDays = null, bonus = false, bonusGranted = false }) {
  return {
    kind,
    outcome,
    roll,
    createdAt,
    bonus,
    bonusGranted,
    spinNumber: undefined,
    win: winCode
      ? {
          code: winCode,
          gift: GIFTS[outcome],
          giftId: outcome,
          createdAt,
          status: 'pending',
          statusLabel: 'Ожидает выдачи',
          ownerUsername: config.ownerUsername,
          ownerUrl: `https://t.me/${config.ownerUsername}`,
        }
      : null,
    streak: streak ?? null,
    guaranteeDays: guaranteeDays ?? null,
  };
}

/**
 * One free spin per server day.
 * Serialised in an IMMEDIATE transaction: double taps, refreshes and
 * simultaneous requests can never produce two free spins or two streak days.
 */
export function assertNotBlocked(userId) {
  const row = db.prepare('SELECT blocked FROM users WHERE tg_id = ?').get(userId);
  if (row?.blocked === 1) throw new SpinError('Доступ к вращениям заблокирован', 'user_blocked', 403);
}

export function spinFree(userId) {
  if (!areSpinsEnabled()) throw new SpinError('Вращения временно приостановлены', 'spins_paused', 503);
  assertNotBlocked(userId);

  return tx(() => {
    const user = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(userId);
    if (!user) throw new SpinError('User not found', 'unknown_user', 404);

const today = serverDay();
    // Ежедневная попытка — основная. Бонусные спины дают дополнительные
    // нажатия сверх неё и никогда не подменяют её, иначе серия рвалась бы.
    const dailyAvailable = !user.free_spin_day || user.free_spin_day < today;
    const useBonus = !dailyAvailable && Number(user.bonus_spins ?? 0) > 0;
    if (!useBonus && !dailyAvailable) {
      throw new SpinError('Бесплатный спин сегодня уже использован', 'already_spun_today', 409);
    }

    const guaranteeDays = getGuaranteeDays();
    const guaranteeGift = getGuaranteeGift();
    const continuesSeries = !useBonus && Boolean(user.streak_last_day) && dayDiff(user.streak_last_day, today) === 1;
    const newStreak = continuesSeries ? user.streak_count + 1 : useBonus ? user.streak_count : 1;
    const seriesGiftWon = Boolean(continuesSeries) && Number(user.series_gift_won) === 1;
    const guaranteeClaimed = Boolean(continuesSeries) && Number(user.guarantee_claimed) === 1;

    const probabilities = getProbabilities();

    let kind = 'free';
    let outcome;
    let roll;
    if (!useBonus && newStreak >= guaranteeDays && !seriesGiftWon && !guaranteeClaimed) {
      kind = 'guarantee';
      outcome = guaranteeGift;
      roll = null;
    } else {
      const drawn = rollOutcome(probabilities);
      outcome = drawn.outcome;
      roll = drawn.roll;
    }

    const { spinId, createdAt } = insertSpin({
      userId,
      kind,
      outcome,
      roll,
      probabilities,
      isBonus: useBonus,
    });

    let winCode = null;
    if (outcome !== 'none') {
      const win = attachWin({ user, spinId, outcome, kind, paymentId: null, createdAt });
      winCode = win.winCode;
    }

    const seriesWonThisSpin = seriesGiftWon || outcome !== 'none';
    const guaranteeClaimedFinal = kind === 'guarantee' ? true : guaranteeClaimed;

    // Каждые N дней серии — дополнительный бесплатный спин (5, 10, 15, 20, 25, 30).
    // День гарантии исключён: там и так выдаётся подарок.
    const bonusEvery = getSeriesBonusEvery();
    const grantBonusSpin =
      !useBonus && bonusEvery > 0 && newStreak > 1 && newStreak % bonusEvery === 0 && newStreak < guaranteeDays;

    if (useBonus) {
      db.prepare('UPDATE users SET bonus_spins = bonus_spins - 1 WHERE tg_id = ?').run(userId);
    } else {
      db.prepare(
        `UPDATE users SET free_spin_day = ?, streak_count = ?, streak_last_day = ?,
           series_gift_won = ?, guarantee_claimed = ?, bonus_spins = bonus_spins + ? WHERE tg_id = ?`,
      ).run(
        today,
        newStreak,
        today,
        seriesWonThisSpin ? 1 : 0,
        guaranteeClaimedFinal ? 1 : 0,
        grantBonusSpin ? 1 : 0,
        userId,
      );
    }

    return shapeResult({
      kind,
      outcome,
      roll,
      createdAt,
      winCode,
      bonus: useBonus,
      bonusGranted: grantBonusSpin,
      streak: {
        day: newStreak,
        total: guaranteeDays,
        remaining: Math.max(0, guaranteeDays - newStreak),
        giftWonInSeries: seriesWonThisSpin,
      },
      guaranteeDays,
    });
  });
}

/**
 * Consumes a confirmed paid spin. `paymentId` is the primary key of an already
 * confirmed payment row; the spin is created at most once per payment.
 */
export function spinPaid(userId, paymentId) {
  if (!areSpinsEnabled()) throw new SpinError('Вращения временно приостановлены', 'spins_paused', 503);
  if (!isPaidSpinsEnabled()) throw new SpinError('Платные спины временно отключены', 'paid_spins_disabled', 503);
  assertNotBlocked(userId);

  // Платный спин покупают только после ежедневного бесплатного — иначе игрок
  // платил бы Stars вместо бесплатной попытки.
  const owner = db.prepare('SELECT free_spin_day FROM users WHERE tg_id = ?').get(userId);
  if (owner && (!owner.free_spin_day || owner.free_spin_day < serverDay())) {
    throw new SpinError('Сначала используйте бесплатный спин', 'daily_spin_available', 409);
  }

  return tx(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) throw new SpinError('Платёж не найден', 'payment_not_found', 404);
    if (payment.user_id !== userId) throw new SpinError('Платёж принадлежит другому пользователю', 'payment_user_mismatch', 403);
    if (payment.status !== 'paid') throw new SpinError('Платёж не подтверждён', 'payment_not_paid', 409);
    if (payment.spin_id) throw new SpinError('Спин по этому платежу уже выдан', 'payment_already_used', 409);

    const user = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(userId);
    if (!user) throw new SpinError('User not found', 'unknown_user', 404);

    const probabilities = getProbabilities();
    const drawn = rollOutcome(probabilities);
    const { spinId, createdAt } = insertSpin({
      userId,
      kind: 'paid',
      outcome: drawn.outcome,
      roll: drawn.roll,
      probabilities,
      paymentId,
    });

    db.prepare('UPDATE payments SET spin_id = ? WHERE id = ?').run(spinId, paymentId);

    let winCode = null;
    if (drawn.outcome !== 'none') {
      const win = attachWin({ user, spinId, outcome: drawn.outcome, kind: 'paid', paymentId, createdAt });
      winCode = win.winCode;
    }

    return shapeResult({
      kind: 'paid',
      outcome: drawn.outcome,
      roll: drawn.roll,
      createdAt,
      winCode,
      streak: null,
    });
  });
}

/** Result of the spin that a confirmed paid payment bought. */
export function paidSpinResultForUser(userId, payload) {
  const payment = db
    .prepare('SELECT * FROM payments WHERE invoice_payload = ? AND user_id = ?')
    .get(payload, userId);
  if (!payment) return null;

  const win = payment.spin_id
    ? db.prepare('SELECT * FROM wins WHERE spin_id = ? AND user_id = ?').get(payment.spin_id, userId)
    : null;

  const spin = payment.spin_id ? db.prepare('SELECT * FROM spins WHERE id = ?').get(payment.spin_id) : null;

  return {
    payload: payment.invoice_payload,
    paymentStatus: payment.status,
    statusLabel: { created: 'Ожидает оплаты', paid: 'Оплачен', failed: 'Ошибка', refunded: 'Возвращён' }[payment.status],
    failureReason: payment.failure_reason,
    consumed: payment.spin_id !== null,
    spin: spin
      ? shapeResult({
          kind: spin.kind,
          outcome: spin.outcome,
          roll: spin.roll,
          createdAt: spin.created_at,
          winCode: win?.win_code ?? null,
        })
      : null,
  };
}

export function freeSpinStatus(user) {
  const today = serverDay();
  const bonusSpins = Number(user.bonus_spins ?? 0);
  const available = (!user.free_spin_day || user.free_spin_day < today) || bonusSpins > 0;
  const guaranteeDays = getGuaranteeDays();
  const dailyAvailable = !user.free_spin_day || user.free_spin_day < today;
  const continues = dailyAvailable && Boolean(user.streak_last_day) && dayDiff(user.streak_last_day, today) === 1;
  const day = dailyAvailable ? (continues ? user.streak_count + 1 : 1) : user.streak_count;
  const bonusEvery = getSeriesBonusEvery();
  return {
    available,
    dailyAvailable,
    bonusSpins,
    bonusEvery,
    today,
    nextFreeSpinAt: available ? null : nextFreeSpinAtIso(user),
    streak: {
      day: Math.max(0, day),
      total: guaranteeDays,
      remaining: Math.max(0, guaranteeDays - Math.max(0, day)),
      giftWonInSeries: user.series_gift_won === 1,
      guaranteeClaimed: user.guarantee_claimed === 1,
      atRisk: Boolean(user.streak_last_day) && !available && (dayDiff(user.streak_last_day, today) ?? 0) > 1,
    },
  };
}

export function userHistory(userId, limit = 50) {
  const rows = db
    .prepare(
      `SELECT w.win_code, w.gift, w.kind, w.status, w.cancel_reason, w.created_at, w.delivered_at
       FROM wins w WHERE w.user_id = ? ORDER BY w.id DESC LIMIT ?`,
    )
    .all(userId, Math.min(Math.max(1, limit), 200));

  const counts = db
    .prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS pending FROM wins WHERE user_id = ?')
    .get('pending', userId);

  return {
    total: counts?.total ?? 0,
    pending: counts?.pending ?? 0,
    items: rows.map((r) => ({
      code: r.win_code,
      giftId: r.gift,
      gift: GIFTS[r.gift],
      kind: r.kind,
      kindLabel: kindLabel(r.kind),
      status: r.status,
      statusLabel: { pending: 'Ожидает выдачи', delivered: 'Выдан', cancelled: 'Отменён' }[r.status],
      cancelReason: r.cancel_reason,
      createdAt: r.created_at,
      deliveredAt: r.delivered_at,
    })),
  };
}

/** Public snapshot used by the Mini App bootstrap and by tests. */
export function publicConfig() {
  const probabilities = getProbabilities();
  return {
    appName: config.appName,
    ownerUsername: config.ownerUsername,
    ownerUrl: `https://t.me/${config.ownerUsername}`,
    spinPriceStars: getSpinPrice(),
    paidSpinsEnabled: isPaidSpinsEnabled(),
    spinsEnabled: areSpinsEnabled(),
    guaranteeDays: getGuaranteeDays(),
    // Подарок гарантии намеренно не раскрывается в клиентском интерфейсе.
    guaranteeDaysOnly: true,
    guarantee: { emoji: '🎁', title: 'Гарантированный подарок', image: null },
    seriesBonusEvery: getSeriesBonusEvery(),
    probabilities,
    gifts: GIFTS,
    outcomeMeta: OUTCOME_META,
  };
}

export function setProbabilities(next, adminId) {
  const cleaned = validateProbabilities(next);
  const previous = getProbabilities();
  setSetting('probabilities', JSON.stringify(cleaned));
  db.prepare('INSERT INTO probability_history (old_value, new_value, changed_by, created_at) VALUES (?, ?, ?, ?)').run(
    JSON.stringify(previous),
    JSON.stringify(cleaned),
    adminId ?? null,
    new Date().toISOString(),
  );
  return { previous, current: cleaned };
}