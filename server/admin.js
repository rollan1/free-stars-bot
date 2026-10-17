import express from 'express';
import { createRequire } from 'node:module';
import { db, getSettingJson, writeAudit, logError } from './db.js';

const require = createRequire(import.meta.url);
import { config } from './config.js';
import {
  overview,
  finance,
  forecast,
  riskReport,
  settlements,
  setBudget,
  setToggle,
} from './finance.js';
import { GIFTS, validateProbabilities } from './roulette.js';
import { getProbabilities, getSpinPrice, setProbabilities } from './game.js';
import { listPayments } from './payments.js';
import { catalogMatch, deliveryStatus, tryAutoDeliver } from './gifts.js';
import { drainQueue, queueStats } from './notify.js';
import {
  AdminOpError,
  describeUser,
  ensureUser,
  forceSpin,
  grantFreeSpin,
  grantWin,
  grantBonusSpins,
  setBonusSpins,
  addStreakDays,
  resetStreak,
  resetUserProgress,
  reopenWin,
  setBlocked,
  setNotes,
  userSnapshot,
} from './adminOps.js';

export const adminRouter = express.Router();

function requireOwner(req, res, next) {
  if (!req.tgUser || !isOwnerNumeric(req.tgUser.id)) {
    logError('admin.denied', `Denied access for ${req.tgUser?.id ?? 'anonymous'}`);
    return res.status(403).json({ error: 'forbidden', message: 'Доступ только для владельца' });
  }
  return next();
}

function isOwnerNumeric(id) {
  return Number.isInteger(id) && config.ownerIds.includes(id);
}

adminRouter.use(requireOwner);

function parseRange(req) {
  const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
  const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
  return { from, to };
}

adminRouter.get('/me', (req, res) => {
  res.json({ id: req.tgUser.id, username: req.tgUser.username, owners: config.ownerIds });
});

adminRouter.get('/stats', (req, res) => {
  const { from, to } = parseRange(req);
  res.json({
    ...overview({ from, to }),
    notifications: queueStats(),
    delivery: deliveryStatus(),
    risk: riskReport(),
  });
});

adminRouter.get('/wins', (req, res) => {
  const { from, to } = parseRange(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(5, Number(req.query.perPage) || 25));
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const status = ['pending', 'delivered', 'cancelled'].includes(req.query.status) ? req.query.status : '';
  const gift = Object.keys(GIFTS).includes(req.query.gift) ? req.query.gift : '';
  const kind = ['free', 'paid', 'guarantee'].includes(req.query.kind) ? req.query.kind : '';

  const where = [];
  const params = [];
  if (q) {
    where.push('(w.win_code = ? OR CAST(w.user_id AS TEXT) = ? OR u.username = ?)');
    params.push(q.toUpperCase(), q.replace(/^@/, ''), q.replace(/^@/, ''));
  }
  if (status) {
    where.push('w.status = ?');
    params.push(status);
  }
  if (gift) {
    where.push('w.gift = ?');
    params.push(gift);
  }
  if (kind) {
    where.push('w.kind = ?');
    params.push(kind);
  }
  if (from) {
    where.push('w.created_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('w.created_at <= ?');
    params.push(`${to}T23:59:59.999Z`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM wins w LEFT JOIN users u ON u.tg_id = w.user_id ${clause}`)
    .get(...params).n;
  const items = db
    .prepare(
      `SELECT w.*, u.username, u.first_name, u.last_name
       FROM wins w LEFT JOIN users u ON u.tg_id = w.user_id
       ${clause} ORDER BY w.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, perPage, (page - 1) * perPage);

  res.json({
    total,
    page,
    perPage,
    items: items.map((w) => ({
      id: w.id,
      winCode: w.win_code,
      userId: w.user_id,
      username: w.username,
      name: [w.first_name, w.last_name].filter(Boolean).join(' ') || null,
      giftId: w.gift,
      gift: GIFTS[w.gift],
      kind: w.kind,
      kindLabel: { free: 'обычный', paid: 'платный', guarantee: 'гарантированный' }[w.kind],
      isGuaranteed: w.kind === 'guarantee',
      status: w.status,
      statusLabel: { pending: 'Ожидает выдачи', delivered: 'Выдан', cancelled: 'Отменён' }[w.status],
      cancelReason: w.cancel_reason,
      createdAt: w.created_at,
      deliveredAt: w.delivered_at,
      deliveredBy: w.delivered_by,
      telegramGiftSent: w.telegram_gift_sent === 1,
      spinId: w.spin_id,
      paymentId: w.payment_id,
    })),
  });
});

adminRouter.get('/wins/:code', (req, res) => {
  const row = db
    .prepare(
      `SELECT w.*, u.username, u.first_name, u.last_name, s.roll, s.probabilities, s.created_at AS spin_created_at
       FROM wins w LEFT JOIN users u ON u.tg_id = w.user_id LEFT JOIN spins s ON s.id = w.spin_id
       WHERE w.win_code = ? OR w.id = ?`,
    )
    .get(String(req.params.code).toUpperCase(), Number(req.params.code) || -1);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const payment = row.payment_id ? db.prepare('SELECT * FROM payments WHERE id = ?').get(row.payment_id) : null;
  return res.json({
    ...row,
    gift: GIFTS[row.gift],
    payment: payment
      ? {
          id: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          chargeId: payment.telegram_charge_id,
          createdAt: payment.created_at,
          failureReason: payment.failure_reason,
        }
      : null,
  });
});

adminRouter.post('/wins/:id/deliver', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM wins WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.status === 'delivered') return res.status(409).json({ error: 'already_delivered' });
  if (row.status === 'cancelled') return res.status(409).json({ error: 'win_cancelled' });

  const now = new Date().toISOString();
  db.prepare('UPDATE wins SET status = ?, delivered_at = ?, delivered_by = ?, updated_at = ? WHERE id = ?').run(
    'delivered',
    now,
    req.tgUser.id,
    now,
    id,
  );
  writeAudit(req.tgUser.id, 'win.deliver', `${row.win_code} (${row.gift}, ${row.kind})`);
  return res.json({ ok: true, winCode: row.win_code, deliveredAt: now, deliveredBy: req.tgUser.id });
});

adminRouter.post('/wins/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) return res.status(400).json({ error: 'reason_required', message: 'Укажите причину отмены' });
  if (reason.length > 500) return res.status(400).json({ error: 'reason_too_long' });

  const row = db.prepare('SELECT * FROM wins WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.status === 'delivered') return res.status(409).json({ error: 'already_delivered' });

  const now = new Date().toISOString();
  db.prepare('UPDATE wins SET status = ?, cancel_reason = ?, updated_at = ? WHERE id = ?').run(
    'cancelled',
    reason,
    now,
    id,
  );
  writeAudit(req.tgUser.id, 'win.cancel', `${row.win_code}: ${reason}`);
  return res.json({ ok: true, winCode: row.win_code, cancelReason: reason });
});

adminRouter.post('/wins/:id/auto-deliver', async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM wins WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const result = await tryAutoDeliver(row);
  writeAudit(req.tgUser.id, 'win.auto_deliver', `${row.win_code}: ${JSON.stringify(result).slice(0, 500)}`);
  return res.json(result);
});

adminRouter.get('/payments', (req, res) => {
  const { from, to } = parseRange(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(5, Number(req.query.perPage) || 25));
  res.json(
    listPayments({
      from,
      to,
      userId: req.query.userId ? Number(req.query.userId) : null,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
  );
});

adminRouter.get('/probabilities', (req, res) => {
  res.json({
    current: getProbabilities(),
    history: db
      .prepare('SELECT * FROM probability_history ORDER BY id DESC LIMIT 20')
      .all()
      .map((h) => ({
        id: h.id,
        oldValue: JSON.parse(h.old_value),
        newValue: JSON.parse(h.new_value),
        changedBy: h.changed_by,
        createdAt: h.created_at,
      })),
    snapshotNote:
      'Каждый спин сохраняет снимок вероятностей. Изменение настроек не влияет на уже сделанные спины.',
  });
});

adminRouter.post('/probabilities', (req, res) => {
  try {
    const cleaned = validateProbabilities(req.body?.probabilities);
    const result = setProbabilities(cleaned, req.tgUser.id);
    writeAudit(req.tgUser.id, 'probabilities.update', JSON.stringify(result));
    return res.json({ ok: true, ...result, effectiveFrom: 'Следующий спин' });
  } catch (err) {
    return res.status(err.status ?? 400).json({ error: 'invalid_probabilities', message: err.message });
  }
});

adminRouter.get('/finance', async (req, res) => {
  const { from, to } = parseRange(req);
  res.json({ ...finance({ from, to }), settlements: await settlements() });
});

adminRouter.get('/forecast', (req, res) => {
  const paidSpinsPerUser = Number.isFinite(Number(req.query.paidSpinsPerUser))
    ? Math.max(0, Number(req.query.paidSpinsPerUser))
    : 3;
  const horizons = String(req.query.horizons ?? '')
    .split(',')
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 3650);
  res.json(
    forecast({
      paidSpinsPerUser,
      horizons: horizons.length ? horizons : [30, 90, 180],
      userCounts: [100, 500, 1000, 5000],
    }),
  );
});

adminRouter.get('/risk', (req, res) => {
  res.json(riskReport());
});

adminRouter.post('/risk/toggle', (req, res) => {
  const name = req.body?.name;
  const value = req.body?.value === true || req.body?.value === '1' || req.body?.value === 1;
  try {
    const result = setToggle(name, value);
    writeAudit(req.tgUser.id, 'risk.toggle', `${name}=${value}`);
    return res.json({ ok: true, ...result });
  } catch {
    return res.status(400).json({ error: 'unknown_toggle' });
  }
});

adminRouter.post('/risk/budget', (req, res) => {
  const stars = Number(req.body?.stars);
  if (!Number.isFinite(stars) || stars < 0) return res.status(400).json({ error: 'invalid_budget' });
  const budget = setBudget(stars);
  writeAudit(req.tgUser.id, 'risk.budget', String(stars));
  return res.json({ ok: true, budgetStars: budget, risk: riskReport() });
});

adminRouter.get('/gifts', async (req, res) => {
  res.json({ ...deliveryStatus(), catalog: await catalogMatch() });
});

adminRouter.get('/notifications', (req, res) => {
  res.json({
    stats: queueStats(),
    items: db
      .prepare('SELECT * FROM notify_queue ORDER BY id DESC LIMIT 50')
      .all()
      .map((n) => ({
        id: n.id,
        winId: n.win_id,
        chatId: n.chat_id,
        status: n.status,
        attempts: n.attempts,
        nextAttemptAt: n.next_attempt_at,
        lastError: n.last_error,
        createdAt: n.created_at,
        sentAt: n.sent_at,
      })),
  });
});

adminRouter.post('/notifications/drain', async (req, res) => {
  res.json(await drainQueue({ limit: 50 }));
});

adminRouter.get('/users', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(5, Number(req.query.perPage) || 25));
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const where = [];
  const params = [];
  if (q) {
    where.push('(CAST(tg_id AS TEXT) = ? OR username = ?)');
    params.push(q.replace(/^@/, ''), q.replace(/^@/, ''));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users ${clause}`).get(...params).n;
  const items = db
    .prepare(`SELECT * FROM users ${clause} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`)
    .all(...params, perPage, (page - 1) * perPage);
  res.json({
    total,
    page,
    perPage,
    items: items.map((u) => ({
      id: u.tg_id,
      username: u.username,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || null,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
      freeSpinDay: u.free_spin_day,
      streakCount: u.streak_count,
      streakLastDay: u.streak_last_day,
      seriesGiftWon: u.series_gift_won === 1,
      guaranteeClaimed: u.guarantee_claimed === 1,
      blocked: u.blocked === 1,
      notes: u.notes ?? null,
      spinsTotal: u.spins_total,
      winsTotal: u.wins_total,
      pendingWins: db.prepare("SELECT COUNT(*) AS n FROM wins WHERE user_id = ? AND status = 'pending'").get(u.tg_id).n,
      isOwner: config.ownerIds.includes(u.tg_id),
    })),
  });
});

/* -------------------------------------------------- инструменты над юзером */

function resolveTarget(req) {
  const raw = req.params.id ?? req.body?.userId;
  const userId = Number(raw);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AdminOpError('Некорректный Telegram ID', 'bad_user_id');
  }
  return userId;
}

const op = (fn) => (req, res, next) => {
  try {
    res.json(fn(resolveTarget(req), req));
  } catch (err) {
    next(err);
  }
};

adminRouter.get('/users/:id', op((userId) => {
  ensureUser(userId);
  return { ok: true, user: userSnapshot(userId) };
}));

adminRouter.post('/users/:id/spin', op((userId, req) => {
  const result = forceSpin(userId, { kind: req.body?.kind ?? 'normal', outcome: req.body?.outcome ?? null }, req.tgUser.id);
  return { ok: true, ...result, user: describeUser(userId) };
}));

adminRouter.post('/users/:id/grant-win', op((userId, req) => {
  const result = grantWin(userId, req.body?.gift, req.tgUser.id);
  return { ok: true, ...result, user: describeUser(userId) };
}));

adminRouter.post('/users/:id/grant-free', op((userId, req) => ({
  ok: true,
  user: grantFreeSpin(userId, req.tgUser.id),
})));

adminRouter.post('/users/:id/streak', op((userId, req) => {
  const action = req.body?.action;
  if (action === 'reset') return { ok: true, user: resetStreak(userId, req.tgUser.id) };
  const days = req.body?.days;
  if (action === 'add') return { ok: true, user: addStreakDays(userId, days, req.tgUser.id) };
  if (action === 'set') {
    const value = Number(days);
    if (!Number.isInteger(value) || value < 0) throw new AdminOpError('Нужно целое число дней', 'bad_days');
    return {
      ok: true,
      user: addStreakDays(userId, value - (ensureUser(userId).streak_count ?? 0), req.tgUser.id),
    };
  }
  throw new AdminOpError('Неизвестное действие', 'bad_action');
}));

adminRouter.post('/users/:id/bonus', op((userId, req) => {
  const count = req.body?.count ?? 1;
  const replace = req.body?.replace === true;
  const user = replace ? setBonusSpins(userId, count, req.tgUser.id) : grantBonusSpins(userId, count, req.tgUser.id);
  return { ok: true, user };
}));

adminRouter.post('/users/:id/block', op((userId, req) => ({
  ok: true,
  user: setBlocked(userId, req.body?.blocked === true, req.tgUser.id),
})));

adminRouter.post('/users/:id/notes', op((userId, req) => ({
  ok: true,
  user: setNotes(userId, req.body?.notes, req.tgUser.id),
})));

adminRouter.post('/users/:id/reset', op((userId, req) => ({
  ok: true,
  user: resetUserProgress(userId, req.tgUser.id),
})));

adminRouter.post('/wins/:id/reopen', (req, res) => {
  res.json({ ok: true, ...reopenWin(Number(req.params.id), req.tgUser.id) });
});

/** Выгрузка базы целиком: перенос на другой хостинг без потери данных. */
adminRouter.get('/export/db.sqlite', (req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="freestars-${stamp}.sqlite"`);
  writeAudit(req.tgUser.id, 'export.db', stamp);
  res.sendFile(config.dbPath);
});

adminRouter.get('/backups', (req, res) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(path.dirname(config.dbPath), 'backups');
  res.json({
    dir,
    files: fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort().reverse().slice(0, 20)
      : [],
  });
});

adminRouter.get('/log', (req, res) => {
  res.json({
    admin: db
      .prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT 100')
      .all()
      .map((r) => ({ id: r.id, adminId: r.admin_id, action: r.action, details: r.details, createdAt: r.created_at })),
    errors: db
      .prepare('SELECT * FROM error_log ORDER BY id DESC LIMIT 100')
      .all()
      .map((r) => ({ id: r.id, scope: r.scope, message: r.message, details: r.details, createdAt: r.created_at })),
  });
});

adminRouter.get('/export/wins.csv', (req, res) => {
  const rows = db
    .prepare(
      `SELECT w.win_code, w.user_id, u.username, w.gift, w.kind, w.status, w.cancel_reason, w.created_at, w.delivered_at, w.delivered_by
       FROM wins w LEFT JOIN users u ON u.tg_id = w.user_id ORDER BY w.id DESC LIMIT 5000`,
    )
    .all();
  const header = 'win_code,user_id,username,gift,kind,status,cancel_reason,created_at,delivered_at,delivered_by';
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [header, ...rows.map((r) => [r.win_code, r.user_id, r.username, r.gift, r.kind, r.status, r.cancel_reason, r.created_at, r.delivered_at, r.delivered_by].map(escape).join(','))].join('\n');
  writeAudit(req.tgUser.id, 'export.wins', `${rows.length} rows`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  return res.send(`\uFEFF${csv}`);
});

adminRouter.get('/settings', (req, res) => {
  const costs = getSettingJson('gift_costs', config.giftCostStars);
  res.json({
    spinPriceStars: getSpinPrice(),
    giftCosts: costs,
    guaranteeDays: Number(db.prepare("SELECT value FROM settings WHERE key='guarantee_days'").get()?.value ?? 31),
    appName: config.appName,
    delivery: deliveryStatus(),
  });
});

adminRouter.post('/settings/gift-costs', (req, res) => {
  const body = req.body?.costs ?? {};
  const next = {};
  for (const key of Object.keys(GIFTS)) {
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: 'invalid_cost', message: `Некорректная стоимость: ${key}` });
    next[key] = value;
  }
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('gift_costs', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(next));
  writeAudit(req.tgUser.id, 'settings.gift_costs', JSON.stringify(next));
  return res.json({ ok: true, giftCosts: next });
});