const mqtt = require('mqtt');

// overridable so the MQTT path can be tested against a local broker
const MQTT_URL = process.env.OPENF1_MQTT_URL || 'wss://mqtt.openf1.org:8084/mqtt';
const TOPICS = ['location', 'car_data', 'intervals', 'position', 'laps', 'stints', 'pit', 'race_control', 'weather'];
const FLUSH_MS = 100;
const WINDOW_MS = 30_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, -1);

/**
 * Source of live rows for the renderer. Rows are batched and delivered as
 * `[{ topic, rows }]` through `send`; the renderer merges them into its stores.
 *
 *  - mqtt:   the real OpenF1 stream (needs a paid account).
 *  - replay: re-emits a recorded session in real time, so the whole live
 *            pipeline can be exercised without a session being on track.
 */
class LiveFeed {
  constructor({ api, send, onStatus }) {
    this.api = api;
    this.send = send;
    this.onStatus = onStatus;
    this.pending = new Map(); // topic -> rows
    this.flushTimer = null;
    this.source = null;
  }

  queue(topic, rows) {
    if (!rows.length) return;
    if (!this.pending.has(topic)) this.pending.set(topic, []);
    this.pending.get(topic).push(...rows);
  }

  flush() {
    if (!this.pending.size) return;
    const batch = [...this.pending].map(([topic, rows]) => ({ topic, rows }));
    this.pending.clear();
    this.send(batch);
  }

  async start({ sessionKey, demo, virtualStart }) {
    this.stop();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    try {
      this.source = demo
        ? new ReplayFeed({ api: this.api, sessionKey, virtualStart, queue: (t, r) => this.queue(t, r), onStatus: this.onStatus })
        : new MqttFeed({ api: this.api, sessionKey, queue: (t, r) => this.queue(t, r), onStatus: this.onStatus });
      const offset = await this.source.start();
      return { ok: true, offset };
    } catch (err) {
      this.stop();
      return { ok: false, error: err.message, code: err.code, detail: err.detail };
    }
  }

  stop() {
    this.source?.stop();
    this.source = null;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.pending.clear();
  }
}

class MqttFeed {
  constructor({ api, sessionKey, queue, onStatus }) {
    Object.assign(this, { api, sessionKey, queue, onStatus });
    this.client = null;
    this.tokenTimer = null;
  }

  /** Resolves with the clock offset (0: real data timestamps are real time). */
  async start() {
    const token = await this.api.ensureToken();
    this.onStatus({ state: 'connecting' });

    const client = mqtt.connect(MQTT_URL, {
      username: this.api.username || 'openf1',
      password: token,
      reconnectPeriod: 2000,
      connectTimeout: 15_000,
    });
    this.client = client;

    client.on('connect', () => {
      client.subscribe(TOPICS.map((t) => `v1/${t}`), (err) => {
        if (err) this.onStatus({ state: 'error', code: 'subscribe_failed', detail: err.message, message: `Subscription failed: ${err.message}` });
        else this.onStatus({ state: 'connected' });
      });
    });
    client.on('reconnect', () => this.onStatus({ state: 'reconnecting' }));
    client.on('offline', () => this.onStatus({ state: 'reconnecting' }));
    client.on('error', (err) => {
      const denied = /not authori[sz]ed|bad user name|refused/i.test(err.message);
      this.onStatus({
        state: 'error',
        code: denied ? 'broker_denied' : undefined,
        message: denied ? 'The broker rejected the login: check that the account has a real-time subscription' : err.message,
      });
      if (denied) client.end(true); // retrying with the same credentials won't help
    });
    client.on('message', (topic, payload) => {
      let data;
      try {
        data = JSON.parse(payload.toString());
      } catch {
        return;
      }
      const rows = (Array.isArray(data) ? data : [data]).filter((r) => r.session_key === this.sessionKey);
      this.queue(topic.replace(/^v1\//, ''), rows);
    });

    // tokens last an hour; a reconnect must use a fresh one
    this.tokenTimer = setInterval(async () => {
      try {
        client.options.password = await this.api.ensureToken();
      } catch (err) {
        this.onStatus({ state: 'error', message: err.message });
      }
    }, 5 * 60_000);

    return 0;
  }

  stop() {
    clearInterval(this.tokenTimer);
    this.client?.end(true);
    this.client = null;
  }
}

/** Replays a recorded session as if it were happening now. */
class ReplayFeed {
  constructor({ api, sessionKey, virtualStart, queue, onStatus }) {
    Object.assign(this, { api, sessionKey, virtualStart, queue, onStatus });
    this.streams = Object.fromEntries(['location', 'car_data', 'intervals'].map((topic) => [
      topic, { rows: [], pos: 0, loadedUntil: virtualStart, loading: false },
    ]));
    this.timeline = []; // static events: { t, topic, row }
    this.timelinePos = 0;
    this.timer = null;
    this.stopped = false;
  }

  /** Data-time "now" of the replay. */
  now() {
    return Date.now() - this.offset;
  }

  async start() {
    this.offset = Date.now() - this.virtualStart;
    this.timer = setInterval(() => this.tick(), 200);
    this.loadStatics().catch((err) => this.onStatus({ state: 'error', code: 'demo_failed', detail: err.message, message: `Demo: ${err.message}` }));
    this.onStatus({ state: 'connected' });
    return this.offset;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  tick() {
    const now = this.now();

    for (const [topic, s] of Object.entries(this.streams)) {
      if (!s.loading && s.loadedUntil < now + 45_000) this.loadWindow(topic, s);
      const out = [];
      while (s.pos < s.rows.length && s.rows[s.pos].t <= now) out.push(s.rows[s.pos++].row);
      this.queue(topic, out);
    }

    while (this.timelinePos < this.timeline.length && this.timeline[this.timelinePos].t <= now) {
      const { topic, row } = this.timeline[this.timelinePos++];
      this.queue(topic, [row]);
    }
  }

  async loadWindow(topic, s) {
    s.loading = true;
    const from = s.loadedUntil;
    try {
      const rows = await this.api.get(topic, {
        session_key: this.sessionKey,
        'date>=': iso(from),
        'date<': iso(from + WINDOW_MS),
      });
      if (this.stopped) return;
      for (const row of rows) s.rows.push({ t: Date.parse(row.date), row });
      s.rows.sort((a, b) => a.t - b.t);
      s.loadedUntil = from + WINDOW_MS;
    } catch (err) {
      console.warn('replay window failed', topic, err.message);
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      s.loading = false;
    }
  }

  /** Low-rate topics: load once, then emit them when their time comes (laps in the order sectors complete). */
  async loadStatics() {
    const q = { session_key: this.sessionKey };
    const [laps, stints, pits, control, weather, positions] = await Promise.all([
      this.api.get('laps', q), this.api.get('stints', q), this.api.get('pit', q),
      this.api.get('race_control', q), this.api.get('weather', q), this.api.get('position', q),
    ]);
    if (this.stopped) return;

    const events = [];
    const add = (t, topic, row) => { if (Number.isFinite(t)) events.push({ t, topic, row }); };
    const lapTimes = new Map(); // "driver:lap" -> { start, end }

    for (const lap of laps) {
      const start = Date.parse(lap.date_start);
      if (!Number.isFinite(start)) continue;
      const s = [lap.duration_sector_1, lap.duration_sector_2, lap.duration_sector_3];
      const blank = {
        ...lap, duration_sector_1: null, duration_sector_2: null, duration_sector_3: null,
        lap_duration: null, i1_speed: null, i2_speed: null, st_speed: null,
      };
      add(start, 'laps', blank);
      if (s[0] != null) add(start + s[0] * 1000, 'laps', { ...blank, duration_sector_1: s[0] });
      if (s[0] != null && s[1] != null) {
        add(start + (s[0] + s[1]) * 1000, 'laps', { ...blank, duration_sector_1: s[0], duration_sector_2: s[1] });
      }
      const end = lap.lap_duration != null ? start + lap.lap_duration * 1000 : start;
      if (lap.lap_duration != null) add(end, 'laps', lap);
      lapTimes.set(`${lap.driver_number}:${lap.lap_number}`, { start, end });
    }

    for (const stint of stints) {
      const first = lapTimes.get(`${stint.driver_number}:${stint.lap_start}`);
      add(first ? first.start : this.virtualStart - 1, 'stints', { ...stint, lap_end: null });
      const last = stint.lap_end != null ? lapTimes.get(`${stint.driver_number}:${stint.lap_end}`) : null;
      if (last) add(last.end, 'stints', stint);
    }
    for (const row of pits) add(Date.parse(row.date), 'pit', row);
    for (const row of control) add(Date.parse(row.date), 'race_control', row);
    for (const row of weather) add(Date.parse(row.date), 'weather', row);
    for (const row of positions) add(Date.parse(row.date), 'position', row);

    events.sort((a, b) => a.t - b.t);
    this.timeline = events;
    // everything before the replay started is the renderer's REST bootstrap; skip ahead of it
    this.timelinePos = events.findIndex((e) => e.t > this.virtualStart - 1);
    if (this.timelinePos < 0) this.timelinePos = events.length;
  }
}

module.exports = { LiveFeed };
