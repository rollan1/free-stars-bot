const tg = window.Telegram?.WebApp ?? null;

if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.('#14110c');
  tg.setBackgroundColor?.('#0a0907');
}

/** Порядок секторов колеса. Стрелка справа (3 часа). */
const WHEEL_ORDER = ['cake', 'bear', 'heart', 'none'];
const POINTER_ANGLE = 90;
/** Чередующиеся акценты: чёрные сектора и золотые градиентные. */
const SECTOR_ACCENT = { cake: false, bear: true, heart: false, none: true };

const state = {
  cfg: null,
  spin: null,
  history: null,
  rotation: 0,
  spinning: false,
  clockOffsetMs: 0,
  countdownTimer: null,
  countdownEnd: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  loader: $('loader'),
  errorBox: $('error-box'),
  errorText: $('error-text'),
  content: $('content'),
  wheel: $('wheel'),
  chanceBadge: $('chance-badge'),
  bonusLabel: $('bonus-label'),
  btnBonus: $('btn-paid'),
  btnMain: $('btn-main'),
  btnSecondary: $('btn-secondary'),
  seriesTrack: $('series-track'),
  seriesInfo: $('series-info'),
  giftsTrack: $('gifts-track'),
  giftsNext: $('gifts-next'),
  timerText: $('timer-text'),
  oddsLine: $('odds-line'),
  rules: $('rules-list'),
  footerOwner: $('footer-owner'),
  historyBadge: $('history-badge'),
  btnHistory: $('btn-history'),
  btnRules: $('btn-rules'),
  modalResult: $('modal-result'),
  modalHistory: $('modal-history'),
  modalRules: $('modal-rules'),
  historyList: $('history-list'),
  toast: $('toast'),
};

/* ------------------------------------------------------------------ utils */

function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('is-error', isError);
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    els.toast.hidden = true;
  }, 3600);
}

function haptic(type = 'light') {
  try {
    tg?.HapticFeedback?.impactOccurred(type);
  } catch {
    /* недоступно */
  }
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function formatPercent(value) {
  return String(Math.round((Number(value) || 0) * 1000) / 1000).replace('.', ',');
}

/**
 * Telegram подставляет initData в WebView не мгновенно: на первом кадре
 * поле может быть ещё пустым. Ждём данные, иначе сервер получает пустой
 * запрос и отвечает 401. Это и была причина надписи «Не удалось войти».
 */
async function waitForInitData(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (tg?.initData && tg.initData.length > 20) return tg.initData;
    await new Promise((r) => setTimeout(r, 100));
  }
  return tg?.initData ?? '';
}

function currentInitData() {
  return tg?.initData ?? '';
}

const REQUEST_TIMEOUT_MS = 12000;
const REQUEST_RETRIES = 2;

async function fetchWithTimeout(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function api(path, { method = 'GET', body = null, retryAuth = false } = {}) {
  const payload = body ? JSON.stringify(body) : undefined;
  let lastErr = null;
  const authRetries = retryAuth ? 3 : 0;
  let authAttempt = 0;

  for (let attempt = 0; attempt <= REQUEST_RETRIES + authRetries; attempt += 1) {
    const headers = {};
    const initData = currentInitData();
    if (initData) headers['x-telegram-init-data'] = initData;
    if (body) headers['content-type'] = 'application/json';

    try {
      const res = await fetchWithTimeout(path, { method, headers, body: payload });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        const err = new Error(data?.message || data?.error || `Ошибка ${res.status}`);
        err.code = data?.error;
        err.status = res.status;
        err.fatal = res.status < 500 && res.status !== 429;
        if (err.status === 401 && authAttempt < authRetries) {
          // Данные Telegram ещё не подставились — подождём и повторим.
          authAttempt += 1;
          await waitForInitData(3000);
          continue;
        }
        throw err;
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt >= REQUEST_RETRIES + authRetries) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error('Сеть недоступна');
}

/* ------------------------------------------------------------------ wheel */

function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function sectorPath(startDeg, endDeg, r) {
  const [x0, y0] = polar(160, 160, r, startDeg);
  const [x1, y1] = polar(160, 160, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M160 160 L${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const SHORT_NAMES = { cake: 'Торт', bear: 'Мишка', heart: 'Сердце', none: 'Ничего' };

function sectorMeta(key) {
  if (key === 'none') return { title: 'Ничего', short: 'Ничего', image: null, emoji: '🍃' };
  const gift = state.cfg.gifts[key];
  return { title: gift.title, short: SHORT_NAMES[key] ?? gift.title, image: gift.image, emoji: gift.emoji };
}

function renderWheel() {
  const R = 152;
  els.wheel.replaceChildren();

  const defs = svgEl('defs');
  const black = svgEl('linearGradient', { id: 'g-black', x1: '0', y1: '0', x2: '0.3', y2: '1' });
  black.append(svgEl('stop', { offset: '0%', 'stop-color': '#2b271d' }));
  black.append(svgEl('stop', { offset: '100%', 'stop-color': '#12100b' }));
  const accent = svgEl('linearGradient', { id: 'g-accent', x1: '0', y1: '0', x2: '0.3', y2: '1' });
  accent.append(svgEl('stop', { offset: '0%', 'stop-color': '#fff6da' }));
  accent.append(svgEl('stop', { offset: '52%', 'stop-color': '#e7c860' }));
  accent.append(svgEl('stop', { offset: '100%', 'stop-color': '#a8842a' }));
  defs.append(black, accent);
  els.wheel.appendChild(defs);

  const rotor = svgEl('g', { id: 'wheel-rotor' });
  rotor.style.transform = `rotate(${state.rotation}deg)`;

  WHEEL_ORDER.forEach((key, index) => {
    const start = index * 90;
    const center = start + 45;
    const meta = sectorMeta(key);
    const isAccent = SECTOR_ACCENT[key];

    rotor.appendChild(
      svgEl('path', { d: sectorPath(start, start + 90, R), fill: isAccent ? 'url(#g-accent)' : 'url(#g-black)' }),
    );

    const [ix, iy] = polar(160, 160, 112, center);

    if (meta.image) {
      rotor.appendChild(
        svgEl('image', {
          href: meta.image,
          x: ix - 26,
          y: iy - 26,
          width: 52,
          height: 52,
          preserveAspectRatio: 'xMidYMid meet',
        }),
      );
    } else {
      const g = svgEl('g', { transform: `translate(${ix.toFixed(2)} ${iy.toFixed(2)})` });
      const emoji = svgEl('text', { class: 'seg-emoji', y: 13 });
      emoji.textContent = meta.emoji;
      g.appendChild(emoji);
      rotor.appendChild(g);
    }

    // Тёмная пилюля с золотой обводкой — читается и на золотом, и на чёрном секторе.
    const label = meta.short;
    const pillW = Math.round(label.length * 6.6) + 20;
    const [lx, ly] = polar(160, 160, 52, center);
    const g = svgEl('g', { transform: `translate(${lx.toFixed(2)} ${ly.toFixed(2)})` });
    g.appendChild(
      svgEl('rect', {
        x: -pillW / 2,
        y: -12,
        width: pillW,
        height: 24,
        rx: 12,
        fill: 'rgba(16,14,10,.94)',
        stroke: 'rgba(212,175,55,.55)',
        'stroke-width': 1,
      }),
    );
    const title = svgEl('text', { class: 'seg-label', y: 0.5, fill: '#f7e3a1' });
    title.textContent = label;
    g.appendChild(title);
    rotor.appendChild(g);
  });

  // Золотая окантовка и тонкие спицы между секторами.
  rotor.appendChild(
    svgEl('g', {
      stroke: 'rgba(212,175,55,.75)',
      'stroke-width': 2,
      fill: 'none',
    }),
  );
  for (let i = 0; i < 4; i += 1) {
    const [sx, sy] = polar(160, 160, 44, i * 90);
    const [ex, ey] = polar(160, 160, R, i * 90);
    const spoke = svgEl('line', { x1: sx, y1: sy, x2: ex, y2: ey });
    rotor.lastChild.appendChild(spoke);
  }
  rotor.appendChild(svgEl('circle', { cx: 160, cy: 160, r: R, fill: 'none', stroke: '#d4af37', 'stroke-width': 8 }));
  rotor.appendChild(svgEl('circle', { cx: 160, cy: 160, r: R + 6, fill: 'none', stroke: 'rgba(247,227,161,.35)', 'stroke-width': 2 }));
  els.wheel.appendChild(rotor);
}

/* ------------------------------------------------------------------ odds */

function prizeChance() {
  const p = state.cfg.probabilities;
  return (Number(p.cake) || 0) + (Number(p.bear) || 0) + (Number(p.heart) || 0);
}

function renderOdds() {
  els.oddsLine.replaceChildren();
  for (const key of WHEEL_ORDER) {
    const meta = sectorMeta(key);
    const li = document.createElement('li');

    if (meta.image) {
      const img = document.createElement('img');
      img.src = meta.image;
      img.alt = meta.title;
      li.appendChild(img);
    } else {
      const box = document.createElement('span');
      box.className = 'ol-empty';
      box.textContent = meta.emoji;
      li.appendChild(box);
    }

    const name = document.createElement('span');
    name.textContent = meta.short;
    const pct = document.createElement('b');
    pct.textContent = `${formatPercent(state.cfg.probabilities[key])}%`;
    li.append(name, pct);
    els.oddsLine.appendChild(li);
  }
}

/* ------------------------------------------------------------------ series */

function renderSeries() {
  const streak = state.spin.streak;
  const total = streak.total;
  const day = Math.min(streak.day, total);

  els.seriesInfo.textContent = `День ${day} из ${total}`;
  els.seriesTrack.replaceChildren();

  const bonusEvery = state.spin.bonusEvery ?? 0;
  for (let i = 1; i <= total; i += 1) {
    const pill = document.createElement('div');
    pill.className = 'series-pill';
    if (i === day) pill.classList.add('is-current');
    if (i === total) pill.classList.add('is-guarantee');

    pill.append(document.createTextNode(`${i} ${i === 1 ? 'день' : pluralDays(i)}`));

    if (bonusEvery > 0 && i > 1 && i % bonusEvery === 0 && i < total) {
      const b = document.createElement('span');
      b.className = 'series-bonus';
      b.textContent = '+1 спин';
      b.title = 'Дополнительный бесплатный спин';
      pill.appendChild(b);
    }

    if (i === day && streak.giftWonInSeries) {
      const plus = document.createElement('span');
      plus.className = 'series-plus';
      plus.textContent = '+1';
      pill.appendChild(plus);
    }
    if (i === total) {
      const sub = document.createElement('span');
      sub.className = 'series-sub';
      sub.textContent = 'гарантия';
      pill.appendChild(sub);
    }
    els.seriesTrack.appendChild(pill);
  }

  const current = els.seriesTrack.querySelector('.is-current');
  if (current) current.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function pluralDays(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

/* ------------------------------------------------------------------ gifts strip */

function renderGifts() {
  const tiles = [];
  for (const key of WHEEL_ORDER) {
    const meta = sectorMeta(key);
    tiles.push({ image: meta.image, emoji: meta.emoji, title: meta.title });
  }
  // Показываем последние выигрыши, чтобы ряд не выглядел пустым.
  for (const item of state.history?.items?.slice(0, 8) ?? []) {
    tiles.push({ image: item.gift.image, emoji: null, title: `${item.gift.title} ${item.code}` });
  }

  els.giftsTrack.replaceChildren();
  for (const tile of tiles) {
    const node = document.createElement('div');
    node.className = 'gift-tile';
    node.title = tile.title;
    if (tile.image) {
      const img = document.createElement('img');
      img.src = tile.image;
      img.alt = tile.title;
      node.appendChild(img);
    } else {
      node.textContent = tile.emoji;
    }
    els.giftsTrack.appendChild(node);
  }
  els.giftsTrack.scrollLeft = 0;
  updateGiftsArrow();
}

function updateGiftsArrow() {
  const track = els.giftsTrack;
  const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
  els.giftsNext.disabled = atEnd;
}

els.giftsNext.addEventListener('click', () => {
  els.giftsTrack.scrollBy({ left: els.giftsTrack.clientWidth * 0.8, behavior: 'smooth' });
});
els.giftsTrack.addEventListener('scroll', updateGiftsArrow);

/* ------------------------------------------------------------------ status */

function renderStatus() {
  const spin = state.spin;
  const cfg = state.cfg;

  els.chanceBadge.textContent = `Шанс ${formatPercent(prizeChance())}%`;
  const bonusSpins = spin.bonusSpins ?? 0;
  const dailyAvailable = spin.dailyAvailable !== false;

  els.chanceBadge.textContent = `Шанс ${formatPercent(prizeChance())}%`;
  els.bonusLabel.textContent = bonusSpins > 0 ? `Бонус ${bonusSpins}` : '+1 спин';

  // Кнопка за Stars появляется только после ежедневного бесплатного спина.
  const paidVisible = !dailyAvailable && cfg.paidSpinsEnabled;
  els.btnBonus.hidden = !paidVisible;
  els.btnBonus.disabled = !paidVisible || state.spinning;

  const freeAvailable = spin.available && cfg.spinsEnabled;

  els.btnMain.disabled = state.spinning || (!freeAvailable && !paidVisible);
  if (freeAvailable && bonusSpins > 0) {
    els.btnMain.textContent = `Крутить ещё · осталось ${bonusSpins}`;
    els.btnMain.classList.add('is-free');
    els.btnSecondary.textContent = 'Мои выигрыши';
    els.btnSecondary.disabled = state.spinning;
    els.btnSecondary.dataset.action = 'history';
  } else if (freeAvailable) {
    els.btnMain.textContent = 'Крутить бесплатно';
    els.btnMain.classList.add('is-free');
    els.btnSecondary.textContent = 'Мои выигрыши';
    els.btnSecondary.disabled = state.spinning;
    els.btnSecondary.dataset.action = 'history';
  } else if (!cfg.spinsEnabled) {
    els.btnMain.textContent = 'Вращения приостановлены';
    els.btnMain.classList.remove('is-free');
    els.btnSecondary.textContent = 'Мои выигрыши';
    els.btnSecondary.dataset.action = 'history';
  } else {
    els.btnMain.textContent = `Крутить сейчас за ${cfg.spinPriceStars} ⭐`;
    els.btnMain.classList.remove('is-free');
    els.btnSecondary.textContent = 'Мои выигрыши';
    els.btnSecondary.disabled = state.spinning;
    els.btnSecondary.dataset.action = 'history';
  }

  if (spin.nextFreeSpinAt && !spin.dailyAvailable) {
    state.countdownEnd = Date.parse(spin.nextFreeSpinAt) - state.clockOffsetMs;
    if (Number.isFinite(state.countdownEnd)) {
      startCountdown();
    } else {
      stopCountdown();
      els.timerText.textContent = 'До бесплатного прокрута: —';
    }
  } else if (freeAvailable) {
    stopCountdown();
    els.timerText.innerHTML = 'Бесплатный прокрут <b>доступен</b>';
  } else {
    stopCountdown();
    els.timerText.textContent = 'До бесплатного прокрута: —';
  }
}

function serverNowMs() {
  return Date.now() + state.clockOffsetMs;
}

function updateCountdown() {
  if (!state.countdownEnd) return;
  const left = Math.max(0, state.countdownEnd - serverNowMs());
  const h = Math.floor(left / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  const s = Math.floor((left % 60000) / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  els.timerText.innerHTML = `До бесплатного прокрута: <b>${h}ч ${pad(m)}м ${pad(s)}с</b>`;
  if (left <= 0) {
    stopCountdown();
    els.timerText.textContent = 'Бесплатный прокрут доступен!';
    refreshSession().catch(() => {});
  }
}

function startCountdown() {
  if (state.countdownTimer) return;
  updateCountdown();
  state.countdownTimer = setInterval(updateCountdown, 1000);
}

function stopCountdown() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  state.countdownEnd = null;
}

/* ------------------------------------------------------------------ rules / history */

function renderRules() {
  const cfg = state.cfg;
  const p = cfg.probabilities;
  const streak = state.spin.streak;
  const items = [
    `Один <b>бесплатный прокрут в сутки</b> по времени сервера. Дополнительный спин — <b>${cfg.spinPriceStars} ⭐ Telegram Stars</b>.`,
    `Шансы: 🎂 ${formatPercent(p.cake)}%, 🧸 ${formatPercent(p.bear)}%, ❤️ ${formatPercent(p.heart)}%, ничего ${formatPercent(p.none)}%.`,
    'Результат определяет сервер до старта анимации — подменить его в браузере нельзя.',
    'Платный спин <b>не</b> тратит ежедневную попытку и <b>не</b> двигает серию.',
    `Серия растёт на 1 день за каждый бесплатный спин подряд. Пропустили хотя бы <b>1 день</b> — серия сбрасывается на <b>1 день</b> с начала, и прогресс до гарантии теряется.`,
    `При ежедневных спинах на <b>${cfg.guaranteeDays}-й день</b> серии выдаётся гарантированный подарок, если в этой серии подарок ещё не выпадал.`,
    'Гарантия даётся <b>один раз за серию</b>.',
    cfg.seriesBonusEvery > 0
      ? `За серию вы получаете дополнительные спины: на <b>${cfg.seriesBonusEvery}-й</b>, ${cfg.seriesBonusEvery * 2}-й, ${cfg.seriesBonusEvery * 3}-й день и так далее (кроме последнего дня серии).`
      : '',
    'Подарок выдаёт владелец вручную. Статус «Выдан» подтверждает только человек после реальной выдачи.',
    'Пустой результат не считается выигрышем и не попадает в историю.',
  ];
  if (streak.day > 1) {
    items.unshift(
      `<b>Ваша серия: ${streak.day} ${streak.day === 1 ? 'день' : pluralDays(streak.day)}.</b> Чтобы не потерять прогресс, крутите каждый день.`,
    );
  }
  els.rules.replaceChildren(
    ...items
      .filter(Boolean)
      .map((html) => {
        const li = document.createElement('li');
        li.innerHTML = html;
        return li;
      }),
  );
}

function renderHistoryBadge() {
  const pending = state.history?.pending ?? 0;
  els.historyBadge.textContent = pending;
  els.historyBadge.hidden = pending === 0;
}

function renderHistory() {
  const h = state.history;
  els.historyList.replaceChildren();
  if (!h || !h.items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent = 'Пока нет выигрышей. Подарки выпадают с шансом 1%, 3% и 3%.';
    els.historyList.appendChild(empty);
    return;
  }
  for (const item of h.items) {
    const row = document.createElement('div');
    row.className = 'history-item';

    const img = document.createElement('img');
    img.src = item.gift.image;
    img.alt = item.gift.title;
    row.appendChild(img);

    const body = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'hi-name';
    name.textContent = item.gift.title;
    const code = document.createElement('div');
    code.className = 'hi-code';
    code.textContent = item.code;
    const meta = document.createElement('div');
    meta.className = 'hi-meta';
    meta.textContent = `${item.kindLabel} · ${formatDateTime(item.createdAt)}${
      item.status === 'cancelled' && item.cancelReason ? ` · ${item.cancelReason}` : ''
    }`;
    body.append(name, code, meta);
    row.appendChild(body);

    const status = document.createElement('span');
    status.className = `hi-status ${item.status}`;
    status.textContent = item.statusLabel;
    row.appendChild(status);

    els.historyList.appendChild(row);
  }
}

/* ------------------------------------------------------------------ result */

function confetti(host) {
  host.replaceChildren();
  const colors = ['#f7e3a1', '#d4af37', '#fff8e2', '#e0324b', '#4fd39a'];
  for (let i = 0; i < 26; i += 1) {
    const bit = document.createElement('i');
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colors[i % colors.length];
    bit.style.animationDuration = `${1.6 + Math.random() * 1.2}s`;
    bit.style.animationDelay = `${Math.random() * 0.4}s`;
    host.appendChild(bit);
  }
}

function showResult(result) {
  const kicker = $('result-kicker');
  const title = $('result-title');
  const imageBox = $('result-gift-image');
  const text = $('result-text');
  const meta = $('result-meta');

  imageBox.classList.remove('is-empty');
  imageBox.replaceChildren();
  meta.hidden = true;
  meta.replaceChildren();

  if (result.win) {
    kicker.textContent = result.kind === 'guarantee' ? 'Гарантия 31-го дня' : 'Выигрыш подтверждён';
    title.textContent = 'Вы выиграли!';
    const img = document.createElement('img');
    img.src = result.win.gift.image;
    img.alt = result.win.gift.title;
    imageBox.appendChild(img);
    text.textContent = 'Чтобы получить подарок, напишите владельцу Free Stars и отправьте номер выигрыша.';
    confetti($('result-confetti'));

    const rows = [
      ['Подарок', `${result.win.gift.emoji} ${result.win.gift.title}`, false],
      ['Номер выигрыша', result.win.code, false],
      ['Дата и время', formatDateTime(result.win.createdAt), false],
      ['Статус', 'Ожидает выдачи', true],
      ['Тип спина', result.kind === 'paid' ? 'платный' : result.kind === 'guarantee' ? 'гарантированный' : 'обычный', true],
    ];
    for (const [label, value, full] of rows) {
      const cell = document.createElement('div');
      if (full) cell.className = 'full';
      const span = document.createElement('span');
      span.textContent = label;
      const strong = document.createElement('strong');
      strong.textContent = value;
      cell.append(span, strong);
      meta.appendChild(cell);
    }
    meta.hidden = false;
    haptic('medium');
  } else {
    kicker.textContent = result.kind === 'paid' ? 'Платный спин' : 'Бесплатный прокрут';
    title.textContent = 'Без подарка';
    imageBox.classList.add('is-empty');
    const span = document.createElement('span');
    span.textContent = '🍃';
    imageBox.appendChild(span);
    text.textContent = 'В этот раз без подарка. Попробуй снова завтра!';
    $('result-confetti').replaceChildren();
    haptic('light');
  }

  if (result.bonusGranted) {
    text.textContent += ' Вам начислен дополнительный спин — крутите ещё!';
  }

  const link = $('result-owner-link');
  link.href = state.cfg.ownerUrl;
  link.textContent = `Написать владельцу @${state.cfg.ownerUsername}`;
  els.modalResult.hidden = false;
}

/* ------------------------------------------------------------------ spins */

function spinTo(outcomeKey) {
  const index = WHEEL_ORDER.indexOf(outcomeKey);
  const sectorCenter = index * 90 + 45;
  const turns = 5 + Math.floor(Math.random() * 2);
  const target = (POINTER_ANGLE - sectorCenter + 360) % 360;

  const rotor = document.getElementById('wheel-rotor');
  state.spinning = true;
  rotor.classList.add('spinning');

  const current = ((state.rotation % 360) + 360) % 360;
  const delta = (((target - current) % 360) + 360) % 360;
  state.rotation = state.rotation + delta + 360 * (turns - 1);
  rotor.style.transform = `rotate(${state.rotation}deg)`;

  return new Promise((resolve) => {
    const done = () => {
      rotor.classList.remove('spinning');
      rotor.removeEventListener('transitionend', done);
      state.spinning = false;
      resolve();
    };
    rotor.addEventListener('transitionend', done);
    setTimeout(done, 5600);
  });
}

async function refreshSession() {
  const data = await api('/api/session', { method: 'POST', retryAuth: true });
  state.cfg = data;
  state.spin = data.spin;
  state.history = data.history;
  state.clockOffsetMs = Date.parse(data.serverTime) - Date.now();
  renderWheel();
  renderOdds();
  renderGifts();
  renderSeries();
  renderStatus();
  renderRules();
  renderHistoryBadge();
  renderHistory();
  els.footerOwner.innerHTML = `<a href="${data.ownerUrl}" target="_blank" rel="noopener">@${data.ownerUsername}</a> выдаёт подарки`;
}

async function doFreeSpin() {
  if (state.spinning) return;
  state.spinning = true;
  renderStatus();
  try {
    const result = await api('/api/spin/free', { method: 'POST' });
    await spinTo(result.outcome);
    showResult(result);
    await refreshSession();
  } catch (err) {
    toast(err.message || 'Не удалось выполнить прокрут', true);
    await refreshSession().catch(() => {});
  } finally {
    state.spinning = false;
    renderStatus();
  }
}

async function doPaidSpin() {
  if (state.spinning) return;
  state.spinning = true;
  renderStatus();
  let payload = null;
  try {
    const invoice = await api('/api/spin/paid/invoice', { method: 'POST' });
    payload = invoice.payload;
    let paidViaCallback = false;

    openInvoice(invoice.invoiceUrl, async (status) => {
      if (status === 'paid') {
        paidViaCallback = true;
        await api('/api/spin/paid/reconcile', { method: 'POST', body: { payload } }).catch(() => {});
        await refreshSession();
        if (state.spin.available) {
          state.spinning = false;
          await doFreeSpin();
        } else {
          toast('⭐ Оплата принята — спин уже выдан');
        }
      }
    });

    const result = await waitForPaidSpin(payload);
    if (result?.spin) {
      await spinTo(result.spin.outcome);
      showResult(result.spin);
      await refreshSession();
    } else if (!paidViaCallback) {
      await refreshSession();
      if (state.spin.available && (state.spin.bonusSpins > 0 || state.spin.dailyAvailable)) {
        toast('⭐ Спин успешно выдан!');
      } else {
        toast('Платёж обрабатывается Telegram. Спин появится через пару секунд.');
      }
    }
  } catch (err) {
    toast(err.message || 'Платёж не выполнен', true);
  } finally {
    state.spinning = false;
    renderStatus();
  }
}

function openInvoice(url, onInvoiceClosed = null) {
  try {
    if (typeof tg?.openInvoice === 'function') {
      tg.openInvoice(url, (status) => {
        if (typeof onInvoiceClosed === 'function') onInvoiceClosed(status);
      });
      return;
    }
    if (tg?.openLink) {
      tg.openLink(url, { try_instant_view: false });
      return;
    }
  } catch {
    /* fallback */
  }
  window.open(url, '_blank', 'noopener');
}

function waitForPaidSpin(payload) {
  return new Promise((resolve) => {
    let closed = false;
    let attempts = 0;
    let lastReconcile = 0;

    const onClosed = () => {
      closed = true;
    };
    tg?.onEvent?.('invoice_closed', onClosed);

    const finish = (value) => {
      clearInterval(timer);
      try {
        tg?.offEvent?.('invoice_closed', onClosed);
      } catch {
        /* игнорируем */
      }
      resolve(value);
    };

    const timer = setInterval(async () => {
      attempts += 1;
      try {
        if (attempts * 2000 - lastReconcile > 6000) {
          lastReconcile = attempts * 2000;
          await api('/api/spin/paid/reconcile', { method: 'POST', body: { payload } }).catch(() => {});
        }
        const data = await api(`/api/spin/paid/result?payload=${encodeURIComponent(payload)}`);
        const payment = data?.payment || data;
        if (payment && (payment.consumed || payment.status === 'paid')) return finish(data);
        if (payment?.status === 'failed' || payment?.status === 'refunded') {
          toast(payment.failureReason || 'Спин не выдан, оплата возвращена.', true);
          return finish(null);
        }
        if (closed && attempts > 5) return finish(null);
        if (attempts > 30) return finish(null);
      } catch {
        if (attempts > 30) return finish(null);
      }
      return undefined;
    }, 2000);
  });
}

/* ------------------------------------------------------------------ events */

els.btnMain.addEventListener('click', () => {
  if (state.spin.available && state.cfg.spinsEnabled) doFreeSpin();
  else doPaidSpin();
});

els.btnBonus.addEventListener('click', doPaidSpin);

els.btnSecondary.addEventListener('click', () => {
  if (els.btnSecondary.dataset.action === 'paid') doPaidSpin();
  else openHistory();
});

els.btnRules.addEventListener('click', () => {
  els.modalRules.hidden = false;
});

async function openHistory() {
  try {
    const data = await api('/api/history?limit=50');
    state.history = data;
    renderHistory();
    renderHistoryBadge();
    els.modalHistory.hidden = false;
  } catch (err) {
    toast(err.message || 'Не удалось загрузить историю', true);
  }
}
els.btnHistory.addEventListener('click', openHistory);
$('result-close').addEventListener('click', () => {
  els.modalResult.hidden = true;
});

for (const modal of [els.modalResult, els.modalHistory, els.modalRules]) {
  modal.querySelectorAll('[data-close]').forEach((node) => {
    node.addEventListener('click', () => {
      modal.hidden = true;
    });
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.cfg) refreshSession().catch(() => {});
});

/* ------------------------------------------------------------------ boot */

(async function boot() {
  const initData = await waitForInitData();
  if (!initData || initData.length <= 20) {
    els.loader.hidden = true;
    els.errorBox.hidden = false;
    els.errorText.textContent =
      'Откройте Free Stars через кнопку в боте @FreeStarsverygoodbot — приложение работает только внутри Telegram.';
    return;
  }
  try {
    await refreshSession();
    els.loader.hidden = true;
    els.content.hidden = false;
  } catch (err) {
    els.loader.hidden = true;
    els.errorBox.hidden = false;
    els.errorText.textContent =
      err.status === 401 || err.status === 403
        ? `Не удалось подтвердить вход: ${err.message}. Закройте и снова откройте приложение.`
        : `${err.message}. Проверьте соединение и откройте приложение ещё раз.`;
    setTimeout(() => {
      els.errorBox.hidden = true;
      els.loader.hidden = false;
      refreshSession()
        .then(() => {
          els.loader.hidden = true;
          els.content.hidden = false;
        })
        .catch(() => {});
    }, 6000);
  }
})();