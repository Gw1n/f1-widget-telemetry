// End-to-end test of the widget's live path against stand-ins: a fake OpenF1 REST API and a local MQTT broker.
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { Aedes } = require('aedes');

const BIN = process.env.BIN;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const NOW = Date.now();
const checks = [];
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// ── fake REST API ───────────────────────────────────────────────────
const requests = [];
const drivers = [
  { driver_number: 1, name_acronym: 'VER', full_name: 'Max VERSTAPPEN', team_name: 'Red Bull', team_colour: '3671C6' },
  { driver_number: 4, name_acronym: 'NOR', full_name: 'Lando NORRIS', team_name: 'McLaren', team_colour: 'FF8000' },
  { driver_number: 16, name_acronym: 'LEC', full_name: 'Charles LECLERC', team_name: 'Ferrari', team_colour: 'E80020' },
];
const LIVE = 900;
const routes = {
  '/v1/sessions': () => [
    { session_key: LIVE, session_name: 'Race', meeting_key: 90, date_start: iso(NOW - 10 * 60e3), date_end: iso(NOW + 80 * 60e3), location: 'Testville', country_name: 'Testland', is_cancelled: false },
    { session_key: 800, session_name: 'Race', meeting_key: 80, date_start: iso(NOW - 7 * 864e5), date_end: iso(NOW - 7 * 864e5 + 2 * 36e5), location: 'Oldtown', country_name: 'Oldland', is_cancelled: false },
  ],
  '/v1/meetings': () => [
    { meeting_key: 90, meeting_name: 'Test Grand Prix', location: 'Testville', country_name: 'Testland' },
    { meeting_key: 80, meeting_name: 'Previous Grand Prix', location: 'Oldtown', country_name: 'Oldland' },
  ],
  '/v1/drivers': () => drivers,
  '/v1/position': () => [
    { session_key: LIVE, driver_number: 1, position: 1, date: iso(NOW - 60e3) },
    { session_key: LIVE, driver_number: 4, position: 2, date: iso(NOW - 60e3) },
  ],
  '/v1/laps': () => [{ session_key: LIVE, driver_number: 1, lap_number: 5, date_start: iso(NOW - 90e3) }],
  '/v1/stints': () => [{ session_key: LIVE, driver_number: 1, stint_number: 1, compound: 'MEDIUM', lap_start: 1, tyre_age_at_start: 0 }],
  '/v1/session_result': () => [
    { position: 1, driver_number: 4, points: 25, dnf: false, dns: false, dsq: false, gap_to_leader: 0 },
    { position: 2, driver_number: 1, points: 18, dnf: false, dns: false, dsq: false, gap_to_leader: 3.2 },
  ],
  '/v1/championship_drivers': () => [{ driver_number: 4, position_current: 1, points_current: 100 }],
  '/v1/championship_teams': () => [{ team_name: 'McLaren', position_current: 1, points_current: 180 }],
};
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/token') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      requests.push({ path: '/token', user: form.get('username') });
      const ok = form.get('username') === 'tester' && form.get('password') === 'secret';
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { access_token: 'TOKEN123', expires_in: '3600', token_type: 'bearer' } : { detail: 'bad' }));
    });
    return;
  }
  requests.push({ path: url.pathname + url.search, auth: req.headers.authorization || '' });
  const handler = routes[url.pathname];
  if (!handler) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"detail":"No results found."}'); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(handler()));
});

// ── local MQTT broker ───────────────────────────────────────────────
let broker; let server; let sockets = new Set();
const seen = { credentials: [], subscriptions: [] };
async function startBroker() {
  broker = await Aedes.createBroker();
  broker.authenticate = (client, username, password, cb) => {
    seen.credentials.push({ username, password: password && password.toString() });
    cb(null, !process.env.DENY && password && password.toString() === 'TOKEN123');
  };
  broker.on('subscribe', (subs) => seen.subscriptions.push(...subs.map((s) => s.topic)));
  sockets = new Set();
  server = net.createServer((s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); broker.handle(s); });
  await new Promise((r) => server.listen(18884, '127.0.0.1', r));
}
const stopBroker = () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(); broker.close(r); });
const publish = (topic, obj) => broker.publish({ topic, payload: Buffer.from(JSON.stringify(obj)), qos: 0, retain: false, cmd: 'publish', dup: false }, () => {});

// ── run the widget ──────────────────────────────────────────────────
(async () => {
  await new Promise((r) => api.listen(18090, '127.0.0.1', r));
  await startBroker();

  let err = '';
  const child = spawn(BIN, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', F1W_DEBUG: '1', F1W_API_BASE: 'http://127.0.0.1:18090', F1W_MQTT_URL: 'tcp://127.0.0.1:18884', F1W_AUTOLOGIN: 'tester:secret' },
  });
  child.stderr.on('data', (d) => (err += d));
  const latest = () => {
    const snaps = [...err.matchAll(/^SNAPSHOT (.*)$/gm)];
    const titles = [...err.matchAll(/^TITLE (.*)$/gm)];
    return { snap: snaps.length ? JSON.parse(snaps.at(-1)[1]) : null, title: titles.length ? titles.at(-1)[1] : '' };
  };
  const until = async (fn, ms = 20000) => { for (let t = 0; t < ms; t += 250) { if (fn()) return true; await wait(250); } return false; };
  const rowsOf = () => (latest().snap?.live.rows ?? []).map((r) => r.driver.acronym);

  if (process.env.DENY) {
    const denied = await until(() => latest().snap?.live.status === 'error' && latest().snap.live.message === 'denied', 20000);
    check('a broker that rejects the login is reported as "denied", not shown as live', denied, JSON.stringify(latest().snap?.live.status));
    await wait(8000);
    check('the widget does not hammer the broker (retries are paced)', seen.credentials.length <= 4, `${seen.credentials.length} login attempts`);
    check('the process is still alive', child.exitCode === null);
    child.kill(); await wait(300);
    const bad = checks.filter((c) => !c).length;
    console.log(`\n${checks.length - bad}/${checks.length} checks passed`);
    process.exit(bad ? 1 : 0);
  }

  // 1. bootstrap over REST (with the bearer token) + MQTT connection with the token as the password
  const bootstrapped = await until(() => rowsOf().join() === 'VER,NOR');
  check('REST bootstrap shows the live order', bootstrapped, rowsOf().join(' '));
  check('login used the credentials', requests.some((r) => r.path === '/token' && r.user === 'tester'));
  const positionRequest = requests.find((r) => r.path.startsWith('/v1/position'));
  check('REST live requests carry the bearer token', positionRequest?.auth === 'Bearer TOKEN123', positionRequest?.auth);
  check('broker got the token as the password', seen.credentials.some((c) => c.password === 'TOKEN123'));
  await until(() => seen.subscriptions.length >= 5, 8000);
  for (const topic of ['v1/position', 'v1/intervals', 'v1/laps', 'v1/stints', 'v1/race_control']) {
    check(`subscribed to ${topic}`, seen.subscriptions.includes(topic));
  }
  check('never subscribed to the heavy topics', !seen.subscriptions.some((t) => /location|car_data/.test(t)), seen.subscriptions.join(','));
  // the REST bootstrap and the details run one request at a time behind the rate limiter, so give them a moment
  await until(() => latest().snap?.live.rows[0]?.compound === 'MEDIUM', 10000);
  await until(() => latest().snap?.lastRace && latest().snap?.standings, 15000);
  const l0 = latest();
  check('live view: status live, session named', l0.snap.live.status === 'live' && l0.snap.live.session === 'Race', `${l0.snap.live.status} ${l0.snap.live.session}`);
  check('tyre compound and age come from the REST stints', l0.snap.live.rows[0].compound === 'MEDIUM' && l0.snap.live.rows[0].tyreAge === 4, `${l0.snap.live.rows[0].compound} ${l0.snap.live.rows[0].tyreAge}`);
  check('details: last race + standings loaded', l0.snap.lastRace?.rows[0].driver.acronym === 'NOR' && l0.snap.standings?.drivers.length === 1);

  // 2. stream updates: a new car, a lap, an interval, a safety car, and an overtake
  publish('v1/position', { session_key: LIVE, driver_number: 16, position: 3, date: iso(Date.now()) });
  publish('v1/intervals', { session_key: LIVE, driver_number: 16, interval: 1.234, gap_to_leader: 5.5, date: iso(Date.now()) });
  publish('v1/laps', { session_key: LIVE, driver_number: 1, lap_number: 6, date_start: iso(Date.now()) });
  publish('v1/race_control', { session_key: LIVE, category: 'SafetyCar', flag: null, scope: null, message: 'SAFETY CAR DEPLOYED', date: iso(Date.now()) });
  publish('v1/position', { session_key: LIVE, driver_number: 4, position: 1, date: iso(Date.now()) });
  publish('v1/position', { session_key: LIVE, driver_number: 1, position: 2, date: iso(Date.now()) });
  publish('v1/position', { session_key: 12345, driver_number: 16, position: 1, date: iso(Date.now()) }); // another session: must be ignored
  const updated = await until(() => rowsOf().join() === 'NOR,VER,LEC', 8000);
  const l1 = latest();
  check('stream updates reorder the live list (other sessions ignored)', updated, rowsOf().join(' '));
  check('lap and flag follow the stream', l1.snap.live.lap === 6 && l1.snap.live.flag === 'SC', `lap=${l1.snap.live.lap} flag=${l1.snap.live.flag}`);
  check('lap gap formatting', l1.snap.live.rows[2].interval === '+1.2', l1.snap.live.rows[2].interval);
  check('tray title shows lap and leader', l1.title === 'L6 · NOR', l1.title);
  check('menu contains the live submenu with the flag', /Live order — Race · L6 · Safety car >/.test(err.slice(err.lastIndexOf('MENU'))));

  // 3. broker outage: the widget must reconnect, re-subscribe, and keep processing
  const before = seen.subscriptions.length;
  await stopBroker();
  await wait(2500);
  await startBroker();
  const resubscribed = await until(() => seen.subscriptions.length >= before + 5, 15000);
  check('reconnected and re-subscribed after a broker restart', resubscribed, `${seen.subscriptions.length - before} new subscriptions`);
  publish('v1/position', { session_key: LIVE, driver_number: 16, position: 1, date: iso(Date.now()) });
  publish('v1/position', { session_key: LIVE, driver_number: 4, position: 3, date: iso(Date.now()) });
  const resumed = await until(() => rowsOf()[0] === 'LEC', 8000);
  check('messages after the outage are applied', resumed, rowsOf().join(' '));

  child.kill();
  await wait(500);
  const failed = checks.filter((c) => !c).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  await stopBroker().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
