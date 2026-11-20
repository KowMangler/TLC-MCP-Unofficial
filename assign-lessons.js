// Assign branch items to meetings through 4/20/27. Mirrors tlc_event_add_lesson logic.
import { TLCClient } from './src/tlc-client.js';

const PLAN = [
  // [meeting ref, branch label, exact item substring]
  ['etvwct3vfvc3', 'Values Branch',          'Truthfulness / Integrity'],
  ['etvb9gqq4yml', 'Hobbies Branch',         'General Hobbies - Year 2'],
  ['etb4qagftsgq', 'Life Skills Branch',     'First Aid - Traumatic'],
  ['ethqr1yu6frs', 'Life Skills Branch',     'First Aid - Medical'],
  ['ete2ajsbakbd', 'Life Skills Branch',     '5. Stewardship'],
  ['ettqtm8atkx5', 'Life Skills Branch',     'Water Safety'],
  ['etg3qpk8aiiy', 'Sports & Fitness Branch','Nutrition & Fitness - Year 2'],
  ['etfap9ib5qac', 'Sports & Fitness Branch','Learn about Sports - Year 2'],
];

const c = new TLCClient();
await c.start();
const badgeCache = {};
for (const [ref, branch, item] of PLAN) {
  const page = await c.fetchText(`/calendar/update/${ref}`);
  const sel = [...page.body.matchAll(/<select[^>]*name="Lesson\[badge_id\]\[\]"[\s\S]*?<\/select>/g)][0][0];
  const badges = [...sel.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)/g)]
    .map((m) => ({ id: m[1], label: m[2].replace(/&amp;/g, '&').replace(/\|.*$/, '').trim() }));
  const b = badges.find((x) => x.label.toLowerCase() === branch.toLowerCase());
  if (!b) { console.log(ref, 'BADGE NOT FOUND', branch); continue; }
  if (!badgeCache[b.id]) {
    const r = await c.postForm('/databuilder/get-badge-items', { 'depdrop_parents[0]': b.id }, { csrfSource: `/calendar/update/${ref}` });
    badgeCache[b.id] = Object.values(JSON.parse(r.body).output || {}).flat();
  }
  const items = badgeCache[b.id].filter((x) => x.name.toLowerCase().includes(item.toLowerCase()));
  if (items.length !== 1) { console.log(ref, branch, item, '-> MATCH', items.length, items.map(x=>x.name)); continue; }
  const it = items[0];
  await c.postForm(`/calendar/update/${ref}`, {
    'Lesson[title]': it.name.replace(/^\d+\.\s*/, ''),
    level_patrol_toggle: 'level',
    'Lesson[level_id]': '', 'Lesson[level_id][]': ['wt'],
    'Lesson[patrol_id]': '', 'Lesson[primary_leader_id]': '', 'Lesson[assistants_id]': '',
    'Lesson[badge_id]': '', 'Lesson[badge_id][]': [b.id],
    'Lesson[items_id]': '', 'Lesson[items_id][]': [it.id],
    'Lesson[notes]': '', 'Lesson[game_time]': '', 'Lesson[plan_json]': '',
  });
  const after = await c.fetchText(`/calendar/update/${ref}`);
  const rows = c.parseLessonRows(after.body);
  const hit = rows.find((r) => r.activity.toLowerCase().includes(it.name.toLowerCase()));
  console.log(ref, '->', hit ? `OK ${hit.activity} [${hit.level}] lesson=${hit.lesson_id}` : `FAIL: not on grid. rows=${JSON.stringify(rows.map(r=>r.activity))}`);
}
await c.stop();
