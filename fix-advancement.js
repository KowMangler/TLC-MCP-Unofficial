// FIX corrupted Heritage Branch advancement grid.
// Root cause: an earlier version of tlc_advancement_report POSTed
// /advancement/process-advancement once per cell of the Heritage Branch grid
// fragment (all WT boys) to READ completion state. The endpoint TOGGLES it.
// Fix: replay one identical POST per affected cell to toggle back.
// The single probe cell (toggled twice, already original) is EXCLUDED.
import { TLCClient } from './src/tlc-client.js';
import fs from 'fs';
const tlc = new TLCClient();
await tlc.start();
const BADGE = 'acvhb63my62f'; // Heritage Branch
const PROBE_CELL = 'hbhmknwaozr5_uizy3scrbant_l3c59dc048e8';
const LEVELS = { l3c59dc048e8: 'Foxes', ib6d767d2f8e: 'Hawks', k37693cfc748: 'ML' };

const page = await tlc.fetchText('/advancement/index?level=wt&user_id=l3c59dc048e8,ib6d767d2f8e,k37693cfc748&award_id=&style=grid');
const meta = (page.body.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
if (!meta) { console.log('NO CSRF', page.status); process.exit(1); }
const H = { 'X-CSRF-Token': meta, 'X-Requested-With': 'XMLHttpRequest' };
const tsel = page.body.match(/<select[^>]*name="trailmen-select\[\]"[\s\S]*?<\/select>/)[0];
const kids = [...tsel.matchAll(/<option value="(u[^"]*)"/g)].map((m) => m[1]);
console.log('boys:', kids.length);

const fragBody = () => TLCClient.formBody({
  _csrf: meta, level: 'wt', style: 'grid', trailmen: kids, badges: BADGE,
  trackLevel: '', lockedLocked: '', lockedChecked: '1', event_id: '', track_attendance: '0',
});
const frag = await tlc.postRaw('/advancement/badge-tracker-view', fragBody(), H);
fs.writeFileSync('out/pre-fix-grid.html', frag.body);

// Rebuild the EXACT id set the broken sweep POSTed: the sweep collected, per row,
// every id matching <seg>_<uid>_<levelid> in the row HTML (td step cells AND any
// bp_/ss_ award img ids), across every <tr> of tbody.
const tb = frag.body.match(/<tbody id="table_items">([\s\S]*?)<\/tbody>/);
if (!tb) { console.log('no tbody', frag.status, frag.body.slice(0, 200)); process.exit(1); }
const ids = [];
for (const tr of tb[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
  for (const m of tr[1].matchAll(/id="([a-z0-9]+_u[a-z0-9]+_[a-z0-9]+)"/g)) ids.push(m[1]);
}
const todo = ids.filter((id) => id !== PROBE_CELL);
console.log('ids to re-toggle:', todo.length, '(step+award ids, same construction as broken sweep)');

const log = fs.createWriteStream('out/fix-log.jsonl');
let done = 0, fail = 0;
let k = 0;
const CONC = 6;
const run = async () => {
  while (k < todo.length) {
    const id = todo[k++];
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await tlc.postRaw('/advancement/process-advancement', TLCClient.formBody({
        _csrf: meta, id, badge_id: BADGE, trailmen_id: kids, event_id: '', track_attendance: '0',
        selectedLevel: 'wt', trackLevel: '', dateSpecified: '', commentSpecified: '', clickedClass: '',
      }), H);
      let j = null;
      try { j = JSON.parse(r.body); } catch {}
      if (j && typeof j.completed !== 'undefined') {
        log.write(JSON.stringify({ id, completed: j.completed, earned_on: j.earned_on, award: j.award_status || null }) + '\n');
        done++;
        break;
      }
      fail++;
      await new Promise((res) => setTimeout(res, 1500));
    }
    if ((done + fail) % 200 === 0) console.log(' progress', done + fail, '/', todo.length, 'fails', fail);
  }
};
await Promise.all(Array.from({ length: CONC }, run));
log.end();
console.log('re-toggle done:', done, 'failed attempts:', fail);

// Verify: fresh fragment, per-step counts. Should be the EXACT complement of the
// corrupted state (which the broken sweep reported).
const frag2 = await tlc.postRaw('/advancement/badge-tracker-view', fragBody(), H);
fs.writeFileSync('out/post-fix-grid.html', frag2.body);
const tb2 = frag2.body.match(/<tbody id="table_items">([\s\S]*?)<\/tbody>/);
if (!tb2) { console.log('verify fragment missing tbody'); process.exit(1); }
let section = '';
for (const tr of tb2[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
  const cells = [...tr[1].matchAll(/<td id="([a-z0-9]+_u[a-z0-9]+_[a-z0-9]+)"([^>]*)>([\s\S]*?)<\/td>/g)];
  const label = ((tr[1].match(/<th[^>]*>([\s\S]*?)<\/th>/) || tr[1].match(/<td[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cells.length) { if (label) section = label; continue; }
  const per = {};
  let epoch = 0;
  for (const m of cells) {
    const lvl = LEVELS[m[1].split('_')[2]] || m[1].split('_')[2];
    per[lvl] = per[lvl] || { done: 0, n: 0 };
    per[lvl].n++;
    if (/data-value="1"/.test(m[2]) || /fa-check\b/.test(m[3])) {
      per[lvl].done++;
      const d = (m[3].match(/class="completed_on_date"[^>]*>([^<]*)/) || [])[1] || '';
      if (d.includes('1969')) epoch++;
    }
  }
  console.log((section + '            ').slice(0, 13) + (label + '                  ').slice(0, 26) + '| ' +
    Object.entries(per).map(([l, v]) => `${l} ${v.done}/${v.n}`).join(' | ') + (epoch ? '  [EPOCH-DATES:' + epoch + ']' : ''));
}
await tlc.stop().catch(() => {});
process.exit(0);
