'use strict';

/**
 * Lap-vs-lap comparison maths. A lap trace is speed over time; distance is the
 * integral of speed (the same approach FastF1 uses), normalised to a 0..1
 * fraction of the lap so two drivers' traces can be laid on one axis.
 */
const Compare = (() => {
  /** Linear interpolation of ys over ascending xs; clamps at the ends. */
  function interp(xs, ys, x) {
    if (!xs.length) return null;
    if (x <= xs[0]) return ys[0];
    const i = Race.upperBound(xs, x);
    if (i >= xs.length) return ys[ys.length - 1];
    const span = xs[i] - xs[i - 1];
    return span > 0 ? ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / span : ys[i];
  }

  /**
   * car_data rows of one lap -> { t (s), v (km/h), frac, total (m), dur (s), vmax }.
   * Edge samples are pinned to the lap boundaries so the trace spans the whole lap.
   */
  function buildTrace(rows, t0, durMs) {
    const pts = rows
      .map((r) => ({ t: (Date.parse(r.date) - t0) / 1000, v: r.speed }))
      .filter((p) => p.t >= 0 && p.t <= durMs / 1000)
      .sort((a, b) => a.t - b.t);
    if (pts.length < 5) return null;

    const dur = durMs / 1000;
    if (pts[0].t > 0) pts.unshift({ t: 0, v: pts[0].v });
    if (pts.at(-1).t < dur) pts.push({ t: dur, v: pts.at(-1).v });

    const dist = [0];
    for (let i = 1; i < pts.length; i++) {
      const dt = pts[i].t - pts[i - 1].t;
      dist.push(dist[i - 1] + (((pts[i].v + pts[i - 1].v) / 2) / 3.6) * dt);
    }
    const total = dist.at(-1) || 1;
    return {
      t: pts.map((p) => p.t),
      v: pts.map((p) => p.v),
      frac: dist.map((d) => d / total),
      total,
      dur,
      vmax: Math.max(...pts.map((p) => p.v)),
    };
  }

  const speedAt = (trace, f) => interp(trace.frac, trace.v, f);
  const timeAt = (trace, f) => interp(trace.frac, trace.t, f);

  /** Time deficit of B relative to A along the lap: >0 means A is ahead. */
  function deltaSeries(a, b, n = 240) {
    const f = [];
    const dt = [];
    for (let i = 0; i <= n; i++) {
      const x = i / n;
      f.push(x);
      dt.push(timeAt(b, x) - timeAt(a, x));
    }
    return { f, dt };
  }

  return { buildTrace, speedAt, timeAt, deltaSeries, interp };
})();
