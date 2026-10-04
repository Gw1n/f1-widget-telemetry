const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.openf1.org';
const BASE = `${API}/v1`;
const TOKEN_REFRESH_MARGIN_MS = 120_000;
// OpenF1 allows 3 requests/second; stay well under it (bursts of 380 ms spacing still hit 429).
const MIN_GAP_MS = 500;
const MAX_ATTEMPTS = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An error with a machine-readable `code`; the UI turns codes into the user's language. */
class AppError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Rate-limited, disk-cached OpenF1 client.
 *
 * Param keys ending in an operator ('date>=', 'date<') are emitted as
 * `date>=value`; all other keys as `key=value`.
 */
class OpenF1 {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.chain = Promise.resolve();
    this.lastRequestAt = 0;
    this.inflight = new Map();
    this.credentials = null; // { username, password }, kept in memory only
    this.token = null; // { value, expiresAt }
  }

  /** Exchange credentials for a bearer token (valid ~1 h). Real-time data needs a paid account. */
  async login(username, password) {
    const res = await fetch(`${API}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 400) throw new AppError('bad_credentials', 'Wrong username or password');
      throw new AppError('login_failed', `Sign-in failed (${res.status})`, `${res.status} ${detail}`.trim());
    }
    const body = await res.json();
    this.credentials = { username, password };
    this.token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
  }

  logout() {
    this.credentials = null;
    this.token = null;
  }

  setCredentials(username, password) {
    this.credentials = { username, password };
    this.token = null;
  }

  get username() {
    return this.credentials?.username ?? null;
  }

  /** A token that is valid for at least the next couple of minutes; re-logs-in when needed. */
  async ensureToken() {
    if (!this.credentials) throw new AppError('not_logged_in', 'Sign in to your OpenF1 account first');
    if (!this.token || this.token.expiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
      await this.login(this.credentials.username, this.credentials.password);
    }
    return this.token.value;
  }

  buildUrl(endpoint, params = {}) {
    const qs = Object.entries(params).map(([key, value]) => {
      const v = encodeURIComponent(value);
      return /[<>]=?$/.test(key) ? `${key}${v}` : `${key}=${v}`;
    });
    return `${BASE}/${endpoint}${qs.length ? `?${qs.join('&')}` : ''}`;
  }

  /** `opts.cache === false` bypasses the disk cache (live data is still changing). */
  async get(endpoint, params, opts = {}) {
    const useCache = opts.cache !== false;
    const url = this.buildUrl(endpoint, params);
    const file = path.join(this.cacheDir, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);

    if (useCache) {
      try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        // cache miss
      }
    }

    const key = `${useCache ? 'c' : 'f'}:${url}`;
    if (!this.inflight.has(key)) {
      const p = this.enqueue(url)
        .then(async (data) => {
          if (useCache) {
            await fs.mkdir(this.cacheDir, { recursive: true });
            await fs.writeFile(file, JSON.stringify(data));
          }
          return data;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return this.inflight.get(key);
  }

  enqueue(url) {
    const job = this.chain.then(() => this.fetchWithRetry(url));
    this.chain = job.catch(() => {});
    return job;
  }

  async fetchWithRetry(url) {
    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const wait = this.lastRequestAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();

      try {
        const headers = this.token ? { Authorization: `Bearer ${await this.ensureToken()}` } : {};
        const res = await fetch(url, { headers });
        if (res.status === 401 && this.token) {
          this.token = null; // stale or revoked token: retry as an anonymous (historical-only) client
          continue;
        }
        if (res.status === 404) return []; // OpenF1: "No results found"
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`OpenF1 ${res.status}`);
          await sleep(1000 * (attempt + 1));
          continue;
        }
        if (!res.ok) throw new Error(`OpenF1 ${res.status}: ${await res.text()}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastError;
  }
}

module.exports = { OpenF1, AppError };
