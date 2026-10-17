import crypto from 'node:crypto';
import { config } from './config.js';
import { db, tx, logError } from './db.js';
import { call, createStarsInvoiceLink, refundStarPayment } from './tg.js';
import { getSpinPrice, spinPaid, SpinError } from './game.js';
import { handleCommand, rememberUser, processReferral } from './bot.js';

const nowIso = () => new Date().toISOString();

/** Payload, который бот генерирует сам для спинов за Stars. */
function isOwnPayload(payload) {
  return typeof payload === 'string' && /^fs_spin_\d+_\d{6,8}$/.test(payload);
}

export function buildPayload(userId) {
  return `fs_spin_${userId}_${crypto.randomInt(1_000_000, 9_999_999)}`;
}

/**
 * Creates a Stars invoice on the server and stores it. The client only ever
 * receives the resulting link — it can neither set the amount nor the currency.
 */
export async function createSpinInvoice(userId) {
  const amount = getSpinPrice();
  const payload = buildPayload(userId);
  const createdAt = nowIso();

  const link = await createStarsInvoiceLink({
    payload,
    title: 'Free Stars — дополнительный спин',
    description: `Дополнительное вращение рулетки Free Stars за ${amount} ⭐`,
    amount,
  });

  db.prepare(
    `INSERT INTO payments (invoice_payload, user_id, amount, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, 'XTR', 'created', ?, ?)`,
  ).run(payload, userId, amount, createdAt, createdAt);

  return { invoiceUrl: link, payload, amount, currency: 'XTR' };
}

/**
 * Server-side pre-checkout validation. Everything comes from the database and
 * the server price — nothing the client can influence.
 */
export function validatePreCheckout(preCheckout) {
  const payload = preCheckout?.invoice_payload;
  const currency = preCheckout?.currency;
  const total = preCheckout?.total_amount;
  const tgId = preCheckout?.from?.id;

  let payment = payload ? db.prepare('SELECT * FROM payments WHERE invoice_payload = ?').get(payload) : null;
  const expected = getSpinPrice();

  // Защита от сброса БД: если инвойс был создан до редеплоя, но payload валидный
  if (!payment && isOwnPayload(payload) && tgId) {
    const createdAt = nowIso();
    db.prepare(
      `INSERT OR IGNORE INTO payments (invoice_payload, user_id, amount, currency, status, created_at, updated_at)
       VALUES (?, ?, ?, 'XTR', 'created', ?, ?)`,
    ).run(payload, tgId, total || expected, createdAt, createdAt);
    payment = db.prepare('SELECT * FROM payments WHERE invoice_payload = ?').get(payload);
  }

  if (!payment) return { ok: false, reason: 'unknown_invoice', payment: null };
  if (payment.status !== 'created' && payment.status !== 'paid') return { ok: false, reason: 'invoice_not_payable', payment };
  if (payment.user_id !== tgId) return { ok: false, reason: 'user_mismatch', payment };
  if (currency !== 'XTR') return { ok: false, reason: 'wrong_currency', payment };
  if (total !== expected) return { ok: false, reason: 'wrong_amount', payment };
  return { ok: true, reason: null, payment };
}

/** Answers pre_checkout_query. The check is server-side; the client's opinion is ignored. */
export async function handlePreCheckoutQuery(preCheckout) {
  const { ok, reason } = validatePreCheckout(preCheckout);
  try {
    await call('answerPreCheckoutQuery', {
      pre_checkout_query_id: preCheckout.id,
      ok,
      error_message: ok ? undefined : 'Платёж не прошёл проверку',
    });
  } catch (err) {
    logError('payments.pre_checkout', err.message, err.stack);
  }
  return ok;
}

/**
 * Превращает подтверждённый платёж в реальный платный спин.
 * Спин создаётся ровно один раз (UNIQUE по payments.spin_id), поэтому
 * повторное событие об оплате не выдаёт второй спин.
 * Если спин выдать не удалось — возвращаем Stars пользователю.
 */
async function deliverSpin(payment) {
  try {
    const spin = spinPaid(payment.user_id, payment.id);

    try {
      await call('sendMessage', {
        chat_id: payment.user_id,
        text: '⭐ <b>Оплата 5 Stars успешно получена!</b>\n\nСпин зачислен — колесо уже крутится! Откройте приложение Free Stars. 🎁',
        parse_mode: 'HTML',
      });
    } catch {
      /* если чат заблокирован пользователем */
    }

    return { ok: true, spin };
  } catch (err) {
    // Пограничный случай: пока ждали подтверждение, наступил новый серверный день
    // и ежедневный спин снова стал доступен. Не возвращаем оплату — начисляем
    // бонусный спин, который пользователь сможет использовать.
    if (err?.code === 'daily_spin_available') {
      db.prepare('UPDATE users SET bonus_spins = COALESCE(bonus_spins, 0) + 1 WHERE tg_id = ?').run(payment.user_id);
      return { ok: true, deferred: true };
    }

    const reason = String(err?.message ?? err);
    logError('payments.deliver', reason, err?.stack);

    try {
      await refundStarPayment(payment.telegram_charge_id, reason);
      db.prepare('UPDATE payments SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?').run(
        'refunded', reason, nowIso(), payment.id,
      );
      return { ok: false, error: reason, refunded: true };
    } catch {
      return { ok: false, error: reason };
    }
  }
}

/**
 * Processes a successful_payment update exactly once.
 * The UNIQUE index on telegram_charge_id plus the status check make replays no-ops.
 */
export async function handleSuccessfulPayment(paymentInfo, tgUser) {
  const payload = paymentInfo?.invoice_payload;
  if (!payload) return { ok: false, error: 'no_payload' };

  const claimed = tx(() => {
    let payment = db.prepare('SELECT * FROM payments WHERE invoice_payload = ?').get(payload);
    
    // Если инвойс отсутствовал в БД (например, после деплоя), восстанавливаем
    // запись — но только для payload, который бот сгенерировал сам.
    if (!payment && isOwnPayload(payload) && tgUser?.id) {
      const createdAt = nowIso();
      db.prepare(
        `INSERT OR IGNORE INTO payments (invoice_payload, user_id, amount, currency, status, created_at, updated_at)
         VALUES (?, ?, ?, 'XTR', 'created', ?, ?)`,
      ).run(payload, tgUser.id, paymentInfo.total_amount || getSpinPrice(), createdAt, createdAt);
      payment = db.prepare('SELECT * FROM payments WHERE invoice_payload = ?').get(payload);
    }

    if (!payment) return { duplicate: false, payment: null };
    if (payment.status === 'paid' || payment.telegram_charge_id) return { duplicate: true, payment };
    if (payment.user_id !== tgUser?.id) return { duplicate: false, payment: null, mismatch: true };

    const amountOk = paymentInfo.currency === 'XTR' && paymentInfo.total_amount === payment.amount;
    if (!amountOk) {
      db.prepare('UPDATE payments SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?').run(
        'failed',
        `Ожидалось ${payment.amount} XTR, получено ${paymentInfo.total_amount} ${paymentInfo.currency}`,
        nowIso(),
        payment.id,
      );
      return { duplicate: false, payment: null, rejected: true };
    }

    db.prepare(
      `UPDATE payments SET status = 'paid', telegram_charge_id = ?, raw = ?, updated_at = ?, paid_at = ?
       WHERE id = ? AND status = 'created'`,
    ).run(paymentInfo.telegram_payment_charge_id, JSON.stringify(paymentInfo), nowIso(), nowIso(), payment.id);

    const fresh = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
    if (!fresh.telegram_charge_id) return { duplicate: true, payment: fresh };
    return { duplicate: false, payment: fresh };
  });

  if (!claimed.payment || claimed.mismatch || claimed.rejected) {
    if (claimed.mismatch) logError('payments.ownership', `Payment ${payload} belongs to another user`);
    return { ok: false, error: claimed.mismatch ? 'user_mismatch' : 'rejected' };
  }
  if (claimed.duplicate) return { ok: true, duplicate: true };

  const outcome = await deliverSpin(claimed.payment);
  return { ...outcome, duplicate: false };
}

/** Lets the Mini App poll the authoritative state after the invoice sheet closes. */
export function paymentStatusForUser(userId, payload) {
  const payment = db.prepare('SELECT * FROM payments WHERE invoice_payload = ? AND user_id = ?').get(payload, userId);
  if (!payment) return null;
  return {
    payload: payment.invoice_payload,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    spinId: payment.spin_id,
    consumed: payment.status === 'paid',
    failureReason: payment.failure_reason,
  };
}

/**
 * Автоматическая сверка ВСЕХ транзакций Stars с официальным Telegram API.
 * Если пользователь оплатил, но запись не сохранилась (редеплой, сбой сети) —
 * бот автоматически начисляет +1 спин и уведомляет пользователя.
 */
export async function autoReconcileAllStars() {
  try {
    const txns = await call('getStarTransactions', { limit: 100 });
    for (const t of txns?.transactions ?? []) {
      const chargeId = t?.id;
      const amount = t?.amount;
      const user = t?.source?.user;
      const payload = t?.source?.invoice_payload;
      const isInvoice = t?.source?.transaction_type === 'invoice_payment' || t?.type === 'invoice_payment';

      if (!isInvoice || !user?.id || !chargeId) continue;

      // Проверяем, есть ли уже этот chargeId в БД
      const existing = db.prepare('SELECT id FROM payments WHERE telegram_charge_id = ?').get(chargeId);
      if (existing) continue;

      console.log(`[freestars] Авто-зачисление Stars: ${chargeId} для пользователя ${user.id} (${amount} XTR)`);

      const now = nowIso();
      const existingUser = db.prepare('SELECT tg_id FROM users WHERE tg_id = ?').get(user.id);
      if (!existingUser) {
        db.prepare(
          `INSERT OR IGNORE INTO users (tg_id, username, first_name, last_name, language_code, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null, user.language_code ?? null, now, now);
      }

      // Сохраняем платёж как подтверждённый
      db.prepare(
        `INSERT INTO payments (invoice_payload, user_id, amount, currency, status, telegram_charge_id, raw, created_at, updated_at, paid_at)
         VALUES (?, ?, ?, 'XTR', 'paid', ?, ?, ?, ?, ?)`,
      ).run(payload || `star_auto_${chargeId}`, user.id, amount, chargeId, JSON.stringify(t), now, now, now);

      // Начисляем бонусный спин
      db.prepare('UPDATE users SET bonus_spins = COALESCE(bonus_spins, 0) + 1 WHERE tg_id = ?').run(user.id);

      // Уведомляем пользователя в Telegram
      try {
        await call('sendMessage', {
          chat_id: user.id,
          text: '⭐ <b>Ваш платёж Stars подтверждён!</b>\n\nВам начислен <b>+1 спин</b> на баланс. Откройте приложение Free Stars и крутите! 🎁',
          parse_mode: 'HTML',
        });
      } catch {
        /* chat error ignore */
      }
    }
  } catch (err) {
    logError('payments.autoReconcile', err.message);
  }
}

/**
 * Verifies a payment against getStarTransactions and processes it.
 * Used as a safety net when the webhook/poll pump is unavailable.
 */
export async function reconcileFromStarTransactions(payload, limitPages = 5) {
  await autoReconcileAllStars();
  let payment = db.prepare('SELECT * FROM payments WHERE invoice_payload = ?').get(payload);
  if (payment?.status === 'paid') return { checked: true, matched: true };

  let offset = 0;
  for (let page = 0; page < limitPages; page += 1) {
    let txns;
    try {
      txns = await call('getStarTransactions', { offset, limit: 100 });
    } catch (err) {
      logError('payments.reconcile', err.message);
      return { checked: false, error: err.message };
    }
    for (const t of txns?.transactions ?? []) {
      if (t?.source?.invoice_payload === payload && (t?.type === 'invoice_payment' || t?.source?.transaction_type === 'invoice_payment')) {
        await handleSuccessfulPayment(
          {
            invoice_payload: payload,
            telegram_payment_charge_id: t.id,
            currency: 'XTR',
            total_amount: t.amount,
          },
          { id: payment?.user_id || t?.source?.user?.id },
        );
        return { checked: true, matched: true };
      }
    }
    if (!txns?.transactions?.length) break;
    offset += txns.transactions.length;
  }
  return { checked: true, matched: false };
}

export function listPayments({ from = null, to = null, userId = null, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (from) {
    where.push('created_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('created_at <= ?');
    params.push(`${to}T23:59:59.999Z`);
  }
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT p.*, u.username, u.first_name, u.last_name
       FROM payments p LEFT JOIN users u ON u.tg_id = p.user_id
       ${clause} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(limit, 500), offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM payments ${clause}`).get(...params).n;
  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      payload: r.invoice_payload,
      chargeId: r.telegram_charge_id,
      userId: r.user_id,
      username: r.username,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      statusLabel: { created: 'Ожидает оплаты', paid: 'Оплачен', failed: 'Ошибка', refunded: 'Возвращён' }[r.status],
      consumed: r.spin_id !== null,
      spinId: r.spin_id,
      failureReason: r.failure_reason,
      createdAt: r.created_at,
    })),
  };
}

/** Dispatches one Bot API update. Shared by the webhook route and the long-poll pump. */
export async function processUpdate(update) {
  if (!update) return;
  const message = update.message ?? update.edited_message ?? update.callback_query?.message;
  if (update.pre_checkout_query) {
    await handlePreCheckoutQuery(update.pre_checkout_query);
    return;
  }
  if (message?.successful_payment) {
    await handleSuccessfulPayment(message.successful_payment, message.from);
    return;
  }
  if (message?.text?.startsWith('/')) {
    // Обработка /start ref_<referrerId>
    const text = message.text.trim();
    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const param = parts[1] ?? '';
      if (param.startsWith('ref_')) {
        const referrerId = parseInt(param.slice(4), 10);
        if (Number.isFinite(referrerId)) {
          // Сначала регистрируем нового пользователя, потом засчитываем реферал
          rememberUser(message.from);
          processReferral(message.from?.id, referrerId);
        }
      }
    }
    await handleCommand(message.text, message.chat?.id, message.from);
  }
}

/**
 * Long polling fallback for local runs without a public HTTPS webhook.
 * Отключается при активном webhook: getUpdates и webhook в Telegram несовместимы.
 * При повторных сбоях делает растущую паузу и не засоряет журнал.
 */
export function startUpdatePump({ intervalMs = 1500 } = {}) {
  if (!config.botToken) return null;
  let offset = null;
  let stopped = false;
  let running = false;
  let failures = 0;
  let conflicted = false;

  const tick = async () => {
    if (stopped || running || conflicted) return;
    running = true;
    try {
      const params = { timeout: 25, allowed_updates: ['message', 'pre_checkout_query'] };
      if (offset !== null) params.offset = offset;
      const updates = await call('getUpdates', params, { retries: 1, timeoutMs: 35000 });
      failures = 0;
      for (const u of updates ?? []) {
        offset = u.update_id + 1;
        try {
          await processUpdate(u);
        } catch (err) {
          logError('updates.dispatch', err.message, err.stack);
        }
      }
    } catch (err) {
      failures += 1;
      const isConflict = /Conflict/i.test(err.message ?? '');
      if (isConflict) {
        conflicted = true;
        logError('updates.poll', 'getUpdates отключён: активен webhook. Обработка идёт через /telegram/webhook.');
        console.warn('[freestars] getWebhook активен — long polling выключен.');
        return;
      }
      if (failures <= 3 || failures % 10 === 0) {
        logError('updates.poll', err.message);
      }
    } finally {
      running = false;
    }

    if (!stopped && !conflicted) {
      const wait = intervalMs + Math.min(60_000, 2000 * failures);
      setTimeout(tick, wait);
    }
  };

  setTimeout(tick, 1000).unref?.();
  return () => {
    stopped = true;
  };
}

/** Drains a small batch of the owner-notification queue (used by the admin panel). */