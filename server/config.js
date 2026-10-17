import 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return n;
}

function str(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/** Owner ids allowed into the admin panel. Always numeric, never username-based. */
const ownerIdsRaw = str('OWNER_TELEGRAM_IDS', '');
const ownerIds = ownerIdsRaw
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n)) {
      throw new Error(`OWNER_TELEGRAM_IDS must contain numeric Telegram IDs, got "${s}"`);
    }
    return n;
  });

/** Если задан PUBLIC_URL, webhook-адрес выводится из него. */
const resolvedPublicUrl = str('PUBLIC_URL', '').replace(/\/+$/, '');
const resolvedWebhookUrl = str('WEBHOOK_URL', resolvedPublicUrl ? `${resolvedPublicUrl}/telegram/webhook` : '');

export const config = {
  botToken: str('BOT_TOKEN', ''),
  botUsername: str('BOT_USERNAME', ''),
  appName: str('APP_NAME', 'Free Stars'),
  ownerUsername: str('OWNER_USERNAME', 'maxxm4z'),
  ownerIds,

  /** Ссылка на группу, кнопка в сообщении /start. */
  groupUrl: str('GROUP_URL', 'https://t.me/maksimruml'),

  port: num('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  publicUrl: resolvedPublicUrl,
  dbPath: path.resolve(ROOT, str('DB_PATH', 'data/freestars.db')),

  /** Server-side timezone offset (hours) used to decide the "server day". */
  serverTzOffsetHours: num('SERVER_TZ_OFFSET_HOURS', 0),
  /** Reject initData older than this many seconds. */
  initDataMaxAgeSeconds: num('INITDATA_MAX_AGE_SECONDS', 86400),

  /** Гарантия: на какой день серии выдаётся подарок. */
  guaranteeDays: num('GUARANTEE_DAYS', 31),
  /** Подарок гарантии. Telegram-подарок Free Stars нельзя отправить напрямую. */
  guaranteeGift: str('GUARANTEE_GIFT', 'bear'),
  /** Каждые N дней серии игрок получает дополнительный бесплатный спин. 0 = выключить. */
  seriesBonusEvery: num('SERIES_BONUS_EVERY', 5),

  /** Telegram Stars price of one extra spin. */
  spinPriceStars: num('SPIN_PRICE_STARS', 5),

  /** Internal cost valuation of gifts, in Stars (owner-defined estimates). */
  giftCostStars: {
    bear: num('COST_BEAR_STARS', 15),
    heart: num('COST_HEART_STARS', 15),
    cake: num('COST_CAKE_STARS', 50),
  },

  /**
   * Optional mapping of a Free Stars gift to a real Telegram gift id so the bot can
   * deliver it through sendGift. Telegram only exposes its own official gift
   * catalog, so these are normally unset and issuance stays manual.
   */
  telegramGiftIds: {
    bear: str('TG_GIFT_BEAR_ID', ''),
    heart: str('TG_GIFT_HEART_ID', ''),
    cake: str('TG_GIFT_CAKE_ID', ''),
  },
  /** Set to 1 to let the bot actually deliver gifts via sendGift. */
  autoIssueGifts: bool('AUTO_ISSUE_GIFTS', false),

/** Risk control: pause thresholds, in internal Stars valuation units. */
  budgetWarningStars: num('BUDGET_WARNING_STARS', 500),
  budgetCriticalStars: num('BUDGET_CRITICAL_STARS', 200),

  webhookUrl: resolvedWebhookUrl,
  webhookSecret: str('WEBHOOK_SECRET', ''),

  /**
   * 'webhook' — обновления приходят на /telegram/webhook.
   * 'polling'  — сервер сам читает getUpdates (нужно, если webhook не задан).
   */
  updateMode: str('UPDATE_MODE', resolvedWebhookUrl ? 'webhook' : 'polling').toLowerCase(),
};

export function validateStartupConfig({ requireBotToken = true } = {}) {
  const problems = [];
  if (requireBotToken && !config.botToken) problems.push('BOT_TOKEN is not set');
  if (config.botToken && !/^\d+:[\w-]{20,}$/.test(config.botToken)) {
    problems.push('BOT_TOKEN does not look like a Telegram bot token');
  }
  if (!config.ownerIds.length) problems.push('OWNER_TELEGRAM_IDS is empty — admin panel would be unusable');
  if (config.spinPriceStars <= 0) problems.push('SPIN_PRICE_STARS must be > 0');
  return problems;
}