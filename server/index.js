import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config, validateStartupConfig, ROOT } from './config.js';
import { db, logError } from './db.js';
import { AuthError, validateInitData, upsertUser, isOwner } from './auth.js';
import {
  spinFree,
  freeSpinStatus,
  userHistory,
  paidSpinResultForUser,
  publicConfig,
  serverNow,
  serverDay,
  nextDayStart,
  getProbabilities,
  getGiftCosts,
  getSpinPrice,
  getGuaranteeDays,
  getGuaranteeGift,
  SpinError,
} from './game.js';
import {
  createSpinInvoice,
  paymentStatusForUser,
  processUpdate,
  startUpdatePump,
  reconcileFromStarTransactions,
  autoReconcileAllStars,
} from './payments.js';
import { adminRouter } from './admin.js';
import { startNotificationWorker, drainQueue } from './notify.js';
import { deliveryStatus } from './gifts.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));

/** Компактный журнал запросов: видно, доходят ли обращения из Telegram. */
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (req.path === '/health') return;
    const ms = Date.now() - startedAt;
    const mark = res.statusCode >= 500 ? 'ERR' : res.statusCode >= 400 ? 'WRN' : 'OK ';
    console.log(`[freestars] ${mark} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function readInitData(req) {
  const header = req.get('x-telegram-init-data');
  if (header) return header;
  if (typeof req.body?.initData === 'string') return req.body.initData;
  if (typeof req.query?.initData === 'string') return req.query.initData;
  return null;
}

/** Validates initData on every protected request; the client is never trusted. */
const requireUser = wrap((req, _res, next) => {
  const initData = readInitData(req);
  try {
    const validated = validateInitData(initData);
    req.tgUser = validated.user;
    req.userRow = upsertUser(validated.user);
    req.isOwner = isOwner(req.tgUser.id);
    next();
  } catch (err) {
    next(err);
  }
});

const simpleLimiter = (maxPerMinute) => {
  const hits = new Map();
  return (req, res, next) => {
    const key = `${req.tgUser?.id ?? req.ip}:${req.path}`;
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < 60000);
    if (list.length >= maxPerMinute) {
      return res.status(429).json({ error: 'too_many_requests', message: 'Слишком много запросов. Подождите минуту.' });
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return next();
  };
};

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: config.appName,
    serverDay: serverDay(),
    serverTime: serverNow().toISOString(),
    nextDayStart: new Date(nextDayStart()).toISOString(),
    botConfigured: Boolean(config.botToken),
    delivery: deliveryStatus().mode,
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    ...publicConfig(),
    serverDay: serverDay(),
    serverTime: serverNow().toISOString(),
  });
});

app.post('/api/session', requireUser, wrap((req, res) => {
  res.json({
    user: {
      id: req.tgUser.id,
      username: req.tgUser.username,
      name: [req.tgUser.firstName, req.tgUser.lastName].filter(Boolean).join(' ') || null,
      isOwner: req.isOwner,
    },
    ...publicConfig(),
    serverDay: serverDay(),
    serverTime: serverNow().toISOString(),
    spin: freeSpinStatus(req.userRow),
    history: userHistory(req.tgUser.id, 30),
    stats: {
      totalSpins: req.userRow.spins_total,
      totalWins: req.userRow.wins_total,
    },
  });
}));

app.post('/api/spin/free', requireUser, simpleLimiter(30), wrap((req, res) => {
  const result = spinFree(req.tgUser.id);
  res.json({ ok: true, ...result, spin: freeSpinStatus(db.prepare('SELECT * FROM users WHERE tg_id = ?').get(req.tgUser.id)) });
}));

app.post('/api/spin/paid/invoice', requireUser, simpleLimiter(10), wrap(async (req, res) => {
  if (!config.botToken) return res.status(503).json({ error: 'bot_not_configured', message: 'Платёжный провайдер не настроен на сервере' });
  const invoice = await createSpinInvoice(req.tgUser.id);
  return res.json({ ok: true, ...invoice });
}));

app.get('/api/spin/paid/status', requireUser, wrap((req, res) => {
  const payload = typeof req.query.payload === 'string' ? req.query.payload : '';
  const status = paymentStatusForUser(req.tgUser.id, payload);
  if (!status) return res.status(404).json({ error: 'payment_not_found' });
  return res.json({ ok: true, payment: status });
}));

app.get('/api/spin/paid/result', requireUser, wrap((req, res) => {
  const payload = typeof req.query.payload === 'string' ? req.query.payload : '';
  const result = paidSpinResultForUser(req.tgUser.id, payload);
  if (!result) return res.status(404).json({ error: 'payment_not_found' });
  const user = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(req.tgUser.id);
  return res.json({ ok: true, payment: result, ...result, spinStatus: freeSpinStatus(user) });
}));

app.post('/api/spin/paid/reconcile', requireUser, simpleLimiter(10), wrap(async (req, res) => {
  const payload = typeof req.body?.payload === 'string' ? req.body.payload : '';
  const result = await reconcileFromStarTransactions(payload);
  const status = paymentStatusForUser(req.tgUser.id, payload);
  res.json({ ok: true, reconcile: result, payment: status });
}));

app.get('/api/history', requireUser, wrap((req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ ok: true, ...userHistory(req.tgUser.id, limit) });
}));

app.get('/api/spin/status', requireUser, wrap((req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(req.tgUser.id);
  res.json({
    ok: true,
    spin: freeSpinStatus(user),
    probabilities: getProbabilities(),
    giftCosts: getGiftCosts(),
    spinPriceStars: getSpinPrice(),
    guaranteeDays: getGuaranteeDays(),
    guaranteeGift: getGuaranteeGift(),
  });
}));

app.use('/api/admin', requireUser, adminRouter);

app.post('/telegram/webhook', express.json(), wrap(async (req, res) => {
  if (config.webhookSecret) {
    const secret = req.get('x-telegram-bot-api-secret-token');
    if (secret !== config.webhookSecret) return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ ok: true });
  try {
    await processUpdate(req.body);
  } catch (err) {
    logError('webhook', err.message, err.stack);
  }
  return undefined;
}));

app.use(
  express.static(path.join(ROOT, 'public'), {
    index: 'index.html',
    setHeaders(res, filePath) {
      const ext = path.extname(filePath).toLowerCase();
      // Код и разметка всегда свежие, иначе Telegram WebView держит старую версию до часа.
      if (ext === '.html' || ext === '.js' || ext === '.css') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
      } else if (ext === '.png' || ext === '.jpg' || ext === '.svg' || ext === '.webp') {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  }),
);

app.get('/admin', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'admin.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  return res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
  if (err instanceof AuthError) {
    return res.status(err.status).json({
      error: err.code,
      message:
        err.code === 'missing_init_data'
          ? 'Данные Telegram не получены. Закройте и снова откройте приложение.'
          : err.code === 'expired_init_data'
            ? 'Сессия устарела. Закройте и снова откройте приложение.'
            : 'Авторизация не пройдена. Откройте приложение через Telegram.',
    });
  }
  if (err instanceof SpinError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  logError(err?.name ?? 'http', err?.message ?? 'unknown error', err?.stack);
  return res.status(500).json({ error: 'internal_error', message: 'Внутренняя ошибка сервера' });
});

const problems = validateStartupConfig({ requireBotToken: false });
if (problems.length) {
  console.warn('[freestars] configuration warnings:\n - ' + problems.join('\n - '));
}

// На бесплатных хостингах (Koyeb, Render) локальный диск эфемерный: база
// создаётся заново при каждом перезапуске. Пустая база на старте — признак
// либо первого запуска, либо потери данных. Скачать копию: /api/admin/export/db.sqlite
if (!Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0)) {
  console.warn('[freestars] база пуста (0 пользователей) — проверьте, не потерялись ли данные при перезапуске');
}

const server = app.listen(config.port, config.host, () => {
  console.log(`[freestars] ${config.appName} listening on http://${config.host}:${config.port}`);
  console.log(`[freestars] owner ids: ${config.ownerIds.join(', ') || '(none)'} | bot token: ${config.botToken ? 'set' : 'NOT SET'}`);
});

const notifyWorker = startNotificationWorker();

/**
 * Ежедневная резервная копия SQLite: на бесплатных хостингах диск временный,
 * а потеря базы означает потерю пользователей и выигрышей.
 */
function startDailyBackup() {
  const dir = path.join(path.dirname(config.dbPath), 'backups');
  const make = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const target = path.join(dir, `freestars-${stamp}.sqlite`);
      fs.copyFileSync(config.dbPath, target);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort();
      for (const old of files.slice(0, -14)) fs.rmSync(path.join(dir, old), { force: true });
      console.log(`[freestars] резервная копия: ${target}`);
    } catch (err) {
      logError('backup', err.message);
    }
  };
  make();
  const timer = setInterval(make, 24 * 3600_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

const backupWorker = startDailyBackup();
const pumpDisabled =
  config.updateMode === 'webhook' ||
  ['1', 'true', 'yes'].includes(String(process.env.DISABLE_UPDATE_PUMP ?? '').toLowerCase());
const stopPump = pumpDisabled ? null : startUpdatePump();

console.log(
  `[freestars] режим обновлений: ${config.updateMode}${config.updateMode === 'webhook' ? ` (${config.webhookUrl})` : ' (long polling)'}`,
);

// Сверка транзакций Stars при старте и каждые 30 секунд
autoReconcileAllStars().catch(() => {});
const reconcileTimer = setInterval(() => {
  autoReconcileAllStars().catch(() => {});
}, 30000);
reconcileTimer.unref?.();

// Graceful shutdown so SQLite is flushed cleanly.
function shutdown(signal) {
  console.log(`[freestars] ${signal} received, shutting down`);
  notifyWorker.stop();
  backupWorker.stop();
  stopPump?.();
  server.close(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server };