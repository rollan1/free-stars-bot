import test from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, advanceDays } from './helpers.js';

const server = await bootServer('adminops');
const { game, db, auth, config } = server;
const ops = await import('../server/adminOps.js');

const ADMIN = 777000111;
const USER = 880000111;

function seed(id) {
  return auth.upsertUser({ id, username: `u${id}`, firstName: 'A', lastName: String(id), isPremium: false });
}

test('инструменты админа создают пользователя, которого ещё нет', () => {
  seed(USER);
  const info = ops.describeUser(USER);
  assert.equal(info.id, USER);
  assert.equal(info.blocked, false);
  assert.equal(info.totals.spins, 0);
});

test('принудительный спин с заданным исходом', () => {
  const res = ops.forceSpin(USER, { kind: 'free', outcome: 'bear' }, ADMIN);
  assert.equal(res.kind, 'free');
  assert.equal(res.outcome, 'bear');
  assert.ok(res.win.code.startsWith('FS-'));
  assert.equal(res.forcedByAdmin, true);

  const win = db.prepare('SELECT * FROM wins WHERE win_code = ?').get(res.win.code);
  assert.equal(win.gift, 'bear');
  assert.equal(win.status, 'pending');
});

test('принудительный пустой результат не создаёт выигрыш', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM wins').get().n;
  const res = ops.forceSpin(USER, { kind: 'free', outcome: 'none' }, ADMIN);
  assert.equal(res.outcome, 'none');
  assert.equal(res.win, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wins').get().n, before);
});

test('принудительная гарантия выдаёт подарок гарантии и фиксирует флаг', () => {
  const res = ops.forceSpin(USER, { kind: 'guarantee' }, ADMIN);
  assert.equal(res.kind, 'guarantee');
  assert.equal(res.outcome, game.getGuaranteeGift());
  assert.ok(res.win);
  assert.equal(ops.describeUser(USER).guaranteeClaimed, true);
});

test('неизвестный подарок отклоняется', () => {
  assert.throws(() => ops.forceSpin(USER, { kind: 'free', outcome: 'unicorn' }, ADMIN), /Неизвестный подарок/);
});

test('выдача бесплатного спина возвращает попытку', () => {
  ops.grantFreeSpin(USER, ADMIN);
  assert.ok(game.spinFree(USER), 'попытка доступна');
  assert.throws(() => game.spinFree(USER), (err) => err.code === 'already_spun_today');

  ops.grantFreeSpin(USER, ADMIN);
  assert.ok(game.spinFree(USER), 'после выдачи попытка снова доступна');
});

test('принудительный спин админа не тратит попытку пользователя', () => {
  ops.grantFreeSpin(USER, ADMIN);
  ops.forceSpin(USER, { kind: 'paid', outcome: 'cake' }, ADMIN);
  assert.doesNotThrow(() => game.spinFree(USER), 'у пользователя осталась своя бесплатная попытка');
});

test('управление серией: начислить, задать, сбросить', () => {
  ops.resetStreak(USER, ADMIN);
  ops.addStreakDays(USER, 10, ADMIN);
  assert.equal(ops.describeUser(USER).streak.day, 10);

  ops.addStreakDays(USER, -3, ADMIN);
  assert.equal(ops.describeUser(USER).streak.day, 7);

  ops.addStreakDays(USER, 3, ADMIN);
  assert.equal(ops.describeUser(USER).streak.day, 10);

  ops.resetStreak(USER, ADMIN);
  assert.equal(ops.describeUser(USER).streak.day, 0);
});

test('блокировка запрещает вращения', () => {
  ops.setBlocked(USER, true, ADMIN);
  assert.equal(ops.describeUser(USER).blocked, true);
  assert.throws(() => game.spinFree(USER), (err) => err.code === 'user_blocked');

  ops.setBlocked(USER, false, ADMIN);
  assert.equal(ops.describeUser(USER).blocked, false);
  ops.grantFreeSpin(USER, ADMIN);
  assert.doesNotThrow(() => game.spinFree(USER));
});

test('заметка владельца сохраняется', () => {
  ops.setNotes(USER, 'проверить выдачу', ADMIN);
  assert.equal(ops.describeUser(USER).notes, 'проверить выдачу');
  ops.setNotes(USER, null, ADMIN);
  assert.equal(ops.describeUser(USER).notes, null);
});

test('выданный выигрыш можно вернуть в ожидание', () => {
  const granted = ops.grantWin(USER, 'cake', ADMIN);
  const winId = db.prepare('SELECT id FROM wins WHERE win_code = ?').get(granted.win.code).id;
  db.prepare("UPDATE wins SET status = 'delivered', delivered_at = '2024-01-01T00:00:00.000Z', delivered_by = ? WHERE id = ?").run(ADMIN, winId);

  const back = ops.reopenWin(winId, ADMIN);
  assert.equal(back.status, 'pending');
  const row = db.prepare('SELECT * FROM wins WHERE id = ?').get(winId);
  assert.equal(row.status, 'pending');
  assert.equal(row.delivered_at, null);
  assert.equal(row.delivered_by, null);
});

test('полный сброс прогресса не стирает историю выигрышей', () => {
  const winsBefore = db.prepare('SELECT COUNT(*) AS n FROM wins WHERE user_id = ?').get(USER).n;
  assert.ok(winsBefore > 0);

  ops.resetUserProgress(USER, ADMIN);
  const info = ops.describeUser(USER);
  assert.equal(info.totals.spins, 0);
  assert.equal(info.totals.wins, 0);
  assert.equal(info.streak.day, 0);
  assert.equal(info.freeSpinDay, null);

  const winsAfter = db.prepare('SELECT COUNT(*) AS n FROM wins WHERE user_id = ?').get(USER).n;
  assert.equal(winsAfter, winsBefore, 'история выигрышей сохраняется');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM wins WHERE user_id = ? AND status = 'pending'").get(USER).n,
    0,
    'ожидающие выдачи отменяются',
  );
});

test('каждое действие админа попадает в журнал', () => {
  const logs = db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT 5').all();
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => l.admin_id === ADMIN));
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM admin_log WHERE action LIKE 'user.%'").get().n >= 5);
});

test('бонусные спины тратятся вместо ежедневной попытки и не двигают серию', () => {
  const id = 880000999;
  seed(id);
  game.spinFree(id); // ежедневный спин потрачен
  assert.throws(() => game.spinFree(id), (err) => err.code === 'already_spun_today');

  ops.grantBonusSpins(id, 3, ADMIN);
  assert.equal(ops.describeUser(id).bonusSpins, 3);

  for (let i = 0; i < 3; i += 1) {
    const r = game.spinFree(id);
    assert.equal(r.bonus, true);
  }
  assert.equal(ops.describeUser(id).bonusSpins, 0);
  assert.throws(() => game.spinFree(id), (err) => err.code === 'already_spun_today', 'после бонусов дневной слот всё равно закрыт');

  const row = db.prepare('SELECT free_spin_day, streak_count FROM users WHERE tg_id = ?').get(id);
  assert.ok(row.free_spin_day, 'ежедневная отметка не тронута');
  assert.equal(row.streak_count, 1, 'бонусные спины не двигают серию');
});

test('выдача бонусных спинов проверяется и попадает в журнал', () => {
  const id = 880000998;
  seed(id);
  assert.throws(() => ops.grantBonusSpins(id, 0, ADMIN), /целое число/);
  assert.throws(() => ops.grantBonusSpins(id, -5, ADMIN), /целое число/);
  ops.setBonusSpins(id, 7, ADMIN);
  assert.equal(ops.describeUser(id).bonusSpins, 7);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'user.bonus_spins_set'").get().n >= 1);
});

test('каждые 5 дней серии выдаётся дополнительный спин, кроме дня гарантии', () => {
  const id = 880000997;
  seed(id);
  game.setProbabilities({ cake: 0, bear: 0, heart: 0, none: 100 }, null);

  const granted = [];
  const bonusCount = (day) => {
    if (day === 1) {
      const r = game.spinFree(id);
      assert.equal(r.bonusGranted, false, 'в первый день бонуса нет');
      return 0;
    }
    const r = game.spinFree(id);
    if (r.bonusGranted) granted.push(day);
    return r.bonusGranted ? 1 : 0;
  };

  const every = game.getSeriesBonusEvery();
  const total = game.getGuaranteeDays();
  for (let day = 1; day <= total; day += 1) {
    bonusCount(day);
    advanceDays(config, 1);
  }

  assert.deepEqual(granted, [every, every * 2, every * 3, every * 4, every * 5, every * 6]);
  assert.equal(granted.includes(total), false, `на ${total}-й день бонусного спина нет`);
  assert.equal(ops.describeUser(id).bonusSpins, 6);

  // день гарантии — только Мишка
  const last = db.prepare('SELECT * FROM wins WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id);
  assert.equal(last.gift, 'bear');
  assert.equal(last.kind, 'guarantee');
});

test('серия не рвётся из-за бонусных спинов', () => {
  const id = 880000996;
  seed(id);
  game.setProbabilities({ cake: 0, bear: 0, heart: 0, none: 100 }, null);
  for (let day = 1; day <= 8; day += 1) {
    game.spinFree(id);
    const bonus = db.prepare('SELECT bonus_spins FROM users WHERE tg_id = ?').get(id).bonus_spins;
    if (bonus > 0) game.spinFree(id); // тратим бонусный, серия не должна страдать
    advanceDays(config, 1);
  }
  const info = ops.describeUser(id);
  assert.equal(info.streak.day, 8, 'серия идёт непрерывно несмотря на бонусные спины');
});

test('снимок пользователя содержит сессию и историю', () => {
  const snapshot = ops.userSnapshot(USER);
  assert.ok(snapshot.spin);
  assert.ok(Array.isArray(snapshot.history.items));
  assert.equal(ops.userSnapshot(1), null);
});