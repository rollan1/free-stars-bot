/**
 * Ответы бота на команды. Сообщение /start содержит две кнопки:
 * «Открыть приложение» (Mini App) и «Группа».
 */
import { config } from './config.js';
import { call } from './tg.js';
import { upsertUser } from './auth.js';
import { db } from './db.js';
import { getGuaranteeDays, getProbabilities, getSpinPrice } from './game.js';

export function miniAppUrl() {
  return config.publicUrl ? `${config.publicUrl}/` : null;
}

export function adminUrl() {
  return config.publicUrl ? `${config.publicUrl}/admin` : null;
}

/** Клавиатура под сообщением: открыть приложение + перейти в группу. */
export function mainKeyboard() {
  const rows = [];
  const url = miniAppUrl();
  if (url) rows.push([{ text: '✨ Открыть приложение', web_app: { url } }]);
  if (config.groupUrl) rows.push([{ text: '👥 Группа', url: config.groupUrl }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/** Шансы и цены читаются из БД, чтобы текст бота не расходился с админкой. */
function percent(value) {
  return String(Math.round((Number(value) || 0) * 100) / 100).replace('.', ',');
}

function startText() {
  const p = getProbabilities();
  const price = getSpinPrice();
  return [
    `✨ <b>${config.appName}</b> — рулетка подарков.`,
    '',
    '• Один бесплатный прокрут в сутки',
    `• Дополнительный спин — ${price} ⭐ Telegram Stars`,
    `• Шансы: 🎂 ${percent(p.cake)}% · 🧸 ${percent(p.bear)}% · ❤️ ${percent(p.heart)}% · 🍃 ${percent(p.none)}%`,
    `• Гарантированный подарок на ${getGuaranteeDays()}-й день серии`,
    '',
    `Выигрыш выдаёт владелец: @${config.ownerUsername}`,
  ].join('\n');
}

function helpText() {
  const price = getSpinPrice();
  return [
    '📖 <b>Как играть</b>',
    '',
    '1. Нажмите «Открыть приложение» под этим сообщением.',
    '2. Крутите колесо — один бесплатный прокрут в сутки.',
    '3. Если выпал подарок, вы получите уникальный номер выигрыша.',
    `4. Отправьте этот номер владельцу @${config.ownerUsername} для получения подарка.`,
    '',
    `Платный спин стоит ${price} ⭐ Telegram Stars и не тратит ежедневную попытку.`,
  ].join('\n');
}

/**
 * Запоминает пользователя, чтобы он появился в админке и мог быть
 * добавлен в список владельцев без дополнительных действий.
 */
export function rememberUser(from) {
  if (!from || !Number.isInteger(from.id)) return null;
  try {
    upsertUser({
      id: from.id,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      languageCode: from.language_code ?? null,
      isPremium: from.is_premium === true,
    });
    return from.id;
  } catch {
    return null;
  }
}

/**
 * Обрабатывает реферальную ссылку.
 * Если новый пользователь пришёл по ссылке ref_<referrerId>,
 * реферер получает +1 бонусный спин.
 * Каждый пользователь может быть засчитан только одному рефереру (UNIQUE referee_id).
 */
export function processReferral(refereeId, referrerId) {
  if (!refereeId || !referrerId || refereeId === referrerId) return false;
  try {
    // Проверяем что реферал ещё не засчитан
    const already = db.prepare('SELECT 1 FROM referrals WHERE referee_id = ?').get(refereeId);
    if (already) return false;
    // Проверяем что реферер существует
    const referrer = db.prepare('SELECT tg_id FROM users WHERE tg_id = ?').get(referrerId);
    if (!referrer) return false;
    // Записываем реферал
    db.prepare('INSERT OR IGNORE INTO referrals (referrer_id, referee_id, created_at) VALUES (?, ?, ?)').run(
      referrerId, refereeId, new Date().toISOString(),
    );
    // Даём рефереру +1 бонусный спин
    db.prepare('UPDATE users SET bonus_spins = bonus_spins + 1 WHERE tg_id = ?').run(referrerId);
    return true;
  } catch {
    return false;
  }
}

/** Количество рефералов пользователя */
export function getReferralCount(userId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ?').get(userId);
  return row?.n ?? 0;
}

export async function sendStart(chatId, from = null) {
  rememberUser(from);
  return call('sendMessage', {
    chat_id: chatId,
    text: startText(),
    parse_mode: 'HTML',
    reply_markup: mainKeyboard(),
  });
}

export async function sendHelp(chatId, from = null) {
  rememberUser(from);
  return call('sendMessage', {
    chat_id: chatId,
    text: helpText(),
    parse_mode: 'HTML',
    reply_markup: mainKeyboard(),
  });
}

export async function sendGroup(chatId) {
  if (!config.groupUrl) {
    return call('sendMessage', {
      chat_id: chatId,
      text: 'Группа пока не привязана.',
      reply_markup: mainKeyboard(),
    });
  }
  return call('sendMessage', {
    chat_id: chatId,
    text: `👥 Наша группа: ${config.groupUrl}`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '👥 Открыть группу', url: config.groupUrl }],
        ...(mainKeyboard()?.inline_keyboard ?? []),
      ],
    },
  });
}

export async function sendSupport(chatId) {
  return call('sendMessage', {
    chat_id: chatId,
    text: 'Напишите владельцу: @maxxm4z',
    reply_markup: mainKeyboard(),
  });
}

/** Обрабатывает команду из чата. Возвращает true, если команда была обработана. */
export async function handleCommand(text, chatId, from = null) {
  const command = String(text ?? '').trim().split('@')[0].toLowerCase().split(' ')[0];
  try {
    if (command === '/start' || command === '/freestars') {
      await sendStart(chatId, from);
      return true;
    }
    if (command === '/help' || command === '/rules') {
      await sendHelp(chatId, from);
      return true;
    }
    if (command === '/group' || command === '/chat') {
      await sendGroup(chatId, from);
      return true;
    }
    if (command === '/support') {
      await sendSupport(chatId, from);
      return true;
    }
    // Команда только для владельца: /bonus <userId> [count]
    if (command === '/bonus' && config.ownerIds.includes(from?.id)) {
      const parts = String(text ?? '').trim().split(/\s+/);
      const targetId = parseInt(parts[1], 10);
      const count = Math.min(100, Math.max(1, parseInt(parts[2] ?? '1', 10) || 1));
      if (!Number.isInteger(targetId) || targetId <= 0) {
        await call('sendMessage', { chat_id: chatId, text: '❌ Использование: /bonus <telegram_id> [количество]' });
        return true;
      }
      try {
        // Убеждаемся что юзер есть в БД, затем выдаём бонусные спины
        const existing = db.prepare('SELECT tg_id FROM users WHERE tg_id = ?').get(targetId);
        if (!existing) {
          const now = new Date().toISOString();
          db.prepare('INSERT OR IGNORE INTO users (tg_id, created_at, last_seen_at) VALUES (?, ?, ?)').run(targetId, now, now);
        }
        db.prepare('UPDATE users SET bonus_spins = bonus_spins + ? WHERE tg_id = ?').run(count, targetId);
        const user = db.prepare('SELECT bonus_spins FROM users WHERE tg_id = ?').get(targetId);
        await call('sendMessage', {
          chat_id: chatId,
          text: `✅ Пользователю <code>${targetId}</code> выдано +${count} бонусных спина.\nТекущий баланс: ${user.bonus_spins} спинов.`,
          parse_mode: 'HTML',
        });
        // Уведомляем самого пользователя
        try {
          await call('sendMessage', {
            chat_id: targetId,
            text: `🎁 Вам выдан +${count} бесплатный спин от владельца Free Stars!\nОткройте приложение, чтобы использовать его.`,
            reply_markup: mainKeyboard(),
          });
        } catch { /* пользователь мог заблокировать бота */ }
      } catch (err) {
        await call('sendMessage', { chat_id: chatId, text: `❌ Ошибка: ${err.message}` });
      }
      return true;
    }

    if (command === '/ref') {
      rememberUser(from);
      const userId = from?.id;
      if (!userId) return true;
      const count = getReferralCount(userId);
      const link = `https://t.me/${config.botUsername}?start=ref_${userId}`;
      await call('sendMessage', {
        chat_id: chatId,
        text: [
          '🔗 <b>Ваша реферальная ссылка:</b>',
          '',
          `<code>${link}</code>`,
          '',
          `👥 Приглашено друзей: <b>${count}</b>`,
          '',
          '✨ За каждого друга, который запустит бота по вашей ссылке, вы получите <b>+1 бесплатный спин</b>!',
        ].join('\n'),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '📤 Поделиться ссылкой', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('✨ Free Stars — крути рулетку и выигрывай подарки!')}` }]],
        },
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}