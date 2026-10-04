'use strict';

const $ = (sel) => document.querySelector(sel);
const el = {
  map: $('#map'), lap: $('#lap'), status: $('#status'),
  info: $('#info'), color: $('#t-color'), acr: $('#t-acr'), pos: $('#t-pos'),
  spd: $('#t-spd'), gear: $('#t-gear'), drs: $('#t-drs'), thr: $('#t-thr'), brk: $('#t-brk'),
  dot: $('#t-dot'), tyre: $('#t-tyre'), stops: $('#t-stops'), stints: $('#t-stints'),
  upAcr: $('#g-up-acr'), up: $('#g-up'), dnAcr: $('#g-dn-acr'), dn: $('#g-dn'),
};
const COMPOUND_LETTER = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };

// the language arrives with the overlay settings; start in the default until then
I18n.init(I18n.DEFAULT_LOCALE);

const state = {
  outline: [],
  bounds: null,
  drivers: new Map(), // number -> { acr, color }
  frame: null,
  drawQueued: false,
};

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

function drawMap() {
  const ctx = fitCanvas(el.map);
  const w = el.map.clientWidth;
  const h = el.map.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!state.bounds) return;

  // leave room for the HUD on top and the telemetry strip at the bottom
  const proj = TrackMap.makeProjection(state.bounds, w, h, Math.max(24, Math.min(w, h) * 0.09));
  const path = TrackMap.trackPath(state.outline, proj);

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 11; ctx.strokeStyle = 'rgba(0, 0, 0, .55)'; ctx.stroke(path);
  ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(190, 198, 218, .55)'; ctx.stroke(path);

  const [sx, sy] = proj(state.outline[0].x, state.outline[0].y);
  ctx.fillStyle = '#fff';
  ctx.fillRect(sx - 1.5, sy - 8, 3, 16);

  const frame = state.frame;
  if (!frame) return;

  const cars = frame.cars
    .map(([num, x, y]) => ({ d: state.drivers.get(num), num, p: proj(x, y) }))
    .filter((c) => c.d)
    .sort((a, b) => (a.num === frame.selected) - (b.num === frame.selected));

  ctx.font = '600 10px -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const { d, num, p: [x, y] } of cars) {
    const sel = num === frame.selected;
    if (sel) {
      ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.strokeStyle = d.color; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, sel ? 6.5 : 5, 0, Math.PI * 2);
    ctx.fillStyle = d.color; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0, 0, 0, .85)'; ctx.stroke();

    // outlined text stays readable on any desktop background
    const tx = x + (sel ? 16 : 9);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0, 0, 0, .75)'; ctx.strokeText(d.acr, tx, y);
    ctx.fillStyle = sel ? '#fff' : '#d4d8e4'; ctx.fillText(d.acr, tx, y);
  }
}

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
function setClass(node, cls) { if (node.className !== cls) node.className = cls; }

function fmtGap(v) {
  if (v == null) return '–';
  return typeof v === 'string' ? v : `${v.toFixed(1)} ${I18n.t('unit.s')}`;
}

function updateGap(acrNode, valueNode, other, emptyText) {
  setText(acrNode, other ? other.acr : '');
  acrNode.style.color = other ? other.color : '';
  setText(valueNode, other ? fmtGap(other.gap) : emptyText);
}

function updateStints(sel) {
  const key = JSON.stringify(sel.stints);
  if (el.stints.dataset.key === key) return;
  el.stints.dataset.key = key;
  el.stints.replaceChildren(...sel.stints.map((s, i) => {
    const chip = document.createElement('span');
    chip.className = `stint${i === sel.stints.length - 1 ? ' now' : ''}`;
    const dot = document.createElement('i');
    dot.className = `dot c-${s.compound}`;
    chip.append(dot, `${s.from}–${i === sel.stints.length - 1 ? '…' : s.to}`);
    return chip;
  }));
}

function updateHud(frame) {
  setText(el.lap, I18n.lapLabel(frame.hud));
  setText(el.status, I18n.t(`status.${frame.hud.status}`));
  setClass(el.status, `chip ${frame.hud.status}`);

  const { sel, tel } = frame;
  el.info.hidden = !sel;
  if (!sel) return;

  el.color.style.background = sel.color;
  setText(el.acr, sel.acr);
  setText(el.pos, sel.pos && sel.pos !== 99 ? `P${sel.pos}` : '');

  if (tel) {
    setText(el.spd, String(Math.round(tel.speed)));
    setText(el.gear, tel.gear === 0 ? 'N' : String(tel.gear));
    setClass(el.drs, `drs${tel.drs >= 10 ? ' open' : tel.drs === 8 ? ' eligible' : ''}`);
    el.thr.style.width = `${Math.max(0, Math.min(100, tel.throttle)) / 2}%`;
    el.brk.style.width = tel.brake > 0 ? '50%' : '0%';
  }

  const compound = sel.tyre?.compound;
  setClass(el.dot, `dot c-${compound}`);
  setText(el.dot, COMPOUND_LETTER[compound] ?? '?');
  const name = I18n.t(I18n.has(`compound.${compound}`) ? `compound.${compound}` : 'compound.unknown');
  setText(el.tyre, sel.tyre ? `${name} · ${I18n.t('ov.tyreAge', { n: sel.tyre.age })}` : '–');
  setText(el.stops, I18n.t('ov.stops', { n: sel.stops }));
  updateStints(sel);

  updateGap(el.upAcr, el.up, sel.ahead, I18n.t('ov.noLeaderAhead'));
  updateGap(el.dnAcr, el.dn, sel.behind, '—');
}

function scheduleDraw() {
  if (state.drawQueued) return;
  state.drawQueued = true;
  requestAnimationFrame(() => {
    state.drawQueued = false;
    drawMap();
  });
}

window.overlay.onSession((session) => {
  state.outline = session.outline;
  state.bounds = session.bounds;
  state.drivers = new Map(session.drivers.map((d) => [d.num, d]));
  state.frame = null;
  scheduleDraw();
});

window.overlay.onFrame((frame) => {
  state.frame = frame;
  updateHud(frame);
  scheduleDraw();
});

window.overlay.onSettings((s) => {
  document.body.classList.toggle('unlocked', !s.locked);
  document.body.classList.toggle('bg', s.background);
  I18n.setLocale(s.locale ?? I18n.DEFAULT_LOCALE);
  scheduleDraw();
});

// dynamic text is set through change-guarded setters, so a fresh frame update re-translates it
I18n.onChange(() => {
  if (state.frame) {
    el.stints.dataset.key = '';
    updateHud(state.frame);
  }
});

window.addEventListener('resize', scheduleDraw);
