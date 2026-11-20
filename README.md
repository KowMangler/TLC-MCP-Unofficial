# tlc-mcp-server

MCP server for **traillifeconnect.com** (Trail Life USA member portal).
Wraps the API-less Yii2 web app: session login (password + SMS 2FA),
calendar reporting + event CRUD, meeting lesson (activity plan) management,
and the Track Advancement heatmap (read-only).

## Tools (13)

| Tool | Purpose |
|---|---|
| `tlc_login` | Verify/refresh session; handles SMS 2FA (`sms_code` arg) — trusted-device lasts ~30 days |
| `tlc_calendar_report` | Events between two dates: `ev_id`, `edit_ref`, type, date, title, venue, active |
| `tlc_event_details` | All non-empty `Event[...]` fields for one event (fees, leads, RSVP, ...) |
| `tlc_event_create` | Create event (required: `title`, `start`, `end`, `event_type`) |
| `tlc_event_update` | Partial update — loads event, changes only given fields |
| `tlc_event_delete` | Hard delete (like the red Delete button), optional participant notify |
| `tlc_event_lessons` | Lessons/activity plans attached to one meeting |
| `tlc_event_add_lesson` | Add lesson by branch + item label (DepDrop cascade resolved); `level` or `patrols` scoping; verified on grid after create |
| `tlc_lessons_report` | Lessons in a date range + per-patrol (Foxes/Hawks/ML) coverage |
| `tlc_lesson_delete` | Remove a lesson (`les...` id), verified gone |
| `tlc_advancement_report` | Track Advancement grid (READ-ONLY): per-step status per boy incl. earned date + tooltip note + purchased/awarded flags; per-patrol completion % |
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
      "args": ["/home/nerd/projects/ TLC-MCP-Server/src/index.js"],
      "timeout": 300
    }
  }
}
```

(Node must be on PATH; here: `~/.hermes/tools/node-26.12.1-linux-x64/bin/node`.
Restart the MCP host after editing `src/` — the registered server keeps running
the old code.)

## TLC site notes — calendar

- Yii2 app, no API. Login: `POST /login` `LoginForm[email|password|rememberMe]` + `_csrf`.
- 2FA: `/site/sms-verify`, form `code`, `trust_device`, `sms_action`.
- Event refs: `et...` (edit URL `/calendar/update/et…`), `ev…` (event id; used by
  `/calendar/delete/ev…?viewType=dayGridMonth&notify=0&delete=1`, grid `data-key`).
- Create/update: one `Event[...]` form (~87 fields); required: `title`,
  `date_range` (`MM-DD-YYYY hh:mm AM to MM-DD-YYYY hh:mm AM`), `event_type_id`
  (`etmeeting`, `etcampout`, ...), `timezone`, `active`, `has_activities`.
- Grid `/calendar/view-events` paginates 50/page (`?page=N`); rows expose
  `cells[2]` as MM/DD/YYYY; CSV export at `?export=csv`. iCal feeds under
  `/icalendar/<token>/<scope>` — the URL path IS the secret; never commit it.

## Lessons / activity plans

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
- Item names may have TRAILING SPACES — never substring-verify with trimmed names.

## Advancement (Track Advancement heatmap) — READ-ONLY POLICY

⚠️ **Incident (2026-11-19):** an early version of `tlc_advancement_report`
"read" per-cell state via `POST /advancement/process-advancement`. That endpoint
is the cell-CLICK **toggle**: it flipped completion for all 960 Heritage Branch
cells (48 WT boys × 20 steps) and **destroyed the earned_on dates**. Flags were
restored by re-toggling each cell once (`fix-advancement.js`, audit in
`out/fix-log.jsonl`); the ~106 earned cells now carry `12/31/1969` (null date)
and are being hand-corrected by staff from paper records. Rules below come from
that incident.

- `POST /advancement/process-advancement` is a **WRITE / TOGGLE**. It also
  overwrites the completion date: toggle-off DELETES the date, toggle-on stores
  the `dateSpecified` param (empty → null → renders `12/31/69`, tooltip
  `"Earned on: 12/31/1969"`). NEVER call it for reads; even a "net-zero"
  double-POST damages history. If a legitimate date correction is ever needed,
  use the page's `date-specified` datepicker flow (what staff does in the UI).
- READ path (the only one tools use):
  1. session-configuring `GET /advancement/index?level=wt&user_id=<ids>&award_id=&style=grid`
     (also sets PHP-session state the AJAX endpoints read; supplies CSRF, badge
     select, roster).
  2. `POST /advancement/badge-tracker-view` (headers `X-CSRF-Token` meta +
     `X-Requested-With: XMLHttpRequest`; body `level, style=grid,
     trailmen[]=<boy ids>, badges=<badge_id>, trackLevel, lockedChecked, event_id,
     track_attendance`). This POST is a RENDER endpoint — observed
     non-mutating across many repeated fetches.
- Fragment cell encoding (`<tbody id="table_items">`): each cell
  `<div class="advance-icon" id="<stepid>_<uid>_<levelid>" data-value="0|1">`
  containing `fad fa-check` (earned) / `fad fa-times-circle incomplete-item`,
  an optional `<div class="completed_on_date">MM/YY/DD` and the tooltip
  `title="..."` (stored comment, e.g. `Earned on: …`). `purchased_level` /
  `awarded_level` mark the award-purchase/awarded sub-states. Section rows have
  no cell ids. Averages: `ave_<step>_<level>`, `all_ave_<step>`. Award images:
  `bp_<uid>_<level>`, `ss_...`. Attendance cells: `attended-<uid>` (separate
  toggle endpoint `$.toggleAttendanceURL` — also a WRITE).
- Tool output per cell: `Y|n @date "tooltip" [purchased] [awarded]`; per-patrol
  completion %; per-boy totals. `out/advancement-audit.csv` / `.json` are
  full-grid dumps (`node audit-advancement.js`) for correction passes.
- Branch/award ids: Heritage `acvhb63my62f`, Life Skills `ac5takv44649`,
  Sci&Tech `acbj0h1vca1j`, Hobbies `acn7nd1otizl`, Values `acgn1dpdw6jt`,
  Sports & Fitness `ac9r5nt7904r`, Outdoor Skills `ac9hfgsftr4d`; group ids
  double as level ids in `user_id` (All Foxes `l3c59dc048e8`, All Hawks
  `ib6d767d2f8e`, All Mountain Lions `k37693cfc748`).
- PITFALL: Playwright `request.post({form})` mangles PHP `key[]` array params —
  serialize the urlencoded body yourself (`TLCClient.formBody` + `postRaw`).

## Scripts

- `audit-advancement.js` — READ-ONLY: runs the advancement tool over stdio,
  writes `out/advancement-audit.{json,csv}` (one row per boy×step with status,
  date, tooltip).
- `test-report.js` — read path over MCP stdio (live data).
- `test-write.js` — create → report → details → update → delete loop with a
  labeled test event; cleans up after itself.
- `test-patrol-lesson.js` — level/patrol-scoped lesson create → verify → delete
  → verify gone (self-cleaning).
- `fix-advancement.js`, `revert-advancement.js` — historical incident scripts.
  **Do not re-run** (they toggle advancement state).
- `probe-adv.js`, `read-live-grid.js` — disabled/reference only.
