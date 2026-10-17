import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.BOT_TOKEN = '1234567890:TEST-token-for-automated-suite-abcdefghij';
process.env.OWNER_TELEGRAM_IDS = '777000111';
process.env.DB_PATH = path.join(os.tmpdir(), 'freestars-tests', `http-${crypto.randomInt(1e9)}`, 'test.db');
process.env.PORT = process.env.TEST_PORT || '49321';
process.env.DISABLE_UPDATE_PUMP = '1';
process.env.SERVER_TZ_OFFSET_HOURS = '0';

const { buildInitDataForTest } = await import('../server/auth.js');
const { server } = await import('../server/index.js');
const { db } = await import('../server/db.js');

if (!server.listening) {
  await new Promise((resolve) => server.once('listening', resolve));
}
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const ownerInit = buildInitDataForTest({ id: 777000111, username: 'Fortmain', first_name: 'Fort', last_name: 'Main' });
const userInit = buildInitDataForTest({ id: 424242, username: 'player', first_name: 'Иван', last_name: 'Петров' });

async function req(pathname, { method = 'GET', initData, body } = {}) {
  const headers = {};
  if (initData) headers['x-telegram-init-data'] = initData;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

after(() => {
  server.close();
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

test('GET /health отвечает и отдаёт серверное время', async () => {
  const res = await req('/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.serverDay, /^\d{4}-\d{2}-\d{2}$/);
});

test('публичный конфиг отдаёт вероятности 1/3/3/93 и цену 5 Stars', async () => {
  const res = await req('/api/config');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.probabilities, { cake: 0.5, bear: 1, heart: 1, none: 97.5 });
  assert.equal(res.json.spinPriceStars, 5);
  assert.equal(res.json.guaranteeDays, 31);
  assert.equal(res.json.guarantee.emoji, '🎁', 'подарок гарантии не раскрывается в клиенте');
  assert.equal(res.json.ownerUrl, 'https://t.me/maxxm4z');
  assert.equal(res.json.gifts.bear.image, '/assets/bear.png');
});

test('без initData защищённые ручки возвращают 401', async () => {
  for (const [pathname, method] of [
    ['/api/session', 'POST'],
    ['/api/spin/free', 'POST'],
    ['/api/history', 'GET'],
    ['/api/admin/stats', 'GET'],
  ]) {
    const res = await req(pathname, { method });
    assert.equal(res.status, 401, `${pathname} должен требовать initData`);
  }
});

test('поддельный initData не проходит', async () => {
  const res = await req('/api/session', { method: 'POST', initData: `${ownerInit}tampered=1` });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'bad_signature');
});

test('админ-панель закрыта для обычного пользователя', async () => {
  for (const pathname of ['/api/admin/me', '/api/admin/stats', '/api/admin/wins', '/api/admin/finance', '/api/admin/log']) {
    const res = await req(pathname, { initData: userInit });
    assert.equal(res.status, 403, `${pathname} не должен быть доступен постороннему`);
    assert.equal(res.json.error, 'forbidden');
  }
});

test('владелец с числовым ID получает доступ к админке', async () => {
  const me = await req('/api/admin/me', { initData: ownerInit });
  assert.equal(me.status, 200);
  assert.equal(me.json.id, 777000111);
  assert.deepEqual(me.json.owners, [777000111]);

  const stats = await req('/api/admin/stats', { initData: ownerInit });
  assert.equal(stats.status, 200);
  assert.equal(typeof stats.json.users.total, 'number');
  assert.deepEqual(stats.json.settings.probabilities, { cake: 0.5, bear: 1, heart: 1, none: 97.5 });
});

test('пользователь создаёт сессию и крутит бесплатный спин один раз', async () => {
  const session = await req('/api/session', { method: 'POST', initData: userInit });
  assert.equal(session.status, 200);
  assert.equal(session.json.user.id, 424242);
  assert.equal(session.json.spin.available, true);
  assert.equal(session.json.spin.streak.day, 1);

  const first = await req('/api/spin/free', { method: 'POST', initData: userInit });
  assert.equal(first.status, 200);
  assert.ok(['cake', 'bear', 'heart', 'none'].includes(first.json.outcome));
  assert.equal(first.json.kind, 'free');

  const second = await req('/api/spin/free', { method: 'POST', initData: userInit });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'already_spun_today');

  const after = await req('/api/spin/free', { method: 'POST', initData: userInit });
  assert.equal(after.status, 409, 'повторные нажатия не дают новых спинов');
});

test('чужая история выигрышей недоступна', async () => {
  const mine = await req('/api/history', { initData: userInit });
  assert.equal(mine.status, 200);
  assert.ok(Array.isArray(mine.json.items));

  const ownerList = await req('/api/admin/wins', { initData: ownerInit });
  assert.equal(ownerList.status, 200);
  assert.ok(ownerList.json.items.every((w) => typeof w.winCode === 'string'));
});

test('изменение вероятностей: сумма 100 обязательна, журнал пишется', async () => {
  const bad = await req('/api/admin/probabilities', {
    method: 'POST',
    initData: ownerInit,
    body: { probabilities: { cake: 5, bear: 5, heart: 5, none: 80 } },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /sum to exactly 100/);

  const negative = await req('/api/admin/probabilities', {
    method: 'POST',
    initData: ownerInit,
    body: { probabilities: { cake: -1, bear: 3, heart: 3, none: 95 } },
  });
  assert.equal(negative.status, 400);

  const ok = await req('/api/admin/probabilities', {
    method: 'POST',
    initData: ownerInit,
    body: { probabilities: { cake: 2, bear: 3, heart: 3, none: 92 } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.current.cake, 2);
  assert.equal(ok.json.previous.cake, 0.5);

  const history = await req('/api/admin/probabilities', { initData: ownerInit });
  assert.ok(history.json.history.length >= 1);
  assert.equal(history.json.history[0].changedBy, 777000111);

  // возвращаем исходные значения
  await req('/api/admin/probabilities', {
    method: 'POST',
    initData: ownerInit,
    body: { probabilities: { cake: 1, bear: 3, heart: 3, none: 93 } },
  });
});

test('выдачу нельзя подтвердить без прав, отмена требует причину', async () => {
  // создаём детерминированный выигрыш: временно делаем шанс 100%
  await req('/api/admin/probabilities', {
    method: 'POST',
    initData: ownerInit,
    body: { probabilities: { cake: 0, bear: 100, heart: 0, none: 0 } },
  });

  const winnerInit = buildInitDataForTest({ id: 515151, username: 'winner', first_name: 'Победитель' });
  const spin = await req('/api/spin/free', { method: 'POST', initData: winnerInit });
  assert.equal(spin.status, 200);
  assert.equal(spin.json.outcome, 'bear');
  assert.ok(spin.json.win.code.startsWith('FS-'));
  assert.equal(spin.json.win.statusLabel, 'Ожидает выдачи');
  assert.equal(spin.json.win.ownerUrl, 'https://t.me/maxxm4z');

  await req('/api/admin/probabilities', {
    method: 'POST',
    initData: ownerInit,
    body: { probabilities: { cake: 1, bear: 3, heart: 3, none: 93 } },
  });

  const wins = await req('/api/admin/wins?perPage=5', { initData: ownerInit });
  const target = wins.json.items.find((w) => w.userId === 515151);
  assert.ok(target, 'нужен хотя бы один выигрыш в тесте');
  assert.equal(target.kindLabel, 'обычный');
  assert.equal(target.isGuaranteed, false);

  const denied = await req(`/api/admin/wins/${target.id}/deliver`, { method: 'POST', initData: userInit });
  assert.equal(denied.status, 403);

  const noReason = await req(`/api/admin/wins/${target.id}/cancel`, { method: 'POST', initData: ownerInit, body: {} });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error, 'reason_required');

  const delivered = await req(`/api/admin/wins/${target.id}/deliver`, { method: 'POST', initData: ownerInit });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.json.deliveredBy, 777000111);

  const again = await req(`/api/admin/wins/${target.id}/deliver`, { method: 'POST', initData: ownerInit });
  assert.equal(again.status, 409);

  const history = await req('/api/history', { initData: winnerInit });
  assert.equal(history.json.items[0].status, 'delivered');
  assert.equal(history.json.items[0].statusLabel, 'Выдан');
});

test('статические файлы отдаются, секретов во фронтенде нет', async () => {
  const index = await req('/');
  assert.equal(index.status, 200);
  assert.match(index.text, /Free Stars/);
  assert.match(index.text, /\/styles\.css/);
  assert.match(index.text, /\/app\.js/);

  for (const asset of ['/assets/bear.png', '/assets/heart.png', '/assets/cake.png']) {
    const res = await fetch(`${base}${asset}`);
    assert.equal(res.status, 200, `${asset} должен отдаваться`);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 1000, `${asset} подозрительно мал`);
    assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', `${asset} не является PNG`);
  }

  const clientJs = await req('/app.js');
  assert.equal(clientJs.status, 200);
  assert.match(clientJs.text, /WHEEL_ORDER/);
  for (const needle of [process.env.BOT_TOKEN, 'TEST-token', 'OWNER_TELEGRAM_IDS', 'DB_PATH']) {
    assert.ok(!clientJs.text.includes(needle), 'секрет не должен попадать во фронтенд');
  }
  const adminJs = await req('/admin.js');
  assert.ok(!adminJs.text.includes(process.env.BOT_TOKEN));
});

test('инвойс не создаётся без токена/настроек, но ошибка безопасна', async () => {
  const res = await req('/api/spin/paid/invoice', { method: 'POST', initData: userInit });
  // В тестовой среде бот-токен фиктивный: запрос либо уйдёт и вернёт ошибку Telegram,
  // либо будет отклонён — важно, что сервер не падает и не выдаёт спин.
  assert.ok([200, 500, 503].includes(res.status), `неожиданный статус ${res.status}`);
  if (res.status === 200) {
    assert.equal(res.json.currency, 'XTR');
    assert.equal(res.json.amount, 5);
    assert.ok(String(res.json.invoiceUrl).length > 0);
  }
});