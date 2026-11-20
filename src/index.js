#!/usr/bin/env node
// MCP server for Trail Life Connect (traillifeconnect.com).
// Calendar reporting + event create/update/delete against the TLC Yii app.
//
// Credentials: TLC_EMAIL / TLC_PASSWORD env vars, or
// ~/.config/tlc-mcp/credentials.env. Session (trusted-device) cached in state/.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TLCClient, BASE_URL } from './tlc-client.js';

function loadCredentials() {
  if (process.env.TLC_EMAIL && process.env.TLC_PASSWORD) {
    return { email: process.env.TLC_EMAIL, password: process.env.TLC_PASSWORD };
  }
  const credFile =
    process.env.TLC_CREDENTIALS_FILE ||
    path.join(os.homedir(), '.config', 'tlc-mcp', 'credentials.env');
  if (fs.existsSync(credFile)) {
    const out = {};
    for (const line of fs.readFileSync(credFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    if (out.TLC_EMAIL && out.TLC_PASSWORD) return { email: out.TLC_EMAIL, password: out.TLC_PASSWORD };
  }
  return {};
}

const tlc = new TLCClient();
const creds = loadCredentials();
let eventTypeCache = null; // label<->token map + create-form defaults, from the live form

const server = new McpServer({ name: 'tlc-mcp-server', version: '0.2.0' });

function textResult(obj) {
  return {
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
  };
}

async function ensureSession() {
  await tlc.ensureAuthed(creds.email, creds.password);
}

// Load the create form once and cache Event[...] defaults + event-type options.
async function formDefaults() {
  if (eventTypeCache) return eventTypeCache;
  const r = await tlc.fetchText('/calendar/create');
  if (r.status === 'UNAUTHENTICATED') throw new Error('session expired');
  const parsed = tlc.parseEventForm(r.body);
  const sel = [...r.body.matchAll(/<select[^>]*name="Event\[event_type_id\]"[\s\S]*?<\/select>/g)][0][0];
  const options = [...sel.matchAll(/<option value="([^"]*)"[^>]*>([^<]+)</g)]
    .map((m) => ({ value: m[1], label: m[2].trim() }))
    .filter((o) => o.value);
  eventTypeCache = { fields: parsed.fields, options };
  return eventTypeCache;
}

function resolveType(input, options) {
  const s = input.toLowerCase();
  const byValue = options.find((o) => o.value === s);
  if (byValue) return byValue.value;
  const byLabel = options.filter((o) => o.label.toLowerCase().includes(s));
  if (byLabel.length === 1) return byLabel[0].value;
  if (byLabel.length > 1)
    throw new Error(`Ambiguous event type "${input}": ${byLabel.map((o) => o.label).join(' | ')}`);
  throw new Error(`Unknown event type "${input}". Options: ${options.map((o) => o.label).join(', ')}`);
}

// "2026-11-22T09:00" or "2026-11-22" -> "11-22-2026 09:00 AM" (event-local wall clock)
function fmtTlcDate(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) throw new Error(`Bad date "${iso}" — use YYYY-MM-DD or YYYY-MM-DDTHH:MM`);
  const [, y, mo, d, hh, mm] = m;
  let hour = hh ? Number(hh) : 9;
  const min = mm ? Number(mm) : 0;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${mo}-${d}-${y} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')} ${ampm}`;
}

// Friendly params -> Event[...] field overrides
function mapChanges(c, options) {
  const f = {};
  if (c.title !== undefined) f['Event[title]'] = c.title;
  if (c.event_type !== undefined) f['Event[event_type_id]'] = resolveType(c.event_type, options);
  if (c.start) {
    if (!c.end) throw new Error('start requires end');
    f['Event[date_range]'] = `${fmtTlcDate(c.start)} to ${fmtTlcDate(c.end)}`;
  }
  if (c.timezone) f['Event[timezone]'] = c.timezone;
  if (c.venue !== undefined) f['Event[location_name]'] = c.venue;
  if (c.address1 !== undefined) f['Event[address1]'] = c.address1;
  if (c.address2 !== undefined) f['Event[address2]'] = c.address2;
  if (c.city !== undefined) f['Event[city]'] = c.city;
  if (c.state !== undefined) f['Event[state]'] = c.state;
  if (c.zip !== undefined) f['Event[zip]'] = c.zip;
  if (c.content !== undefined) f['Event[content]'] = c.content;
  if (c.active !== undefined) f['Event[active]'] = c.active ? '1' : '0';
  if (c.fields) {
    for (const [k, v] of Object.entries(c.fields)) {
      f[k.startsWith('Event[') ? k : `Event[${k}]`] = String(v);
    }
  }
  return f;
}

const changeParams = {
  title: z.string().optional().describe('Event title'),
  event_type: z.string().optional().describe('Event type label or token (e.g. "Campout", "etcampout")'),
  start: z.string().optional().describe('Start, YYYY-MM-DD or YYYY-MM-DDTHH:MM (event-local wall clock)'),
  end: z.string().optional().describe('End, same format'),
  timezone: z.string().optional().describe('IANA tz, e.g. America/Chicago'),
  venue: z.string().optional().describe('Venue name (location_name)'),
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional().describe('2-letter state code'),
  zip: z.string().optional(),
  content: z.string().optional().describe('Event description/details text'),
  active: z.boolean().optional(),
  fields: z.record(z.string()).optional().describe('Raw Event[...] field overrides (advanced)'),
};

// Detect Yii validation failure on a re-rendered form page.
function formErrors(html) {
  const errs = [...html.matchAll(/class="help-block"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
    .filter((t) => t && !/^\* required$/.test(t));
  const flash = [...html.matchAll(/alert-danger[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return [...errs, ...flash];
}

// ---------- session tools ----------

server.registerTool(
  'tlc_login',
  {
    title: 'TLC login',
    description:
      'Verify or refresh the Trail Life Connect session. Password login + SMS 2FA; a trusted-device session lasts ~30 days.',
    inputSchema: {
      sms_code: z.string().optional().describe('SMS 2FA code, if prompted'),
      force: z.boolean().optional(),
    },
  },
  async ({ sms_code, force }) => {
    if (!creds.email || !creds.password)
      return textResult({ error: 'No credentials at ~/.config/tlc-mcp/credentials.env' });
    try {
      if (!force && (await tlc.isAuthed())) return textResult({ ok: true, note: 'saved session valid' });
      const r = await tlc.login(creds.email, creds.password);
      if (r.landedOn.includes('sms-verify')) {
        if (!sms_code)
          return textResult({
            ok: false,
            needs_sms_code: true,
            note: 'SMS sent to the mobile number on the account; re-call with sms_code.',
          });
        const v = await tlc.smsVerify(sms_code);
        return textResult(v);
      }
      return textResult(r);
    } catch (e) {
      return textResult({ error: e.message });
    }
  }
);

// ---------- calendar tools ----------

server.registerTool(
  'tlc_calendar_report',
  {
    title: 'TLC calendar report',
    description:
      'Report calendar events (all scopes visible to this staff account) between two dates. Returns ev_id, edit_ref, type, date, title, venue, active/going/attended.',
    inputSchema: {
      from: z.string().describe('YYYY-MM-DD'),
      to: z.string().describe('YYYY-MM-DD'),
    },
  },
  async ({ from, to }) => {
    await ensureSession();
    const rows = await tlc.crawlViewEvents();
    const fromDate = new Date(from + 'T00:00:00');
    const toDate = new Date(to + 'T23:59:59');
    const out = [];
    for (const row of rows) {
      const dm = (row.cells['2'] || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (!dm) continue;
      const d = new Date(Number(dm[3]), Number(dm[1]) - 1, Number(dm[2]));
      if (d < fromDate || d > toDate) continue;
      out.push({
        ev_id: row.ev_id,
        edit_ref: row.et_ref,
        type: row.cells['1'],
        date: row.cells['2'],
        title: row.cells['3'],
        venue: row.cells['4'],
        active: row.cells['8'],
        going: row.cells['10'],
        attended: row.cells['11'],
      });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return textResult({ count: out.length, from, to, events: out });
  }
);

server.registerTool(
  'tlc_event_details',
  {
    title: 'TLC event details',
    description:
      'Full details of one event: all non-empty Event[...] form fields (title, date_range, fees, leads, RSVP settings...). Accepts the et... edit ref from tlc_calendar_report.',
    inputSchema: { ref: z.string().describe('et... edit ref (or ev... id)') },
  },
  async ({ ref }) => {
    await ensureSession();
    let pathRef = ref;
    if (ref.startsWith('ev')) {
      const rows = await tlc.crawlViewEvents();
      const hit = rows.find((r) => r.ev_id === ref);
      if (!hit) return textResult({ error: `no edit ref found for ${ref}` });
      pathRef = hit.et_ref;
    }
    const r = await tlc.fetchText(`/calendar/update/${pathRef}`);
    if (r.status === 'UNAUTHENTICATED') return textResult({ error: 'session expired' });
    const { fields } = tlc.parseEventForm(r.body);
    const data = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v && v !== '0' && k !== 'Event[viewValidator]') data[k.replace('Event[', '').replace(']', '')] = v;
    }
    return textResult({ ref: pathRef, fields: data });
  }
);

server.registerTool(
  'tlc_event_create',
  {
    title: 'TLC create event',
    description:
      'Create a calendar event. Required: title, start, end, event_type. Everything else inherits site defaults. Returns refs for the new event.',
    inputSchema: changeParams,
  },
  async (params) => {
    await ensureSession();
    const { fields: defaults, options } = await formDefaults();
    if (!params.title || !params.start || !params.end || !params.event_type)
      return textResult({ error: 'title, start, end, event_type are required' });
    let overrides;
    try {
      overrides = mapChanges(params, options);
    } catch (e) {
      return textResult({ error: e.message });
    }
    const body = { ...defaults, ...overrides };
    const r = await tlc.postForm('/calendar/create', body);
    const errs = formErrors(r.body);
    if (errs.length) return textResult({ ok: false, validation_errors: errs });
    const ref =
      (r.url.match(/\/calendar\/update\/(et[a-z0-9]+)/) || [])[1] ||
      (r.body.match(/\/calendar\/update\/(et[a-z0-9]+)/) || [])[1];
    const ev = (r.body.match(/delete\/(ev[a-z0-9]+)/) || [])[1];
    return textResult({
      ok: true,
      edit_ref: ref,
      ev_id: ev,
      url: ref ? `${BASE_URL}/calendar/update/${ref}` : r.url,
    });
  }
);

server.registerTool(
  'tlc_event_update',
  {
    title: 'TLC update event',
    description:
      'Update an existing event: loads the current event, applies only the fields you pass, posts the rest back unchanged.',
    inputSchema: { ref: z.string().describe('et... edit ref'), ...changeParams },
  },
  async ({ ref, ...params }) => {
    await ensureSession();
    const { options } = await formDefaults();
    const get = await tlc.fetchText(`/calendar/update/${ref}`);
    if (get.status === 'UNAUTHENTICATED') return textResult({ error: 'session expired' });
    let overrides;
    try {
      overrides = mapChanges(params, options);
    } catch (e) {
      return textResult({ error: e.message });
    }
    if (!Object.keys(overrides).length) return textResult({ ok: false, error: 'no changes given' });
    const { csrf, fields } = tlc.parseEventForm(get.body);
    const body = { _csrf: csrf, ...fields, ...overrides };
    const r = await tlc.postForm(`/calendar/update/${ref}`, body);
    const errs = formErrors(r.body);
    if (errs.length) return textResult({ ok: false, validation_errors: errs, posted: Object.keys(overrides) });
    return textResult({ ok: true, ref, changed: Object.keys(overrides) });
  }
);

server.registerTool(
  'tlc_event_delete',
  {
    title: 'TLC delete event',
    description:
      'Delete an event (hard delete, same as the red Delete event button). notify=true notifies participants.',
    inputSchema: {
      ref: z.string().describe('et... edit ref or ev... event id'),
      notify: z.boolean().optional().describe('Notify participants (default false)'),
    },
  },
  async ({ ref, notify = false }) => {
    await ensureSession();
    let ev = ref;
    if (ref.startsWith('et')) {
      const get = await tlc.fetchText(`/calendar/update/${ref}`);
      ev = (get.body.match(/delete\/(ev[a-z0-9]+)/) || [])[1];
      if (!ev) return textResult({ error: `no ev id found on update page for ${ref}` });
    }
    const action = `/calendar/delete/${ev}?viewType=dayGridMonth&notify=${notify ? 1 : 0}&delete=1`;
    const r = await tlc.postForm(action, {});
    // Authoritative check: the ev row must be gone from the events grid.
    const rows = await tlc.crawlViewEvents();
    if (rows.some((x) => x.ev_id === ev)) {
      const errs = formErrors(r.body);
      return textResult({ ok: false, still_present: true, validation_errors: errs });
    }
    return textResult({ ok: true, deleted: ev, notified: !!notify });
  }
);

server.registerTool(
  'tlc_event_lessons',
  {
    title: 'TLC event lesson plan',
    description:
      'Lesson/activity plan rows for an event (level, patrols, primary leader, assistants, activity, notes). Accepts one et... ref or a list.',
    inputSchema: {
      refs: z.array(z.string()).describe('et... edit refs'),
    },
  },
  async ({ refs }) => {
    await ensureSession();
    const out = [];
    for (const ref of refs) {
      const r = await tlc.fetchText(`/calendar/update/${ref}`);
      if (r.status === 'UNAUTHENTICATED') return textResult({ error: 'session expired' });
      out.push({ ref, lessons: tlc.parseLessonRows(r.body) });
    }
    return textResult(out);
  }
);

server.registerTool(
  'tlc_event_add_lesson',
  {
    title: 'TLC add lesson/activity to event',
    description:
      'Replicates the UI flow: meeting -> Activity Plans -> Level (default Woodlands Trail) -> Badge/Branch -> Item -> Create Activity. Resolves branch+item labels to ids via the cascade, creates the lesson, and verifies it appears on the event.',
    inputSchema: {
      ref: z.string().describe('et... edit ref of the meeting'),
      branch: z.string().describe('Branch/badge label, e.g. "Values Branch", "Life Skills Branch"'),
      item: z.string().describe('Branch item label (substring ok), e.g. "Godly Citizenship"'),
      level: z.string().optional().describe('Woodlands Trail (default, covers all 3 patrols), Foxes, Hawks, Mountain Lions, Navigators, or Adventurers. Ignored if patrols given.'),
      patrols: z.array(z.string()).optional().describe('Scope to actual patrols (Fox, Hawk, Mountain Lion, Legends, Guidon, Adventurer) instead of a level'),
      title: z.string().optional().describe('Reference title (defaults to item name)'),
      notes: z.string().optional(),
      game_time: z.string().optional(),
    },
  },
  async ({ ref, branch, item, level = 'Woodlands Trail', patrols, title, notes = '', game_time = '' }) => {
    await ensureSession();
    const LEVEL_IDS = {
      'woodlands trail': 'wt',
      'foxes': 'l3c59dc048e8',
      'hawks': 'ib6d767d2f8e',
      'mountain lions': 'k37693cfc748',
      'navigators': 'j8e296a067a3',
      'adventurers': 'x1ff1de77400',
    };
    if (!patrols && !LEVEL_IDS[level.toLowerCase()])
      return textResult({ error: `Unknown level "${level}". Use Woodlands Trail, Foxes, Hawks, Mountain Lions, Navigators, or Adventurers.` });

    // 1. Resolve branch -> badge id from the event page's badge select.
    const page = await tlc.fetchText(`/calendar/update/${ref}`);
    if (page.status === 'UNAUTHENTICATED') return textResult({ error: 'session expired' });
    const sel = [...page.body.matchAll(/<select[^>]*name="Lesson\[badge_id\]\[\]"[\s\S]*?<\/select>/g)][0]?.[0];
    if (!sel) return textResult({ error: 'badge select not found — is this an event with Activity Plans?' });
    const badges = [...sel.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)/g)]
      .map((m) => ({ id: m[1], label: m[2].replace(/&amp;/g, '&').replace(/\|.*$/, '').trim() }));
    const bl = branch.toLowerCase();
    const badgeMatches = badges.filter((b) => b.label.toLowerCase().includes(bl));
    if (badgeMatches.length !== 1)
      return textResult({ error: `Branch "${branch}" matched ${badgeMatches.length} badges`, options: badgeMatches.map((b) => b.label) });
    const badge = badgeMatches[0];

    // 2. Cascade: get-badge-items -> resolve item label to id.
    const itemsResp = await tlc.postForm(
      '/databuilder/get-badge-items',
      { 'depdrop_parents[0]': badge.id },
      { csrfSource: `/calendar/update/${ref}` }
    );
    let groups;
    try {
      groups = JSON.parse(itemsResp.body).output;
    } catch {
      return textResult({ error: 'items cascade returned non-JSON', body: itemsResp.body.slice(0, 300) });
    }
    if (!groups || typeof groups !== 'object') return textResult({ error: 'no items for badge', badge: badge.label });
    const allItems = Object.values(groups).flatMap((g) => g);
    const il = item.toLowerCase();
    const itemMatches = allItems.filter((it) => it.name.toLowerCase().includes(il));
    if (itemMatches.length !== 1)
      return textResult({ error: `Item "${item}" matched ${itemMatches.length} items in ${badge.label}`, options: itemMatches.map((x) => x.name) });
    const found = itemMatches[0];

    // 3. Scope: patrols (patrol toggle) or level.
    let toggle = 'level', levelArr = [LEVEL_IDS[level.toLowerCase()]], patrolArr = [];
    if (patrols && patrols.length) {
      const psel = [...page.body.matchAll(/<select[^>]*name="Lesson\[patrol_id\]\[\]"[\s\S]*?<\/select>/g)][0]?.[0];
      if (!psel) return textResult({ error: 'patrol select not found on event page' });
      const popts = [...psel.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)/g)]
        .map((m) => ({ id: m[1], label: m[2].trim() }));
      const ids = [];
      for (const p of patrols) {
        const hit = popts.filter((o) => o.label.toLowerCase() === p.toLowerCase());
        if (hit.length !== 1)
          return textResult({ error: `Patrol "${p}" matched ${hit.length}`, options: popts.map((o) => o.label) });
        ids.push(hit[0].id);
      }
      toggle = 'patrol';
      levelArr = [];
      patrolArr = ids;
    }

    // 4. Create Activity (Lesson[...] form on the event update page).
    await tlc.postForm(`/calendar/update/${ref}`, {
      'Lesson[title]': title || found.name.replace(/^\d+\.\s*/, ''),
      level_patrol_toggle: toggle,
      'Lesson[level_id]': '',
      'Lesson[level_id][]': levelArr,
      'Lesson[patrol_id]': '',
      'Lesson[patrol_id][]': patrolArr,
      'Lesson[primary_leader_id]': '',
      'Lesson[assistants_id]': '',
      'Lesson[badge_id]': '',
      'Lesson[badge_id][]': [badge.id],
      'Lesson[items_id]': '',
      'Lesson[items_id][]': [found.id],
      'Lesson[notes]': notes,
      'Lesson[game_time]': game_time,
      'Lesson[plan_json]': '',
    });

    // 5. Verify on the event grid.
    const after = await tlc.fetchText(`/calendar/update/${ref}`);
    const rows = tlc.parseLessonRows(after.body);
    const hit = rows.find((r) => r.activity.toLowerCase().includes(il));
    if (!hit) return textResult({ ok: false, error: 'lesson not found on event after create', badge: badge.label, item: found.name });
    return textResult({ ok: true, lesson_id: hit.lesson_id, activity: hit.activity, level: hit.level, item: found.name });
  }
);

server.registerTool(
  'tlc_lessons_report',
  {
    title: 'TLC advancement/lesson report by patrol',
    description:
      'Report all lesson/activity plans on events between two dates, with per-patrol coverage for Woodlands Trail (Foxes/Hawks/Mountain Lions). Level-scoped (Woodlands Trail) lessons count for all three patrols; patrol-scoped lessons count only for their patrols.',
    inputSchema: {
      from: z.string().describe('YYYY-MM-DD'),
      to: z.string().describe('YYYY-MM-DD'),
      type_filter: z.string().optional().describe('Substring of event type, default "Troop meeting"'),
    },
  },
  async ({ from, to, type_filter = 'meeting' }) => {
    await ensureSession();
    const PATROLS = ['Foxes', 'Hawks', 'Mountain Lions'];
    const fromDate = new Date(from + 'T00:00:00');
    const toDate = new Date(to + 'T23:59:59');
    const events = [];
    for (const row of await tlc.crawlViewEvents()) {
      const dm = (row.cells['2'] || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (!dm) continue;
      const d = new Date(Number(dm[3]), Number(dm[1]) - 1, Number(dm[2]));
      if (d < fromDate || d > toDate) continue;
      const type = row.cells['1'] || '';
      if (!type.toLowerCase().includes(type_filter.toLowerCase())) continue;
      events.push({ ref: row.et_ref, date: `${dm[3]}-${dm[1]}-${dm[2]}`, title: row.cells['3'] });
    }
    const meetings = [];
    for (const ev of events) {
      const page = await tlc.fetchText(`/calendar/update/${ev.ref}`);
      const rows = page.status === 200 ? tlc.parseLessonRows(page.body) : [];
      meetings.push({
        date: ev.date,
        title: ev.title,
        ref: ev.ref,
        lessons: rows.map((r) => {
          const lv = r.level || '', pt = r.patrols || '';
          const scoped = PATROLS.filter((p) => lv.includes('Woodlands') || lv.includes(p) || pt.includes(p));
          return { lesson_id: r.lesson_id, activity: r.activity, level: r.level, patrols: r.patrols, covers: scoped };
        }),
      });
    }
    const byPatrol = {};
    for (const p of PATROLS) {
      byPatrol[p] = meetings
        .flatMap((m) => m.lessons.filter((l) => l.covers.includes(p)).map((l) => `${m.date}  ${l.activity}`));
    }
    return textResult({ from, to, event_count: events.length, meetings, patrol_coverage: byPatrol });
  }
);

server.registerTool(
  'tlc_lesson_delete',
  {
    title: 'TLC delete lesson/activity',
    description: 'Delete one lesson/activity-plan row (les... id from tlc_lessons_report or tlc_event_lessons) from its event.',
    inputSchema: {
      lesson_id: z.string().describe('les... lesson id'),
      ref: z.string().describe('et... edit ref of the event the lesson is on (for CSRF)'),
    },
  },
  async ({ lesson_id, ref }) => {
    await ensureSession();
    await tlc.postForm(`/calendar/delete-lesson?id=${lesson_id}`, {}, { csrfSource: `/calendar/update/${ref}` });
    const after = await tlc.fetchText(`/calendar/update/${ref}`);
    const gone = !tlc.parseLessonRows(after.body).some((r) => r.lesson_id === lesson_id);
    return textResult({ ok: gone, lesson_id, verified_gone: gone });
  }
);

server.registerTool(
  'tlc_advancement_report',
  {
    title: 'TLC advancement completion report (Track Advancement heatmap)',
    description:
      'READ-ONLY Track Advancement grid (never touches write endpoints): per step, per boy: earned/not + completion date + tooltip note + purchased/awarded flags, with per-patrol completion % (badge default Heritage Branch, Woodlands Trail Foxes/Hawks/Mountain Lions).',
    inputSchema: {
      badge: z.string().optional().describe('Badge/branch label, e.g. "Heritage Branch", "Values Branch" (default Heritage Branch)'),
      level: z.string().optional().describe('Woodlands Trail (default), Navigators, or Adventurers'),
      patrols: z.array(z.string()).optional().describe('Patrols/levels to include, default Foxes, Hawks, Mountain Lions'),
    },
  },
  async ({ badge = 'Heritage Branch', level = 'Woodlands Trail', patrols }) => {
    await ensureSession();
    const LEVEL_IDS = { 'woodlands trail': 'wt', navigators: 'navadv', adventurers: 'navadv' };
    const levelParam = LEVEL_IDS[level.toLowerCase()];
    if (!levelParam) return textResult({ error: `Unknown level "${level}"` });
    const wantedPatrols = (patrols && patrols.length ? patrols : ['Foxes', 'Hawks', 'Mountain Lions']);

    // 1. Session-configured GET: sets level + group context, gives CSRF, badge options, WT roster.
    const groupIds = { foxes: 'l3c59dc048e8', hawks: 'ib6d767d2f8e', 'mountain lions': 'k37693cfc748' };
    const gid = wantedPatrols.map((p) => groupIds[p.toLowerCase()]).filter(Boolean).join(',');
    const page = await tlc.fetchText(`/advancement/index?level=${levelParam}&user_id=${gid}&award_id=&style=grid`);
    if (page.status === 'UNAUTHENTICATED') return textResult({ error: 'session expired' });
    const meta = (page.body.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
    const sel = page.body.match(/<select[^>]*name="badge-select"[\s\S]*?<\/select>/)[0];
    const badges = [...sel.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)/g)]
      .map((m) => ({ id: m[1], label: m[2].replace(/&amp;/g, '&').replace(/\|.*$/, '').trim() }));
    const bm = badges.filter((b) => b.label.toLowerCase() === badge.toLowerCase());
    if (bm.length !== 1) return textResult({ error: `Badge "${badge}" matched ${bm.length}`, options: badges.map((b) => b.label) });
    const badgeId = bm[0].id;

    // 2. Roster: optgroups (patrol name -> kids) from the trailmen select.
    const tsel = page.body.match(/<select[^>]*name="trailmen-select\[\]"[\s\S]*?<\/select>/)[0];
    const boys = [];
    for (const g of tsel.matchAll(/<optgroup label="([^"]*)"[\s\S]*?(?=<optgroup|<\/select>)/g))
      for (const k of g[0].matchAll(/<option value="(u[^"]*)"[^>]*>([^<]*)/g))
        boys.push({ id: k[1], name: k[2], patrol: g[1], levelKey: groupIds[g[1].toLowerCase()] });
    if (!boys.length) return textResult({ error: 'no trailmen in roster for this level/patrols' });

    const H = { 'X-CSRF-Token': meta, 'X-Requested-With': 'XMLHttpRequest' };
    const kids = boys.map((b) => b.id);

    // 3. Grid fragment ONLY. NOTE: /advancement/process-advancement is a WRITE
    // (toggle) endpoint — the site uses it for cell clicks. Never call it to read.
    // Completion state is rendered server-side in the fragment (data-value, icon,
    // completed_on_date div).
    const gridBody = TLCClient.formBody({
      _csrf: meta, level: levelParam, style: 'grid', trailmen: kids, badges: badgeId,
      trackLevel: '', lockedChecked: '1', event_id: '', track_attendance: '0',
    });
    const frag = await tlc.postRaw('/advancement/badge-tracker-view', gridBody, H);
    const tbody = frag.body.match(/<tbody id="table_items">([\s\S]*?)<\/tbody>/);
    if (!tbody) return textResult({ error: 'grid fragment not returned', status: frag.status, snippet: frag.body.slice(0, 300) });

    const steps = [];
    let section = '';
    for (const tr of tbody[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [];
      for (const m of tr[1].matchAll(/id="([a-z0-9]+_u[a-z0-9]+_[a-z0-9]+)"([^>]*)>([\s\S]*?)<\/td>/g)) {
        const done = /data-value="1"/.test(m[2]) || /fa-check\b/.test(m[3]);
        const on = (m[3].match(/class="completed_on_date"[^>]*>([^<]*)/) || [])[1] || '';
        const note = (m[3].match(/title="([^"]*)"/) || [])[1] || '';
        const purchased = /purchased_level/.test(m[3]);
        const awarded = /awarded_level/.test(m[3]);
        cells.push({ id: m[1], done, on: on.trim(), note: note.trim(), purchased, awarded });
      }
      const label = ((tr[1].match(/<th[^>]*>([\s\S]*?)<\/th>/) || tr[1].match(/<td[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '')
        .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (!cells.length) { if (label) section = label; continue; }
      steps.push({ section, name: label, cells });
    }
    if (!steps.length) return textResult({ error: 'no step rows parsed' });

    // 4. Aggregate from fragment-rendered state (read-only).
    const patrolNames = [...new Set(boys.map((b) => b.patrol))];
    const cellFor = (s, b) => s.cells.find((c) => c.id.includes('_' + b.id + '_'));
    const report = steps.map((s) => {
      const per = {};
      const earned_by = [];
      const all = {};
      for (const b of boys) {
        const c = cellFor(s, b);
        const flag = c?.done ? 'Y' : 'n';
        all[b.name] = c ? flag + (c.on ? '@' + c.on : '') + (c.purchased ? ' [purchased]' : '') + (c.awarded ? ' [awarded]' : '') + (c.note ? ' "' + c.note + '"' : '') : '?';
        if (c && c.done) {
          per[b.patrol] = (per[b.patrol] || 0) + 1;
          earned_by.push({ boy: b.name, on: c.on, note: c.note });
        }
      }
      const completion = {};
      for (const p of patrolNames) {
        const total = boys.filter((b) => b.patrol === p).length;
        const n = per[p] || 0;
        completion[p] = `${n}/${total} (${total ? Math.round((n / total) * 100) : 0}%)`;
      }
      return { section: s.section, step: s.name, completion, earned_by, cells: all };
    });
    const perPatrolTotals = {};
    for (const p of patrolNames) {
      perPatrolTotals[p] = boys.filter((b) => b.patrol === p).map((b) => {
        let earned = 0;
        for (const s of steps) if (cellFor(s, b)?.done) earned++;
        return { name: b.name, steps_earned: `${earned}/${steps.length}` };
      });
    }
    return textResult({
      badge: bm[0].label,
      level,
      patrols: patrolNames,
      total_boys: boys.length,
      note: 'state parsed from server-rendered grid fragment; no write endpoints called',
      steps: report,
      per_patrol: perPatrolTotals,
    });
  }
);

server.registerTool(
  'tlc_ical_feeds',
  {
    title: 'TLC iCal feed URLs',
    description:
      'Personalized iCalendar feed URLs (troop/area/region/home_office/all + public) for subscribing other calendar apps. SECURITY: the URL path is a secret token.',
    inputSchema: {},
  },
  async () => {
    await ensureSession();
    const r = await tlc.fetchText('/calendar/ical');
    const feeds = [...r.body.matchAll(/\/icalendar\/[a-z0-9\/_]+/g)].map((m) => BASE_URL + m[0]);
    return textResult({ feeds: [...new Set(feeds)] });
  }
);

server.registerTool(
  'tlc_fetch_page',
  {
    title: 'TLC fetch authenticated page',
    description: 'GET any authenticated TLC path and return raw HTML (discovery/debug).',
    inputSchema: { path: z.string().describe('e.g. "/calendar"') },
  },
  async ({ path: p }) => {
    await ensureSession();
    const r = await tlc.fetchText(p);
    if (r.status === 'UNAUTHENTICATED') return textResult({ error: 'session expired; call tlc_login' });
    return textResult(r.body.slice(0, 30000));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
