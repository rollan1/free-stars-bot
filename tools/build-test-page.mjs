/**
 * Собирает тестовую страницу Mini App с эмуляцией Telegram WebApp,
 * чтобы проверить клиент в браузере без реального Telegram.
 *
 * Запуск: node tools/build-test-page.mjs [owner|user]
 * Результат: public/_test.html (удаляется после проверки)
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const mode = process.argv[2] ?? 'owner';
const lateInit = process.argv.includes('--late-init');
const env = Object.fromEntries(
  fs
    .readFileSync('./.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const user =
  mode === 'owner'
    ? { id: Number(env.OWNER_TELEGRAM_IDS), username: env.OWNER_USERNAME, first_name: 'Owner' }
    : { id: 999000111, username: 'testuser', first_name: 'Тест' };

const p = {
  user: JSON.stringify(user),
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: 'AAHdF6IQ',
};
const dcs = Object.keys(p)
  .sort()
  .map((k) => `${k}=${p[k]}`)
  .join('\n');
const secret = crypto.createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
const initData = `${Object.keys(p)
  .sort()
  .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(p[k])}`)
  .join('&')}&hash=${hash}`;

let html = fs.readFileSync('./public/index.html', 'utf8');
// В тестовой странице настоящий SDK не нужен: initData у telegram-web-app.js
// объявлен как непереопределяемый, поэтому подменяем весь скрипт собственной заглушкой.
html = html.replace(/<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js[^"]*"><\/script>\s*/, '');

const stub = `<script>
window.__ERRORS__ = [];
window.addEventListener('error', (e) => window.__ERRORS__.push('error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => window.__ERRORS__.push('reject: ' + String(e.reason)));
window.Telegram = { WebApp: {
  initData: ${JSON.stringify(lateInit ? '' : initData)},
  initDataUnsafe: ${JSON.stringify(lateInit ? null : JSON.parse(p.user))},
  ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {},
  enableClosingConfirmation() {}, disableVerticalSwipes() {},
  onEvent() {}, offEvent() {}, openLink(url) { window.__OPENED__ = url; },
  HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
  colorScheme: 'dark', themeParams: {}, platform: 'android', version: '7.0',
}};
${lateInit ? `// Telegram подставляет данные не сразу — эмулируем задержку в 1.5 с.
setTimeout(function () {
  window.Telegram.WebApp.initData = ${JSON.stringify(initData)};
  window.Telegram.WebApp.initDataUnsafe = ${JSON.stringify(JSON.parse(p.user))};
}, 1500);` : ''}
</script>
`;

const diag = `<div id="diag" style="position:fixed;left:0;bottom:0;z-index:9999;background:#000;color:#0f0;font:11px monospace;padding:4px;width:100%;overflow:hidden;white-space:nowrap">x</div>
<script>
setTimeout(function () {
  var svg = document.getElementById('wheel');
  var img = document.querySelectorAll('img');
  var broken = 0;
  img.forEach(function (i) { if (i.complete && i.naturalWidth === 0) broken += 1; });
  document.getElementById('diag').textContent = JSON.stringify({
    errors: window.__ERRORS__,
    contentShown: !document.getElementById('content').hidden,
    loaderHidden: document.getElementById('loader').hidden,
    sectors: svg ? svg.querySelectorAll('path').length : 0,
    svgImages: svg ? svg.querySelectorAll('image').length : 0,
    seriesPills: document.querySelectorAll('.series-pill').length,
    currentPill: document.querySelectorAll('.series-pill.is-current').length,
    giftTiles: document.querySelectorAll('.gift-tile').length,
    oddsCells: document.querySelectorAll('.odds-cell').length,
    chance: (document.getElementById('chance-badge') || {}).textContent,
    mainBtn: (document.getElementById('btn-main') || {}).textContent,
    timer: (document.getElementById('timer-text') || {}).textContent,
    totalImages: img.length,
    brokenImages: broken,
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: Array.from(document.querySelectorAll('*')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1);
    }).slice(0, 6).map((el) => el.tagName + '.' + (el.className || '') + ':' + Math.round(el.getBoundingClientRect().right))
  });
}, 3000);
</script>`;

html = html.replace('<script src="/app.js" type="module"></script>', `${stub}<script src="/app.js" type="module"></script>`);
html = html.replace('</body>', `${diag}</body>`);
fs.writeFileSync('./public/_test.html', html);
console.log(`public/_test.html готов (режим: ${mode}, id=${user.id})`);