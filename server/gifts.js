import { config } from './config.js';
import { db, logError } from './db.js';
import { getAvailableGifts, sendTelegramGift } from './tg.js';
import { GIFTS } from './roulette.js';

/**
 * Telegram only lets bots send gifts from its own official catalog
 * (see Bot API: getAvailableGifts / sendGift). Free Stars's Мишка / Торт / Сердце are
 * custom artwork, so by default delivery stays manual via @maxxm4z.
 *
 * If the owner maps a Free Stars gift to a real Telegram gift id (TG_GIFT_*_ID) and
 * sets AUTO_ISSUE_GIFTS=1, the bot will attempt real delivery and record the result.
 */
export function deliveryMode() {
  const mapped = Object.entries(config.telegramGiftIds).filter(([, id]) => id);
  return config.autoIssueGifts && mapped.length > 0 ? 'automatic' : 'manual';
}

export function mappedGifts() {
  return Object.entries(config.telegramGiftIds)
    .filter(([, id]) => id)
    .map(([gift, id]) => ({ gift, giftId: id, title: GIFTS[gift]?.title ?? gift }));
}

export async function catalogMatch() {
  const mapped = mappedGifts();
  if (!mapped.length) return { checked: false, reason: 'no_mapping' };
  try {
    const available = await getAvailableGifts();
    const ids = new Set((available?.gifts ?? []).map((g) => String(g.id)));
    return {
      checked: true,
      available: [...ids],
      matches: mapped.map((m) => ({ ...m, available: ids.has(String(m.giftId)) })),
    };
  } catch (err) {
    logError('gifts.catalog', err.message);
    return { checked: false, error: err.message };
  }
}

/**
 * Attempts real gift delivery for a win.
 * Returns {delivered:boolean, mode, reason}. Never marks a win as delivered in the
 * business sense — that stays a manual owner action.
 */
export async function tryAutoDeliver(win) {
  const tgGiftId = config.telegramGiftIds[win.gift];
  if (!config.autoIssueGifts || !tgGiftId) {
    return { delivered: false, mode: 'manual', reason: 'automatic delivery is disabled or unmapped' };
  }
  if (win.status === 'cancelled') return { delivered: false, mode: 'automatic', reason: 'win is cancelled' };

  try {
    const sent = await sendTelegramGift(tgGiftId, win.user_id, {
      text: `Free Stars: ${GIFTS[win.gift].title} (${win.win_code})`,
      payForUpgrade: true,
    });
    db.prepare('UPDATE wins SET telegram_gift_sent = 1, updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      win.id,
    );
    return { delivered: true, mode: 'automatic', response: sent };
  } catch (err) {
    logError('gifts.send', err.message, err.stack);
    return { delivered: false, mode: 'automatic', reason: err.message };
  }
}

export function deliveryStatus() {
  return {
    mode: deliveryMode(),
    ownerUsername: config.ownerUsername,
    ownerUrl: `https://t.me/${config.ownerUsername}`,
    mapped: mappedGifts(),
    note:
      deliveryMode() === 'manual'
        ? 'Telegram Bot API позволяет отправлять только подарки из официального каталога Telegram. Подарки Free Stars выдаются вручную через @maxxm4z.'
        : 'Бот пытается отправить настоящий Telegram Gift. Статус «Выдан» всё равно подтверждается владельцем вручную.',
  };
}