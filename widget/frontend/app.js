'use strict';

// The widget window. Rust owns all data and pushes snapshots; this file only draws them.

const DICT = {
  en: {
    'tab.next': 'Next',
    'tab.grid': 'Grid',
    'tab.results': 'Results',
    'tab.live': 'Live',
    'tab.settings': 'Settings',
    'next.weekend': 'Weekend',
    'next.none': 'No upcoming sessions',
    'next.onTrack': 'On track now',
    'next.local': 'Local time · {tz}',
    'next.loading': 'Loading the schedule…',
    'next.error': 'Could not load the schedule: {why}',
    'grid.title': 'Starting grid',
    'grid.empty': 'The starting grid appears here once qualifying is over.',
    'results.last': 'Last race',
    'results.empty': 'No finished race yet.',
    'results.standings': 'Standings',
    'results.drivers': 'Drivers',
    'results.teams': 'Teams',
    'results.pts': 'pts',
    'live.title': 'Live order',
    'live.lap': 'Lap {n}',
    'live.noSession': 'No live session right now.',
    'live.next': 'Next: {name} — {when}.',
    'live.signIn': '{session} is on track. Sign in with your OpenF1 account to see live positions.',
    'live.signInIdle': 'Live positions need an OpenF1 account with a real-time subscription (openf1.org). You can sign in now and it will connect when a session starts.',
    'live.connecting': 'Connecting to the live feed…',
    'live.reconnecting': 'Connection lost, reconnecting… ({why})',
    'live.denied': 'The broker rejected the login. Check that your account has a real-time subscription.',
    'live.waiting': 'Connected. Waiting for the first positions…',
    'live.interval': 'Int.',
    'live.gap': 'Gap',
    'live.leader': 'Leader',
    'flag.GREEN': 'Green flag',
    'flag.YELLOW': 'Yellow flag',
    'flag.RED': 'Red flag',
    'flag.SC': 'Safety car',
    'flag.VSC': 'Virtual SC',
    'flag.SC_END': 'SC ending',
    'flag.CHEQUERED': 'Finished',
    'account.username': 'Username',
    'account.password': 'Password',
    'account.remember': 'Remember on this computer (system keychain)',
    'account.signIn': 'Sign in',
    'account.signOut': 'Sign out',
    'account.signInForLive': 'Sign in for live data',
    'account.signedInAs': 'Signed in as {user}',
    'account.signedOut': 'Not signed in. The schedule, grid and results need no account.',
    'account.signingIn': 'Signing in…',
    'err.bad_credentials': 'Wrong username or password',
    'settings.language': 'Language',
    'settings.onTop': 'Keep this window on top',
    'settings.account': 'OpenF1 account',
    'settings.data': 'Data',
    'settings.refresh': 'Refresh now',
    'settings.credit': 'Data: OpenF1 (openf1.org). Unofficial; not affiliated with Formula 1.',
    'status.finished': 'finished',
    'dnf': 'DNF',
    'd': 'd',
  },
  ru: {
    'tab.next': 'Далее',
    'tab.grid': 'Решётка',
    'tab.results': 'Итоги',
    'tab.live': 'Лайв',
    'tab.settings': 'Настройки',
    'next.weekend': 'Уикенд',
    'next.none': 'Ближайших сессий нет',
    'next.onTrack': 'Идёт сейчас',
    'next.local': 'Ваше время · {tz}',
    'next.loading': 'Загрузка расписания…',
    'next.error': 'Не удалось загрузить расписание: {why}',
    'grid.title': 'Стартовая решётка',
    'grid.empty': 'Стартовая решётка появится здесь после квалификации.',
    'results.last': 'Прошлая гонка',
    'results.empty': 'Завершённых гонок пока нет.',
    'results.standings': 'Чемпионат',
    'results.drivers': 'Пилоты',
    'results.teams': 'Команды',
    'results.pts': 'очк.',
    'live.title': 'Позиции в реальном времени',
    'live.lap': 'Круг {n}',
    'live.noSession': 'Сейчас нет идущей сессии.',
    'live.next': 'Ближайшая: {name} — {when}.',
    'live.signIn': 'Идёт {session}. Войди в аккаунт OpenF1, чтобы видеть позиции.',
    'live.signInIdle': 'Для позиций в реальном времени нужен аккаунт OpenF1 с подпиской на real-time (openf1.org). Можно войти заранее, подключение произойдёт при старте сессии.',
    'live.connecting': 'Подключение к лайву…',
    'live.reconnecting': 'Связь потеряна, переподключаюсь… ({why})',
    'live.denied': 'Брокер отклонил вход. Проверь, что у аккаунта есть подписка на real-time.',
    'live.waiting': 'Подключено. Ждём первые позиции…',
    'live.interval': 'Инт.',
    'live.gap': 'Отрыв',
    'live.leader': 'Лидер',
    'flag.GREEN': 'Зелёный флаг',
    'flag.YELLOW': 'Жёлтый флаг',
    'flag.RED': 'Красный флаг',
    'flag.SC': 'Сейфти-кар',
    'flag.VSC': 'Виртуальный SC',
    'flag.SC_END': 'SC заканчивает',
    'flag.CHEQUERED': 'Финиш',
    'account.username': 'Логин',
    'account.password': 'Пароль',
    'account.remember': 'Запомнить на этом компьютере (системное хранилище)',
    'account.signIn': 'Войти',
    'account.signOut': 'Выйти',
    'account.signInForLive': 'Войти для лайва',
    'account.signedInAs': 'Вы вошли как {user}',
    'account.signedOut': 'Вход не выполнен. Расписание, решётка и итоги работают без аккаунта.',
    'account.signingIn': 'Вход…',
    'err.bad_credentials': 'Неверный логин или пароль',
    'settings.language': 'Язык',
    'settings.onTop': 'Держать окно поверх остальных',
    'settings.account': 'Аккаунт OpenF1',
    'settings.data': 'Данные',
    'settings.refresh': 'Обновить сейчас',
    'settings.credit': 'Данные: OpenF1 (openf1.org). Неофициально, не связано с Formula 1.',
    'status.finished': 'завершено',
    'dnf': 'сход',
    'd': 'д',
  },
};

const tauri = window.__TAURI__;
const invoke = (cmd, args) => tauri.core.invoke(cmd, args);
const $ = (sel) => document.querySelector(sel);

const state = {
  snap: null,
  locale: 'en',
  tab: window.__F1W_TAB && ['next', 'grid', 'results', 'live', 'settings'].includes(window.__F1W_TAB)
    ? window.__F1W_TAB
    : window.__F1W_TAB === 'account' ? 'live' : 'next',
  standings: 'drivers',
  signingIn: false,
};

// ───────────────────────── helpers ─────────────────────────

const t = (key, params = {}) => (DICT[state.locale][key] ?? DICT.en[key] ?? key)
  .replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');

const dateLocale = () => (state.locale === 'ru' ? 'ru-RU' : 'en-GB');
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const two = (n) => String(n).padStart(2, '0');

function fmtWhen(ms) {
  return new Intl.DateTimeFormat(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms);
}

function fmtCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const clock = `${two(Math.floor((s % 86400) / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
  return d > 0 ? `${d}${t('d')} ${clock}` : clock;
}

function fmtLap(seconds) {
  if (seconds == null) return '';
  const m = Math.floor(seconds / 60);
  const rest = (seconds - m * 60).toFixed(3).padStart(6, '0');
  return m > 0 ? `${m}:${rest}` : rest;
}

/** Tiny DOM builder; text is always set as text, never as markup. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Re-run `build` only when the data it depends on changed (keeps scroll and typing intact). */
const signatures = {};
function once(key, signature, build) {
  const text = JSON.stringify(signature);
  if (signatures[key] === text) return;
  signatures[key] = text;
  build();
}

const COMPOUND_LETTER = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };
const tyreDot = (compound) => h('i', { class: `dot c-${compound}` }, COMPOUND_LETTER[compound] ?? '');

function applyI18n() {
  document.documentElement.lang = state.locale;
  document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => { node.title = t(node.dataset.i18nTitle); });
}

// ───────────────────────── rendering ─────────────────────────

function renderHeader(snap) {
  $('#meeting').textContent = snap.meeting?.name ?? (snap.error ? '' : t('next.loading'));
  const sub = snap.meeting ? [snap.meeting.location, snap.meeting.country].filter(Boolean).join(' · ') : '';
  $('#sub').textContent = sub;
}

function renderNext(snap) {
  const next = snap.next;
  $('#next-name').textContent = next ? next.name : snap.error ? '' : t('next.none');
  $('#next-error').textContent = !next && snap.error ? t('next.error', { why: snap.error }) : '';
  $('#weekend-title').hidden = snap.weekend.length === 0;
  $('#next-when').textContent = next ? fmtWhen(next.startMs) : '';
  $('#next-tz').textContent = next ? t('next.local', { tz: timeZone() }) : '';

  once('weekend', [snap.weekend, state.locale], () => {
    const nextStart = next?.startMs;
    $('#weekend').replaceChildren(...snap.weekend.map((s) => h(
      'div',
      { class: `sess ${s.status}${s.startMs === nextStart ? ' next' : ''}` },
      h('span', { class: 'mark' }, s.status === 'finished' ? '✓' : s.status === 'inProgress' ? '▶' : ''),
      h('span', {}, s.name),
      h('span', { class: 'when' }, fmtWhen(s.startMs)),
    )));
  });
}

/** Cheap per-second update of the big countdown. */
function tick() {
  const next = state.snap?.next;
  const el = $('#next-count');
  if (!next) { el.textContent = ''; return; }
  const now = Date.now();
  const onTrack = now >= next.startMs && now < next.endMs;
  el.classList.toggle('live', onTrack);
  el.textContent = onTrack ? t('next.onTrack') : fmtCountdown((next.startMs - now) / 1000);
}

function renderGrid(snap) {
  const grid = snap.grid;
  once('grid', [grid, state.locale], () => {
    $('#grid-title').textContent = grid ? `${t('grid.title')} — ${grid.meeting}` : t('grid.title');
    $('#grid').replaceChildren(...(grid
      ? grid.rows.map((r) => h('div', { class: 'line' },
        h('span', { class: 'pos' }, r.position),
        h('span', { class: 'bar', style: `background:${r.driver.color}` }),
        h('span', { class: 'acr' }, r.driver.acronym),
        h('span', { class: 'name' }, r.driver.name),
        h('span', { class: 'val' }, fmtLap(r.lapTime))))
      : [h('div', { class: 'notice' }, t('grid.empty'))]));
  });
}

function renderResults(snap) {
  once('results', [snap.lastRace, state.locale], () => {
    const race = snap.lastRace;
    $('#results-title').textContent = race ? `${t('results.last')} — ${race.meeting}` : t('results.last');
    $('#results').replaceChildren(...(race
      ? race.rows.map((r) => h('div', { class: 'line' },
        h('span', { class: 'pos' }, r.position ?? '–'),
        h('span', { class: 'bar', style: `background:${r.driver.color}` }),
        h('span', { class: 'acr' }, r.driver.acronym),
        h('span', { class: 'name' }, r.driver.name),
        h('span', { class: 'val' },
          r.note ? h('span', { class: 'note' }, r.note === 'DNF' ? t('dnf') : r.note) : null,
          r.position === 1 ? '' : (r.gap ?? ''),
          r.points ? h('b', { class: 'pts' }, r.points) : null)))
      : [h('div', { class: 'notice' }, t('results.empty'))]));
  });

  once('standings', [snap.standings, state.standings, state.locale], () => {
    const s = snap.standings;
    document.querySelectorAll('[data-standings]').forEach((b) => b.classList.toggle('on', b.dataset.standings === state.standings));
    if (!s) { $('#standings').replaceChildren(); return; }
    $('#standings').replaceChildren(...(state.standings === 'drivers'
      ? s.drivers.slice(0, 12).map((r) => h('div', { class: 'line' },
        h('span', { class: 'pos' }, r.position),
        h('span', { class: 'bar', style: `background:${r.driver.color}` }),
        h('span', { class: 'acr' }, r.driver.acronym),
        h('span', { class: 'name' }, r.driver.name),
        h('span', { class: 'val' }, h('b', {}, r.points), ` ${t('results.pts')}`)))
      : s.teams.map((r) => h('div', { class: 'line' },
        h('span', { class: 'pos' }, r.position),
        h('span', { class: 'bar', style: 'background:var(--line)' }),
        h('span', { class: 'acr' }, ''),
        h('span', { class: 'name' }, r.team),
        h('span', { class: 'val' }, h('b', {}, r.points), ` ${t('results.pts')}`)))));
  });
}

function renderLive(snap) {
  const live = snap.live;
  const loggedIn = snap.account.loggedIn;
  $('#live-dot').hidden = live.status !== 'live';

  let message = '';
  if (live.status === 'noSession') {
    message = snap.next
      ? `${t('live.noSession')} ${t('live.next', { name: snap.next.name, when: fmtWhen(snap.next.startMs) })}`
      : t('live.noSession');
    if (!loggedIn) message += `\n${t('live.signInIdle')}`;
  } else if (live.status === 'noAccount') {
    message = t('live.signIn', { session: live.session });
  } else if (live.status === 'connecting') {
    message = t('live.connecting');
  } else if (live.status === 'error') {
    message = live.message === 'denied' ? t('live.denied') : t('live.reconnecting', { why: live.message ?? '' });
  } else if (live.status === 'live' && live.rows.length === 0) {
    message = t('live.waiting');
  }
  const note = $('#live-message');
  note.textContent = message;
  note.style.whiteSpace = 'pre-line';

  // the sign-in form stays in the DOM (re-creating it would eat what the user is typing)
  $('#login-form').hidden = loggedIn;

  once('live', [live, state.locale], () => {
    if (live.status !== 'live' || live.rows.length === 0) {
      $('#live-head').replaceChildren();
      $('#live-table').replaceChildren();
      return;
    }
    $('#live-head').replaceChildren(
      h('b', {}, t('live.title')),
      live.lap != null ? h('span', { class: 'chip' }, t('live.lap', { n: live.lap })) : null,
      h('span', { class: `chip ${live.flag}` }, t(`flag.${live.flag}`)),
    );
    $('#live-table').replaceChildren(
      h('div', { class: 'live-line live-cols' },
        h('span'), h('span'), h('span', {}, ''), h('span', { class: 'gap' }, t('live.interval')), h('span', { class: 'gap' }, t('live.gap')), h('span', { class: 'tyre' })),
      ...live.rows.map((r) => h('div', { class: 'live-line' },
        h('span', { class: 'pos' }, r.position),
        h('span', { class: 'bar', style: `background:${r.driver.color}` }),
        h('span', { class: 'acr' }, r.driver.acronym),
        h('span', { class: 'gap' }, r.position === 1 ? t('live.leader') : r.interval),
        h('span', { class: 'gap' }, r.position === 1 ? '' : r.gap),
        h('span', { class: 'tyre' }, r.compound ? tyreDot(r.compound) : null, r.tyreAge != null && r.compound ? r.tyreAge : ''))),
    );
  });
}

function renderSettings(snap) {
  if (document.activeElement !== $('#lang')) $('#lang').value = state.locale;
  const acc = snap.account;
  $('#account-state').textContent = acc.loggedIn ? t('account.signedInAs', { user: acc.username }) : t('account.signedOut');
  $('#sign-out').hidden = !acc.loggedIn;
  $('#go-live').hidden = acc.loggedIn;
  $('#error').textContent = snap.error ?? '';
}

function render() {
  const snap = state.snap;
  if (!snap) return;
  if (snap.locale && snap.locale !== state.locale && DICT[snap.locale]) {
    state.locale = snap.locale;
    applyI18n();
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  document.querySelectorAll('main > section').forEach((s) => s.classList.toggle('on', s.id === `panel-${state.tab}`));

  renderHeader(snap);
  renderNext(snap);
  renderGrid(snap);
  renderResults(snap);
  renderLive(snap);
  renderSettings(snap);
  tick();
}

function setSnapshot(snap) {
  state.snap = snap;
  render();
}

// ───────────────────────── events ─────────────────────────

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
document.querySelectorAll('[data-standings]').forEach((b) => b.addEventListener('click', () => { state.standings = b.dataset.standings; render(); }));

$('#lang').addEventListener('change', async () => {
  const code = $('#lang').value;
  state.locale = code;
  applyI18n();
  Object.keys(signatures).forEach((k) => delete signatures[k]);
  render();
  await invoke('set_locale', { code });
});
$('#on-top').addEventListener('change', () => invoke('set_always_on_top', { on: $('#on-top').checked }));
$('#refresh').addEventListener('click', () => invoke('refresh'));
$('#sign-out').addEventListener('click', () => invoke('logout'));
$('#go-live').addEventListener('click', () => { state.tab = 'live'; render(); $('#login-user').focus(); });

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.signingIn) return;
  state.signingIn = true;
  const error = $('#login-error');
  error.textContent = t('account.signingIn');
  error.style.color = 'var(--dim)';
  try {
    await invoke('login', {
      username: $('#login-user').value.trim(),
      password: $('#login-pass').value,
      remember: $('#login-remember').checked,
    });
    $('#login-pass').value = '';
    error.textContent = '';
    setSnapshot(await invoke('get_snapshot'));
  } catch (err) {
    const code = String(err);
    error.style.color = '';
    error.textContent = DICT[state.locale][`err.${code}`] ? t(`err.${code}`) : code;
  } finally {
    state.signingIn = false;
  }
});

tauri.event.listen('snapshot', (e) => setSnapshot(e.payload));
tauri.event.listen('navigate', (e) => { state.tab = e.payload === 'account' ? 'live' : e.payload; render(); });

applyI18n();
invoke('get_snapshot').then(setSnapshot);
setInterval(tick, 1000);

// diagnostics for `F1W_DEBUG=1`: tell the backend what this web view actually shows
if (window.__F1W_DEBUG) {
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  setTimeout(() => invoke('debug_report', {
    report: JSON.stringify({
      tab: state.tab,
      meeting: $('#meeting').textContent,
      count: $('#next-count').textContent,
      weekendRows: document.querySelectorAll('#weekend .sess').length,
      visiblePanels: [...document.querySelectorAll('main > section.on')].map((s) => s.id),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]') ? 'meta' : 'config',
      errors,
    }),
  }), 4000);
}
