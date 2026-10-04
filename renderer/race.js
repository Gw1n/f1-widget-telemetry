'use strict';

/**
 * Derived race data: laps, sectors, tyres, pit stops, race control, weather.
 * Everything is evaluated "as of" playback time T, so a replay shows only what
 * a live viewer would know at that moment (a sector time appears when the
 * sector is actually completed).
 */
const Race = (() => {
  const EPS = 0.0005;
  const TRACK_FLAGS = { GREEN: 'GREEN', CLEAR: 'GREEN', YELLOW: 'YELLOW', 'DOUBLE YELLOW': 'YELLOW', RED: 'RED', CHEQUERED: 'CHEQUERED' };

  /** First index with arr[i] > value. */
  function upperBound(arr, value) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };

  /** Running minimum of {t, v} events -> parallel arrays that only grow on improvement. */
  function runningMin(events) {
    events.sort((a, b) => a.t - b.t);
    const out = { t: [], v: [] };
    let best = Infinity;
    for (const e of events) {
      if (e.v < best) { best = e.v; out.t.push(e.t); out.v.push(best); }
    }
    return out;
  }

  const bestAt = (series, T) => {
    const i = upperBound(series.t, T);
    return i ? series.v[i - 1] : null;
  };

  /** Measure k: 0..2 = sectors, 3 = whole lap. */
  const valueOf = (lap, k) => (k < 3 ? lap.s[k] : lap.dur);
  function endOf(lap, k) {
    if (k === 3) return lap.dur == null ? null : lap.t0 + lap.dur * 1000;
    let sum = 0;
    for (let i = 0; i <= k; i++) {
      if (lap.s[i] == null) return null;
      sum += lap.s[i];
    }
    return lap.t0 + sum * 1000;
  }

  function build({ laps, stints, pits, control, weather }) {
    // laps ------------------------------------------------------------
    const lapsBy = new Map();
    for (const l of laps) {
      if (!l.date_start) continue;
      push(lapsBy, l.driver_number, {
        n: l.lap_number,
        t0: Date.parse(l.date_start),
        s: [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3],
        dur: l.lap_duration,
        i1: l.i1_speed,
        i2: l.i2_speed,
        st: l.st_speed,
      });
    }
    for (const arr of lapsBy.values()) arr.sort((a, b) => a.t0 - b.t0);
    const totalLaps = laps.reduce((m, l) => Math.max(m, l.lap_number), 0);

    // best-time series (overall and per driver) for purple/green coloring
    const overallEvents = [[], [], [], []];
    const personalEvents = new Map();
    for (const [drv, arr] of lapsBy) {
      const mine = [[], [], [], []];
      for (const lap of arr) {
        for (let k = 0; k < 4; k++) {
          const v = valueOf(lap, k);
          const end = endOf(lap, k);
          if (v == null || end == null) continue;
          overallEvents[k].push({ t: end, v });
          mine[k].push({ t: end, v });
        }
      }
      personalEvents.set(drv, mine);
    }
    const overall = overallEvents.map(runningMin);
    const personal = new Map([...personalEvents].map(([drv, ev]) => [drv, ev.map(runningMin)]));

    // stints / pits ---------------------------------------------------
    const stintsBy = new Map();
    for (const s of stints) push(stintsBy, s.driver_number, s);
    for (const arr of stintsBy.values()) arr.sort((a, b) => a.stint_number - b.stint_number);

    const pitsBy = new Map();
    for (const p of pits) {
      push(pitsBy, p.driver_number, {
        t: Date.parse(p.date), lap: p.lap_number, lane: p.pit_duration ?? p.lane_duration, stop: p.stop_duration,
      });
    }
    for (const arr of pitsBy.values()) arr.sort((a, b) => a.t - b.t);

    // race control / weather -----------------------------------------
    const msgs = control
      .map((m) => ({ ...m, t: Date.parse(m.date) }))
      .sort((a, b) => a.t - b.t);
    const msgTimes = msgs.map((m) => m.t);
    const wx = weather
      .map((w) => ({ ...w, t: Date.parse(w.date) }))
      .sort((a, b) => a.t - b.t);
    const wxTimes = wx.map((w) => w.t);

    // queries ---------------------------------------------------------
    const rowIndex = (drv, T) => {
      const a = lapsBy.get(drv);
      if (!a) return -1;
      let lo = 0;
      let hi = a.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid].t0 <= T) lo = mid + 1; else hi = mid;
      }
      return lo - 1;
    };

    /** Current lap number (0 before the start). */
    const lapNumber = (drv, T) => {
      const i = rowIndex(drv, T);
      return i < 0 ? 0 : lapsBy.get(drv)[i].n;
    };

    /** { n, cur: [S1,S2,S3,lap] revealed so far, last: previous lap or null } */
    function sectors(drv, T) {
      const i = rowIndex(drv, T);
      if (i < 0) return null;
      const a = lapsBy.get(drv);
      const lap = a[i];
      const cur = [0, 1, 2, 3].map((k) => {
        const end = endOf(lap, k);
        return end != null && end <= T ? valueOf(lap, k) : null;
      });
      let last = null;
      if (i > 0) {
        const p = a[i - 1];
        last = { n: p.n, v: [0, 1, 2, 3].map((k) => valueOf(p, k)), i1: p.i1, i2: p.i2, st: p.st };
      }
      return { n: lap.n, cur, last };
    }

    /** Duration of the most recently completed lap. */
    function lastLap(drv, T) {
      const s = sectors(drv, T);
      if (!s) return null;
      return s.cur[3] ?? s.last?.v[3] ?? null;
    }

    function bests(drv, T) {
      const mine = personal.get(drv);
      return {
        personal: [0, 1, 2, 3].map((k) => (mine ? bestAt(mine[k], T) : null)),
        overall: overall.map((series) => bestAt(series, T)),
      };
    }

    /** 'p' overall best, 'g' personal best, 'y' slower than both. */
    function grade(value, personalBest, overallBest) {
      if (value == null) return '';
      if (overallBest != null && value <= overallBest + EPS) return 'p';
      if (personalBest != null && value <= personalBest + EPS) return 'g';
      return 'y';
    }

    function tyre(drv, T) {
      const list = stintsBy.get(drv);
      if (!list || !list.length) return null;
      const lap = Math.max(1, lapNumber(drv, T));
      let idx = list.findIndex((s) => lap >= s.lap_start && (s.lap_end == null || lap <= s.lap_end));
      if (idx < 0) idx = Math.max(0, list.findLastIndex((s) => s.lap_start <= lap));
      const s = list[idx];
      return { compound: s.compound, age: (s.tyre_age_at_start ?? 0) + Math.max(0, lap - s.lap_start), stint: idx };
    }

    /** Laps of a driver that are fully completed by time T. */
    const completedLaps = (drv, T) => (lapsBy.get(drv) || []).filter((l) => l.dur != null && l.t0 + l.dur * 1000 <= T);
    const lastLapRow = (drv, T) => completedLaps(drv, T).at(-1) ?? null;
    const bestLapRow = (drv, T) => completedLaps(drv, T).reduce((b, l) => (!b || l.dur < b.dur ? l : b), null);

    const stintsOf = (drv) => stintsBy.get(drv) || [];
    const pitsOf = (drv, T) => (pitsBy.get(drv) || []).filter((p) => p.t <= T);
    const inPit = (drv, T) => (pitsBy.get(drv) || []).some((p) => p.t <= T && T < p.t + (p.lane || 25) * 1000);

    function trackStatus(T) {
      let code = 'GREEN';
      for (const m of msgs) {
        if (m.t > T) break;
        if (m.category === 'SafetyCar') {
          if (/DEPLOYED/.test(m.message)) code = /VIRTUAL/.test(m.message) ? 'VSC' : 'SC';
          else if (/ENDING|IN THIS LAP/.test(m.message)) code = 'SC_END';
        } else if (m.category === 'Flag' && m.scope === 'Track' && TRACK_FLAGS[m.flag]) {
          code = TRACK_FLAGS[m.flag];
        }
      }
      return code;
    }

    function recentMessages(T, n) {
      const out = [];
      for (let i = upperBound(msgTimes, T) - 1; i >= 0 && out.length < n; i--) out.push(msgs[i]);
      return out;
    }

    const weatherAt = (T) => {
      const i = upperBound(wxTimes, T);
      return i ? wx[i - 1] : wx[0] || null;
    };

    return {
      totalLaps, lapNumber, sectors, lastLap, lastLapRow, bestLapRow, bests, grade, tyre, stintsOf, pitsOf, inPit,
      trackStatus, recentMessages, weatherAt,
    };
  }

  /** 84.557 -> "1:24.557" */
  function fmtLap(sec) {
    if (sec == null) return '–';
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
  }
  const fmtSector = (sec) => (sec == null ? '–' : sec.toFixed(3));

  return { build, upperBound, fmtLap, fmtSector };
})();
