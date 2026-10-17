import { config } from './config.js';
import { db, getSetting, setSetting } from './db.js';
import { GIFTS, OUTCOMES } from './roulette.js';
import { getGiftCosts, getGuaranteeDays, getGuaranteeGift, getProbabilities, getSpinPrice, isPaidSpinsEnabled, areSpinsEnabled } from './game.js';
import { call } from './tg.js';

const COST_KEY = 'budget_stars';

export function getBudget() {
  const raw = getSetting(COST_KEY);
  if (raw === null || raw === '') return config.budgetWarningStars * 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : config.budgetWarningStars * 10;
}

export function setBudget(stars) {
  setSetting(COST_KEY, String(stars));
  return getBudget();
}

export function rangeFilter(from, to, column = 'created_at') {
  const where = [];
  const params = [];
  if (from) {
    where.push(`${column} >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`${column} <= ?`);
    params.push(`${to}T23:59:59.999Z`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function giftStats({ from = null, to = null } = {}) {
  const { clause, params } = rangeFilter(from, to);
  const counts = Object.fromEntries(Object.keys(GIFTS).map((g) => [g, 0]));
  for (const row of db.prepare(`SELECT gift, COUNT(*) AS n FROM wins ${clause} GROUP BY gift`).all(...params)) {
    counts[row.gift] = row.n;
  }
  const status = { pending: 0, delivered: 0, cancelled: 0 };
  for (const row of db
    .prepare(`SELECT status, COUNT(*) AS n FROM wins ${clause} GROUP BY status`)
    .all(...params)) {
    status[row.status] = row.n;
  }
  const guaranteed = db
    .prepare(`SELECT COUNT(*) AS n FROM wins ${clause ? `${clause} AND` : 'WHERE'} kind = 'guarantee'`)
    .get(...params).n;
  return { counts, status, guaranteed };
}

export function overview({ from = null, to = null } = {}) {
  const { clause, params } = rangeFilter(from, to);

  const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const newUsers = db.prepare(`SELECT COUNT(*) AS n FROM users ${clause}`).get(...params).n;
  const activeDay = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?`)
    .get(new Date(Date.now() - 86400000).toISOString()).n;
  const activeWeek = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= ?`)
    .get(new Date(Date.now() - 7 * 86400000).toISOString()).n;

  const spins = Object.fromEntries(
    db
      .prepare(`SELECT kind, COUNT(*) AS n FROM spins ${clause} GROUP BY kind`)
      .all(...params)
      .map((r) => [r.kind, r.n]),
  );
  const empty = db.prepare(`SELECT COUNT(*) AS n FROM spins ${clause ? `${clause} AND` : 'WHERE'} outcome = 'none'`).get(...params).n;
  const totalSpins = Object.values(spins).reduce((a, b) => a + b, 0);

  const gifts = giftStats({ from, to });

  const paid = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS stars FROM payments ${rangeFilter(from, to).clause ? `${rangeFilter(from, to).clause} AND` : 'WHERE'} status = 'paid'`)
    .get(...rangeFilter(from, to).params);
  const refunded = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS stars FROM payments ${rangeFilter(from, to).clause ? `${rangeFilter(from, to).clause} AND` : 'WHERE'} status = 'refunded'`)
    .get(...rangeFilter(from, to).params);
  const failed = db
    .prepare(`SELECT COUNT(*) AS n FROM payments ${rangeFilter(from, to).clause ? `${rangeFilter(from, to).clause} AND` : 'WHERE'} status = 'failed'`)
    .get(...rangeFilter(from, to).params);
  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM payments ${rangeFilter(from, to).clause ? `${rangeFilter(from, to).clause} AND` : 'WHERE'} status = 'created'`)
    .get(...rangeFilter(from, to).params);

  return {
    range: { from, to },
    users: { total: totalUsers, newInRange: newUsers, active24h: activeDay, active7d: activeWeek },
    spins: {
      total: totalSpins,
      free: spins.free ?? 0,
      paid: spins.paid ?? 0,
      guarantee: spins.guarantee ?? 0,
      empty,
      won: totalSpins - empty,
    },
    gifts: {
      won: gifts.counts,
      wonTotal: Object.values(gifts.counts).reduce((a, b) => a + b, 0),
      status: gifts.status,
      guaranteed: gifts.guaranteed,
      pending: gifts.status.pending,
      delivered: gifts.status.delivered,
      cancelled: gifts.status.cancelled,
    },
    payments: {
      paidCount: paid.n,
      starsReceived: paid.stars,
      refundedCount: refunded.n,
      starsRefunded: refunded.stars,
      failedCount: failed.n,
      awaitingCount: pending.n,
    },
    settings: {
      spinPriceStars: getSpinPrice(),
      probabilities: getProbabilities(),
      giftCosts: getGiftCosts(),
      guaranteeDays: getGuaranteeDays(),
      guaranteeGift: getGuaranteeGift(),
      paidSpinsEnabled: isPaidSpinsEnabled(),
      spinsEnabled: areSpinsEnabled(),
    },
  };
}

/** Actual Telegram-side data, when the bot token allows it. */
export async function settlements() {
  try {
    const balance = await call('getMyStarBalance', {}, { retries: 1 });
    const txs = await call('getStarTransactions', { offset: 0, limit: 100 }, { retries: 1 });
    const byType = {};
    let total = 0;
    for (const t of txs?.transactions ?? []) {
      const type = t?.type ?? 'unknown';
      byType[type] = (byType[type] ?? 0) + (Number(t?.amount) || 0);
      total += Number(t?.amount) || 0;
    }
    return {
      ok: true,
      balanceStars: balance?.balance?.amount ?? null,
      recentTransactions: (txs?.transactions ?? []).slice(0, 50).map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        date: t.date,
        source: t.source?.type ?? null,
        payload: t.source?.invoice_payload ?? null,
        nanostarAmount: t.source?.nanostar_amount ?? null,
      })),
      totalByType: byType,
      totalReceived: total,
      note: 'Bot API не показывает вывод Stars на стороне владельца — данные о реальных расчётах доступны только владельцу.',
    };
  } catch (err) {
    return { ok: false, error: err.message, note: 'Не удалось получить данные Telegram. Проверьте токен бота и лимиты.' };
  }
}

function costOf(win) {
  const costs = getGiftCosts();
  return costs[win.gift] ?? 0;
}

export function finance({ from = null, to = null } = {}) {
  const costs = getGiftCosts();
  const { clause, params } = rangeFilter(from, to);

  const rows = db
    .prepare(`SELECT gift, status, kind, COUNT(*) AS n FROM wins ${clause} GROUP BY gift, status, kind`)
    .all(...params);

  const byGiftStatus = {};
  for (const g of Object.keys(GIFTS)) byGiftStatus[g] = { pending: 0, delivered: 0, cancelled: 0, cost: costs[g] };
  for (const r of rows) {
    if (!byGiftStatus[r.gift]) continue;
    byGiftStatus[r.gift][r.status] = r.n;
  }

  const deliveredCost = Object.entries(byGiftStatus).reduce((acc, [g, v]) => acc + v.delivered * costs[g], 0);
  const pendingCost = Object.entries(byGiftStatus).reduce((acc, [g, v]) => acc + v.pending * costs[g], 0);
  const cancelledCost = Object.entries(byGiftStatus).reduce((acc, [g, v]) => acc + v.cancelled * costs[g], 0);

  const revenue = db
    .prepare(`SELECT COALESCE(SUM(amount),0) AS stars FROM payments ${rangeFilter(from, to).clause ? `${rangeFilter(from, to).clause} AND` : 'WHERE'} status = 'paid'`)
    .get(...rangeFilter(from, to).params).stars;
  const refunds = db
    .prepare(`SELECT COALESCE(SUM(amount),0) AS stars FROM payments ${rangeFilter(from, to).clause ? `${rangeFilter(from, to).clause} AND` : 'WHERE'} status = 'refunded'`)
    .get(...rangeFilter(from, to).params).stars;

  const guarantee = estimateGuaranteeLiability();

  const netStars = revenue - refunds - deliveredCost - pendingCost;

  return {
    range: { from, to },
    currencyNote:
      'Внутренняя оценка подарков в Stars задана владельцем. Это не официальный курс Telegram и не денежный остаток.',
    revenue: {
      paidSpins: db
        .prepare(`SELECT COUNT(*) AS n FROM payments ${rangeFilter(from, to).clause ? `${rangeFilter(from, to).clause} AND` : 'WHERE'} status = 'paid'`)
        .get(...rangeFilter(from, to).params).n,
      grossStars: revenue,
      refundedStars: refunds,
      netReceivedStars: revenue - refunds,
    },
    expenses: {
      byGift: Object.entries(byGiftStatus).map(([gift, v]) => ({
        gift,
        title: GIFTS[gift].title,
        unitCostStars: costs[gift],
        delivered: v.delivered,
        pending: v.pending,
        cancelled: v.cancelled,
        deliveredCostStars: v.delivered * costs[gift],
        pendingCostStars: v.pending * costs[gift],
      })),
      deliveredCostStars: deliveredCost,
      pendingObligationStars: pendingCost,
      cancelledValueStars: cancelledCost,
      guaranteeExposureStars: guarantee.totalStars,
    },
    result: {
      estimatedNetStars: netStars,
      note: 'Оценка: поступившие Stars минус обязательства по выданным и ожидающим выдачи подаркам. Не является прибылью.',
      breakEvenStars: deliveredCost + pendingCost,
      breakEvenPaidSpins: Math.ceil((deliveredCost + pendingCost) / Math.max(1, getSpinPrice())),
    },
    guaranteeExposure: guarantee,
    risk: riskReport({ pendingCost, deliveredCost }),
  };
}

/**
 * Expected future cost of guarantees, assuming each user keeps one free spin
 * every day. For a user on day N the chance of reaching day 31 is (31 - N)/31.
 */
export function estimateGuaranteeLiability() {
  const guaranteeDays = getGuaranteeDays();
  const gift = getGuaranteeGift();
  const costs = getGiftCosts();
  const unit = costs[gift] ?? 0;

  const users = db
    .prepare(
      `SELECT tg_id, streak_count, series_gift_won, guarantee_claimed, streak_last_day FROM users
       WHERE guarantee_claimed = 0 AND series_gift_won = 0 AND streak_count < ?`,
    )
    .all(guaranteeDays);

  let expected = 0;
  for (const u of users) {
    const remaining = Math.max(0, guaranteeDays - u.streak_count);
    expected += (remaining / guaranteeDays) * unit;
  }
  return {
    usersAtRisk: users.length,
    guaranteeDays,
    gift,
    unitCostStars: unit,
    totalStars: Math.round(expected * 100) / 100,
    method: `P = (${guaranteeDays} - текущий день) / ${guaranteeDays}, стоимость подарка гарантии ${unit} ⭐`,
    estimate: true,
  };
}

export function riskReport({ pendingCost = null, deliveredCost = null } = {}) {
  const costs = getGiftCosts();
  const guarantee = estimateGuaranteeLiability();
  const pending =
    pendingCost ??
    db
      .prepare(`SELECT gift, COUNT(*) AS n FROM wins WHERE status = 'pending' GROUP BY gift`)
      .all()
      .reduce((acc, r) => acc + r.n * (costs[r.gift] ?? 0), 0);
  const spent =
    deliveredCost ??
    db
      .prepare(`SELECT gift, COUNT(*) AS n FROM wins WHERE status = 'delivered' GROUP BY gift`)
      .all()
      .reduce((acc, r) => acc + r.n * (costs[r.gift] ?? 0), 0);

  const budget = getBudget();
  const exposure = pending + guarantee.totalStars;
  const ratio = budget > 0 ? exposure / budget : 0;

  let level = 'ok';
  if (exposure >= budget || ratio >= 1) level = 'critical';
  else if (exposure >= budget * (config.budgetCriticalStars / Math.max(1, config.budgetWarningStars)) || exposure >= config.budgetWarningStars) level = 'warning';

  return {
    budgetStars: budget,
    pendingObligationStars: pending,
    deliveredSpentStars: spent,
    guaranteeExposureStars: guarantee.totalStars,
    totalExposureStars: Math.round(exposure * 100) / 100,
    level,
    paidSpinsEnabled: isPaidSpinsEnabled(),
    spinsEnabled: areSpinsEnabled(),
    recommendation:
      level === 'critical'
        ? 'Обязательства превышают бюджет. Отключите новые платные спины, чтобы не увеличивать риск.'
        : level === 'warning'
          ? 'Приближение к бюджету. Следите за темпом выдачи подарков.'
          : 'Обязательства в пределах бюджета.',
    confirmedObligationsPreserved:
      'Отключение новых спинов не отменяет уже выигранные подарки: они остаются в статусе «Ожидает выдачи».',
  };
}

/**
 * Scenario forecast. Every number is explicitly an estimate based on the stated
 * assumptions, never a promise.
 */
export function forecast({
  horizons = [30, 90, 180],
  paidSpinsPerUser = 3,
  userCounts = [100, 500, 1000, 5000],
} = {}) {
  const probabilities = getProbabilities();
  const costs = getGiftCosts();
  const price = getSpinPrice();
  const guaranteeDays = getGuaranteeDays();
  const guaranteeGift = getGuaranteeGift();

  const expectedCostPerNormalSpin = OUTCOMES.reduce((acc, key) => {
    if (key === 'none') return acc;
    return acc + (probabilities[key] / 100) * (costs[key] ?? 0);
  }, 0);

  const scenarios = [];
  for (const users of userCounts) {
    for (const horizon of horizons) {
      const freeSpins = users * horizon;
      const paidSpins = users * paidSpinsPerUser;
      const totalSpins = freeSpins + paidSpins;

      const normalWins = OUTCOMES.filter((o) => o !== 'none').reduce(
        (acc, key) => {
          acc[key] = Math.round(totalSpins * (probabilities[key] / 100) * 100) / 100;
          return acc;
        },
        {},
      );
      const normalCost = OUTCOMES.reduce(
        (acc, key) => (key === 'none' ? acc : acc + normalWins[key] * (costs[key] ?? 0)),
        0,
      );

      const guaranteeCount = (users * Math.max(0, horizon - (guaranteeDays - 1))) / guaranteeDays;
      const guaranteeCost = guaranteeCount * (costs[guaranteeGift] ?? 0);

      const unsettledWindow = Math.min(14, horizon);
      const pendingEstimate = (totalSpins * (unsettledWindow / Math.max(1, horizon))) * expectedCostPerNormalSpin
        + ((users * Math.max(0, horizon - (guaranteeDays - 1))) / guaranteeDays) * ((costs[guaranteeGift] ?? 0) * (unsettledWindow / Math.max(1, horizon)));

      const revenue = paidSpins * price;
      const totalCost = normalCost + guaranteeCost;

      scenarios.push({
        users,
        horizonDays: horizon,
        freeSpins,
        paidSpins,
        revenueStars: revenue,
        expectedNormalWins: normalWins,
        expectedGuaranteeGifts: Math.round(guaranteeCount * 100) / 100,
        expectedNormalCostStars: round2(normalCost),
        expectedGuaranteeCostStars: round2(guaranteeCost),
        expectedTotalCostStars: round2(totalCost),
        estimatedResultStars: round2(revenue - totalCost),
        estimatedPendingObligationStars: round2(pendingEstimate),
        breakEvenPaidSpinsPerUser: round2((totalCost / Math.max(1, users)) / Math.max(1, price)),
      });
    }
  }

  return {
    estimate: true,
    assumptions: {
      probabilitySource: 'текущие настройки вероятностей',
      freeSpinsPerUserPerDay: 1,
      paidSpinsPerUser,
      spinPriceStars: price,
      guaranteeDays,
      guaranteeGift,
      giftCosts: costs,
      note: 'Гарантия срабатывает на ' + guaranteeDays + '-й день непрерывной серии, поэтому её ожидаемое число линейно растёт с горизонтом.',
    },
    scenarios,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function setToggle(name, value) {
  if (!['paid_spins_enabled', 'all_spins_enabled'].includes(name)) {
    throw new Error('Unknown toggle');
  }
  setSetting(name, value ? '1' : '0');
  return { name, value: Boolean(value) };
}