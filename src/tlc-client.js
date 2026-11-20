// Trail Life Connect (traillifeconnect.com) client.
// TLC is a Yii2 server-rendered app: session-cookie auth, CSRF token forms,
// no public API. Strategy: log in via a real browser session (Playwright),
// persist cookies to a storageState file, then use the shared request
// context for fast HTML/AJAX fetches without re-rendering pages.

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const BASE_URL = process.env.TLC_BASE_URL || 'https://www.traillifeconnect.com';
const STATE_FILE = process.env.TLC_STATE_FILE || path.join(ROOT, 'state', 'tlc-session.json');

export class TLCClient {
  constructor({ stateFile = STATE_FILE } = {}) {
    this.stateFile = stateFile;
    this.browser = null;
    this.context = null;
  }

  hasSavedSession() {
    return fs.existsSync(this.stateFile);
  }

  async start() {
    if (this.context) return this.context;
    this.browser = await chromium.launch({ headless: true });
    const opts = {};
    if (this.hasSavedSession()) opts.storageState = this.stateFile;
    this.context = await this.browser.newContext({
      ...opts,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    return this.context;
  }

  async saveState() {
    await this.context.storageState({ path: this.stateFile });
  }

  async stop() {
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.context = null;
    this.browser = null;
  }

  // Returns the CSRF token embedded in a page (Yii embeds it as a meta tag
  // and as a hidden _csrf input on every form).
  async getCsrf(page) {
    const token = await page
      .querySelector('meta[name="csrf-token"]')
      ?.then((el) => el.getAttribute('content'));
    if (token) return token;
    const input = await page.$('input[name="_csrf"]');
    if (input) return input.getAttribute('value');
    throw new Error('No CSRF token found on ' + page.url());
  }

  // Full interactive login through the real login form.
  async login(email, password) {
    await this.start();
    const page = await this.context.newPage();
    try {
      await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
      await page.fill('input[name="LoginForm[email]"]', email);
      await page.fill('input[name="LoginForm[password]"]', password);
      await page.click('button[type="submit"], input[type="submit"]');
      await page.waitForLoadState('networkidle');
      if (page.url().includes('/login')) {
        const err = await page
          .$eval('.help-block, .alert-danger, .has-error', (el) => el.textContent.trim())
          .catch(() => 'Login failed (still on /login)');
        throw new Error(`TLC login failed: ${err}`);
      }
      await this.saveState();
      return { ok: true, landedOn: page.url() };
    } finally {
      await page.close();
    }
  }

  // Complete the SMS 2FA step (call right after login() lands on /site/sms-verify).
  async smsVerify(code) {
    await this.start();
    const page = await this.context.newPage();
    try {
      await page.goto(`${BASE_URL}/site/sms-verify`, { waitUntil: 'domcontentloaded' });
      if (page.url().includes('/login')) throw new Error('pre-2FA session expired; call login again');
      await page.fill('#sms-verify-code', code);
      const trust = await page.$('#w0');
      if (trust) await trust.evaluate((el) => { el.value = '1'; });
      await page.click('button[name="sms_action"]');
      await page.waitForLoadState('networkidle');
      if (page.url().includes('sms-verify') || page.url().includes('login')) {
        const t = await page.evaluate(() => document.body.innerText.slice(0, 500));
        throw new Error('SMS verify failed: ' + t);
      }
      await this.saveState();
      return { ok: true, landedOn: page.url(), trusted_device: true };
    } finally {
      await page.close();
    }
  }

  // Is the saved/current session still authenticated?
  async isAuthed() {
    await this.start();
    const resp = await this.context.request.get(`${BASE_URL}/calendar`, {
      maxRedirects: 0,
    });
    // TLC redirects unauthenticated requests to /login (302).
    return resp.status() !== 302 && resp.ok();
  }

  async ensureAuthed(email, password) {
    if (await this.isAuthed()) return;
    if (!email || !password) {
      throw new Error(
        'TLC session expired or missing and no credentials supplied. ' +
          'Set TLC_EMAIL and TLC_PASSWORD env vars (or pass via config).'
      );
    }
    await this.login(email, password);
  }

  // GET an authenticated path; returns { status, url, body } with body as text.
  async fetchText(urlPath, { headers = {} } = {}) {
    await this.start();
    const url = urlPath.startsWith('http') ? urlPath : `${BASE_URL}${urlPath}`;
    const resp = await this.context.request.get(url, { headers });
    const body = await resp.text();
    if (resp.status() === 302 || /Login to Trail Life Connect/.test(body)) {
      return { status: 'UNAUTHENTICATED', url: resp.url(), body };
    }
    return { status: resp.status(), url: resp.url(), body };
  }

  // POST a Yii-style form (auto-attaches _csrf from the matching GET page).
  async postForm(urlPath, fields, { csrfSource = urlPath, headers = {}, timeout = 30000 } = {}) {
    await this.start();
    const url = `${BASE_URL}${urlPath}`;
    let csrf = fields._csrf;
    if (!csrf) {
      const src = await this.context.request.get(
        csrfSource.startsWith('http') ? csrfSource : `${BASE_URL}${csrfSource}`
      );
      const html = await src.text();
      const m =
        html.match(/name="csrf-token"\s+content="([^"]+)"/) ||
        html.match(/name="_csrf"[^>]*value="([^"]+)"/);
      if (!m) throw new Error(`Could not extract CSRF from ${csrfSource}`);
      csrf = m[1];
    }
    const resp = await this.context.request.post(url, {
      form: { _csrf: csrf, ...fields },
      headers,
      timeout,
    });
    const body = await resp.text();
    return { status: resp.status(), url: resp.url(), body };
  }

  // POST a pre-serialized urlencoded body (exact bytes — needed where PHP
  // 'key[]' array params are involved and Playwright's form serializer mangles them).
  async postRaw(urlPath, body, headers = {}) {
    await this.start();
    const url = urlPath.startsWith('http') ? urlPath : `${BASE_URL}${urlPath}`;
    const resp = await this.context.request.post(url, {
      data: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', ...headers },
      timeout: 300000,
    });
    const text = await resp.text();
    return { status: resp.status(), body: text };
  }

  static formBody(obj) {
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) for (const x of v) parts.push(`${encodeURIComponent(k)}[]=${encodeURIComponent(x ?? '')}`);
      else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`);
    }
    return parts.join('&');
  }

  // ---- Event form parsing (create + update pages share one form) ----

  // Extracts the <form id="event-form"> block and returns { csrf, fields }
  // with every Event[...] input/select/textarea current value.
  parseEventForm(html) {
    const m = html.match(/<form id="event-form"[\s\S]*?<\/form>/);
    if (!m) throw new Error('event-form not found on page');
    const form = m[0];
    const csrf = (form.match(/name="_csrf"[^>]*value="([^"]+)"/) || [])[1];
    const fields = {};
    for (const inp of form.matchAll(/<input[^>]*name="(Event\[[^"]+\])"[^>]*>/g)) {
      const tag = inp[0];
      // checkboxes/radios: take value attr only when checked (checkboxX uses hidden inputs, always sent)
      const type = (tag.match(/type="([^"]*)"/) || [])[1] || 'text';
      const value = (tag.match(/value="([^"]*)"/) || [])[1] ?? '';
      if ((type === 'checkbox' || type === 'radio') && !/checked/.test(tag) && !tag.includes('hidden')) continue;
      fields[inp[1]] = value;
    }
    for (const sel of form.matchAll(/<select[^>]*name="(Event\[[^"]+\])"[\s\S]*?<\/select>/g)) {
      const opts = [...sel[0].matchAll(/<option value="([^"]*)"[^>]*>/g)];
      const chosen = opts.find((o) => /\bselected\b/.test(o[0])) || opts[0];
      fields[sel[1]] = chosen ? chosen[1] : '';
    }
    for (const ta of form.matchAll(/<textarea[^>]*name="(Event\[[^"]+\])"[\s\S]*?<\/textarea>/g)) {
      fields[ta[1]] = ta[0].replace(/<textarea[^>]*>/, '').replace(/<\/textarea>/, '');
    }
    return { csrf, fields };
  }

  // ---- view-events grid crawler ----

  // Returns all rows: { ev_id (data-key), et_ref (edit link), cells: {seq: text} }
  async crawlViewEvents({ maxPages = 40 } = {}) {
    const rows = [];
    for (let page = 1; page <= maxPages; page++) {
      const path = page === 1 ? '/calendar/view-events' : `/calendar/view-events?page=${page}`;
      const r = await this.fetchText(path);
      if (r.status === 'UNAUTHENTICATED') throw new Error('session expired');
      let count = 0;
      for (const tr of r.body.matchAll(/<tr class="[^"]*" data-key="(ev[a-z0-9]+)">([\s\S]*?)<\/tr>/g)) {
        count++;
        const cells = {};
        for (const td of tr[2].matchAll(/<td[^>]*data-col-seq="(\d+)"[^>]*>([\s\S]*?)<\/td>/g)) {
          if (td[1] === '8' && /toggle-green/.test(td[2])) { cells['8'] = 'Y'; continue; }
          cells[td[1]] = td[2]
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
            .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ').trim();
        }
        const et = (tr[2].match(/\/calendar\/update\/(et[a-z0-9]+)/) || [])[1];
        rows.push({ ev_id: tr[1], et_ref: et, cells });
      }
      if (count === 0) break;
      // Total pages = max page number seen in pagination hrefs on this page.
      const pages = [...r.body.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
      const maxPage = pages.length ? Math.max(...pages) : page;
      if (page >= maxPage) break;
    }
    return rows;
  }

  // Parse per-event lesson/activity grid (troop_lessons_grid on the update page).
  // Returns [{lesson_id, level, patrols, primary_leader, assistants, activity, notes, game_time}]
  parseLessonRows(html) {
    const gi = html.indexOf('id="troop_lessons_grid"');
    if (gi === -1) return [];
    const seg = html.slice(gi, gi + 60000);
    const rows = [];
    for (const tr of seg.matchAll(/<tr[^>]*data-key="(les[a-z0-9]+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = {};
      for (const td of tr[2].matchAll(/data-col-seq="(\d+)"[^>]*>([\s\S]*?)<\/td>/g)) {
        cells[td[1]] = td[2]
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
          .replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
          .replace(/&#0?46;/g, '.').replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ').trim();
      }
      rows.push({
        lesson_id: tr[1],
        level: cells['0'] || '',
        patrols: cells['1'] || '',
        primary_leader: cells['2'] || '',
        assistants: cells['3'] || '',
        activity: cells['4'] || '',
        notes: cells['5'] || '',
        game_time: cells['6'] || '',
      });
    }
    return rows;
  }
}
