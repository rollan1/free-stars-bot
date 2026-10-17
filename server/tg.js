import { config } from './config.js';
import { logError } from './db.js';

const API_ROOT = 'https://api.telegram.org';

export class TelegramApiError extends Error {
  constructor(description, { method, errorCode = null, retryAfter = null } = {}) {
    super(`Telegram API ${method} failed: ${description}`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.description = description;
    this.errorCode = errorCode;
    this.retryAfter = retryAfter;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isConfigured() {
  return Boolean(config.botToken);
}

/**
 * Calls a Bot API method. Retries on transport errors and 429/5xx using the
 * retry_after hint from Telegram. Never throws on business errors — callers decide.
 */
export async function call(method, payload = {}, { retries = 3, timeoutMs = 20000 } = {}) {
  if (!config.botToken) throw new TelegramApiError('BOT_TOKEN is not configured', { method });

  let attempt = 0;
  let lastErr = null;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${API_ROOT}/bot${config.botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));

      if (body.ok) return body.result;

      const retryAfter = body.parameters?.retry_after ?? null;
      const isRateLimit = body.error_code === 429;
      const isServerError = typeof body.error_code === 'number' && body.error_code >= 500;
      lastErr = new TelegramApiError(body.description ?? 'unknown error', {
        method,
        errorCode: body.error_code ?? null,
        retryAfter,
      });
      if ((isRateLimit || isServerError) && attempt < retries) {
        const wait = (retryAfter ?? 2 ** attempt) * 1000;
        await sleep(Math.min(wait, 30000));
        attempt += 1;
        continue;
      }
      throw lastErr;
    } catch (err) {
      if (err instanceof TelegramApiError) throw err;
      lastErr = err;
      if (attempt < retries) {
        await sleep(Math.min(2 ** attempt * 500, 8000));
        attempt += 1;
        continue;
      }
      throw new TelegramApiError(`network error: ${err.message}`, { method });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export const getMe = () => call('getMe');
export const sendMessage = (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, ...extra });

/**
 * Creates a Telegram Stars invoice (XTR, empty provider_token) for one extra spin.
 * For XTR the amount is a whole number of Stars.
 */
export async function createStarsInvoiceLink({ payload, title, description, amount }) {
  return call('createInvoiceLink', {
    title,
    description,
    payload,
    currency: 'XTR',
    prices: [{ label: title, amount }],
    provider_token: '',
    max_tip_amount: 0,
    suggested_tip_amounts: [],
    allow_updates: false,
  });
}

export async function getStarTransactions({ offset = 0, limit = 100 } = {}) {
  return call('getStarTransactions', { offset, limit });
}

export async function getMyStarBalance() {
  return call('getMyStarBalance');
}

export async function refundStarPayment(userId, telegramPaymentChargeId) {
  return call('refundStarPayment', { user_id: userId, telegram_payment_charge_id: telegramPaymentChargeId });
}

export async function getAvailableGifts() {
  return call('getAvailableGifts');
}

/** Sends a real Telegram gift. Only usable with ids from getAvailableGifts. */
export async function sendTelegramGift(giftId, userId, { text = '', payForUpgrade = false } = {}) {
  return call('sendGift', { gift_id: giftId, user_id: userId, text, pay_for_upgrade: payForUpgrade });
}

/**
 * Best-effort owner notification. Returns {ok, error} instead of throwing so the
 * caller can enqueue a retry without failing the user's spin.
 */
export async function notifyOwner(chatId, text) {
  try {
    const message = await sendMessage(chatId, text, { disable_web_page_preview: true });
    return { ok: true, messageId: message?.message_id ?? null };
  } catch (err) {
    logError('telegram.notify', err.message, err.stack);
    return { ok: false, error: err.message, retryAfter: err.retryAfter ?? null };
  }
}