import test from 'node:test';
import assert from 'node:assert/strict';
import { bootServer } from './helpers.js';

const server = await bootServer('payments');
const { payments, db, game, auth } = server;

function seedUser(id, username) {
  return auth.upsertUser({ id, username, firstName: 'U', lastName: String(id), isPremium: false });
}

function seedPayment(userId, payload, chargeId, { amount = 5, currency = 'XTR', status = 'created' } = {}) {
  const now = '2024-01-01T00:00:00.000Z';
  const res = db
    .prepare(
      `INSERT INTO payments (invoice_payload, telegram_charge_id, user_id, amount, currency, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(payload, chargeId ?? null, userId, amount, currency, status, now, now);
  return Number(res.lastInsertRowid);
}

test('цена дополнительного спина равна 5 Stars в валюте XTR', () => {
  assert.equal(game.getSpinPrice(), 5);
  assert.equal(game.publicConfig().spinPriceStars, 5);
});

test('повторное событие об оплате не выдаёт второй спин', async () => {
  const userId = 5001;
  seedUser(userId, 'payer');
  game.spinFree(userId); // сначала ежедневный бесплатный
  const paymentId = seedPayment(userId, 'pl-1');

  const info = { invoice_payload: 'pl-1', telegram_payment_charge_id: 'ch-1', currency: 'XTR', total_amount: 5 };

  const first = await payments.handleSuccessfulPayment(info, { id: userId });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);

  for (let i = 0; i < 5; i += 1) {
    const replay = await payments.handleSuccessfulPayment(info, { id: userId });
    assert.equal(replay.duplicate, true, 'повторная обработка должна быть no-op');
  }

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spins WHERE payment_id = ?').get(paymentId).n, 1, 'один платёж — ровно один спин');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE telegram_charge_id = ?').get('ch-1').n, 1);
});

test('один charge_id не может быть привязан к двум платежам', async () => {
  const userId = 5002;
  seedUser(userId, 'u2');
  game.spinFree(userId);
  seedPayment(userId, 'pl-2');
  await payments.handleSuccessfulPayment(
    { invoice_payload: 'pl-2', telegram_payment_charge_id: 'ch-2', currency: 'XTR', total_amount: 5 },
    { id: userId },
  );

  const otherId = seedPayment(userId, 'pl-3');
  assert.throws(
    () => db.prepare('UPDATE payments SET telegram_charge_id = ? WHERE id = ?').run('ch-2', otherId),
    /UNIQUE constraint/,
    'UNIQUE-индекс защищает от двойного списания одного платежа Telegram',
  );
});

test('подмена суммы или валюты отклоняется', async () => {
  const userId = 5003;
  seedUser(userId, 'u3');
  const paymentId = seedPayment(userId, 'pl-4', null, { amount: 5 });

  const res = await payments.handleSuccessfulPayment(
    { invoice_payload: 'pl-4', telegram_payment_charge_id: 'ch-4', currency: 'USD', total_amount: 500 },
    { id: userId },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'rejected');

  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  assert.equal(row.status, 'failed');
  assert.match(row.failure_reason, /XTR/);
  assert.equal(row.spin_id, null, 'спин не выдан');
});

test('оплата чужого пользователя игнорируется', async () => {
  const owner = 5004;
  const attacker = 5005;
  seedUser(owner, 'owner');
  seedUser(attacker, 'att');
  seedPayment(owner, 'pl-5');

  const res = await payments.handleSuccessfulPayment(
    { invoice_payload: 'pl-5', telegram_payment_charge_id: 'ch-5', currency: 'XTR', total_amount: 5 },
    { id: attacker },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'user_mismatch');
  assert.equal(db.prepare('SELECT status FROM payments WHERE invoice_payload = ?').get('pl-5').status, 'created');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spins').get().n >= 1, true);
});

test('неизвестный payload игнорируется', async () => {
  const res = await payments.handleSuccessfulPayment(
    { invoice_payload: 'nope', telegram_payment_charge_id: 'ch-6', currency: 'XTR', total_amount: 5 },
    { id: 5004 },
  );
  assert.equal(res.ok, false);
});

test('pre_checkout проверяется на сервере: подмена суммы и валюты не проходит', () => {
  const userId = 5006;
  seedUser(userId, 'u6');
  seedPayment(userId, 'pl-7', null, { amount: 5 });

  assert.equal(
    payments.validatePreCheckout({ id: 'q1', invoice_payload: 'pl-7', from: { id: userId }, currency: 'XTR', total_amount: 5 }).ok,
    true,
  );
  assert.equal(
    payments.validatePreCheckout({ id: 'q1', invoice_payload: 'pl-7', from: { id: userId }, currency: 'XTR', total_amount: 1 }).reason,
    'wrong_amount',
  );
  assert.equal(
    payments.validatePreCheckout({ id: 'q1', invoice_payload: 'pl-7', from: { id: userId }, currency: 'USD', total_amount: 5 }).reason,
    'wrong_currency',
  );
  assert.equal(
    payments.validatePreCheckout({ id: 'q1', invoice_payload: 'pl-7', from: { id: 9999 }, currency: 'XTR', total_amount: 5 }).reason,
    'user_mismatch',
  );
  assert.equal(
    payments.validatePreCheckout({ id: 'q1', invoice_payload: 'unknown', from: { id: userId }, currency: 'XTR', total_amount: 5 }).reason,
    'unknown_invoice',
  );
});

test('после подтверждения результат платного спина виден пользователю', async () => {
  const userId = 5009;
  seedUser(userId, 'u9');
  // Платные спины открываются только после ежедневного бесплатного.
  assert.throws(() => game.spinPaid(userId, 1), (err) => err.code === 'daily_spin_available');
  game.spinFree(userId);

  const paymentId = seedPayment(userId, 'pl-10');

  const before = game.paidSpinResultForUser(userId, 'pl-10');
  assert.equal(before.consumed, false);
  assert.equal(before.spin, null);

  await payments.handleSuccessfulPayment(
    { invoice_payload: 'pl-10', telegram_payment_charge_id: 'ch-10', currency: 'XTR', total_amount: 5 },
    { id: userId },
  );

  const after = game.paidSpinResultForUser(userId, 'pl-10');
  assert.equal(after.consumed, true);
  assert.ok(after.spin, 'после оплаты должен появиться результат спина');
  assert.equal(after.spin.kind, 'paid');
  assert.ok(db.prepare('SELECT spin_id FROM payments WHERE id = ?').get(paymentId).spin_id !== null);
});

test('статус платежа виден только своему пользователю', () => {
  const userId = 5008;
  seedUser(userId, 'u8');
  seedPayment(userId, 'pl-9');
  assert.ok(payments.paymentStatusForUser(userId, 'pl-9'));
  assert.equal(payments.paymentStatusForUser(9999, 'pl-9'), null);
  assert.equal(payments.paymentStatusForUser(userId, 'other'), null);
});

test('история платежей скрывает чужие записи', () => {
  const list = payments.listPayments({ userId: 5008 });
  assert.ok(list.items.every((p) => p.userId === 5008));
});