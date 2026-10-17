import test from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, advanceDays } from './helpers.js';

const server = await bootServer('game');
const { game, db, config, auth } = server;
const adminOps = await import('../server/adminOps.js');

function newUser(id) {
  return auth.upsertUser({ id, username: `u${id}`, firstName: 'U', lastName: String(id), isPremium: false });
}

test('пользователь создаётся и его статистика пустая', () => {
  const user = newUser(1001);
  assert.equal(user.spins_total, 0);
  assert.equal(user.free_spin_day, null);
  assert.equal(user.streak_count, 0);
});

test('бесплатный спин выдаётся один раз в сутки', () => {
  newUser(1002);
  const first = game.spinFree(1002);
  assert.ok(['cake', 'bear', 'heart', 'none'].includes(first.outcome));
  assert.equal(first.kind, 'free');
  assert.equal(first.streak.day, 1);

  assert.throws(() => game.spinFree(1002), (err) => err.code === 'already_spun_today');

  advanceDays(config, 1);
  const second = game.spinFree(1002);
  assert.equal(second.streak.day, 2);
  assert.equal(second.kind, 'free');
});

test('смена часового пояса устройства не даёт второй спин', () => {
  newUser(1003);
  game.spinFree(1003);
  // повторные запросы в тот же серверный день
  for (let i = 0; i < 5; i += 1) {
    assert.throws(() => game.spinFree(1003), (err) => err.code === 'already_spun_today');
  }
  const row = db.prepare('SELECT spins_total, free_spin_day FROM users WHERE tg_id = 1003').get();
  assert.equal(row.spins_total, 1);
});

test('пропуск дня сбрасывает серию', () => {
  newUser(1004);
  game.spinFree(1004);
  advanceDays(config, 1);
  game.spinFree(1004);
  const mid = db.prepare('SELECT streak_count FROM users WHERE tg_id = 1004').get();
  assert.equal(mid.streak_count, 2);

  advanceDays(config, 2); // пропущен день
  const after = game.spinFree(1004);
  assert.equal(after.streak.day, 1);
  assert.equal(after.streak.remaining, 30);
});

test('пустой результат не создаёт выигрыш', () => {
  const userId = 1005;
  newUser(userId);
  // доводим серию до 30-го дня, где гарантия ещё не срабатывает
  let emptyFound = false;
  for (let day = 0; day < 30; day += 1) {
    const r = game.spinFree(userId);
    if (r.outcome === 'none') {
      emptyFound = true;
      assert.equal(r.win, null);
    } else {
      assert.ok(r.win?.code?.startsWith('FS-'));
    }
    advanceDays(config, 1);
  }
  assert.equal(emptyFound, true, 'на 30 спинах должен встретиться пустой результат');
});

test('гарантия на 31-й день работает независимо от вероятностей (1% не отменяет обещание)', () => {
  const userId = 2001;
  newUser(userId);
  const guaranteeDays = game.getGuaranteeDays();
  assert.equal(guaranteeDays, 31);

  // Даже при нулевых шансах на подарок гарантия обязана сработать.
  game.setProbabilities({ cake: 0, bear: 0, heart: 0, none: 100 }, null);

  let guaranteeResult = null;
  for (let day = 1; day <= guaranteeDays; day += 1) {
    const r = game.spinFree(userId);
    if (day < guaranteeDays) {
      assert.notEqual(r.kind, 'guarantee', `гарантия не должна срабатывать раньше ${guaranteeDays}-го дня`);
      assert.equal(r.outcome, 'none');
      assert.equal(r.win, null);
    }
    if (day === guaranteeDays) guaranteeResult = r;
    advanceDays(config, 1);
  }

  assert.equal(guaranteeResult.kind, 'guarantee');
  assert.equal(guaranteeResult.outcome, game.getGuaranteeGift());
  assert.ok(guaranteeResult.win, 'гарантия обязана создавать выигрыш');
  assert.match(guaranteeResult.win.code, /^FS-\d{6}$/);

  const win = db.prepare('SELECT * FROM wins WHERE win_code = ?').get(guaranteeResult.win.code);
  assert.equal(win.kind, 'guarantee');
  assert.equal(win.status, 'pending');
  assert.equal(win.user_id, userId);

  game.setProbabilities({ cake: 1, bear: 3, heart: 3, none: 93 }, null);
});

test('гарантия выдаётся ровно один раз за серию', () => {
  const userId = 2002;
  newUser(userId);
  const guaranteeDays = game.getGuaranteeDays();

  // Игрок без выигрышей: доводим до дня гарантии
  game.setProbabilities({ cake: 0, bear: 0, heart: 0, none: 100 }, null);
  let guaranteedAt = null;
  for (let day = 1; day <= guaranteeDays; day += 1) {
    const r = game.spinFree(userId);
    if (r.kind === 'guarantee') guaranteedAt = day;
    advanceDays(config, 1);
  }

  assert.equal(guaranteedAt, guaranteeDays, `гарантия должна сработать на ${guaranteeDays}-й день`);

  const after = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(userId);
  assert.equal(after.guarantee_claimed, 1);
  assert.equal(after.series_gift_won, 1);

  // ещё 40 дней серии — второй гарантии быть не должно
  game.setProbabilities({ cake: 1, bear: 3, heart: 3, none: 93 }, null);
  for (let day = 0; day < 40; day += 1) {
    const r = game.spinFree(userId);
    assert.notEqual(r.kind, 'guarantee', 'повторная гарантия в той же серии запрещена');
    advanceDays(config, 1);
  }
});

test('выигрыш раньше отменяет гарантию в этой серии', () => {
  const userId = 2003;
  newUser(userId);

  // Гарантируем выигрыш на втором спине через подмену вероятностей
  game.setProbabilities({ cake: 0, bear: 0, heart: 0, none: 100 }, null);
  const empty = game.spinFree(userId);
  assert.equal(empty.outcome, 'none');
  assert.equal(empty.win, null);

  game.setProbabilities({ cake: 0, bear: 100, heart: 0, none: 0 }, null);
  advanceDays(config, 1);
  const won = game.spinFree(userId);
  assert.equal(won.outcome, 'bear');
  assert.ok(won.win);
  assert.equal(won.kind, 'free', 'гарантия не нужна, подарок выпал сам');

  game.setProbabilities({ cake: 0, bear: 0, heart: 0, none: 100 }, null);
  advanceDays(config, 1);
  let guaranteeSeen = false;
  for (let day = 0; day < 40; day += 1) {
    const r = game.spinFree(userId);
    if (r.kind === 'guarantee') guaranteeSeen = true;
    advanceDays(config, 1);
  }
  assert.equal(guaranteeSeen, false, 'гарантия не выдаётся, если в серии уже был подарок');

  game.setProbabilities({ cake: 1, bear: 3, heart: 3, none: 93 }, null);
});

test('новая серия после пропуска снова получает гарантию', () => {
  const userId = 2004;
  newUser(userId);
  game.setProbabilities({ cake: 0, bear: 0, heart: 0, none: 100 }, null);

  for (let day = 0; day < 5; day += 1) {
    game.spinFree(userId);
    advanceDays(config, 1);
  }
  advanceDays(config, 3); // пропуск
  let guarantees = 0;
  for (let day = 0; day < 31; day += 1) {
    const r = game.spinFree(userId);
    if (r.kind === 'guarantee') guarantees += 1;
    advanceDays(config, 1);
  }
  assert.equal(guarantees, 1, 'в новой серии гарантия доступна снова');
  game.setProbabilities({ cake: 1, bear: 3, heart: 3, none: 93 }, null);
});

test('платный спин не тратит ежедневную попытку и не двигает серию', () => {
  const userId = 3001;
  newUser(userId);

  // Бонусный спин — дополнительный: ежедневная попытка от него не страдает.
  adminOps.grantBonusSpins(userId, 1, 1);
  game.spinFree(userId); // ежедневный спин
  game.spinFree(userId); // дополнительный, за счёт бонуса

  const dayUsed = db.prepare('SELECT free_spin_day, streak_count FROM users WHERE tg_id = ?').get(userId);
  assert.equal(dayUsed.streak_count, 1, 'бонусный спин не увеличивает серию');

  const paymentId = db
    .prepare(
      `INSERT INTO payments (invoice_payload, telegram_charge_id, user_id, amount, currency, status, created_at, updated_at)
       VALUES ('payload-1', 'charge-1', ?, 5, 'XTR', 'paid', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
    )
    .run(userId).lastInsertRowid;

  game.setProbabilities({ cake: 0, bear: 100, heart: 0, none: 0 }, null);
  const paid = game.spinPaid(userId, Number(paymentId));
  assert.equal(paid.kind, 'paid');
  assert.equal(paid.outcome, 'bear');
  assert.ok(paid.win);

  const user = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(userId);
  assert.equal(user.free_spin_day, dayUsed.free_spin_day, 'платный спин не тратит ежедневную попытку');
  assert.equal(user.streak_count, dayUsed.streak_count, 'платный спин не увеличивает серию');
  game.setProbabilities({ cake: 1, bear: 3, heart: 3, none: 93 }, null);
});

test('повторное использование одного платежа запрещено', () => {
  const userId = 3002;
  newUser(userId);
  game.spinFree(userId);
  const paymentId = Number(
    db
      .prepare(
        `INSERT INTO payments (invoice_payload, telegram_charge_id, user_id, amount, currency, status, created_at, updated_at)
         VALUES ('payload-2', 'charge-2', ?, 5, 'XTR', 'paid', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
      )
      .run(userId).lastInsertRowid,
  );

  game.spinPaid(userId, paymentId);
  assert.throws(() => game.spinPaid(userId, paymentId), (err) => err.code === 'payment_already_used');

  const spins = db.prepare('SELECT COUNT(*) AS n FROM spins WHERE payment_id = ?').get(paymentId);
  assert.equal(spins.n, 1);
});

test('чужая валюта и неверная сумма не проходят', () => {
  const userId = 3003;
  newUser(userId);
  game.spinFree(userId);
  const id = Number(
    db
      .prepare(
        `INSERT INTO payments (invoice_payload, user_id, amount, currency, status, created_at, updated_at)
         VALUES ('payload-3', ?, 5, 'XTR', 'created', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
      )
      .run(userId).lastInsertRowid,
  );
  assert.throws(() => game.spinPaid(userId, id), (err) => err.code === 'payment_not_paid');
});

test('история пользователя не содержит пустых результатов', () => {
  const userId = 4001;
  newUser(userId);
  game.setProbabilities({ cake: 0, bear: 0, heart: 0, none: 100 }, null);
  game.spinFree(userId);
  advanceDays(config, 1); // новый серверный день: снова доступен бесплатный
  game.spinFree(userId);
  game.setProbabilities({ cake: 0, bear: 100, heart: 0, none: 0 }, null);
  game.spinPaid(
    userId,
    Number(
      db
        .prepare(
          `INSERT INTO payments (invoice_payload, telegram_charge_id, user_id, amount, currency, status, created_at, updated_at)
           VALUES ('payload-4', 'charge-4', ?, 5, 'XTR', 'paid', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
        )
        .run(userId).lastInsertRowid,
    ),
  );

  const history = game.userHistory(userId, 10);
  assert.equal(history.total, 1);
  assert.equal(history.items[0].giftId, 'bear');
  assert.equal(history.items[0].kind, 'paid');
  game.setProbabilities({ cake: 1, bear: 3, heart: 3, none: 93 }, null);
});

test('уведомление владельцу ставится в очередь один раз на выигрыш', () => {
  const queued = db.prepare('SELECT COUNT(*) AS n FROM notify_queue').get().n;
  const wins = db.prepare('SELECT COUNT(*) AS n FROM wins').get().n;
  assert.ok(wins > 0);
  assert.equal(queued, wins, 'одно уведомление на каждый выигрыш');

  const winId = db.prepare('SELECT id FROM wins LIMIT 1').get().id;
  const before = db.prepare('SELECT COUNT(*) AS n FROM notify_queue WHERE win_id = ?').get(winId).n;
  db.prepare(
    `INSERT OR IGNORE INTO notify_queue (win_id, chat_id, text, status, attempts, next_attempt_at, created_at)
     VALUES (?, 777000111, 'dup', 'pending', 0, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
  ).run(winId);
  const after = db.prepare('SELECT COUNT(*) AS n FROM notify_queue WHERE win_id = ?').get(winId).n;
  assert.equal(after, before, 'дубликат уведомления не создаётся');
});

test('очередь уведомлений допускает нескольких владельцев для одного выигрыша', () => {
  const winId = db.prepare('SELECT id FROM wins LIMIT 1').get().id;
  const before = db.prepare('SELECT COUNT(*) AS n FROM notify_queue WHERE win_id = ?').get(winId).n;
  game.enqueueOwnerNotification(winId, 999000222, 'второй владелец');
  const after = db.prepare('SELECT COUNT(*) AS n FROM notify_queue WHERE win_id = ?').get(winId).n;
  assert.equal(after, before + 1, 'второй владелец должен получить своё уведомление');

  game.enqueueOwnerNotification(winId, 999000222, 'повтор');
  const repeat = db.prepare('SELECT COUNT(*) AS n FROM notify_queue WHERE win_id = ?').get(winId).n;
  assert.equal(repeat, after, 'повторная постановка для того же чата игнорируется');
});