// Read-only: load real Track Advancement page, dump live-DOM grid state for 2 boys.
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ storageState: 'state/tlc-session.json' });
const pg = await ctx.newPage();
const ajax = [];
pg.on('response', async (r) => {
  if (r.url().includes('badge-tracker-view') || r.url().includes('process-advancement')) {
    try { ajax.push([r.url().split('/advancement/')[1], (await r.text()).length]); } catch {}
  }
});
await pg.goto('https://www.traillifeconnect.com/advancement/index?level=wt&user_id=uizy3scrbant,uavhwfjfnaaz&award_id=acvhb63my62f&style=grid', { waitUntil: 'networkidle', timeout: 120000 }).catch((e) => console.log('goto:', e.message));
await pg.waitForTimeout(12000);
const rows = await pg.evaluate(() => {
  const out = [];
  document.querySelectorAll('#table_items tr').forEach((tr) => {
    const cells = [...tr.querySelectorAll('td[id]')].map((td) => ({
      id: td.id,
      dv: td.getAttribute('data-value'),
      icon: (td.querySelector('i') || {}).className || '',
      date: (td.querySelector('.completed_on_date') || {}).textContent || '',
    }));
    if (cells.length) {
      const lbl = (tr.querySelector('th') || tr.querySelector('td')).textContent.replace(/\s+/g, ' ').trim();
      out.push([lbl, cells]);
    } else {
      const lbl = tr.textContent.replace(/\s+/g, ' ').trim();
      if (lbl) out.push(['SEC:' + lbl, []]);
    }
  });
  return out;
});
for (const [lbl, cells] of rows) {
  if (!cells.length) { console.log('\n' + lbl); continue; }
  const s = cells.map((c) => {
    const mark = c.icon.includes('fa-check') ? 'CHK' : c.icon.includes('times') ? 'X' : (c.icon ? 'ICON' : 'blank');
    return c.id.slice(0, 12) + ':' + mark + '/dv' + c.dv + (c.date ? '@' + c.date.trim() : '');
  }).join(' ');
  console.log(lbl.padEnd(28) + s);
}
console.log('\nAJAX calls observed during load:', JSON.stringify(ajax));
await b.close();
