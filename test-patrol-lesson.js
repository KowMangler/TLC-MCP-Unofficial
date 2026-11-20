// Round-trip: level-scoped (Foxes-only) lesson create + delete, self-cleaning.
import { TLCClient } from './src/tlc-client.js';
const c = new TLCClient();
await c.start();
const ref = 'etmedomoxwak'; // 02/16/27 meeting (still lesson-less)
const page = await c.fetchText(`/calendar/update/${ref}`);
const sel = [...page.body.matchAll(/<select[^>]*name="Lesson\[badge_id\]\[\]"[\s\S]*?<\/select>/g)][0][0];
const badge = [...sel.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)/g)]
  .map((m) => ({ id: m[1], label: m[2].replace(/&amp;/g, '&').replace(/\|.*$/, '').trim() }))
  .find((b) => b.label.toLowerCase() === 'values branch');
const r2 = await c.postForm('/databuilder/get-badge-items', { 'depdrop_parents[0]': badge.id }, { csrfSource: `/calendar/update/${ref}` });
const item = Object.values(JSON.parse(r2.body).output).flat().find((x) => x.name.toLowerCase().includes('teamwork'));

await c.postForm(`/calendar/update/${ref}`, {
  'Lesson[title]': 'Teamwork',
  level_patrol_toggle: 'level',
  'Lesson[level_id]': '', 'Lesson[level_id][]': ['l3c59dc048e8'], // Foxes level
  'Lesson[patrol_id]': '', 'Lesson[patrol_id][]': [],
  'Lesson[primary_leader_id]': '', 'Lesson[assistants_id]': '',
  'Lesson[badge_id]': '', 'Lesson[badge_id][]': [badge.id],
  'Lesson[items_id]': '', 'Lesson[items_id][]': [item.id],
  'Lesson[notes]': '', 'Lesson[game_time]': '', 'Lesson[plan_json]': '',
});

const hit = c.parseLessonRows((await c.fetchText(`/calendar/update/${ref}`)).body)
  .find((x) => x.activity.toLowerCase().includes('teamwork'));
console.log('created row:', JSON.stringify(hit));

if (hit) {
  await c.postForm(`/calendar/delete-lesson?id=${hit.lesson_id}`, {}, { csrfSource: `/calendar/update/${ref}` });
  const gone = !c.parseLessonRows((await c.fetchText(`/calendar/update/${ref}`)).body).some((x) => x.lesson_id === hit.lesson_id);
  console.log('delete verified gone:', gone);
}
await c.stop();
