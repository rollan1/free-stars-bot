const tg = window.Telegram?.WebApp ?? null;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.('#14110c');
  tg.setBackgroundColor?.('#0a0907');
}

const $ = (id) => document.getElementById(id);
const state = { tab: 'stats', winsPage: 1, usersPage: 1, range: {} };
let forecastData = null;

async function waitForInitData(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (tg?.initData && tg.initData.length > 20) return tg.initData;
    await new Promise((r) => setTimeout(r, 100));
  }
  return tg?.initData ?? '';
}

async function api(path, { method = 'GET', body = null, retryAuth = false } = {}) {
  const payload = body ? JSON.stringify(body) : undefined;
  let lastErr = null;
  const authRetries = retryAuth ? 3 : 0;
  let authAttempt = 0;

  for (let attempt = 0; attempt <= 2 + authRetries; attempt += 1) {
    const headers = {};
    const initData = tg?.initData ?? '';
    if (initData) headers['x-telegram-init-data'] = initData;
    if (body) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(path, { method, headers, body: payload, signal: controller.signal });
      clearTimeout(timer);
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        const err = new Error(data?.message || data?.error || `Ошибка ${res.status}`);
        err.status = res.status;
        err.fatal = res.status < 500 && res.status !== 429;
        if (err.status === 401 && authAttempt < authRetries) {
          authAttempt += 1;
          await waitForInitData(3000);
          continue;
        }
        throw err;
      }
      return data;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err.fatal || attempt >= 2 + authRetries) throw err;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error('Сеть недоступна');
}

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU');
}
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function stars(n) {
  return `${Number(n || 0).toLocaleString('ru-RU')} ⭐`;
}
function query(extra = {}) {
  const params = new URLSearchParams({ ...state.range, ...extra });
  const s = params.toString();
  return s ? `?${s}` : '';
}

function stat(key, value, sub = '', tone = '') {
  return `<div class="stat"><div class="k">${esc(key)}</div><div class="v ${tone}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function table(headers, rows) {
  if (!rows.length) return '<p class="muted">Нет данных.</p>';
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

/* ------------------------------------------------------------------ tabs */

function activateTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
  loadTab(name);
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

/* ------------------------------------------------------------------ stats */

async function loadStats() {
  const d = await api(`/api/admin/stats${query()}`);
  $('stats-root').innerHTML = [
    stat('Всего пользователей', d.users.total, `+${d.users.newInRange} за период`),
    stat('Активны за 24 часа', d.users.active24h, `${d.users.active7d} за 7 дней`),
    stat('Всего спинов', d.spins.total, `${d.spins.won} с подарком`),
    stat('Бесплатных спинов', d.spins.free),
    stat('Платных спинов', d.spins.paid),
    stat('Гарантированных', d.spins.guarantee, 'подарок по 31-му дню'),
    stat('Пустых результатов', d.spins.empty, `выигрышей: ${d.spins.won}`),
    stat('🧸 Мишек выиграно', d.gifts.won.bear),
    stat('❤️ Сердец выиграно', d.gifts.won.heart),
    stat('🎂 Тортов выиграно', d.gifts.won.cake),
    stat('Ожидают выдачи', d.gifts.pending, '', 'gold'),
    stat('Выдано', d.gifts.delivered, '', 'ok'),
    stat('Отменено', d.gifts.cancelled, '', 'bad'),
    stat('Получено Stars', stars(d.payments.starsReceived), `${d.payments.paidCount} платных спинов`, 'gold'),
    stat('Возвращено Stars', stars(d.payments.starsRefunded), `${d.payments.refundedCount} возвратов`, d.payments.starsRefunded ? 'bad' : ''),
    stat('Неуспешных платежей', d.payments.failedCount, '', d.payments.failedCount ? 'bad' : ''),
    stat('Ожидают оплаты', d.payments.awaitingCount, '', d.payments.awaitingCount ? '' : ''),
  ].join('');
}

/* ------------------------------------------------------------------ users */

let currentUserId = null;

async function loadUsers() {
  const q = $('users-q').value.trim();
  const d = await api(`/api/admin/users?page=${state.usersPage}&perPage=25&q=${encodeURIComponent(q)}`);
  const rows = d.items.map((u) => `
    <tr>
      <td><b>${u.id}</b>${u.isOwner ? ' <span class="tag paid">владелец</span>' : ''}</td>
      <td>${u.username ? `@${esc(u.username)}` : '—'}</td>
      <td>${esc(u.name ?? '—')}</td>
      <td>${u.streakCount} / ${31}</td>
      <td>${u.spinsTotal}</td>
      <td>${u.winsTotal} (в ожидании ${u.pendingWins})</td>
      <td>${u.blocked ? '<span class="tag cancelled">заблокирован</span>' : '<span class="tag delivered">активен</span>'}</td>
      <td>${fmtDateTime(u.lastSeenAt)}</td>
      <td><button class="btn btn-ghost btn-sm" data-open-user="${u.id}">Открыть</button></td>
    </tr>`);
  $('users-table').innerHTML = table(
    ['Telegram ID', 'Username', 'Имя', 'Серия', 'Спинов', 'Выигрышей', 'Статус', 'Активность', ''],
    rows,
  );
  $('users-page').textContent = `стр. ${d.page} · всего ${d.total}`;
  state.usersPage = d.page;
  document.querySelectorAll('[data-open-user]').forEach((btn) => {
    btn.addEventListener('click', () => openUser(btn.dataset.openUser));
  });
}

async function openUser(userId) {
  try {
    const d = await api(`/api/admin/users/${userId}`);
    currentUserId = userId;
    const u = d.user;
    $('user-card').hidden = false;
    $('user-card-title').textContent = `${u.id}${u.username ? ` · @${u.username}` : ''}`;
    $('user-streak-input').value = u.streak.day;
    $('user-notes').value = u.notes ?? '';
    $('user-card-stats').innerHTML = [
      stat('Серия', `${u.streak.day} / ${u.streak.guaranteeDays}`, u.streak.lastDay ?? '—'),
      stat('Спинов всего', u.totals.spins),
      stat('Выигрышей', u.totals.wins, `в ожидании: ${u.pendingWins}`),
      stat('Бесплатный спин', u.freeSpinDay ? 'использован' : 'доступен', u.freeSpinDay ?? '', u.freeSpinDay ? '' : 'ok'),
      stat('Бонусных спинов', u.bonusSpins ?? 0, u.bonusSpins ? 'нажмите «Крутить ещё»' : ''),
      stat('Статус', u.blocked ? 'Заблокирован' : 'Активен', '', u.blocked ? 'bad' : 'ok'),
      stat('Гарантия', u.guaranteeClaimed ? 'использована' : u.seriesGiftWon ? 'не выдастся (был выигрыш)' : 'доступна'),
    ].join('');
    $('user-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(err.message || 'Не удалось загрузить пользователя', true);
  }
}

async function userAction(action, extra = {}) {
  if (!currentUserId) {
    toast('Сначала откройте пользователя', true);
    return;
  }
  try {
    const res = await api(`/api/admin/users/${currentUserId}/${action}`, { method: 'POST', body: extra });
    let message = 'Готово';
    if (res.win) message = `Выигрыш ${res.win.code}: ${res.win.gift.title}`;
    else if (res.outcome) message = `Спин: ${res.outcome}`;
    toast(message);
    await openUser(currentUserId);
    await loadUsers();
  } catch (err) {
    toast(err.message || 'Ошибка', true);
  }
}

const USER_ACTIONS = {
  'spin-random': () => userAction('spin', { kind: 'free' }),
  'spin-bear': () => userAction('grant-win', { gift: 'bear' }),
  'spin-heart': () => userAction('grant-win', { gift: 'heart' }),
  'spin-cake': () => userAction('grant-win', { gift: 'cake' }),
  'spin-none': () => userAction('spin', { kind: 'free', outcome: 'none' }),
  'spin-guarantee': () => userAction('spin', { kind: 'guarantee' }),
  'grant-free': () => userAction('grant-free'),
  'bonus-set': () => userAction('bonus', { count: Number($('user-bonus-input').value), replace: true }),
  'streak-set': () => userAction('streak', { action: 'set', days: Number($('user-streak-input').value) }),
  'streak-plus': () => userAction('streak', { action: 'add', days: 1 }),
  'streak-reset': () => userAction('streak', { action: 'reset' }),
  'block-on': () => userAction('block', { blocked: true }),
  'block-off': () => userAction('block', { blocked: false }),
  notes: () => userAction('notes', { notes: $('user-notes').value }),
  'reset-all': () => openConfirm(
    'Полный сброс пользователя?',
    'Обнулятся спины, серия и гарантия. История выигрышей сохранится, ожидающие выдачи будут отменены.',
    () => userAction('reset'),
  ),
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-ua]');
  if (!btn) return;
  USER_ACTIONS[btn.dataset.ua]?.();
});

$('users-search').addEventListener('click', () => {
  state.usersPage = 1;
  loadUsers();
});
$('users-prev').addEventListener('click', () => {
  state.usersPage = Math.max(1, state.usersPage - 1);
  loadUsers();
});
$('users-next').addEventListener('click', () => {
  state.usersPage += 1;
  loadUsers();
});
$('users-myid').addEventListener('click', async () => {
  try {
    const me = await api('/api/admin/me', { retryAuth: true });
    $('users-q').value = String(me.id);
    state.usersPage = 1;
    await loadUsers();
    await openUser(me.id);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ------------------------------------------------------------------ wins */

async function loadWins() {
  const q = $('wins-q').value.trim();
  const status = $('wins-status').value;
  const kind = $('wins-kind').value;
  const d = await api(`/api/admin/wins${query({ q, status, kind, page: state.winsPage, perPage: 25 })}`);
  const rows = d.items.map((w) => `
    <tr>
      <td><b>${esc(w.winCode)}</b></td>
      <td>${w.tgGiftImg ?? ''}${esc(w.gift.title)}</td>
      <td><span class="tag ${w.kind === 'guarantee' ? 'guarantee' : w.kind}">${esc(w.kindLabel)}</span></td>
      <td>${esc(w.userId)}${w.username ? `<br><span class="muted">@${esc(w.username)}</span>` : ''}</td>
      <td>${esc(w.name ?? '—')}</td>
      <td>${fmtDateTime(w.createdAt)}</td>
      <td><span class="tag ${w.status}">${esc(w.statusLabel)}</span></td>
      <td class="wrap">${esc(w.cancelReason ?? '')}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-deliver="${w.id}">Выдан</button>
        <button class="btn btn-ghost btn-sm" data-cancel="${w.id}" data-code="${esc(w.winCode)}">Отмена</button>
        ${w.status === 'delivered' ? `<button class="btn btn-ghost btn-sm" data-reopen="${w.id}">Вернуть</button>` : ''}
      </td>
    </tr>`);
  $('wins-table').innerHTML = table(
    ['Номер', 'Подарок', 'Тип', 'Telegram ID', 'Имя', 'Дата', 'Статус', 'Причина', 'Действия'],
    rows,
  );
  $('wins-page').textContent = `стр. ${d.page} · всего ${d.total}`;
  state.winsPage = d.page;

  document.querySelectorAll('[data-deliver]').forEach((btn) => {
    btn.addEventListener('click', () => openConfirm('Отметить как выданный?', 'Статус «Выдан» сохранит дату и ваш Telegram ID. Убедитесь, что подарок реально выдан.', async () => {
      await api(`/api/admin/wins/${btn.dataset.deliver}/deliver`, { method: 'POST' });
      toast('Отмечено как выданный');
      await loadWins();
    }));
  });
  document.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => openReason('Отменить выигрыш', btn.dataset.code, async (reason) => {
      await api(`/api/admin/wins/${btn.dataset.cancel}/cancel`, { method: 'POST', body: { reason } });
      toast('Выигрыш отменён');
      await loadWins();
    }));
  });
  document.querySelectorAll('[data-reopen]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/admin/wins/${btn.dataset.reopen}/reopen`, { method: 'POST' });
      toast('Возвращён в ожидание выдачи');
      await loadWins();
    });
  });
}

$('wins-prev').addEventListener('click', () => {
  state.winsPage = Math.max(1, state.winsPage - 1);
  loadWins();
});
$('wins-next').addEventListener('click', () => {
  state.winsPage += 1;
  loadWins();
});

/* ------------------------------------------------------------------ payments */

async function loadPayments() {
  const d = await api(`/api/admin/payments${query({ perPage: 60 })}`);
  const rows = d.items.map((p) => `
    <tr>
      <td>${p.id}</td>
      <td>${esc(p.username ? `@${p.username}` : p.userId)}</td>
      <td>${esc(p.name ?? '—')}</td>
      <td>${p.amount} ${esc(p.currency)}</td>
      <td><span class="tag ${p.status}">${esc(p.statusLabel)}</span></td>
      <td>${p.consumed ? 'спин выдан' : p.status === 'created' ? 'ждёт оплаты' : 'нет'}</td>
      <td class="wrap">${esc(p.failureReason ?? '')}</td>
      <td>${fmtDateTime(p.createdAt)}</td>
    </tr>`);
  $('payments-table').innerHTML = table(
    ['ID', 'Пользователь', 'Имя', 'Сумма', 'Статус', 'Спин', 'Ошибка', 'Создан'],
    rows,
  );
}

/* ------------------------------------------------------------------ odds */

const OUTCOME_LABELS = { cake: '🎂 Торт «Мерцание»', bear: '🧸 Мишка', heart: '❤️ Сердце', none: '🍃 Ничего' };
const GIFT_IMAGES = { bear: '/assets/bear.png', heart: '/assets/heart.png', cake: '/assets/cake.png' };

async function loadOdds() {
  const d = await api('/api/admin/probabilities');
  $('odds-note').textContent = d.snapshotNote;
  $('odds-form').innerHTML = ['cake', 'bear', 'heart', 'none']
    .map((key) => {
      const img = GIFT_IMAGES[key]
        ? `<img src="${GIFT_IMAGES[key]}" alt="">`
        : '<span style="font-size:20px">🍃</span>';
      return `<div class="odds-field">
        <label for="od-${key}">${img} ${OUTCOME_LABELS[key]}</label>
        <input id="od-${key}" type="number" step="0.001" min="0" max="100" data-odds="${key}" value="${d.current[key]}" />
      </div>`;
    })
    .join('');
  $('odds-form').insertAdjacentHTML(
    'beforeend',
    `<div class="odds-sum" id="odds-sum"></div>`,
  );

  const updateSum = () => {
    const vals = readOdds();
    const sum = Object.values(vals).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const el = $('odds-sum');
    el.textContent = `Сумма: ${sum.toFixed(3).replace('.', ',')}% / 100%`;
    el.className = `odds-sum ${Math.abs(sum - 100) < 1e-6 ? 'is-ok' : 'is-bad'}`;
    $('odds-save').disabled = Math.abs(sum - 100) > 1e-6;
  };
  document.querySelectorAll('[data-odds]').forEach((input) => input.addEventListener('input', updateSum));
  updateSum();

  $('odds-save').onclick = async () => {
    try {
      const res = await api('/api/admin/probabilities', { method: 'POST', body: { probabilities: readOdds() } });
      toast(`Сохранено. Применяется со спина: ${res.effectiveFrom}`);
      await loadOdds();
    } catch (err) {
      toast(err.message, true);
    }
  };

  $('odds-history').innerHTML = table(
    ['Когда', 'Кто', 'Было', 'Стало'],
    d.history.map((h) => {
      const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(' · ');
      return `<tr><td>${fmtDateTime(h.createdAt)}</td><td>${esc(h.changedBy ?? '—')}</td><td class="wrap">${esc(fmt(h.oldValue))}</td><td class="wrap">${esc(fmt(h.newValue))}</td></tr>`;
    }),
  );
}

function readOdds() {
  const out = {};
  document.querySelectorAll('[data-odds]').forEach((input) => {
    out[input.dataset.odds] = Number(input.value);
  });
  return out;
}

/* ------------------------------------------------------------------ finance */

async function loadFinance() {
  const d = await api(`/api/admin/finance${query()}`);
  const f = d;
  const settlement = f.settlements ?? {};
  const html = `
    <div class="card">
      <h3>Финансовый результат за период</h3>
      <p class="warn-note">${esc(f.currencyNote)}</p>
      <div class="grid">
        ${stat('Оплаченных спинов', f.revenue.paidSpins)}
        ${stat('Валовой объём Stars', stars(f.revenue.grossStars), '', 'gold')}
        ${stat('Возвращено', stars(f.revenue.refundedStars), '', f.revenue.refundedStars ? 'bad' : '')}
        ${stat('Чистые поступления', stars(f.revenue.netReceivedStars), '', 'ok')}
        ${stat('Стоимость выданных', stars(f.expenses.deliveredCostStars), '', 'bad')}
        ${stat('Обязательства (ожидают)', stars(f.expenses.pendingObligationStars), '', 'gold')}
        ${stat('Оценка обязательств по гарантии', stars(f.expenses.guaranteeExposureStars), 'оценка', '')}
        ${stat('Расчётный результат', stars(f.result.estimatedNetStars), f.result.note, f.result.estimatedNetStars >= 0 ? 'ok' : 'bad')}
        ${stat('Точка безубыточности', `${f.result.breakEvenPaidSpins} платных спинов`, `по цене ${stars(f.settings?.spinPriceStars ?? 5)}`)}
      </div>
      <h3 style="margin-top:20px">Расходы по видам подарков</h3>
      <div class="table-wrap">
        ${table(
          ['Подарок', 'Цена', 'Выдано', 'Ожидает', 'Отменено', 'Затрачено', 'Обязательства'],
          f.expenses.byGift.map((g) => `
            <tr>
              <td>${esc(g.title)}</td><td>${g.unitCostStars} ⭐</td>
              <td>${g.delivered}</td><td>${g.pending}</td><td>${g.cancelled}</td>
              <td>${stars(g.deliveredCostStars)}</td><td>${stars(g.pendingCostStars)}</td>
            </tr>`),
        )}
      </div>
      <h3 style="margin-top:20px">Фактические расчёты Telegram</h3>
      ${
        settlement.ok
          ? `<div class="kv">
              <div><span>Баланс бота</span><strong>${settlement.balanceStars === null ? '—' : stars(settlement.balanceStars)}</strong></div>
              <div><span>Всего поступило (по транзакциям)</span><strong>${stars(settlement.totalReceived)}</strong></div>
              ${Object.entries(settlement.totalByType ?? {})
                .map(([type, amount]) => `<div><span>${esc(type)}</span><strong>${stars(amount)}</strong></div>`)
                .join('')}
            </div>
            <p class="warn-note">${esc(settlement.note)}</p>
            <div class="table-wrap">${table(
              ['Дата', 'Тип', 'Сумма', 'Источник', 'Payload'],
              (settlement.recentTransactions ?? []).map((t) => `
                <tr><td>${fmtDateTime(new Date(t.date * 1000).toISOString())}</td><td>${esc(t.type)}</td>
                <td>${t.amount} ⭐</td><td>${esc(t.source ?? '—')}</td><td class="wrap">${esc(t.payload ?? '—')}</td></tr>`),
            )}</div>`
          : `<p class="warn-note">${esc(settlement.error ?? 'Нет данных')}</p>`
      }
    </div>
    <div class="card">
      <h3>Прогноз по сценариям (оценка, не гарантия)</h3>
      <div class="row-tools">
        <label class="muted">Платных спинов на пользователя за период:
          <input id="fc-paid" type="number" min="0" step="0.5" value="3" style="width:90px" />
        </label>
        <button class="btn btn-ghost btn-sm" id="fc-apply" type="button">Пересчитать</button>
      </div>
      <div id="forecast-root"></div>
    </div>`;
  $('finance-root').innerHTML = html;
  $('fc-apply').addEventListener('click', loadForecast);
  await loadForecast();
}

async function loadForecast() {
  const paidSpinsPerUser = $('fc-paid')?.value ?? 3;
  const d = await api(`/api/admin/forecast?paidSpinsPerUser=${encodeURIComponent(paidSpinsPerUser)}`);
  forecastData = d;
  $('forecast-root').innerHTML = `
    <p class="forecast-note">
      Допущения: ${d.assumptions.freeSpinsPerUserPerDay} бесплатный спин в день, ${d.assumptions.paidSpinsPerUser} платных спинов
      на пользователя, цена ${d.assumptions.spinPriceStars} ⭐, гарантия на ${d.assumptions.guaranteeDays}-й день.
      Все значения ниже — <b>оценки</b>, а не гарантированный результат.
    </p>
    <div class="table-wrap">
      ${table(
        ['Пользователей', 'Горизонт', 'Доход', 'Обычные подарки', 'Гарантия', 'Итого расход', 'Оценка результата', 'Ожидаемые обязательства'],
        d.scenarios.map((s) => `
          <tr>
            <td>${s.users}</td><td>${s.horizonDays} дн.</td>
            <td>${stars(s.revenueStars)}</td>
            <td>${stars(s.expectedNormalCostStars)}</td>
            <td>${s.expectedGuaranteeGifts} шт. / ${stars(s.expectedGuaranteeCostStars)}</td>
            <td>${stars(s.expectedTotalCostStars)}</td>
            <td><b class="${s.estimatedResultStars >= 0 ? 'pos' : 'neg'}">${stars(s.estimatedResultStars)}</b></td>
            <td>${stars(s.estimatedPendingObligationStars)}</td>
          </tr>`),
      )}
    </div>`;
}

/* ------------------------------------------------------------------ risk */

async function loadRisk() {
  const d = await api('/api/admin/risk');
  const levelText = { ok: 'Бюджет под контролем', warning: 'Внимание: приближение к лимиту', critical: 'Критично: обязательства превышают бюджет' };
  $('risk-root').innerHTML = `
    <div class="card">
      <div class="risk-banner ${d.level}">
        <h3>${levelText[d.level]}</h3>
        <p>${esc(d.recommendation)}</p>
        <p class="muted">${esc(d.confirmedObligationsPreserved)}</p>
      </div>
      <div class="grid">
        ${stat('Бюджет (внутренняя оценка)', stars(d.budgetStars), 'настраивается ниже')}
        ${stat('Текущие обязательства', stars(d.pendingObligationStars), 'ожидают выдачи', 'gold')}
        ${stat('Оценка по гарантии', stars(d.guaranteeExposureStars), `${d.totalExposureStars} ⭐ всего`)}
        ${stat('Уже потрачено', stars(d.deliveredSpentStars), '', 'bad')}
      </div>
      <div class="row-tools" style="margin-top:16px">
        <input type="number" id="budget-input" min="0" step="10" value="${d.budgetStars}" style="width:120px" />
        <button class="btn btn-gold btn-sm" id="budget-save" type="button">Сохранить бюджет</button>
      </div>
    </div>
    <div class="card">
      <h3>Переключатели</h3>
      <div class="switch-row">
        <div><b>Новые вращения</b><div class="muted">Отключение не отменяет ранее выигранные подарки.</div></div>
        <div class="switch ${d.spinsEnabled ? 'is-on' : ''}" id="sw-spins"></div>
      </div>
      <div class="switch-row">
        <div><b>Платные спины</b><div class="muted">Можно временно остановить поступление Stars.</div></div>
        <div class="switch ${d.paidSpinsEnabled ? 'is-on' : ''}" id="sw-paid"></div>
      </div>
    </div>`;

  $('budget-save').addEventListener('click', async () => {
    await api('/api/admin/risk/budget', { method: 'POST', body: { stars: Number($('budget-input').value) } });
    toast('Бюджет обновлён');
    loadRisk();
  });
  $('sw-spins').addEventListener('click', async () => {
    await api('/api/admin/risk/toggle', { method: 'POST', body: { name: 'all_spins_enabled', value: !d.spinsEnabled } });
    toast('Переключено');
    loadRisk();
  });
  $('sw-paid').addEventListener('click', async () => {
    await api('/api/admin/risk/toggle', { method: 'POST', body: { name: 'paid_spins_enabled', value: !d.paidSpinsEnabled } });
    toast('Переключено');
    loadRisk();
  });
}

/* ------------------------------------------------------------------ logs */

async function loadLogs() {
  const d = await api('/api/admin/log');
  $('admin-log').innerHTML = table(
    ['Когда', 'Админ', 'Действие', 'Детали'],
    d.admin.map((r) => `<tr><td>${fmtDateTime(r.createdAt)}</td><td>${esc(r.adminId)}</td><td>${esc(r.action)}</td><td class="wrap">${esc(r.details ?? '')}</td></tr>`),
  );
  $('error-log').innerHTML = table(
    ['Когда', 'Раздел', 'Сообщение'],
    d.errors.map((r) => `<tr><td>${fmtDateTime(r.createdAt)}</td><td>${esc(r.scope)}</td><td class="wrap">${esc(r.message)}</td></tr>`),
  );
}

/* ------------------------------------------------------------------ modal */

function openConfirm(title, text, onOk) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = `<p class="modal-body-line">${esc(text)}</p>`;
  $('modal-ok').textContent = 'Подтвердить';
  $('modal-ok').onclick = async () => {
    closeModal();
    try {
      await onOk();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('modal').hidden = false;
}

function openReason(title, code, onOk) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = `
    <p class="modal-body-line">Выигрыш <b>${esc(code)}</b> будет помечен как отменённый. Причина обязательна и сохраняется в истории.</p>
    <textarea id="reason-input" placeholder="Например: пользователь не вышел на связь"></textarea>`;
  $('modal-ok').textContent = 'Отменить выигрыш';
  $('modal-ok').onclick = async () => {
    const reason = $('reason-input').value.trim();
    if (!reason) {
      toast('Укажите причину', true);
      return;
    }
    closeModal();
    await onOk(reason);
  };
  $('modal').hidden = false;
}

function closeModal() {
  $('modal').hidden = true;
}
$('modal').querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', closeModal));

/* ------------------------------------------------------------------ filters */

function applyRange() {
  state.range = {};
  if ($('f-from').value) state.range.from = $('f-from').value;
  if ($('f-to').value) state.range.to = $('f-to').value;
  $('wins-export').href = `/api/admin/export/wins.csv`;
  state.winsPage = 1;
  loadTab(state.tab);
}
$('f-apply').addEventListener('click', applyRange);
$('f-reset').addEventListener('click', () => {
  $('f-from').value = '';
  $('f-to').value = '';
  state.range = {};
  loadTab(state.tab);
});

/* ------------------------------------------------------------------ loader */

const LOADERS = {
  stats: loadStats,
  users: loadUsers,
  wins: loadWins,
  payments: loadPayments,
  odds: loadOdds,
  finance: loadFinance,
  risk: loadRisk,
  logs: loadLogs,
};

async function loadTab(name) {
  try {
    await LOADERS[name]();
  } catch (err) {
    toast(err.message || 'Не удалось загрузить раздел', true);
  }
}

(async function boot() {
  if (!tg?.initData) {
    $('gate-text').textContent = 'Откройте панель из Telegram: права проверяются по подписи initData и числовому Telegram ID владельца.';
    return;
  }
  try {
    const me = await api('/api/admin/me', { retryAuth: true });
    $('admin-identity').textContent = `@${me.username ?? '—'} · ID ${me.id}`;
    $('gate').hidden = true;
    $('panel').hidden = false;
    activateTab('stats');
  } catch (err) {
    $('gate-text').textContent =
      err.status === 403
        ? `Доступ запрещён. Telegram ID ${tg.initDataUnsafe?.user?.id ?? '—'} не входит в список владельцев (OWNER_TELEGRAM_IDS).`
        : err.message || 'Не удалось проверить права.';
  }
})();