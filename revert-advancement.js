// Revert accidental advancement toggles.
// The report sweep POSTed /advancement/process-advancement once per cell (Heritage
// Branch badge, all 48 WT boys, all step rows in the fragment) + probe-adv.js POSTed
// the single cell hbhmknwaozr5_uizy3scrbant_l3c59dc048e8 once.
// If the endpoint TOGGLES completed, one more identical POST per cell restores it.
// The probe cell was flipped twice (probe + sweep) so it is EXCLUDED from the sweep.
import { TLCClient } from './src/tlc-client.js';
const tlc = new TLCClient();
await tlc.start();
const fs = await import('fs');
const BADGE = 'acvhb63my62f';
const PROBE_CELL = 'hbhmknwaozr5_uizy3scrbant_l3c59dc048e8';

const page = await tlc.fetchText('/advancement/index?level=wt&user_id=l3c59dc048e8,ib6d767d2f8e,k37693cfc748&award_id=&style=grid');
const meta = (page.body.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
if (!meta) { console.log('NO CSRF', page.status); process.exit(1); }
const H = { 'X-CSRF-Token': meta, 'X-Requested-With': 'XMLHttpRequest' };
const tsel = page.body.match(/<select[^>]*name="trailmen-select\[\]"[\s\S]*?<\/select>/)[0];
const kids = [...tsel.matchAll(/<option value="(u[^"]*)"/g)].map((m) => m[1]);
console.log('boys:', kids.length);

const frag = await tlc.postRaw('/advancement/badge-tracker-view', TLCClient.formBody({
  _csrf: meta, level: 'wt', style: 'grid', trailmen: kids, badges: BADGE,
  trackLevel: '', lockedChecked: '1', event_id: '', track_attendance: '0',
}), H);
const tbody = frag.body.match(/<tbody id="table_items">([\s\S]*?)<\/tbody>/);
if (!tbody) { console.log('no tbody', frag.status, frag.body.slice(0, 200)); process.exit(1); }
const cellIds = [...frag.body.matchAll(/id="([a-z0-9]+_u[a-z0-9]+_[a-z0-9]+)"/g)].map((m) => m[1]);
console.log('cells in fragment:', cellIds.length, 'probe included:', cellIds.includes(PROBE_CELL));

const post = async (id) => {
  const r = await tlc.postRaw('/advancement/process-advancement', TLCClient.formBody({
    _csrf: meta, id, badge_id: BADGE, trailmen_id: kids, event_id: '', track_attendance: '0',
    selectedLevel: 'wt', trackLevel: '', dateSpecified: '', commentSpecified: '', clickedClass: '',
  }), H);
  try { return JSON.parse(r.body); } catch { return { raw: r.body.slice(0, 120) }; }
};

// 1) TOGGLE CHECK on one cell (2 POSTs = net zero) — also tells whether the
// response echoes pre- or post-toggle value.
if (process.argv[2] === 'check') {
  const c = cellIds.find((id) => id.endsWith('_' + kids[0] + '_l3c59dc048e8')) || cellIds[0];
  const a = await post(c); const b = await post(c);
  console.log('cell', c);
  console.log('post1:', JSON.stringify({ completed: a.completed, earned_on: a.earned_on, comment: a.comment }));
  console.log('post2:', JSON.stringify({ completed: b.completed, earned_on: b.earned_on, comment: b.comment }));
  console.log(a.completed !== b.completed ? 'TOGGLES (state alternates)' : 'does NOT toggle (or returns same)');
  process.exit(0);
}

// 2) full revert sweep, excluding the probe cell.
const todo = cellIds.filter((id) => id !== PROBE_CELL);
console.log('revert sweep:', todo.length, 'POSTs (probe cell excluded)');
let i = 0, errs = 0;
const pool = async (jobs, conc) => {
  let k = 0;
  const run = async () => { while (k < jobs.length) { await jobs[k++]; } };
  await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, run));
};
await pool(todo.map((id) => async () => {
  const j = await post(id);
  if (j.raw) errs++;
  if (++i % 200 === 0) console.log('  ...', i, 'done', 'errs', errs);
}), 6);
console.log('sweep complete. errors:', errs);

// 3) verify: fresh fragment, count done cells per step.
const frag2 = await tlc.postRaw('/advancement/badge-tracker-view', TLCClient.formBody({
  _csrf: meta, level: 'wt', style: 'grid', trailmen: kids, badges: BADGE,
  trackLevel: '', lockedChecked: '1', event_id: '', track_attendance: '0',
}), H);
fs.writeFileSync('out/verify-grid.html', frag2.body);
const tb2 = frag2.body.match(/<tbody id="table_items">([\s\S]*?)<\/tbody>/);
if (!tb2) { console.log('verify fragment missing tbody'); process.exit(1); }
let section = '';
for (const tr of tb2[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
  const cells = [...tr[1].matchAll(/id="([a-z0-9]+_u[a-z0-9]+_[a-z0-9]+)"([^>]*)>([\s\S]*?)<\/td>/g)];
  const label = ((tr[1].match(/<th[^>]*>([\s\S]*?)<\/th>/) || tr[1].match(/<td[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cells.length) { if (label) section = label; continue; }
  const per = {};
  for (const m of cells) {
    const lvl = m[1].split('_')[2];
    const done = /data-value="1"/.test(m[2]) || /fa-check/.test(m[3]);
    per[lvl] = per[lvl] || { done: 0, n: 0 };
    per[lvl].n++; if (done) per[lvl].done++;
  }
  console.log(section + ' | ' + label + ' | ' + Object.entries(per).map(([l, v]) => `${l}:${v.done}/${v.n}`).join(' '));
}
