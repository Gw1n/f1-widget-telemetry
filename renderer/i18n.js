'use strict';

/**
 * Minimal i18n shared by the main window and the overlay.
 *
 *  - `t(key, params)`: `{name}` placeholders; an entry may be an object of plural
 *    forms (`one`/`few`/`many`/`other`), picked with `params.n`.
 *  - `apply(root)`: fills `data-i18n` (text) and `data-i18n-title` (tooltip) attributes.
 *  - English is the source language and the fallback for missing Russian keys.
 */
const I18n = (() => {
  const DICT = {
    en: {
      // header
      'title.season': 'Season',
      'title.race': 'Grand Prix',
      'title.language': 'Language',
      'title.live': 'Live data',
      'btn.live': '● Live',
      'btn.liveExit': '■ Exit live',
      'ov.title': 'Transparent always-on-top window with the track map',
      'ov.open': 'Overlay',
      'ov.close': 'Close overlay',
      'ov.lock': 'Lock',
      'ov.size': 'Size',
      'ov.opacity': 'Opacity',
      'ov.bg': 'Background',
      'ov.hint': 'Drag the window · Ctrl/⌘+Alt+L to lock',
      'ov.ahead': '▲ ahead',
      'ov.behind': '▼ behind',
      'ov.gear': 'Gear',
      'ov.noLeaderAhead': 'leader',
      'ov.stops': { one: '{n} pit stop', other: '{n} pit stops' },
      'ov.tyreAge': { one: '{n} lap', other: '{n} laps' },
      'pin': 'Keep on top',

      // map HUD
      'hud.preStart': 'PRE-START',
      'hud.lap': 'LAP {n}/{total}',
      'hud.lapOnly': 'LAP {n}',
      'hud.loading': 'Loading data…',
      'wx.air': 'Air',
      'wx.track': 'Track',
      'wx.wind': 'Wind',
      'wx.rain': 'Rain',
      'wx.yes': 'yes',
      'wx.no': 'no',
      'feed.lap': 'L{n} · ',
      'status.GREEN': 'Green flag',
      'status.YELLOW': 'Yellow flag',
      'status.RED': 'Red flag',
      'status.SC': 'Safety car',
      'status.VSC': 'Virtual SC',
      'status.SC_END': 'SC ending',
      'status.CHEQUERED': 'Finished',

      // timing board
      'board.driver': 'Driver',
      'board.tyres': 'Tyres',
      'board.interval': 'Interval',
      'board.leader': 'Leader',
      'board.lap': 'Lap',
      'compound.SOFT': 'Soft',
      'compound.MEDIUM': 'Medium',
      'compound.HARD': 'Hard',
      'compound.INTERMEDIATE': 'Inter',
      'compound.WET': 'Wet',
      'compound.unknown': 'Tyres',

      // driver panel
      'tel.hint': 'Select a driver: click a dot on the map or a row in the table',
      'tel.compareWith': 'Compare with',
      'tel.pick': '— pick a driver —',
      'tel.gear': 'gear',
      'tel.throttle': 'Throttle',
      'tel.brake': 'Brake',
      'unit.kmh': 'km/h',
      'unit.ms': 'm/s',
      'unit.s': 's',
      'lap.lap': 'Lap',
      'lap.current': 'Lap {n}',
      'lap.currentNone': 'Lap –',
      'lap.last': 'Last',
      'lap.best': 'Best',
      'lap.traps': 'Speed traps (last lap):',
      'lap.trapsLine': 'I1 {i1} · I2 {i2} · ST {st} km/h',
      'sec.tyres': 'Tyres',
      'sec.pits': 'Pit stops',
      'pits.none': 'No stops yet',
      'pits.lap': 'Lap {n}',
      'pits.stationary': 'stationary {s} s',
      'stint.range': 'L{from}–{to}',
      'tyre.card': { one: '{age} lap · pit {stops}', other: '{age} laps · pit {stops}' },

      // comparison
      'cmp.title': 'Comparison',
      'cmp.modeTitle': 'Which laps to compare',
      'cmp.modeLast': 'Last lap',
      'cmp.modeBest': 'Best lap',
      'cmp.close': 'Close comparison',
      'cmp.now': 'Now',
      'cmp.last': 'Last',
      'cmp.best': 'Best',
      'cmp.gap': 'Gap on track: {acr} ahead by {s} s',
      'cmp.gapLapped': 'Gap on track: drivers are on different laps',
      'cmp.fasterBy': 'Faster by',
      'cmp.lap': 'Lap',
      'cmp.kmh': '{n} km/h',
      'cmp.loadingLap': 'Loading lap…',
      'cmp.failed': 'Could not load: {msg}',
      'cmp.missing': 'One of the drivers has no completed lap',
      'cmp.ahead': '{acr} ahead',
      'cmp.hover': '{pct}% of lap · {a} {va} km/h · {b} {vb} km/h · {s} s in favour of {w}',
      'cmp.idle': '{a} lap {na}: {ta} · {b} lap {nb}: {tb}',

      // transport / footer
      'play.title': 'Space',
      'speed.title': 'Speed',

      // live
      'live.delay': 'Delay',
      'live.delayTitle': 'How far behind the live edge the picture runs. Match it to your broadcast by adjusting it. Below 3–4 s the picture may stutter: data does not arrive instantly.',
      'live.pill': '● LIVE −{s} s',
      'live.behind': 'Back to live · −{m}:{ss}',
      'live.loadingSession': 'Live: loading session…',
      'live.connecting': 'Live: connecting…',
      'live.reconnecting': 'Live: connection lost, reconnecting…',
      'live.error': 'Live: {msg}',
      'live.at': 'LIVE · {loc}',
      'live.noSession': 'No session is on track right now.',
      'live.next': ' Next: {name}, {loc} — {when}.',
      'live.waitRace': 'Wait for the race to load',
      'live.needCredentials': 'Enter a username and password',
      'live.dialogTitle': 'Live',
      'live.hint': 'OpenF1 live data requires a paid subscription (openf1.org). Your username and password are only used to obtain a token for the data stream.',
      'live.signedInAs': 'Signed in as',
      'live.signOut': 'Sign out',
      'live.username': 'Username',
      'live.password': 'Password',
      'live.remember': 'Remember (stored encrypted in the system keychain)',
      'live.start': 'Start live',
      'live.signInStart': 'Sign in and start live',
      'live.demo': 'Demo live',
      'live.demoTitle': 'Replays the selected race in real time through the same channel',
      'live.cancel': 'Cancel',
      'live.demoHint': 'Demo live replays the selected race in real time and needs no account. Handy for seeing what live looks like outside race weekends.',
      'live.connectingMsg': 'Connecting…',

      // loading and errors
      'status.loading': 'Loading session…',
      'status.calendar': 'Loading calendar…',
      'status.noRaces': 'No completed races',
      'status.loadError': 'Load error: {msg}',
      'status.error': 'Error: {msg}',
      'err.noOutlineData': 'No data to build the track map from',
      'err.noLapForMap': 'No lap data for the map',
      'err.outlineFailed': 'Could not build the track',
      'err.bad_credentials': 'Wrong username or password',
      'err.login_failed': 'Sign-in failed ({detail})',
      'err.not_logged_in': 'Sign in to your OpenF1 account first',
      'err.broker_denied': 'The broker rejected the login: check that the account has a real-time subscription',
      'err.subscribe_failed': 'Subscription failed: {detail}',
      'err.demo_failed': 'Demo: {detail}',
    },

    ru: {
      'title.season': 'Сезон',
      'title.race': 'Гран-при',
      'title.language': 'Язык',
      'title.live': 'Живые данные',
      'btn.live': '● Лайв',
      'btn.liveExit': '■ Выйти из лайва',
      'ov.title': 'Прозрачное окно с картой поверх всех окон',
      'ov.open': 'Оверлей',
      'ov.close': 'Закрыть оверлей',
      'ov.lock': 'Закрепить',
      'ov.size': 'Размер',
      'ov.opacity': 'Непрозр.',
      'ov.bg': 'Фон',
      'ov.hint': 'Перетащи окно · Ctrl/⌘+Alt+L — закрепить',
      'ov.ahead': '▲ впереди',
      'ov.behind': '▼ позади',
      'ov.gear': 'Пер.',
      'ov.noLeaderAhead': 'лидер',
      'ov.stops': { one: '{n} пит-стоп', few: '{n} пит-стопа', many: '{n} пит-стопов', other: '{n} пит-стопа' },
      'ov.tyreAge': { one: '{n} круг', few: '{n} круга', many: '{n} кругов', other: '{n} круга' },
      'pin': 'Окно поверх',

      'hud.preStart': 'ДО СТАРТА',
      'hud.lap': 'КРУГ {n}/{total}',
      'hud.lapOnly': 'КРУГ {n}',
      'hud.loading': 'Загрузка данных…',
      'wx.air': 'Воздух',
      'wx.track': 'Трасса',
      'wx.wind': 'Ветер',
      'wx.rain': 'Дождь',
      'wx.yes': 'да',
      'wx.no': 'нет',
      'feed.lap': 'К{n} · ',
      'status.GREEN': 'Зелёный флаг',
      'status.YELLOW': 'Жёлтый флаг',
      'status.RED': 'Красный флаг',
      'status.SC': 'Сейфти-кар',
      'status.VSC': 'Виртуальный SC',
      'status.SC_END': 'SC заканчивает',
      'status.CHEQUERED': 'Финиш',

      'board.driver': 'Пилот',
      'board.tyres': 'Шины',
      'board.interval': 'Интервал',
      'board.leader': 'Лидер',
      'board.lap': 'Круг',
      'compound.SOFT': 'Софт',
      'compound.MEDIUM': 'Медиум',
      'compound.HARD': 'Хард',
      'compound.INTERMEDIATE': 'Интер',
      'compound.WET': 'Дождь',
      'compound.unknown': 'Шины',

      'tel.hint': 'Выбери пилота — клик по точке или в таблице',
      'tel.compareWith': 'Сравнить с',
      'tel.pick': '— выбрать пилота —',
      'tel.gear': 'передача',
      'tel.throttle': 'Газ',
      'tel.brake': 'Тормоз',
      'unit.kmh': 'км/ч',
      'unit.ms': 'м/с',
      'unit.s': 'с',
      'lap.lap': 'Круг',
      'lap.current': 'Круг {n}',
      'lap.currentNone': 'Круг –',
      'lap.last': 'Прошлый',
      'lap.best': 'Лучший',
      'lap.traps': 'Спидтрап (прошлый круг):',
      'lap.trapsLine': 'I1 {i1} · I2 {i2} · ST {st} км/ч',
      'sec.tyres': 'Шины',
      'sec.pits': 'Пит-стопы',
      'pits.none': 'Пока без остановок',
      'pits.lap': 'Круг {n}',
      'pits.stationary': 'стоянка {s} с',
      'stint.range': 'К{from}–{to}',
      'tyre.card': { one: '{age} круг · пит {stops}', few: '{age} круга · пит {stops}', many: '{age} кругов · пит {stops}', other: '{age} круга · пит {stops}' },

      'cmp.title': 'Сравнение',
      'cmp.modeTitle': 'Какие круги сравнивать',
      'cmp.modeLast': 'Прошлый круг',
      'cmp.modeBest': 'Лучший круг',
      'cmp.close': 'Закрыть сравнение',
      'cmp.now': 'Сейчас',
      'cmp.last': 'Посл.',
      'cmp.best': 'Лучш.',
      'cmp.gap': 'Разрыв на трассе: {acr} впереди на {s} с',
      'cmp.gapLapped': 'Разрыв на трассе: пилоты на разных кругах',
      'cmp.fasterBy': 'Быстрее на',
      'cmp.lap': 'Круг',
      'cmp.kmh': '{n} км/ч',
      'cmp.loadingLap': 'Загрузка круга…',
      'cmp.failed': 'Не удалось загрузить: {msg}',
      'cmp.missing': 'У одного из пилотов нет завершённого круга',
      'cmp.ahead': '{acr} впереди',
      'cmp.hover': '{pct}% круга · {a} {va} км/ч · {b} {vb} км/ч · {s} с в пользу {w}',
      'cmp.idle': '{a} круг {na}: {ta} · {b} круг {nb}: {tb}',

      'play.title': 'Пробел',
      'speed.title': 'Скорость',

      'live.delay': 'Задержка',
      'live.delayTitle': 'Насколько позже живого края идёт картинка. Совпадает с трансляцией, если подобрать задержку под неё. Меньше 3–4 с возможны рывки: данные приходят не мгновенно.',
      'live.pill': '● LIVE −{s} с',
      'live.behind': 'К лайву · −{m}:{ss}',
      'live.loadingSession': 'Лайв: загрузка сессии…',
      'live.connecting': 'Лайв: подключение…',
      'live.reconnecting': 'Лайв: связь потеряна, переподключаюсь…',
      'live.error': 'Лайв: {msg}',
      'live.at': 'LIVE · {loc}',
      'live.noSession': 'Сейчас нет идущей сессии.',
      'live.next': ' Ближайшая: {name}, {loc} — {when}.',
      'live.waitRace': 'Дождись загрузки гонки',
      'live.needCredentials': 'Введи логин и пароль',
      'live.dialogTitle': 'Лайв',
      'live.hint': 'Живые данные OpenF1 доступны только по платной подписке (openf1.org). Логин и пароль нужны, чтобы получить токен для потока.',
      'live.signedInAs': 'Вы вошли как',
      'live.signOut': 'Выйти',
      'live.username': 'Логин',
      'live.password': 'Пароль',
      'live.remember': 'Запомнить (хранится зашифрованным в системном хранилище)',
      'live.start': 'Начать лайв',
      'live.signInStart': 'Войти и начать лайв',
      'live.demo': 'Демо-лайв',
      'live.demoTitle': 'Повтор выбранной гонки в реальном времени через тот же канал',
      'live.cancel': 'Отмена',
      'live.demoHint': 'Демо-лайв повторяет выбранную гонку в реальном времени и работает без аккаунта. Удобно, чтобы посмотреть, как выглядит лайв, вне гоночных выходных.',
      'live.connectingMsg': 'Подключение…',

      'status.loading': 'Загрузка сессии…',
      'status.calendar': 'Загрузка календаря…',
      'status.noRaces': 'Нет завершённых гонок',
      'status.loadError': 'Ошибка загрузки: {msg}',
      'status.error': 'Ошибка: {msg}',
      'err.noOutlineData': 'нет данных, по которым можно построить трассу',
      'err.noLapForMap': 'нет данных круга для карты',
      'err.outlineFailed': 'не удалось построить трассу',
      'err.bad_credentials': 'Неверный логин или пароль',
      'err.login_failed': 'Ошибка входа ({detail})',
      'err.not_logged_in': 'Сначала войди в аккаунт OpenF1',
      'err.broker_denied': 'Брокер отклонил вход: проверь, что у аккаунта есть подписка на real-time',
      'err.subscribe_failed': 'Подписка не удалась: {detail}',
      'err.demo_failed': 'Демо: {detail}',
    },
  };

  const LOCALES = { en: { name: 'English', date: 'en-GB' }, ru: { name: 'Русский', date: 'ru-RU' } };
  const DEFAULT_LOCALE = 'en';
  const listeners = [];
  let locale = DEFAULT_LOCALE;

  function pickForm(entry, n) {
    if (typeof entry === 'string') return entry;
    const category = new Intl.PluralRules(locale).select(n ?? 0);
    return entry[category] ?? entry.other;
  }

  /** The entry for a key in the active language, falling back to English. */
  const lookup = (key) => DICT[locale][key] ?? DICT.en[key];

  function t(key, params = {}) {
    const entry = lookup(key);
    if (entry === undefined) return key; // a visible placeholder beats a blank
    return pickForm(entry, params.n).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');
  }

  /** Fill every `data-i18n` / `data-i18n-title` element under `root`. */
  function apply(root = document) {
    document.documentElement.lang = locale;
    root.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
    root.querySelectorAll('[data-i18n-title]').forEach((node) => { node.title = t(node.dataset.i18nTitle); });
  }

  function setLocale(next) {
    if (!DICT[next] || next === locale) return false;
    locale = next;
    apply();
    listeners.forEach((fn) => fn(locale));
    return true;
  }

  /** The "LAP 7/55" label of the HUD (before the start, or without a total in live mode). */
  const lapLabel = ({ pre, lapNo, total }) => {
    if (pre) return t('hud.preStart');
    return total != null ? t('hud.lap', { n: lapNo, total }) : t('hud.lapOnly', { n: lapNo });
  };

  /** First-run setup: set the language and fill the static markup, even when it is the default. */
  function init(initial) {
    locale = DICT[initial] ? initial : DEFAULT_LOCALE;
    apply();
  }

  /** Dates follow the app language (not the OS), but always the user's own time zone. */
  const formatDateTime = (date) => new Date(date).toLocaleString(LOCALES[locale].date, { dateStyle: 'medium', timeStyle: 'short' });

  return {
    t,
    lapLabel,
    apply,
    init,
    setLocale,
    formatDateTime,
    has: (key) => lookup(key) !== undefined,
    onChange: (fn) => listeners.push(fn),
    get locale() { return locale; },
    locales: LOCALES,
    DEFAULT_LOCALE,
  };
})();
