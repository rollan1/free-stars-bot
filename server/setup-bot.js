/**
 * Настройка бота: команды, кнопка меню Mini App и (опционально) webhook для платежей.
 *
 * Запуск:  node server/setup-bot.js            — команды + кнопка меню
 *          node server/setup-bot.js --webhook  — дополнительно ставит webhook
 *          node server/setup-bot.js --no-webhook — снимает webhook (для long polling)
 */
import crypto from 'node:crypto';
import { config, validateStartupConfig } from './config.js';
import { call, getMe } from './tg.js';

const problems = validateStartupConfig();
if (problems.length) {
  console.error('[freestars] Нужно исправить конфигурацию:\n - ' + problems.join('\n - '));
  process.exit(1);
}

const hasPublicUrl = Boolean(config.publicUrl);
if (!hasPublicUrl) {
  console.warn('[freestars] PUBLIC_URL не задан — кнопку меню Mini App установить нельзя.');
  console.warn('[freestars] Остальные настройки бота всё равно будут применены.');
}
const miniAppUrl = hasPublicUrl ? `${config.publicUrl}/` : null;
const adminUrl = hasPublicUrl ? `${config.publicUrl}/admin` : null;

/**
 * Telegram принимает в secret_token только A-Z, a-z, 0-9, "_" и "-".
 */
function normalizeSecret(secret) {
  const cleaned = String(secret ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned.length >= 1 && cleaned.length <= 256 ? cleaned : null;
}

function generateSecret(botId) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(32);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${botId}_${out}`.slice(0, 256);
}

async function main() {
  const me = await getMe();
  console.log(`[freestars] Бот: @${me.username} (${me.id})`);

  await call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Открыть рулетку Free Stars' },
      { command: 'rules', description: 'Как играть и получить подарок' },
      { command: 'ref', description: 'Моя реферальная ссылка — +1 спин за друга' },
      { command: 'group', description: 'Наша группа' },
      { command: 'support', description: 'Связаться с владельцем' },
    ],
  });
  console.log('[freestars] Команды бота обновлены');

  if (hasPublicUrl) {
    await call('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Free Stars', web_app: { url: miniAppUrl } },
    });
    console.log(`[freestars] Кнопка меню: ${miniAppUrl}`);
  }

  await call('setMyDescription', {
    description:
      'Free Stars — рулетка подарков. Один бесплатный спин в сутки, дополнительный — за 5 ⭐. Выигрыш выдаёт владелец.',
  });
  await call('setMyShortDescription', { short_description: 'Рулетка подарков Free Stars: 1 бесплатный спин в сутки' });

  const args = process.argv.slice(2);
  if (args.includes('--webhook')) {
    if (!hasPublicUrl) {
      console.error('[freestars] Для webhook нужен PUBLIC_URL с публичным HTTPS-адресом.');
      process.exit(1);
    }
    const secret = normalizeSecret(config.webhookSecret) ?? generateSecret(me.id);
    const url = `${config.publicUrl}/telegram/webhook`;
    await call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'pre_checkout_query'] });
    const info = await call('getWebhookInfo');
    console.log(`[freestars] Webhook установлен: ${url}`);
    console.log(`[freestars] Статус webhook: ${info.status}${info.pending_update_count ? `, в очереди ${info.pending_update_count}` : ''}`);
    if (normalizeSecret(config.webhookSecret) !== config.webhookSecret) {
      console.log(`[freestars] В .env укажите WEBHOOK_SECRET=${secret}`);
    }
  } else if (args.includes('--no-webhook')) {
    await call('deleteWebhook', { drop_pending_updates: false });
    console.log('[freestars] Webhook удалён. Работает long polling.');
  } else {
    console.log('[freestars] Webhook не трогаем.');
    if (hasPublicUrl) {
      console.log('          Для платежей по сети нужен HTTPS: node server/setup-bot.js --webhook');
    }
  }

  console.log(hasPublicUrl ? `[freestars] Готово. Админка: ${adminUrl}` : '[freestars] Готово (без кнопки меню: нет PUBLIC_URL).');
}

main().catch((err) => {
  console.error(`[freestars] Ошибка: ${err.message}`);
  process.exit(1);
});