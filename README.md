# tlc-mcp-server

MCP server for **traillifeconnect.com** (Trail Life USA member portal).
Wraps the API-less Yii2 web app: session login (password + SMS 2FA),
calendar reporting, and event create / update / delete.

## Tools

| Tool | Purpose |
|---|---|
| `tlc_login` | Verify/refresh session; handles SMS 2FA (`sms_code` arg) — trusted-device lasts ~30 days |
| `tlc_calendar_report` | Events between two dates: `ev_id`, `edit_ref`, type, date, title, venue, active |
| `tlc_event_details` | All non-empty `Event[...]` fields for one event (fees, leads, RSVP, ...) |
| `tlc_event_create` | Create event (required: `title`, `start`, `end`, `event_type`) |
| `tlc_event_update` | Partial update — loads event, changes only given fields |
| `tlc_event_delete` | Hard delete (like the red Delete button), optional participant notify |
| `tlc_ical_feeds` | Personal iCal feed URLs (troop/area/region/.../public) |
| `tlc_fetch_page` | Raw authenticated page GET (discovery/debug) |

## Setup

```bash
mkdir -p ~/.config/tlc-mcp
cat > ~/.config/tlc-mcp/credentials.env <<'EOF'
TLC_EMAIL=you@example.com
TLC_PASSWORD=***
EOF
chmod 600 ~/.config/tlc-mcp/credentials.env
npm install
node src/index.js   # starts the stdio MCP server
```

First call may land on SMS 2FA: call `tlc_login` with the received
`sms_code`. The server ticks "Trust this browser for 30 days" and caches the
session in `state/tlc-session.json` (gitignored).

## Registering with an MCP client

```json
{
  "mcpServers": {
    "tlc": {
      "command": "node",
      "args": ["/home/nerd/projects/ TLC-MCP-Server/src/index.js"]
    }
  }
}
```

(Node must be on PATH; here: `~/.hermes/tools/node-26.12.1-linux-x64/bin/node`.)

## TLC site notes (how this works)

- Yii2 app, no API. Login: `POST /login` `LoginForm[email|password|rememberMe]` + `_csrf`.
- 2FA: `/site/sms-verify`, form `code`, `trust_device`, `sms_action`.
- Event refs: `et...` (edit URL `/calendar/update/et…`), `ev…` (event id; used by
  `/calendar/delete/ev…?viewType=dayGridMonth&notify=0&delete=1`, grid `data-key`).
- Create/update: one `Event[...]` form (~87 fields); required: `title`,
  `date_range` (`MM-DD-YYYY hh:mm AM to MM-DD-YYYY hh:mm AM`), `event_type_id`
  (`etmeeting`, `etcampout`, ...), `timezone`, `active`, `has_activities`.
- Grid `/calendar/view-events` paginates 50/page (`?page=N`); CSV export at
  `?export=csv`. iCal feeds under `/icalendar/<token>/<scope>` — the URL
  path IS the secret; never commit it.

## Lessons / activity plans (advancement)

- Lesson grid `troop_lessons_grid` is embedded on `/calendar/update/et…?tab=lessons`;
  rows `data-key="les…"`, columns: Levels, Patrols, Primary leader, Assistants,
  Activity, Activity notes, Game time notes.
- Create = POST the `Lesson[...]` form to `/calendar/update/et…` (same action).
  Fields: `Lesson[title]`, `level_patrol_toggle` (`level`|`patrol`),
  `Lesson[level_id][]`, `Lesson[patrol_id][]`, `Lesson[badge_id][]`,
  `Lesson[items_id][]`, `Lesson[notes]`, `Lesson[game_time]`, `Lesson[plan_json]`.
- Level ids (`Lesson[level_id][]`): `wt` Woodlands Trail (grid expands to Foxes/
  Hawks/Mountain Lions), `l3c59dc048e8` Foxes, `ib6d767d2f8e` Hawks,
  `k37693cfc748` Mountain Lions, `j8e296a067a3` Navigators, `x1ff1de77400`
  Adventurers. NOTE: in TLC's model Foxes/Hawks/Mountain Lions are LEVELS, not
  patrols — scoping one patrol = its level id.
- Patrol ids (`Lesson[patrol_id][]`, toggle `patrol`): actual patrol names
  `p09d7de7eb33` Fox, `pb43500a3d53` Hawk, `pea9f6bbe0b8` Mountain Lion,
  `p494bec76be3` Legends, `pengmejgsla5` Guidon, `p5f123c605d9` Adventurer.
- Branch badge ids + per-branch items: badge ids from the `Lesson[badge_id][]`
  select; items via DepDrop cascade `POST /databuilder/get-badge-items` with flat
  key `depdrop_parents[0]=<badge_id>` → `{"output":{"<group>":[{"id","name"}…]}}`.
- Edit one lesson: `/calendar/update-lesson?id=les…`; delete:
  `POST /calendar/delete-lesson?id=les…` (+ CSRF from the event page).
- Tests: `node test-patrol-lesson.js` — patrol/level-scoped lesson create →
  verify grid → delete → verify gone (self-cleaning).

## Advancement (Track Advancement heatmap)

- Page `/advancement/index`; filter form is `POST /advancement/index` but the
  real view params ride in the **action query string**:
  `/advancement/index?level=wt&user_id=<ids>&award_id=<badge>&style=<standard|grid|summary>`.
  A GET with those params also sets PHP-session state the AJAX endpoints read.
- Heatmap fragment: `POST /advancement/badge-tracker-view`
  (headers `X-CSRF-Token` meta + `X-Requested-With: XMLHttpRequest`; body
  `level, style=grid, trailmen[]=<boy ids>, badges=<badge_id>, trackLevel, lockedChecked, event_id, track_attendance`).
  Only renders per-boy columns after the configured GET. Cell ids:
  `<stepid>_<trailmanid>_<levelid>`; averages `ave_*`, `all_ave_*`.
- ⚠️ `POST /advancement/process-advancement` is a **WRITE — it TOGGLES the cell's
  completed state** (this is the cell-click handler; the "Updating bulk achievements"
  checkbox flow). The JSON response echoes the NEW state, so calling it to "read"
  silently corrupts data. NEVER call it from report tooling. Read state from the
  badge-tracker-view fragment instead: each cell `<div class="advance-icon"
  id="step_uid_lvlid" data-value="0|1">` with `fad fa-check` vs
  `fa-times-circle incomplete-item` and `<div class="completed_on_date">`.
- PITFALL: Playwright `request.post({form})` mangles PHP `key[]` array params —
  serialize the urlencoded body yourself (`TLCClient.formBody` + `postRaw`).
- Group ids double as level ids: All Foxes `l3c59dc048e8`, All Hawks
  `ib6d767d2f8e`, All Mountain Lions `k37693cfc748` (user_id param accepts them).

## Tools (13)

tlc_login, tlc_calendar_report, tlc_event_details, tlc_event_create,
tlc_event_update, tlc_event_delete, tlc_event_lessons, tlc_event_add_lesson
(branch+item labels, level or patrol scoping, verified), tlc_lessons_report
(date range + per-patrol Foxes/Hawks/Mountain Lions coverage), tlc_lesson_delete,
tlc_advancement_report (Track Advancement grid: per-step completion % per patrol
+ Branch Pin/Sylvan Star counts), tlc_ical_feeds, tlc_fetch_page.

## Tests

- `node test-report.js` — read path over MCP stdio (live data).
- `node test-write.js` — create → report → details → update → delete loop with a
  labeled test event; cleans up after itself.
