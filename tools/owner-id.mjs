/**
 * Печатает числовые Telegram ID пользователей, которые уже написали боту.
 * Нужен, чтобы заполнить OWNER_TELEGRAM_IDS в .env — панель проверяет
 * числовой ID, а не @username.
 *
 * Важно: запускать при выключенном сервере, иначе long polling заберёт
 * обновления раньше скрипта.
 *
 *   npm run owner:id             # все, кто писал боту
 *   npm run owner:id -- maxxm4z  # только этот @username
 */
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const token = process.env.BOT_TOKEN ?? '';
if (!token) {
  console.error('BOT_TOKEN не задан в .env');
  process.exit(1);
}

const want = String(process.argv[2] ?? '').replace(/^@/, '').toLowerCase();

function call(method, params = {}) {
  const query = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.telegram.org/bot${token}/${method}?${query}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.ok) reject(new Error(data.description ?? 'Bot API error'));
          else resolve(data.result);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
  });
}

const me = await call('getMe');
console.log(`Бот: @${me.username} (${me.id})\n`);

const updates = await call('getUpdates', { limit: 100, allowed_updates: JSON.stringify(['message']) });
const users = new Map();
for (const update of updates) {
  const from = update.message?.from;
  if (!from || from.is_bot) continue;
  users.set(from.id, `@${from.username ?? '(без юзернейма)'} — ${from.first_name ?? ''}`.trim());
}

if (!users.size) {
  console.log('Боту ещё никто не писал.');
  console.log('Отправьте боту /start, затем запустите скрипт ещё раз.');
  process.exit(0);
}

let found = false;
for (const [id, label] of users) {
  const username = label.split(' ')[0].slice(1).toLowerCase();
  if (want && username !== want) continue;
  found = true;
  console.log(`${id}  ${label}`);
}

if (want && !found) console.log(`\n@${want} ещё не писал боту. Пусть он отправит /start.`);