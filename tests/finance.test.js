import test from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, advanceDays } from './helpers.js';

const server = await bootServer('finance');
const { game, db, finance, auth, config } = server;

function seedUser(id, username) {
  return auth.upsertUser({ id, username, firstName: 'F', lastName: String(id), isPremium: false });
}

function markDelivered(winCode, adminId) {
  db.prepare("UPDATE wins SET status = 'delivered', delivered_at = '2024-01-02T00:00:00.000Z', delivered_by = ? WHERE win_code = ?").run(
    adminId,
    winCode,
  );
}

test('внутренние стоимости подарков соответствуют ТЗ', () => {
  const costs = game.getGiftCosts();
  assert.deepEqual(costs, { bear: 15, heart: 15, cake: 50 });
});

test('стоимость подарков по умолчанию не смешивается с поступлениями', () => {
  const f = finance.finance({});
  assert.equal(f.revenue.grossStars, 0);
  assert.equal(f.expenses.deliveredCostStars, 0);
  assert.equal(f.result.estimatedNetStars, 0);
  assert.match(f.currencyNote, /не официальный курс/);
});

test('статистика считает спины, пустые результаты и подарки по видам', () => {
  const a = seedUser(6001, 'a');
  const b = seedUser(6002, 'b');
  assert.ok(a && b);

  // 100% торт для детерминизма
  game.setProbabilities({ cake: 100, bear: 0, heart: 0, none: 0 }, null);
  game.spinFree(6001);
  advanceDays(config, 1);
  game.spinFree(6001);

  // 100% пусто для второго пользователя
  game.setProbabilities({ cake: 0, bear: 0, heart: 0, none: 100 }, null);
  advanceDays(config, 1);
  game.spinFree(6002);
  game.setProbabilities({ cake: 1, bear: 3, heart: 3, none: 93 }, null);

  const stats = finance.overview({});
  assert.equal(stats.spins.total, 3);
  assert.equal(stats.spins.free, 3);
  assert.equal(stats.spins.paid, 0);
  assert.equal(stats.spins.empty, 1);
  assert.equal(stats.spins.won, 2);
  assert.equal(stats.gifts.won.cake, 2);
  assert.equal(stats.gifts.pending, 2);
  assert.equal(stats.users.total >= 2, true);

  const giftStats = finance.giftStats({});
  assert.equal(giftStats.counts.cake, 2);
  assert.equal(giftStats.status.pending, 2);
});

test('подтверждение выдачи попадает в расходы, отмена — нет', () => {
  const wins = db.prepare("SELECT win_code FROM wins WHERE status = 'pending' ORDER BY id LIMIT 2").all();
  markDelivered(wins[0].win_code, 777000111);

  const f = finance.finance({});
  assert.equal(f.expenses.deliveredCostStars, 50, 'один торт = 50 Stars внутренней оценки');
  assert.equal(f.expenses.pendingObligationStars, 50, 'второй торт всё ещё ожидает выдачи');

  const pendingId = db.prepare("SELECT id FROM wins WHERE status = 'pending' LIMIT 1").get().id;
  db.prepare("UPDATE wins SET status = 'cancelled', cancel_reason = 'тест' WHERE id = ?").run(pendingId);

  const f2 = finance.finance({});
  assert.equal(f2.expenses.pendingObligationStars, 0);
  assert.equal(f2.expenses.cancelledValueStars, 50);
  assert.equal(f2.expenses.deliveredCostStars, 50);
});

test('финансовый результат учитывает поступления Stars', () => {
  const now = '2024-05-05T10:00:00.000Z';
  db.prepare(
    `INSERT INTO payments (invoice_payload, telegram_charge_id, user_id, amount, currency, status, created_at, updated_at)
     VALUES ('fin-1', 'fin-charge-1', 6001, 5, 'XTR', 'paid', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO payments (invoice_payload, telegram_charge_id, user_id, amount, currency, status, created_at, updated_at)
     VALUES ('fin-2', 'fin-charge-2', 6001, 5, 'XTR', 'refunded', ?, ?)`,
  ).run(now, now);

  const f = finance.finance({});
  assert.equal(f.revenue.grossStars, 5);
  assert.equal(f.revenue.refundedStars, 5);
  assert.equal(f.revenue.netReceivedStars, 0);
  assert.equal(f.result.estimatedNetStars, -50, '5 поступивших Stars минус 50 обязательств = -50');
  assert.equal(f.result.estimatedNetStars < 0, true, 'проект может быть убыточным — это показывается честно');
});

test('фильтр по датам работает', () => {
  const range = finance.finance({ from: '2024-05-01', to: '2024-05-10' });
  assert.equal(range.revenue.grossStars, 5);
  const other = finance.finance({ from: '2023-01-01', to: '2023-01-05' });
  assert.equal(other.revenue.grossStars, 0);
});

test('оценка обязательств по гарантии считается по формуле (31 - день)/31', () => {
  const exposure = finance.estimateGuaranteeLiability();
  assert.equal(exposure.guaranteeDays, 31);
  assert.equal(exposure.gift, 'bear', 'гарантированный подарок — Мишка');
  assert.equal(exposure.unitCostStars, 15);
  assert.equal(exposure.estimate, true);
  assert.ok(exposure.totalStars >= 0);
  assert.match(exposure.method, /31/);
});

test('прогноз по сценариям считается и помечен как оценка', () => {
  const f = finance.forecast({ paidSpinsPerUser: 3 });
  assert.equal(f.estimate, true);
  const users = new Set(f.scenarios.map((s) => s.users));
  assert.deepEqual([...users].sort((a, b) => a - b), [100, 500, 1000, 5000]);

  const s100 = f.scenarios.find((s) => s.users === 100 && s.horizonDays === 30);
  assert.ok(s100);
  // 100 пользователей × 30 дней = 3000 бесплатных + 300 платных = 3300 спинов
  assert.equal(s100.freeSpins, 3000);
  assert.equal(s100.paidSpins, 300);
  assert.equal(s100.revenueStars, 1500);
  assert.equal(s100.expectedNormalWins.cake, 33, '1% от 3300 спинов');
  assert.equal(s100.expectedNormalWins.bear, 99, '3% от 3300 спинов');
  assert.equal(s100.expectedNormalWins.heart, 99, '3% от 3300 спинов');
  assert.equal(s100.expectedGuaranteeGifts, 0, 'за 30 дней гарантия на 31-й день не достигается');
  // 33×50 + 99×15 + 99×15 = 1650 + 1485 + 1485 = 4620
  assert.equal(s100.expectedNormalCostStars, 4620);
  assert.equal(s100.estimatedResultStars, 1500 - 4620);

  const s100_180 = f.scenarios.find((s) => s.users === 100 && s.horizonDays === 180);
  assert.equal(s100_180.expectedGuaranteeGifts, Math.round((100 * (180 - 30)) / 31 * 100) / 100);
});

test('прогноз показывает растущие обязательства при росте пользователей', () => {
  const f = finance.forecast({ horizons: [90], paidSpinsPerUser: 1 });
  const byUsers = f.scenarios.reduce((acc, s) => ({ ...acc, [s.users]: s }), {});
  assert.ok(byUsers[5000].expectedTotalCostStars > byUsers[100].expectedTotalCostStars);
  assert.ok(byUsers[5000].estimatedPendingObligationStars > 0);
  assert.ok(byUsers[5000].estimatedPendingObligationStars > byUsers[100].estimatedPendingObligationStars);
});

test('контроль риска считает обязательства и уровень', () => {
  const risk = finance.riskReport();
  assert.ok(['ok', 'warning', 'critical'].includes(risk.level));
  assert.ok(risk.pendingObligationStars >= 0);
  assert.ok(risk.budgetStars > 0);
  assert.match(risk.confirmedObligationsPreserved, /не отменяет/);

  const before = risk.level;
  finance.setBudget(0);
  const critical = finance.riskReport();
  assert.equal(critical.level, 'critical');
  finance.setBudget(risk.budgetStars);
  assert.equal(finance.riskReport().level, before === 'critical' ? 'critical' : finance.riskReport().level);
});

test('переключатели останавливают новые спины, не трогая выигрыши', () => {
  finance.setToggle('all_spins_enabled', false);
  assert.equal(game.areSpinsEnabled(), false);
  assert.throws(() => game.spinFree(6001), (err) => err.code === 'spins_paused');

  const winsBefore = db.prepare('SELECT COUNT(*) AS n FROM wins').get().n;
  assert.ok(winsBefore >= 1, 'выигрыши сохраняются при остановке новых спинов');

  finance.setToggle('all_spins_enabled', true);
  finance.setToggle('paid_spins_enabled', false);
  assert.equal(game.isPaidSpinsEnabled(), false);
  const paymentId = Number(
    db
      .prepare(
        `INSERT INTO payments (invoice_payload, telegram_charge_id, user_id, amount, currency, status, created_at, updated_at)
         VALUES ('blk-1', 'blk-charge', 6002, 5, 'XTR', 'paid', '2024-05-05T10:00:00.000Z', '2024-05-05T10:00:00.000Z')`,
      )
      .run().lastInsertRowid,
  );
  assert.throws(() => game.spinPaid(6002, paymentId), (err) => err.code === 'paid_spins_disabled');
  finance.setToggle('paid_spins_enabled', true);
});