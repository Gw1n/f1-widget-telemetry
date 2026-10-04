'use strict';

const CH = 30_000; // data chunk length, ms
const YEARS = [2026, 2025, 2024, 2023];
const { upperBound, fmtLap, fmtSector } = Race;

// Time-series streams loaded in 30 s chunks. `perDriver` streams are fetched only for the selected driver.
const KINDS = {
  loc: {
    endpoint: 'location', perDriver: false, fields: ['x', 'y'],
    sample: { lerp: ['x', 'y'], step: [] },
    skip: (r) => r.x === 0 && r.y === 0, // no-signal samples
  },
  int: {
    endpoint: 'intervals', perDriver: false, fields: ['interval', 'gap_to_leader'],
    sample: { lerp: [], step: ['interval', 'gap_to_leader'] },
  },
  car: {
    endpoint: 'car_data', perDriver: true, fields: ['speed', 'rpm', 'throttle', 'n_gear', 'brake', 'drs'],
    sample: { lerp: ['speed', 'rpm', 'throttle'], step: ['n_gear', 'brake', 'drs'] },
  },
};
const COMPOUND_LETTER = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };
const INFO_INTERVAL_MS = 200; // how often the text panels refresh
const TICK_MS = 16; // playback clock
const OVERLAY_FRAME_MS = 33; // ~30 fps to the overlay window
const DEFAULT_LIVE_DELAY_S = 6; // how far behind the live edge playback runs
const MAX_LIVE_DELAY_S = 120; // enough to line up with a delayed TV broadcast
const DEMO_LEAD_MS = 60_000; // demo live starts this long before lights out
const FRESH_WINDOW_MS = 120_000; // chunks this close to the live edge are not cached
const MAX_GAP_MS = 2500; // don't interpolate across larger holes in data
const RPM_MAX = 13000;
const TRACE_WINDOW_MS = 20_000;

const $ = (sel) => document.querySelector(sel);

/** The delay is a viewing preference, so it outlives the session. */
function loadLiveDelayMs() {
  try {
    const saved = Number(localStorage.getItem('liveDelayS'));
    if (Number.isFinite(saved) && saved >= 0 && saved <= MAX_LIVE_DELAY_S && localStorage.getItem('liveDelayS') !== null) {
      return saved * 1000;
    }
  } catch {
    // storage unavailable: fall back to the default
  }
  return DEFAULT_LIVE_DELAY_S * 1000;
}
const el = {
  year: $('#year'), race: $('#race'), pin: $('#pin'), status: $('#status'),
  map: $('#map'), buffering: $('#buffering'), rows: $('#rows'),
  lapinfo: $('#lapinfo'), trackstatus: $('#trackstatus'), weather: $('#weather'), rcfeed: $('#rcfeed'),
  telColor: $('#tel-color'), telName: $('#tel-name'), telBody: $('#tel-body'),
  spd: $('#spd'), gear: $('#gear'), drs: $('#drs'),
  rpm: $('#rpm'), rpmV: $('#rpm-v'), thr: $('#thr'), thrV: $('#thr-v'), brk: $('#brk'),
  trace: $('#trace'),
  lapCur: $('#lap-cur'), lapLast: $('#lap-last'), lapBest: $('#lap-best'),
  traps: $('#traps'), stints: $('#stints'), pits: $('#pits'),
  play: $('#play'), speed: $('#speed'), seek: $('#seek'), clock: $('#clock'),
  compare: $('#compare'), cmpSelect: $('#cmp-select'), cmpMode: $('#cmp-mode'), cmpClose: $('#cmp-close'),
  cardA: $('#card-a'), cardB: $('#card-b'), cmpGap: $('#cmp-gap'), cmpBody: $('#cmp-body'),
  thA: $('#th-a'), thB: $('#th-b'), cmpReadout: $('#cmp-readout'),
  cmpSpeed: $('#cmp-speed'), cmpDelta: $('#cmp-delta'),
  lang: $('#lang'), liveDelayWrap: $('#live-delay-wrap'), liveDelay: $('#live-delay'),
  liveBtn: $('#live-btn'), livePill: $('#live-pill'), liveDialog: $('#live-dialog'),
  liveAccount: $('#live-account'), liveFields: $('#live-fields'), liveUser: $('#live-user'),
  liveUsername: $('#live-username'), livePassword: $('#live-password'), liveRemember: $('#live-remember'),
  liveMsg: $('#live-msg'), liveGo: $('#live-go'), liveDemo: $('#live-demo'),
  liveCancel: $('#live-cancel'), liveLogout: $('#live-logout'),
  ovToggle: $('#ov-toggle'), ovLock: $('#ov-lock'), ovSize: $('#ov-size'),
  ovOpacity: $('#ov-opacity'), ovBg: $('#ov-bg'),
};

// English is the default language; an explicit choice is remembered
function loadLocale() {
  try {
    return localStorage.getItem('locale') || I18n.DEFAULT_LOCALE;
  } catch {
    return I18n.DEFAULT_LOCALE;
  }
}
I18n.init(loadLocale());

const state = {
  token: 0, // bumped on every session switch; stale async results are dropped
  session: null,
  drivers: new Map(), // number -> { num, acr, name, team, color }
  outline: [], // [{x, y}] one clean lap
  bounds: null,
  raceStart: 0,
  start: 0,
  end: 0,
  t: 0, // current simulated time, epoch ms
  playing: false,
  speed: 1,
  scrubbing: false,
  selected: null,
  model: null, // Race.build(...) result
  raw: null, // low-rate datasets behind the model (set per session)
  live: newLiveState(),
  liveDelay: loadLiveDelayMs(), // ms behind the live edge
  races: [], // recorded races of the selected season
  loc: new Map(), // chunk idx -> Map(driver -> cols)
  int: new Map(), // same shape as loc
  car: new Map(), // driver -> Map(chunk idx -> cols)
  positions: new Map(), // driver -> { t: [], p: [] }
  pending: new Set(),
  retryAt: new Map(),
  carScreen: [], // [{ num, x, y }] from the last draw
  rows: new Map(), // driver -> board row elements
  lastInfo: 0,
  infoKeys: {},
  order: [], // [{ d, pos }] from the last board update
  hud: { pre: true, lapNo: 1, total: null, status: 'GREEN' }, // mirrored to the overlay
  statusMsg: null, // { key, params } of the status line, so it can be re-translated
  overlayStatus: null,
  selInfo: null, // selected-driver summary mirrored to the overlay
  cmp: { b: null, mode: 'last', key: '', data: null, rows: null, hover: null }, // second driver for comparison
  overlayOpen: false,
  lastTick: 0,
  lastPush: 0,
};

// ───────────────────────── helpers ─────────────────────────

const iso = (ms) => new Date(ms).toISOString().slice(0, -1); // OpenF1 takes UTC without the Z
const chunkOf = (ms) => Math.floor(ms / CH);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function setStatus(text) {
  state.statusMsg = null;
  el.status.textContent = text;
}

/** A status line that is re-translated when the language changes. */
function setStatusT(key, params) {
  state.statusMsg = { key, params };
  el.status.textContent = I18n.t(key, params);
}

/** An error carrying its translation key. */
function fail(key, params) {
  const err = new Error(I18n.t(key, params));
  err.i18n = { key, params };
  return err;
}

/** User-facing text for an error: our own keys, error codes from the main process, or the raw message. */
function errorText(err) {
  if (err?.i18n) return I18n.t(err.i18n.key, err.i18n.params);
  if (err?.code && I18n.has(`err.${err.code}`)) return I18n.t(`err.${err.code}`, { detail: err.detail ?? err.message });
  return err?.message ?? String(err);
}

/** Turn an `{ ok: false, error, code, detail }` reply from the main process into an Error. */
const replyError = (res) => Object.assign(new Error(res.error), { code: res.code, detail: res.detail });

function fmtClock(ms) {
  const rel = Math.round((ms - state.raceStart) / 1000);
  const sign = rel < 0 ? '-' : '';
  const s = Math.abs(rel);
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${sign}${h}:${m}:${sec}`;
}

/**
 * Value of a time series at time T. `get(idx)` returns the columns of chunk
 * idx. Numeric `lerp` fields are interpolated, `step` fields hold the last value.
 */
function sampleAt(get, T, { lerp, step }) {
  const idx = chunkOf(T);
  let pc; let pi = -1; let nc; let ni = -1;

  const cur = get(idx);
  if (cur && cur.t.length) {
    const i = upperBound(cur.t, T);
    if (i > 0) { pc = cur; pi = i - 1; }
    if (i < cur.t.length) { nc = cur; ni = i; }
  }
  if (!pc) {
    const prev = get(idx - 1);
    if (prev && prev.t.length) { pc = prev; pi = prev.t.length - 1; }
  }
  if (!nc) {
    const next = get(idx + 1);
    if (next && next.t.length) { nc = next; ni = 0; }
  }
  if (!pc && !nc) return null;

  const a = pc || nc; const ai = pc ? pi : ni;
  const out = {};
  const canLerp = pc && nc && nc.t[ni] - pc.t[pi] < MAX_GAP_MS && nc.t[ni] > pc.t[pi];
  const f = canLerp ? (T - pc.t[pi]) / (nc.t[ni] - pc.t[pi]) : 0;

  for (const k of lerp) {
    out[k] = canLerp ? a[k][ai] + (nc[k][ni] - a[k][ai]) * f : a[k][ai];
  }
  for (const k of step) out[k] = a[k][ai];
  return out;
}

const sampleLoc = (drv, T) => sampleAt((i) => state.loc.get(i)?.get(drv), T, KINDS.loc.sample);
const sampleInt = (drv, T) => sampleAt((i) => state.int.get(i)?.get(drv), T, KINDS.int.sample);
const sampleCar = (drv, T) => sampleAt((i) => state.car.get(drv)?.get(i), T, KINDS.car.sample);

// ───────────────────────── stores ─────────────────────────
// Time series live in chunk stores (30 s each). REST chunks and the live stream
// both merge into them through insertRow, which keeps columns sorted and drops
// duplicates, so the two sources may overlap freely.

function newCols(fields) {
  const cols = { t: [] };
  for (const f of fields) cols[f] = [];
  return cols;
}

/** Columns of (kind, driver, chunk); created on demand when `create` is set. */
function colsFor(kind, drv, idx, create) {
  if (kind === 'car') {
    let byChunk = state.car.get(drv);
    if (!byChunk) {
      if (!create) return undefined;
      state.car.set(drv, (byChunk = new Map()));
    }
    let cols = byChunk.get(idx);
    if (!cols && create) byChunk.set(idx, (cols = newCols(KINDS.car.fields)));
    return cols;
  }
  let byDriver = state[kind].get(idx);
  if (!byDriver) {
    if (!create) return undefined;
    state[kind].set(idx, (byDriver = new Map()));
  }
  let cols = byDriver.get(drv);
  if (!cols && create) byDriver.set(drv, (cols = newCols(KINDS[kind].fields)));
  return cols;
}

function insertRow(cols, fields, t, row) {
  const n = cols.t.length;
  let i = n;
  if (n && t <= cols.t[n - 1]) {
    i = upperBound(cols.t, t);
    if (i > 0 && cols.t[i - 1] === t) return; // duplicate
  }
  if (i === n) {
    cols.t.push(t);
    for (const f of fields) cols[f].push(row[f]);
  } else {
    cols.t.splice(i, 0, t);
    for (const f of fields) cols[f].splice(i, 0, row[f]);
  }
}

/** Merge rows (any drivers, any chunks) into the chunk stores. */
function ingestSeries(kind, rows) {
  const cfg = KINDS[kind];
  for (const r of rows) {
    if (cfg.skip?.(r)) continue;
    const t = Date.parse(r.date);
    insertRow(colsFor(kind, r.driver_number, chunkOf(t), true), cfg.fields, t, r);
  }
}

/** A fetched chunk counts as loaded even when it had no rows. */
function markLoaded(kind, drv, idx) {
  if (kind === 'car') colsFor('car', drv, idx, true);
  else if (!state[kind].has(idx)) state[kind].set(idx, new Map());
}

function addPositions(rows) {
  for (const p of rows) {
    let s = state.positions.get(p.driver_number);
    if (!s) state.positions.set(p.driver_number, (s = { t: [], p: [] }));
    const t = Date.parse(p.date);
    const n = s.t.length;
    if (!n || t > s.t[n - 1]) {
      s.t.push(t); s.p.push(p.position);
    } else {
      const i = upperBound(s.t, t);
      if (i > 0 && s.t[i - 1] === t) s.p[i - 1] = p.position;
      else { s.t.splice(i, 0, t); s.p.splice(i, 0, p.position); }
    }
  }
}

// Low-rate datasets (laps, stints, ...) keep their rows plus a key index so a
// changed row (a lap gaining a sector time) replaces the earlier version.
const RAW_KEYS = {
  laps: (r) => `${r.driver_number}:${r.lap_number}`,
  stints: (r) => `${r.driver_number}:${r.stint_number}`,
  pits: (r) => `${r.driver_number}:${r.date}`,
  control: (r) => `${r.date}:${r.message}`,
  weather: (r) => r.date,
};
const TOPIC_RAW = { laps: 'laps', stints: 'stints', pit: 'pits', race_control: 'control', weather: 'weather' };

const makeRaw = () => Object.fromEntries(Object.keys(RAW_KEYS).map((k) => [k, { rows: [], idx: new Map() }]));

function upsertRaw(name, rows) {
  const store = state.raw[name];
  for (const r of rows) {
    const key = RAW_KEYS[name](r);
    const i = store.idx.get(key);
    if (i === undefined) {
      store.idx.set(key, store.rows.length);
      store.rows.push(r);
    } else {
      store.rows[i] = r;
    }
  }
}

function rebuildModel() {
  state.model = Race.build(Object.fromEntries(Object.entries(state.raw).map(([k, v]) => [k, v.rows])));
  const starts = state.raw.laps.rows
    .filter((l) => l.lap_number === 1)
    .map((l) => Date.parse(l.date_start))
    .filter(Number.isFinite);
  state.raceStart = starts.length ? Math.min(...starts) : Date.parse(state.session.date_start);
}

// ───────────────────────── data loading ─────────────────────────

const get = (endpoint, params, opts) => window.f1.get(endpoint, params, opts);

/** Demo live replays a recorded session, so anything after the replay clock hasn't "happened" yet. */
function clipRows(rows, field) {
  if (!state.live.demo) return rows;
  const edge = liveEdge();
  return rows.filter((r) => !(Date.parse(r[field]) > edge));
}

async function loadChunk(kind, drv, idx) {
  const key = `${kind}:${drv ?? ''}:${idx}`;
  if (state.pending.has(key)) return;
  if ((state.retryAt.get(key) ?? 0) > Date.now()) return;

  const cfg = KINDS[kind];
  state.pending.add(key);
  const token = state.token;
  const params = {
    session_key: state.session.session_key,
    'date>=': iso(idx * CH),
    'date<': iso((idx + 1) * CH),
  };
  if (cfg.perDriver) params.driver_number = drv;
  // chunks near the live edge are still changing: never cache them
  const fresh = state.live.on && (idx + 1) * CH > liveEdge() - FRESH_WINDOW_MS;

  try {
    const rows = await get(cfg.endpoint, params, { cache: !fresh });
    if (token !== state.token) return;
    ingestSeries(kind, clipRows(rows, 'date'));
    markLoaded(kind, drv, idx);
    state.retryAt.delete(key);
  } catch (err) {
    console.warn('chunk failed', key, err);
    state.retryAt.set(key, Date.now() + 3000);
  } finally {
    state.pending.delete(key);
  }
}

/** Request chunks around the playhead; the main process serialises and caches them. */
function pump() {
  if (!state.session) return;
  const base = chunkOf(state.t);
  const ahead = Math.min(6, 1 + Math.ceil(state.speed / 4));
  for (let i = 0; i <= ahead; i++) {
    const idx = base + i;
    if (idx * CH > state.end) break; // in live mode `end` is the live edge
    if (!state.loc.has(idx)) loadChunk('loc', null, idx);
    if (!state.int.has(idx)) loadChunk('int', null, idx);
    for (const drv of [state.selected, state.cmp.b]) {
      if (drv != null && !state.car.get(drv)?.has(idx)) loadChunk('car', drv, idx);
    }
  }
  // the chunk just behind the playhead is needed for interpolation after a seek
  if (base > 0 && !state.loc.has(base - 1)) loadChunk('loc', null, base - 1);
  if (base > 0 && !state.int.has(base - 1)) loadChunk('int', null, base - 1);
}

async function loadSession(session, { live = false } = {}) {
  if (!live) await stopLive(); // opening a recorded race ends live mode
  const token = ++state.token;
  Object.assign(state, {
    session, drivers: new Map(), outline: [], bounds: null, playing: false,
    selected: null, model: null, loc: new Map(), int: new Map(), car: new Map(), positions: new Map(),
    pending: new Set(), retryAt: new Map(), carScreen: [], rows: new Map(), infoKeys: {}, selInfo: null,
    raw: makeRaw(),
  });
  state.cmp.b = null;
  resetCompare();
  setPlaying(false);
  renderTelemetryHeader();
  el.rows.replaceChildren();
  setStatusT(live ? 'live.loadingSession' : 'status.loading');

  const sk = session.session_key;
  const opts = { cache: !live };
  try {
    // the main process serialises these behind the API rate limit
    const q = { session_key: sk };
    const [drivers, laps, stints, pits, control, weather, positions] = await Promise.all([
      get('drivers', q, opts), get('laps', q, opts), get('stints', q, opts), get('pit', q, opts),
      get('race_control', q, opts), get('weather', q, opts), get('position', q, opts),
    ]);
    if (token !== state.token) return;

    upsertRaw('laps', clipRows(laps, 'date_start'));
    upsertRaw('stints', stints);
    upsertRaw('pits', clipRows(pits, 'date'));
    upsertRaw('control', clipRows(control, 'date'));
    upsertRaw('weather', clipRows(weather, 'date'));
    rebuildModel();

    for (const d of drivers) {
      state.drivers.set(d.driver_number, {
        num: d.driver_number,
        acr: d.name_acronym,
        name: d.full_name,
        team: d.team_name,
        color: `#${d.team_colour || '888888'}`,
      });
    }
    addPositions(clipRows(positions, 'date'));

    state.start = Date.parse(session.date_start);
    if (live) {
      state.end = liveEdge();
      state.t = state.end - state.liveDelay;
    } else {
      state.end = Date.parse(session.date_end);
      state.t = Math.max(state.start, state.raceStart - 15_000);
    }
    el.seek.min = state.start;
    el.seek.max = state.end;
    el.seek.value = state.t;

    buildBoard();
    const source = await outlineSource(session, laps);
    if (token !== state.token) return;
    await loadOutline(source.sessionKey, source.laps, token);
    if (token !== state.token) return;
    sendOverlaySession();

    if (live) {
      await bootstrapLiveHead(token);
      if (token !== state.token) return;
      setStatusT('live.at', { loc: session.location });
    } else {
      setStatus(`${session.location} · ${session.year}`);
    }
    setPlaying(true);
  } catch (err) {
    if (token !== state.token) return;
    console.error(err);
    setStatusT('status.loadError', { msg: errorText(err) });
  }
}

/**
 * Lap-2 rows to trace the track from. A live session may not have completed a
 * lap yet; then the shape is borrowed from the last race at the same circuit.
 */
async function outlineSource(session, laps) {
  const own = laps.filter((l) => l.lap_number === 2 && l.date_start && l.lap_duration);
  if (own.length) return { sessionKey: session.session_key, laps: own };

  const past = await get('sessions', { circuit_key: session.circuit_key, session_name: 'Race' });
  const previous = past
    .filter((s) => s.session_key !== session.session_key && Date.parse(s.date_end) < Date.now())
    .sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start))[0];
  if (!previous) throw fail('err.noOutlineData');
  return { sessionKey: previous.session_key, laps: await get('laps', { session_key: previous.session_key, lap_number: 2 }) };
}

/** Track shape = the location trace of one representative lap. */
async function loadOutline(sessionKey, laps2, token) {
  const candidates = laps2
    .filter((l) => l.date_start && l.lap_duration)
    .sort((a, b) => a.lap_duration - b.lap_duration);
  if (!candidates.length) throw fail('err.noLapForMap');

  const lap = candidates[Math.floor(candidates.length / 4)];
  const from = Date.parse(lap.date_start);
  const rows = await get('location', {
    session_key: sessionKey,
    driver_number: lap.driver_number,
    'date>=': iso(from),
    'date<': iso(from + lap.lap_duration * 1000),
  });
  if (token !== state.token) return;

  const pts = rows.filter((r) => r.x !== 0 || r.y !== 0).map((r) => ({ x: r.x, y: r.y }));
  if (pts.length < 10) throw fail('err.outlineFailed');
  state.outline = pts;

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  state.bounds = {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

// ───────────────────────── playback ─────────────────────────

function setPlaying(on) {
  state.playing = on;
  el.play.textContent = on ? '❚❚' : '▶';
}

function selectDriver(num) {
  state.selected = state.selected === num ? null : num;
  state.infoKeys = {};
  state.lastInfo = 0; // refresh the panels on the next frame
  if (state.cmp.b === state.selected) state.cmp.b = null; // can't compare a driver with themselves
  resetCompare();
  renderTelemetryHeader();
}

/** Shift-click: pick the comparison driver (the first plain click picks the main one). */
function compareWith(num) {
  if (state.selected == null) selectDriver(num);
  else if (num !== state.selected) setCompare(num === state.cmp.b ? null : num);
}

function renderTelemetryHeader() {
  const d = state.drivers.get(state.selected);
  el.telBody.hidden = !d;
  el.telName.classList.toggle('on', Boolean(d));
  el.telName.textContent = d ? `${d.name} · ${d.team}` : I18n.t('tel.hint');
  el.telColor.style.background = d ? d.color : '';
}

// ───────────────────────── drawing ─────────────────────────

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Current map position of every driver we have data for. */
function samplePositions() {
  const out = [];
  for (const d of state.drivers.values()) {
    const s = sampleLoc(d.num, state.t);
    if (s) out.push({ d, x: s.x, y: s.y });
  }
  return out;
}

function drawMap() {
  const ctx = fitCanvas(el.map);
  const w = el.map.clientWidth;
  const h = el.map.clientHeight;
  ctx.clearRect(0, 0, w, h);
  state.carScreen = [];
  if (!state.bounds) return;

  const proj = TrackMap.makeProjection(state.bounds, w, h);

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const path = TrackMap.trackPath(state.outline, proj);
  ctx.lineWidth = 16; ctx.strokeStyle = '#1e2330'; ctx.stroke(path);
  ctx.lineWidth = 12; ctx.strokeStyle = '#2b3243'; ctx.stroke(path);

  // start/finish tick
  const [sx, sy] = proj(state.outline[0].x, state.outline[0].y);
  ctx.fillStyle = '#e8eaf0';
  ctx.fillRect(sx - 1.5, sy - 11, 3, 22);

  const cars = [];
  for (const { d, x: wx, y: wy } of samplePositions()) {
    const [x, y] = proj(wx, wy);
    cars.push({ d, x, y });
    state.carScreen.push({ num: d.num, x, y });
  }
  // selected car last, so it's drawn on top
  cars.sort((a, b) => (a.d.num === state.selected) - (b.d.num === state.selected));

  ctx.font = '600 10px -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  for (const { d, x, y } of cars) {
    const sel = d.num === state.selected;
    if (sel) {
      ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.strokeStyle = d.color; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, sel ? 7 : 5.5, 0, Math.PI * 2);
    ctx.fillStyle = d.color; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#0b0d12'; ctx.stroke();

    ctx.fillStyle = sel ? '#fff' : '#aab0c0';
    ctx.fillText(d.acr, x + (sel ? 17 : 10), y);
  }
}

function currentOrder() {
  const rows = [];
  for (const d of state.drivers.values()) {
    const s = state.positions.get(d.num);
    let pos = 99;
    if (s && s.t.length) {
      const i = upperBound(s.t, state.t);
      pos = s.p[Math.max(0, i - 1)];
    }
    rows.push({ d, pos });
  }
  return rows.sort((a, b) => a.pos - b.pos || a.d.num - b.d.num);
}

const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const setClass = (node, cls) => { if (node.className !== cls) node.className = cls; };
const fmtGap = (v) => (v == null ? '' : typeof v === 'string' ? v : `+${v.toFixed(1)}`);

function labelled(label, value) {
  const span = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = value;
  span.append(`${label} `, b);
  return span;
}

function tyreDot(compound) {
  const dot = document.createElement('i');
  dot.className = `dot c-${compound}`;
  dot.textContent = COMPOUND_LETTER[compound] ?? '?';
  return dot;
}

/** Board rows are created once and updated in place, so clicks never hit a node that's being replaced. */
function buildBoard() {
  const frag = document.createDocumentFragment();
  for (const d of state.drivers.values()) {
    const row = document.createElement('div');
    row.addEventListener('click', (e) => (e.shiftKey ? compareWith(d.num) : selectDriver(d.num)));
    const cells = {};
    for (const name of ['pos', 'tc', 'acr', 'tyre', 'int', 'gap', 'lap']) {
      cells[name] = document.createElement('span');
      cells[name].className = name;
      row.append(cells[name]);
    }
    cells.tc.style.background = d.color;
    cells.acr.textContent = d.acr;
    cells.dot = document.createElement('i');
    cells.age = document.createElement('b');
    cells.tyre.append(cells.dot, cells.age);
    state.rows.set(d.num, { row, cells });
    frag.append(row);
  }
  el.rows.append(frag);

  el.cmpSelect.replaceChildren(
    new Option(I18n.t('tel.pick'), ''),
    ...[...state.drivers.values()].map((d) => new Option(`${d.acr} · ${d.name}`, d.num)),
  );
}

function updateBoard() {
  const { model } = state;
  const order = currentOrder();
  order.forEach(({ d, pos }, i) => {
    const { row, cells } = state.rows.get(d.num);
    if (row.style.order !== String(i)) row.style.order = i;
    setClass(row, `row${d.num === state.selected ? ' sel' : ''}`);
    setText(cells.pos, pos === 99 ? '–' : String(pos));

    const tyre = model.tyre(d.num, state.t);
    setClass(cells.dot, `dot c-${tyre?.compound}`);
    setText(cells.dot, COMPOUND_LETTER[tyre?.compound] ?? '');
    const pitting = model.inPit(d.num, state.t);
    setClass(cells.age, pitting ? 'pit' : '');
    setText(cells.age, pitting ? 'PIT' : tyre ? String(tyre.age) : '');

    const iv = sampleInt(d.num, state.t);
    setText(cells.int, i === 0 ? '' : fmtGap(iv?.interval));
    setText(cells.gap, i === 0 ? I18n.t('board.leader') : fmtGap(iv?.gap_to_leader));

    const last = model.lastLap(d.num, state.t);
    const b = model.bests(d.num, state.t);
    setText(cells.lap, last == null ? '' : fmtLap(last));
    setClass(cells.lap, `lap ${model.grade(last, b.personal[3], b.overall[3])}`);
  });
  state.order = order;
  return order;
}

/** Lap counter, flag status, weather and the race-control feed over the map. */
function updateHud(order) {
  const { model } = state;
  const T = state.t;

  const leader = order[0]?.d.num;
  const lap = leader != null ? model.lapNumber(leader, T) : 0;
  // the total is only known for a finished recording
  const hud = {
    pre: T < state.raceStart,
    lapNo: Math.max(1, lap),
    total: state.live.on ? null : model.totalLaps,
    status: model.trackStatus(T),
  };
  const { status } = hud;
  state.hud = hud;
  setText(el.lapinfo, I18n.lapLabel(hud));
  setText(el.trackstatus, I18n.t(`status.${status}`));
  setClass(el.trackstatus, `chip ${status}`);

  const w = model.weatherAt(T);
  const wKey = w ? [w.air_temperature, w.track_temperature, w.wind_speed, w.rainfall].join() : '';
  if (state.infoKeys.weather !== wKey) {
    state.infoKeys.weather = wKey;
    el.weather.replaceChildren(...(w ? [
      labelled(I18n.t('wx.air'), `${w.air_temperature}°`),
      labelled(I18n.t('wx.track'), `${w.track_temperature}°`),
      labelled(I18n.t('wx.wind'), `${w.wind_speed} ${I18n.t('unit.ms')}`),
      labelled(I18n.t('wx.rain'), I18n.t(w.rainfall ? 'wx.yes' : 'wx.no')),
    ] : []));
  }

  const msgs = model.recentMessages(T, 3);
  const mKey = msgs.map((m) => m.t + m.message).join();
  if (state.infoKeys.feed !== mKey) {
    state.infoKeys.feed = mKey;
    el.rcfeed.replaceChildren(...msgs.map((m) => {
      const div = document.createElement('div');
      div.textContent = `${m.lap_number ? I18n.t('feed.lap', { n: m.lap_number }) : ''}${m.message}`;
      return div;
    }));
  }
}

function fillLapRow(tr, label, values, grades) {
  setText(tr.children[0], label);
  for (let k = 0; k < 4; k++) {
    const td = tr.children[k + 1];
    setText(td, k < 3 ? fmtSector(values[k]) : fmtLap(values[k]));
    setClass(td, grades[k] ?? '');
  }
}

/** Sectors, speed traps, tyre stints and pit stops of the selected driver. */
function updateDriverPanel() {
  const num = state.selected;
  if (num == null) return;
  const { model } = state;
  const T = state.t;
  const none = [null, null, null, null];

  const sec = model.sectors(num, T);
  const b = model.bests(num, T);
  const grades = (values) => values.map((v, k) => model.grade(v, b.personal[k], b.overall[k]));

  fillLapRow(el.lapCur, sec ? I18n.t('lap.current', { n: sec.n }) : I18n.t('lap.currentNone'), sec?.cur ?? none, sec ? grades(sec.cur) : []);
  fillLapRow(el.lapLast, sec?.last ? I18n.t('lap.current', { n: sec.last.n }) : I18n.t('lap.last'), sec?.last?.v ?? none, sec?.last ? grades(sec.last.v) : []);
  fillLapRow(el.lapBest, I18n.t('lap.best'), b.personal, b.personal.map((v, k) => model.grade(v, v, b.overall[k])));

  const last = sec?.last;
  setText(el.traps, last ? I18n.t('lap.trapsLine', { i1: last.i1 ?? '–', i2: last.i2 ?? '–', st: last.st ?? '–' }) : '–');

  // stints that have started so far
  const stints = model.stintsOf(num);
  const cur = model.tyre(num, T)?.stint ?? -1;
  const stintKey = `${num}|${cur}|${stints.map((s) => `${s.compound}${s.lap_start}${s.lap_end}`).join()}`;
  if (state.infoKeys.stints !== stintKey) {
    state.infoKeys.stints = stintKey;
    el.stints.replaceChildren(...stints.slice(0, cur + 1).map((s, i) => {
      const chip = document.createElement('span');
      chip.className = `chip-stint${i === cur ? ' now' : ''}`;
      chip.append(tyreDot(s.compound), I18n.t('stint.range', { from: s.lap_start, to: i === cur ? '…' : s.lap_end }));
      return chip;
    }));
  }

  const pits = model.pitsOf(num, T);
  const pitKey = `${num}|${pits.length}`;
  if (state.infoKeys.pits !== pitKey) {
    state.infoKeys.pits = pitKey;
    el.pits.replaceChildren(...(pits.length ? pits.map((p) => {
      const div = document.createElement('div');
      const right = document.createElement('b');
      right.textContent = `${p.lane != null ? `${p.lane.toFixed(1)} ${I18n.t('unit.s')}` : '–'}${p.stop != null ? ` · ${I18n.t('pits.stationary', { s: p.stop.toFixed(1) })}` : ''}`;
      div.append(I18n.t('pits.lap', { n: p.lap }), right);
      return div;
    }) : [I18n.t('pits.none')]));
  }
}

function updateTelemetry() {
  if (state.selected == null) return;
  const s = sampleCar(state.selected, state.t);

  const speed = s ? Math.round(s.speed) : 0;
  el.spd.textContent = s ? speed : '–';
  el.gear.textContent = s ? (s.n_gear === 0 ? 'N' : s.n_gear) : '–';
  el.rpm.style.width = `${s ? clamp(s.rpm / RPM_MAX, 0, 1) * 100 : 0}%`;
  el.rpmV.textContent = s ? Math.round(s.rpm) : '';
  el.thr.style.width = `${s ? clamp(s.throttle, 0, 100) : 0}%`;
  el.thrV.textContent = s ? `${Math.round(s.throttle)}%` : '';
  el.brk.style.width = s && s.brake > 0 ? '100%' : '0%';

  const drs = s ? s.drs : 0;
  el.drs.className = `drs${drs >= 10 ? ' open' : drs === 8 ? ' eligible' : ''}`;

  drawTrace();
}

function drawTrace() {
  const ctx = fitCanvas(el.trace);
  const w = el.trace.clientWidth;
  const h = el.trace.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const t0 = state.t - TRACE_WINDOW_MS;
  const idx = chunkOf(state.t);
  const pts = [];
  for (const i of [idx - 1, idx]) {
    const c = state.car.get(state.selected)?.get(i);
    if (!c) continue;
    for (let k = 0; k < c.t.length; k++) {
      if (c.t[k] >= t0 && c.t[k] <= state.t) pts.push([c.t[k], c.speed[k], c.throttle[k]]);
    }
  }

  ctx.strokeStyle = '#222733'; ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75]) {
    ctx.beginPath(); ctx.moveTo(0, h * frac); ctx.lineTo(w, h * frac); ctx.stroke();
  }
  if (pts.length < 2) return;

  const X = (t) => ((t - t0) / TRACE_WINDOW_MS) * w;
  const draw = (col, max, color) => {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = X(p[0]); const y = h - 3 - (p[col] / max) * (h - 6);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
  };
  draw(2, 100, 'rgba(46,204,113,.6)');
  draw(1, 360, '#4da3ff');
}

// ───────────────────────── live ─────────────────────────
// Live mode follows the data's "now" (wall clock minus the replay offset) a few
// seconds behind, so interpolation always has a next sample. Everything older
// than the live edge can be scrubbed like a recording (DVR).

function newLiveState() {
  return {
    on: false, demo: false, ready: false, following: true, offset: 0,
    buffer: [], lastRowT: 0, modelDirty: false, lastRebuild: 0, backfilling: false, connection: '',
  };
}

/** Data-time "now": real time for the OpenF1 stream, shifted for the demo replay. */
const liveEdge = () => Date.now() - state.live.offset;

function updateLiveUi() {
  const { on } = state.live;
  el.liveBtn.classList.toggle('on', on);
  el.liveBtn.textContent = I18n.t(on ? 'btn.liveExit' : 'btn.live');
}

function updateLivePill() {
  const live = state.live.on && state.live.ready;
  el.livePill.hidden = !live;
  el.liveDelayWrap.hidden = !live;
  if (!live) return;
  if (document.activeElement !== el.liveDelay) el.liveDelay.value = Math.round(state.liveDelay / 1000);

  if (state.live.following) {
    setText(el.livePill, I18n.t('live.pill', { s: Math.round(state.liveDelay / 1000) }));
    setClass(el.livePill, 'live');
    el.livePill.disabled = true;
  } else {
    const behind = Math.max(0, Math.round((liveEdge() - state.liveDelay - state.t) / 1000));
    setText(el.livePill, I18n.t('live.behind', { m: Math.floor(behind / 60), ss: String(behind % 60).padStart(2, '0') }));
    setClass(el.livePill, 'behind');
    el.livePill.disabled = false;
  }
  el.speed.disabled = state.live.following;
}

/** The most recent session, if it is on track (or about to be); otherwise explain what's next. */
async function findLiveSession() {
  const [latest] = await get('sessions', { session_key: 'latest' }, { cache: false });
  const now = Date.now();
  if (latest && now >= Date.parse(latest.date_start) - 15 * 60_000 && now <= Date.parse(latest.date_end) + 30 * 60_000) {
    return latest;
  }

  const upcoming = (await get('sessions', { 'date_start>=': iso(now) }, { cache: false }))
    .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start))[0];
  const next = upcoming
    ? I18n.t('live.next', { name: upcoming.session_name, loc: upcoming.location, when: I18n.formatDateTime(upcoming.date_start) })
    : '';
  throw new Error(I18n.t('live.noSession') + next);
}

async function startLive({ demo }) {
  let session;
  let virtualStart = null;
  if (demo) {
    if (!state.session) throw fail('live.waitRace');
    session = state.session;
    virtualStart = state.raceStart - DEMO_LEAD_MS; // the replay starts a minute before lights out
  } else {
    session = await findLiveSession();
  }

  // rows start arriving as soon as the feed is up; they wait in `buffer` until the bootstrap is done
  state.live = { ...newLiveState(), on: true, demo };
  const res = await window.f1.live.start({ sessionKey: session.session_key, demo, virtualStart });
  if (!res.ok) {
    state.live = newLiveState();
    updateLiveUi();
    throw replyError(res);
  }
  state.live.offset = res.offset;
  updateLiveUi();
  await loadSession(session, { live: true });
}

async function stopLive() {
  if (!state.live.on) return;
  state.live = newLiveState();
  updateLiveUi();
  updateLivePill();
  el.speed.disabled = false;
  await window.f1.live.stop();
}

/** History near the live edge over REST, then replay what the stream delivered meanwhile. */
async function bootstrapLiveHead(token) {
  const edge = liveEdge();
  for (const idx of [chunkOf(edge) - 1, chunkOf(edge)]) {
    for (const kind of ['loc', 'int', 'car']) {
      const rows = await get(KINDS[kind].endpoint, {
        session_key: state.session.session_key,
        'date>=': iso(idx * CH),
        'date<': iso((idx + 1) * CH),
      }, { cache: false });
      if (token !== state.token) return;
      ingestSeries(kind, clipRows(rows, 'date'));
      if (kind !== 'car') markLoaded(kind, null, idx);
    }
  }

  state.live.ready = true;
  for (const batch of state.live.buffer) ingestLive(batch);
  state.live.buffer = [];
  state.live.modelDirty = true;
}

/** Merge one batch of stream rows: [{ topic, rows }]. */
function ingestLive(batch) {
  const live = state.live;
  for (const { topic, rows } of batch) {
    const last = rows.at(-1);
    const t = Date.parse(last?.date ?? last?.date_start);
    if (t > live.lastRowT) live.lastRowT = t;

    if (topic === 'location') ingestSeries('loc', rows);
    else if (topic === 'car_data') ingestSeries('car', rows);
    else if (topic === 'intervals') ingestSeries('int', rows);
    else if (topic === 'position') addPositions(rows);
    else if (TOPIC_RAW[topic]) {
      upsertRaw(TOPIC_RAW[topic], rows);
      live.modelDirty = true;
    }
  }
}

function onLiveRows(batch) {
  if (!state.live.on) return;
  if (state.live.ready) ingestLive(batch);
  else state.live.buffer.push(batch);
}

/** After a dropped connection: fetch what was missed over REST. Duplicates are harmless. */
async function backfill() {
  const live = state.live;
  if (live.backfilling || !live.ready) return;
  live.backfilling = true;
  const token = state.token;
  const opts = { cache: false };
  try {
    const edge = liveEdge();
    const from = live.lastRowT || edge - 60_000;
    const q = { session_key: state.session.session_key };
    for (let idx = chunkOf(from); idx <= chunkOf(edge); idx++) {
      for (const kind of ['loc', 'int', 'car']) {
        const rows = await get(KINDS[kind].endpoint, { ...q, 'date>=': iso(idx * CH), 'date<': iso((idx + 1) * CH) }, opts);
        if (token !== state.token || !state.live.on) return;
        ingestSeries(kind, clipRows(rows, 'date'));
      }
    }
    addPositions(clipRows(await get('position', { ...q, 'date>=': iso(from) }, opts), 'date'));
    upsertRaw('laps', clipRows(await get('laps', q, opts), 'date_start'));
    upsertRaw('stints', await get('stints', q, opts));
    upsertRaw('pits', clipRows(await get('pit', q, opts), 'date'));
    upsertRaw('control', clipRows(await get('race_control', q, opts), 'date'));
    upsertRaw('weather', clipRows(await get('weather', q, opts), 'date'));
    live.modelDirty = true;
  } catch (err) {
    console.warn('backfill failed', err);
  } finally {
    live.backfilling = false;
  }
}

function onLiveStatus(s) {
  const live = state.live;
  if (!live.on) return;
  const previous = live.connection;
  live.connection = s.state;

  if (s.state === 'connecting') setStatusT('live.connecting');
  else if (s.state === 'reconnecting') setStatusT('live.reconnecting');
  else if (s.state === 'error') setStatusT('live.error', { msg: errorText(s) });
  else if (s.state === 'connected') {
    if (state.session && live.ready) setStatusT('live.at', { loc: state.session.location });
    if (previous === 'reconnecting') backfill();
  }
}

// login dialog ------------------------------------------------------

function setLiveMessage(text, ok = false) {
  el.liveMsg.textContent = text;
  el.liveMsg.classList.toggle('ok', ok);
}

async function refreshLiveDialog() {
  const account = await window.f1.live.account();
  el.liveAccount.hidden = !account.loggedIn;
  el.liveFields.hidden = account.loggedIn;
  el.liveUser.textContent = account.username ?? '';
  el.liveGo.textContent = I18n.t(account.loggedIn ? 'live.start' : 'live.signInStart');
  setLiveMessage('');
}

async function openLiveDialog() {
  await refreshLiveDialog();
  el.liveDialog.showModal();
}

/** Runs an action with the dialog buttons disabled; failures are shown inside the dialog. */
async function withLiveDialog(action) {
  const buttons = el.liveDialog.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  setLiveMessage(I18n.t('live.connectingMsg'), true);
  try {
    await action();
    el.liveDialog.close();
  } catch (err) {
    setLiveMessage(errorText(err));
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

async function loginAndGoLive() {
  const account = await window.f1.live.account();
  if (!account.loggedIn) {
    const username = el.liveUsername.value.trim();
    const password = el.livePassword.value;
    if (!username || !password) throw fail('live.needCredentials');
    const res = await window.f1.live.login({ username, password, remember: el.liveRemember.checked });
    if (!res.ok) throw replyError(res);
    el.livePassword.value = '';
  }
  await startLive({ demo: false });
}

function togglePlay() {
  if (state.live.on && state.live.following) {
    state.live.following = false; // pausing a live feed means falling behind it
    setPlaying(false);
  } else {
    setPlaying(!state.playing);
  }
}

// ───────────────────────── comparison ─────────────────────────

const CHART_LEFT = 38;
const CHART_RIGHT = 6;
const CHART_STEPS = 240;
const CMP_ROWS = [{ label: 'S1' }, { label: 'S2' }, { label: 'S3' }, { key: 'cmp.lap' }, { label: 'Vmax' }];

const compareActive = () => state.cmp.b != null && state.selected != null;

function resetCompare() {
  Object.assign(state.cmp, { key: '', data: null, rows: null, hover: null });
  el.cmpSelect.value = state.cmp.b ?? '';
  el.compare.hidden = !compareActive();
}

function setCompare(num) {
  state.cmp.b = num != null && num !== state.selected ? num : null;
  state.lastInfo = 0;
  resetCompare();
}

function buildCard(root) {
  const mk = (tag, cls, parent) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    parent.append(node);
    return node;
  };
  const head = mk('div', 'c-head', root);
  const line1 = mk('div', 'c-line', root);
  // static captions are translated by I18n.apply through their data-i18n attribute
  const caption = (line, key) => {
    const label = mk('span', '', line);
    label.dataset.i18n = key;
    label.textContent = I18n.t(key);
  };
  const line2 = mk('div', 'c-line', root);
  caption(line2, 'cmp.now');
  const line3 = mk('div', 'c-line', root);
  caption(line3, 'cmp.last');
  const line4 = mk('div', 'c-line', root);
  caption(line4, 'cmp.best');
  return {
    root,
    acr: mk('span', 'c-acr', head),
    pos: mk('span', 'c-pos', head),
    dot: mk('i', 'dot', line1),
    tyre: mk('b', '', line1),
    now: mk('b', '', line2),
    last: mk('b', '', line3),
    best: mk('b', '', line4),
  };
}

function buildCompareTable() {
  return CMP_ROWS.map(({ label, key }) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    if (key) th.dataset.i18n = key;
    th.textContent = key ? I18n.t(key) : label;
    const cells = { a: document.createElement('td'), b: document.createElement('td'), d: document.createElement('td') };
    tr.append(th, cells.a, cells.b, cells.d);
    el.cmpBody.append(tr);
    return cells;
  });
}

const cards = { a: buildCard(el.cardA), b: buildCard(el.cardB) };
const cmpCells = buildCompareTable();

function setColor(node, color) { if (node.style.color !== color) node.style.color = color; }

function updateCard(card, d) {
  const { model } = state;
  const T = state.t;
  const pos = state.order.find((r) => r.d.num === d.num)?.pos;
  const tyre = model.tyre(d.num, T);
  const car = sampleCar(d.num, T);
  const last = model.lastLap(d.num, T);
  const best = model.bests(d.num, T).personal[3];

  card.root.style.borderTopColor = d.color;
  setText(card.acr, d.acr);
  setColor(card.acr, d.color);
  setText(card.pos, pos && pos !== 99 ? `P${pos}` : '');
  setClass(card.dot, `dot c-${tyre?.compound}`);
  setText(card.dot, COMPOUND_LETTER[tyre?.compound] ?? '');
  setText(card.tyre, tyre ? I18n.t('tyre.card', { n: tyre.age, age: tyre.age, stops: model.pitsOf(d.num, T).length }) : '');
  setText(card.now, car ? `${Math.round(car.speed)} ${I18n.t('unit.kmh')} · ${car.n_gear === 0 ? 'N' : car.n_gear}` : '–');
  setText(card.last, fmtLap(last));
  setText(card.best, fmtLap(best));
}

function updateGap(A, B) {
  const gA = sampleInt(A.num, state.t)?.gap_to_leader;
  const gB = sampleInt(B.num, state.t)?.gap_to_leader;
  let text = '';
  if (typeof gA === 'number' && typeof gB === 'number') {
    const [ahead] = gA <= gB ? [A] : [B];
    text = I18n.t('cmp.gap', { acr: ahead.acr, s: Math.abs(gA - gB).toFixed(1) });
  } else if (gA != null && gB != null) {
    text = I18n.t('cmp.gapLapped');
  }
  setText(el.cmpGap, text);
}

/** Fractions of the lap where sector 1 and 2 end (measured on the given trace). */
function sectorFractions(row, trace) {
  if (row.s[0] == null || row.s[1] == null) return [];
  return [row.s[0], row.s[0] + row.s[1]].map((t) => Compare.interp(trace.t, trace.frac, t));
}

async function loadCompareData(key, A, rowA, B, rowB) {
  const token = state.token;
  const cmp = state.cmp;
  const fetchTrace = async (drv, row) => {
    if (!row) return null;
    const rows = await get('car_data', {
      session_key: state.session.session_key,
      driver_number: drv,
      'date>=': iso(row.t0),
      'date<': iso(row.t0 + row.dur * 1000),
    });
    return Compare.buildTrace(rows, row.t0, row.dur * 1000);
  };

  try {
    const [a, b] = await Promise.all([fetchTrace(A, rowA), fetchTrace(B, rowB)]);
    if (token !== state.token || cmp.key !== key) return; // selection changed while loading
    cmp.data = a && b
      ? { a, b, delta: Compare.deltaSeries(a, b, CHART_STEPS), sectors: sectorFractions(rowA, a) }
      : { missing: true };
  } catch (err) {
    console.warn('compare data failed', err);
    if (cmp.key === key) cmp.data = { error: err.message };
  }
}

function updateCompareTable(A, B, rowA, rowB) {
  const data = state.cmp.data?.a ? state.cmp.data : null;
  setText(el.thA, A.acr); setColor(el.thA, A.color);
  setText(el.thB, B.acr); setColor(el.thB, B.color);

  CMP_ROWS.forEach((_, k) => {
    const cells = cmpCells[k];
    const va = k < 3 ? rowA?.s[k] : k === 3 ? rowA?.dur : data?.a.vmax;
    const vb = k < 3 ? rowB?.s[k] : k === 3 ? rowB?.dur : data?.b.vmax;
    const fmt = k < 3 ? fmtSector : k === 3 ? fmtLap : (v) => (v == null ? '–' : String(Math.round(v)));
    setText(cells.a, fmt(va));
    setText(cells.b, fmt(vb));

    const comparable = va != null && vb != null && Math.abs(va - vb) > 0.0005;
    // lower is better for times, higher for top speed
    const aWins = comparable && (k < 4 ? va < vb : va > vb);
    const winner = aWins ? A : B;
    setClass(cells.a, comparable && aWins ? 'win' : '');
    setClass(cells.b, comparable && !aWins ? 'win' : '');
    setColor(cells.a, comparable && aWins ? A.color : '');
    setColor(cells.b, comparable && !aWins ? B.color : '');

    const diff = Math.abs(va - vb);
    setText(cells.d, comparable ? `${winner.acr} ${k < 4 ? diff.toFixed(3) : I18n.t('cmp.kmh', { n: Math.round(diff) })}` : '');
    setColor(cells.d, comparable ? winner.color : '');
  });
}

function updateCompare() {
  if (!compareActive()) return;
  const { model, cmp } = state;
  const T = state.t;
  const A = state.drivers.get(state.selected);
  const B = state.drivers.get(cmp.b);
  const pick = cmp.mode === 'best' ? model.bestLapRow : model.lastLapRow;
  const rowA = pick(A.num, T);
  const rowB = pick(B.num, T);
  cmp.rows = { a: rowA, b: rowB };

  const key = [A.num, rowA?.n, B.num, rowB?.n, cmp.mode].join();
  if (key !== cmp.key) {
    cmp.key = key;
    cmp.data = null;
    loadCompareData(key, A.num, rowA, B.num, rowB);
  }

  updateCard(cards.a, A);
  updateCard(cards.b, B);
  updateGap(A, B);
  updateCompareTable(A, B, rowA, rowB);
}

function niceCeil(v, step) { return Math.ceil(v / step) * step; }

function drawSectorMarks(ctx, data, X, y0, y1, labels) {
  if (!data.sectors?.length) return;
  ctx.save();
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  ctx.fillStyle = '#6f7688';
  ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  const edges = [0, ...data.sectors, 1];
  edges.slice(1, -1).forEach((f) => {
    ctx.beginPath(); ctx.moveTo(X(f), y0); ctx.lineTo(X(f), y1); ctx.stroke();
  });
  ctx.setLineDash([]);
  if (labels) for (let i = 0; i < edges.length - 1; i++) ctx.fillText(`S${i + 1}`, X((edges[i] + edges[i + 1]) / 2), y0 + 10);
  ctx.restore();
}

function drawCursor(ctx, X, y0, y1) {
  const f = state.cmp.hover;
  if (f == null) return;
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(f), y0); ctx.lineTo(X(f), y1); ctx.stroke();
}

function chartMessage(ctx, w, h, text) {
  ctx.fillStyle = '#6f7688';
  ctx.font = '12px -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2);
}

function drawSpeedChart(A, B, data) {
  const ctx = fitCanvas(el.cmpSpeed);
  const w = el.cmpSpeed.clientWidth;
  const h = el.cmpSpeed.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const x0 = CHART_LEFT; const x1 = w - CHART_RIGHT; const y0 = 4; const y1 = h - 4;
  const vmax = data?.a ? niceCeil(Math.max(data.a.vmax, data.b.vmax), 50) : 350;
  const X = (f) => x0 + f * (x1 - x0);
  const Y = (v) => y1 - (v / vmax) * (y1 - y0);

  ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= vmax; v += 100) {
    ctx.strokeStyle = '#222733'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, Y(v)); ctx.lineTo(x1, Y(v)); ctx.stroke();
    ctx.fillStyle = '#6f7688'; ctx.fillText(String(v), x0 - 6, Y(v));
  }

  if (!data) return chartMessage(ctx, w, h, I18n.t('cmp.loadingLap'));
  if (data.error) return chartMessage(ctx, w, h, I18n.t('cmp.failed', { msg: data.error }));
  if (data.missing) return chartMessage(ctx, w, h, I18n.t('cmp.missing'));

  drawSectorMarks(ctx, data, X, y0, y1, true);
  ctx.lineJoin = 'round';
  const lines = [[data.a, A.color, []], [data.b, B.color, A.color === B.color ? [6, 4] : []]];
  for (const [trace, color, dash] of lines) {
    ctx.beginPath();
    for (let i = 0; i <= CHART_STEPS; i++) {
      const f = i / CHART_STEPS;
      const x = X(f); const y = Y(Compare.speedAt(trace, f));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.setLineDash(dash);
    ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke();
  }
  ctx.setLineDash([]);
  drawCursor(ctx, X, y0, y1);
}

function drawDeltaChart(A, B, data) {
  const ctx = fitCanvas(el.cmpDelta);
  const w = el.cmpDelta.clientWidth;
  const h = el.cmpDelta.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!data?.delta) return;

  const x0 = CHART_LEFT; const x1 = w - CHART_RIGHT; const y0 = 4; const y1 = h - 4;
  const mid = (y0 + y1) / 2;
  const lim = niceCeil(Math.max(0.3, ...data.delta.dt.map(Math.abs)), 0.1);
  const X = (f) => x0 + f * (x1 - x0);
  const Y = (dt) => mid - (dt / lim) * (mid - y0); // up = A is ahead

  ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [lim, 0, -lim]) {
    ctx.strokeStyle = v === 0 ? '#3a4156' : '#222733'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, Y(v)); ctx.lineTo(x1, Y(v)); ctx.stroke();
    ctx.fillStyle = '#6f7688'; ctx.fillText(v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`, x0 - 6, Y(v));
  }

  // area between the curve and zero, in the colour of whoever is ahead
  const curve = new Path2D();
  curve.moveTo(X(0), mid);
  data.delta.f.forEach((f, i) => curve.lineTo(X(f), Y(data.delta.dt[i])));
  curve.lineTo(X(1), mid);
  curve.closePath();
  for (const [color, top, bottom] of [[A.color, y0, mid], [B.color, mid, y1]]) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, top, x1 - x0, bottom - top); ctx.clip();
    ctx.globalAlpha = 0.28; ctx.fillStyle = color; ctx.fill(curve);
    ctx.restore();
  }

  drawSectorMarks(ctx, data, X, y0, y1);

  ctx.beginPath();
  data.delta.f.forEach((f, i) => {
    const x = X(f); const y = Y(data.delta.dt[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#e8eaf0'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = A.color; ctx.fillText(`▲ ${I18n.t('cmp.ahead', { acr: A.acr })}`, x0 + 6, y0 + 12);
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = B.color; ctx.fillText(`▼ ${I18n.t('cmp.ahead', { acr: B.acr })}`, x0 + 6, y1 - 2);

  drawCursor(ctx, X, y0, y1);
}

function updateReadout(A, B, data) {
  const { hover, rows } = state.cmp;
  let text = '';
  if (data?.delta && hover != null) {
    const i = Math.round(hover * CHART_STEPS);
    const dt = data.delta.dt[i];
    text = I18n.t('cmp.hover', {
      pct: Math.round(hover * 100),
      a: A.acr, va: Math.round(Compare.speedAt(data.a, hover)),
      b: B.acr, vb: Math.round(Compare.speedAt(data.b, hover)),
      s: Math.abs(dt).toFixed(3), w: dt >= 0 ? A.acr : B.acr,
    });
  } else if (rows?.a && rows?.b) {
    text = I18n.t('cmp.idle', { a: A.acr, na: rows.a.n, ta: fmtLap(rows.a.dur), b: B.acr, nb: rows.b.n, tb: fmtLap(rows.b.dur) });
  }
  setText(el.cmpReadout, text);
}

function drawCompare() {
  if (!compareActive()) return;
  const A = state.drivers.get(state.selected);
  const B = state.drivers.get(state.cmp.b);
  const { data } = state.cmp;
  drawSpeedChart(A, B, data);
  drawDeltaChart(A, B, data);
  updateReadout(A, B, data);
}

// ───────────────────────── main loop ─────────────────────────

/**
 * Playback clock, data pump and overlay feed. This runs on a timer rather than
 * requestAnimationFrame, which the browser pauses when the window is covered or
 * minimised, and the overlay must keep moving then.
 */
function tick() {
  const now = performance.now();
  const dt = Math.min(now - state.lastTick, 100);
  state.lastTick = now;
  if (!state.session || !state.bounds) return;

  const live = state.live.on && state.live.ready;
  // near the live edge the stream fills chunks as data arrives, so there is nothing to wait for
  const ready = state.loc.has(chunkOf(state.t)) || (live && chunkOf(state.t) >= chunkOf(liveEdge()) - 1);
  el.buffering.hidden = !(state.playing && !ready);

  if (live) {
    const edge = liveEdge();
    const target = edge - state.liveDelay;
    state.end = edge;
    el.seek.max = edge;
    if (state.live.following) {
      if (!state.scrubbing) state.t = target;
    } else if (state.playing && ready) {
      state.t = Math.min(state.t + dt * state.speed, target);
      if (state.t >= target) state.live.following = true; // caught up with the feed
    }
    if (state.live.modelDirty && now - state.live.lastRebuild > 1000) {
      state.live.modelDirty = false;
      state.live.lastRebuild = now;
      rebuildModel();
    }
  } else if (state.playing && ready) {
    state.t += dt * state.speed;
    if (state.t >= state.end) { state.t = state.end; setPlaying(false); }
  }
  if (!state.scrubbing) {
    pump();
    el.seek.value = state.t;
  }
  el.clock.textContent = fmtClock(state.t);

  if (now - state.lastInfo >= INFO_INTERVAL_MS) {
    state.lastInfo = now;
    const order = updateBoard();
    updateHud(order);
    updateDriverPanel();
    updateCompare();
    state.selInfo = buildSelInfo(order);
    updateLivePill();
  }
  if (state.overlayOpen) pushOverlayFrame(now);
}

function frame() {
  if (state.session && state.bounds) {
    drawMap();
    updateTelemetry();
    drawCompare();
  }
  requestAnimationFrame(frame);
}

// ───────────────────────── overlay ─────────────────────────

function sendOverlaySession() {
  window.f1.overlay.sendSession({
    outline: state.outline,
    bounds: state.bounds,
    drivers: [...state.drivers.values()].map(({ num, acr, color }) => ({ num, acr, color })),
  });
}

function pushOverlayFrame(now) {
  if (now - state.lastPush < OVERLAY_FRAME_MS) return;
  state.lastPush = now;

  const d = state.drivers.get(state.selected);
  const s = d && sampleCar(d.num, state.t);
  window.f1.overlay.sendFrame({
    cars: samplePositions().map(({ d: car, x, y }) => [car.num, x, y]),
    selected: state.selected,
    hud: state.hud,
    sel: state.selInfo,
    tel: s
      ? { speed: s.speed, gear: s.n_gear, throttle: s.throttle, brake: s.brake, drs: s.drs }
      : null,
  });
}

/**
 * Summary of the selected driver for the overlay: tyres, stops and the
 * time gaps to the cars directly ahead and behind.
 */
function buildSelInfo(order) {
  const d = state.drivers.get(state.selected);
  if (!d) return null;
  const { model } = state;
  const T = state.t;

  const i = order.findIndex((r) => r.d.num === d.num);
  const tyre = model.tyre(d.num, T);
  const stints = model.stintsOf(d.num)
    .slice(0, (tyre?.stint ?? -1) + 1)
    .map((s) => ({ compound: s.compound, from: s.lap_start, to: s.lap_end }));

  // a car's `interval` is its gap to the car in front of it
  const gapOf = (num) => sampleInt(num, T)?.interval ?? null;
  const neighbour = (other, gap) => other && { acr: other.d.acr, color: other.d.color, gap };
  const ahead = i > 0 ? order[i - 1] : null;
  const behind = i >= 0 && i < order.length - 1 ? order[i + 1] : null;

  return {
    acr: d.acr,
    color: d.color,
    pos: order[i]?.pos,
    tyre: tyre && { compound: tyre.compound, age: tyre.age },
    stints,
    stops: model.pitsOf(d.num, T).length,
    ahead: neighbour(ahead, gapOf(d.num)),
    behind: neighbour(behind, behind ? gapOf(behind.d.num) : null),
  };
}

function applyOverlayStatus(st) {
  state.overlayStatus = st;
  state.overlayOpen = st.open;
  el.ovToggle.classList.toggle('on', st.open);
  el.ovToggle.textContent = I18n.t(st.open ? 'ov.close' : 'ov.open');
  for (const control of [el.ovLock, el.ovSize, el.ovOpacity, el.ovBg]) control.disabled = !st.open;

  el.ovLock.checked = st.locked;
  el.ovBg.checked = st.background;
  // don't fight the user's thumb while a slider is being dragged
  if (document.activeElement !== el.ovSize) el.ovSize.value = st.width;
  if (document.activeElement !== el.ovOpacity) el.ovOpacity.value = st.opacity;
}

// ───────────────────────── UI wiring ─────────────────────────

async function loadRaces(year) {
  setStatusT('status.calendar');
  el.race.replaceChildren();
  const sessions = await get('sessions', { year, session_name: 'Race' });
  const done = sessions
    .filter((s) => !s.is_cancelled && Date.parse(s.date_end) < Date.now())
    .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));

  for (const s of done) {
    const opt = document.createElement('option');
    opt.value = s.session_key;
    opt.textContent = s.location;
    el.race.append(opt);
  }
  if (!done.length) { setStatusT('status.noRaces'); return null; }

  el.race.selectedIndex = done.length - 1;
  return done;
}

async function selectYear(year) {
  const races = await loadRaces(year);
  if (!races) return;
  state.races = races;
  el.race.onchange = () => loadSession(races.find((r) => String(r.session_key) === el.race.value));
  await loadSession(races[races.length - 1]);
}

for (const y of YEARS) {
  const opt = document.createElement('option');
  opt.value = y; opt.textContent = y;
  el.year.append(opt);
}

el.year.addEventListener('change', () => selectYear(Number(el.year.value)).catch((e) => setStatusT('status.error', { msg: errorText(e) })));
el.pin.addEventListener('change', () => window.f1.setAlwaysOnTop(el.pin.checked));
el.play.addEventListener('click', togglePlay);
el.speed.addEventListener('change', () => { state.speed = Number(el.speed.value); });

el.seek.addEventListener('pointerdown', () => { state.scrubbing = true; });
el.seek.addEventListener('input', () => { state.t = Number(el.seek.value); });
el.seek.addEventListener('change', () => {
  state.t = Number(el.seek.value);
  state.scrubbing = false;
  // dropping the handle at the live edge re-joins the feed
  if (state.live.on) state.live.following = state.t >= liveEdge() - state.liveDelay - 1500;
});

el.liveBtn.addEventListener('click', async () => {
  if (!state.live.on) { openLiveDialog(); return; }
  await stopLive();
  const race = state.races.find((r) => String(r.session_key) === el.race.value);
  if (race) loadSession(race);
});
el.liveDelay.addEventListener('input', () => {
  const seconds = Number(el.liveDelay.value);
  if (el.liveDelay.value === '' || !Number.isFinite(seconds)) return; // mid-typing
  state.liveDelay = Math.min(MAX_LIVE_DELAY_S, Math.max(0, seconds)) * 1000;
  try {
    localStorage.setItem('liveDelayS', String(state.liveDelay / 1000));
  } catch {
    // preference just won't persist
  }
});
el.livePill.addEventListener('click', () => { state.live.following = true; setPlaying(true); });
el.liveGo.addEventListener('click', () => withLiveDialog(loginAndGoLive));
el.liveDemo.addEventListener('click', () => withLiveDialog(() => startLive({ demo: true })));
el.liveCancel.addEventListener('click', () => el.liveDialog.close());
el.liveLogout.addEventListener('click', async () => {
  await stopLive();
  await window.f1.live.logout();
  refreshLiveDialog();
});
window.f1.live.onRows(onLiveRows);
window.f1.live.onStatus(onLiveStatus);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); togglePlay(); }
});

el.cmpSelect.addEventListener('change', () => setCompare(el.cmpSelect.value === '' ? null : Number(el.cmpSelect.value)));
el.cmpClose.addEventListener('click', () => setCompare(null));
el.cmpMode.addEventListener('change', () => {
  state.cmp.mode = el.cmpMode.value;
  state.lastInfo = 0;
});
for (const canvas of [el.cmpSpeed, el.cmpDelta]) {
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const f = (e.clientX - rect.left - CHART_LEFT) / (rect.width - CHART_LEFT - CHART_RIGHT);
    state.cmp.hover = f >= 0 && f <= 1 ? f : null;
  });
  canvas.addEventListener('mouseleave', () => { state.cmp.hover = null; });
}

el.ovToggle.addEventListener('click', () => window.f1.overlay.toggle());
el.ovLock.addEventListener('change', () => window.f1.overlay.configure({ locked: el.ovLock.checked }));
el.ovBg.addEventListener('change', () => window.f1.overlay.configure({ background: el.ovBg.checked }));
el.ovSize.addEventListener('input', () => window.f1.overlay.configure({ width: Number(el.ovSize.value) }));
el.ovOpacity.addEventListener('input', () => window.f1.overlay.configure({ opacity: Number(el.ovOpacity.value) }));
window.f1.overlay.onStatus(applyOverlayStatus);
window.f1.overlay.configure({ locale: I18n.locale }).then(applyOverlayStatus);

// language ------------------------------------------------------------
for (const [code, info] of Object.entries(I18n.locales)) el.lang.append(new Option(info.name, code));
el.lang.value = I18n.locale;
el.lang.addEventListener('change', () => I18n.setLocale(el.lang.value));
I18n.onChange(() => {
  try {
    localStorage.setItem('locale', I18n.locale);
  } catch {
    // the choice just won't persist
  }
  window.f1.overlay.configure({ locale: I18n.locale });

  // text that is only rebuilt when its data changes has to be rebuilt now
  state.infoKeys = {};
  state.lastInfo = 0;
  if (state.statusMsg) el.status.textContent = I18n.t(state.statusMsg.key, state.statusMsg.params);
  renderTelemetryHeader();
  updateLiveUi();
  if (state.overlayStatus) applyOverlayStatus(state.overlayStatus);
  if (el.cmpSelect.options[0]) el.cmpSelect.options[0].text = I18n.t('tel.pick');
  if (el.liveDialog.open) refreshLiveDialog();
});

// initial text for elements that are filled from code rather than from data-i18n
renderTelemetryHeader();
updateLiveUi();
el.ovToggle.textContent = I18n.t('ov.open');

el.map.addEventListener('click', (e) => {
  const rect = el.map.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  let best = null;
  let bestD = 20;
  for (const c of state.carScreen) {
    const dist = Math.hypot(c.x - mx, c.y - my);
    if (dist < bestD) { best = c; bestD = dist; }
  }
  if (best) (e.shiftKey ? compareWith(best.num) : selectDriver(best.num));
});

selectYear(YEARS[0]).catch((e) => setStatusT('status.error', { msg: errorText(e) }));
setInterval(tick, TICK_MS);
requestAnimationFrame(frame);
