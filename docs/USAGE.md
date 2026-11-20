# tlc-mcp-server — Usage Guide

MCP server for **traillifeconnect.com** (Trail Life USA member portal). The site is a
Yii2 server-rendered app with **no public API**: everything this server does is done as an
authenticated browser session — password login + SMS 2FA, CSRF-token form posts, and HTML
grid parsing.

> Note: the tool table in the top-level `README.md` predates the five lesson/advancement
> tools. The authoritative tool surface is the **13 tools** listed in this document (see
> [ARCHITECTURE.md](ARCHITECTURE.md) for where each lives in code).

---

## 1. Prerequisites

**Fastest path:** `./install.sh` at the project root — a Linux installer that checks/installs
Node (user-local LTS if system node is too old), runs `npm ci`, installs the pinned Playwright
Chromium, creates the credentials template, and finishes with a stdio smoke test asserting the
full tool surface. Flags: `--with-deps` (Chromium OS libraries via sudo), `--no-node-install`,
`--skip-smoke`. The manual steps below are what it automates.

| Requirement | Notes |
|---|---|
| Node.js ≥ 18 | Required by Playwright 1.65. Developed with Node 26 (`~/.hermes/tools/node-26.12.1-linux-x64/bin/node` on this machine). Must be on `PATH` **as seen by the MCP client** — GUI apps often don't inherit your shell PATH; use an absolute `command` path in the client config if needed. |
| npm install | `npm install` in the project root. |
| Playwright Chromium | Playwright pins its own Chromium build: run `npx playwright install chromium`. A cached `~/.cache/ms-playwright` from a different Playwright version will **not** match and the server will fail to launch. |
| TLC account | A staff account on traillifeconnect.com. The mobile number on the account receives the SMS 2FA code. |

## 2. Credentials

Credentials are **never stored in the repo**. The server resolves them in this order:

1. `TLC_EMAIL` + `TLC_PASSWORD` environment variables, else
2. `TLC_CREDENTIALS_FILE` env var pointing to a dotenv-style file, else
3. `~/.config/tlc-mcp/credentials.env`

Recommended setup:

```bash
mkdir -p ~/.config/tlc-mcp
cat > ~/.config/tlc-mcp/credentials.env <<'EOF'
TLC_EMAIL=you@example.com
TLC_PASSWORD=***
EOF
chmod 600 ~/.config/tlc-mcp/credentials.env
```

Missing credentials surface as a tool error: `{ "error": "No credentials at ~/.config/tlc-mcp/credentials.env" }`.

## 3. Registering with an MCP client

stdio transport, one process:

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

Use the absolute path to your `node` binary if the client's environment lacks it. Note the
leading space in the directory name (` TLC-MCP-Server`) — always quote the path.

## 4. Session lifecycle

- **Session storage:** Playwright `storageState` saved to `state/tlc-session.json`
  (gitignored). It contains the live cookies — `PHPSESSID`, `_identity`, `_csrf`,
  `trusted_device` (plus analytics cookies). Treat this file as credential-equivalent:
  it grants full account access for its lifetime. Never commit or copy it.
- **Trusted device:** the 2FA step ticks "trust device", so a completed session lasts
  **~30 days** without another SMS code.
- **Automatic check:** every tool except `tlc_login` runs `ensureAuthed` first: a `GET /calendar`
  with `maxRedirects: 0`; a 302 means the session died. If valid credentials exist the
  password phase is re-run automatically.
- **When you see `{ "error": "session expired" }`:** call `tlc_login`. If it answers
  `{ "ok": false, "needs_sms_code": true }`, read the SMS that arrived on the account's
  mobile number and call `tlc_login` **again** with `{"sms_code": "..."}` to complete the
  trusted-device handshake. Codes expire quickly — be ready to supply one before calling.
- **Force re-login:** `tlc_login {"force": true}`. Nuclear reset: delete `state/tlc-session.json`.

## 5. Identifier schemes

TLC uses three id prefixes; tools accept/report them:

| Prefix | Meaning | Seen in |
|---|---|---|
| `ev…` | Event id | grid `data-key`, delete URL, `tlc_calendar_report.ev_id` |
| `et…` | Edit ref | the edit URL `/calendar/update/et…`, `tlc_calendar_report.edit_ref` — the working handle for most tools |
| `les…` | Lesson row id | Activity Plans grid on an event page, `tlc_event_add_lesson` result |

## 6. Date and value formats

- `tlc_calendar_report` `from`/`to`: `YYYY-MM-DD` (inclusive day range).
- `tlc_event_create` / `tlc_event_update` `start`/`end`: `YYYY-MM-DD` (defaults to **09:00**) or
  `YYYY-MM-DDTHH:MM`. Times are **event-local wall clock**; the server converts to the site's
  internal `MM-DD-YYYY hh:mm AM to MM-DD-YYYY hh:mm AM` `date_range` string.
- `event_type`: either the site token (`etmeeting`, `etcampout`, …) or a label substring
  (`"Meeting"`, `"Campout"`). An ambiguous substring returns an error listing the candidates.
- `timezone`: IANA name, e.g. `America/Chicago`. `state`: 2-letter code.
- Shared change parameters (create & update): `title`, `event_type`, `start`+`end` (start
  requires end), `timezone`, `venue`, `address1`, `address2`, `city`, `state`, `zip`,
  `content`, `active` (bool), and `fields` — a raw `Event[...]` → value map for advanced
  overrides of any of the ~87 form fields.

## 7. Tool reference (13 tools)

### `tlc_login` — session control
- **Args:** `sms_code?` (2FA code, if prompted), `force?` (bool, re-login even if saved session looks valid).
- **Returns:** `{ok:true, note:"saved session valid"}` when the cached session works; `{ok:true, landedOn, trusted_device:true}` after a completed login (+2FA); `{ok:false, needs_sms_code:true}` when SMS is required; `{error}` on bad credentials (login failure text is extracted from the site, best-effort).

### `tlc_calendar_report` — list events in a date range
- **Args:** `from` (YYYY-MM-DD), `to` (YYYY-MM-DD).
- **Returns:** `{count, from, to, events:[{ev_id, edit_ref, type, date, title, venue, active, going, attended}]}` sorted by date. Covers all scopes visible to the staff account.
- **How it works:** crawls `/calendar/view-events` (Krajee GridView, 50 rows/page, up to 40 pages), then filters client-side on the row date. Expect a few seconds for wide ranges.

### `tlc_event_details` — read one event
- **Args:** `ref` (`et…` edit ref, or `ev…` id — an `ev…` is resolved to its `et…` via a grid crawl).
- **Returns:** `{ref, fields}` with every **non-empty** `Event[...]` form field (fees, leads, RSVP settings, registration windows…). Fields equal to `'0'` are omitted as noise; use `tlc_event_update` `fields` to write any field this shows you.

### `tlc_event_create` — create an event
- **Required args:** `title`, `start`, `end`, `event_type`. Everything else inherits cached site defaults from `/calendar/create`.
- **Returns:** `{ok:true, edit_ref, ev_id, url}` — capture `edit_ref` for follow-up updates/lessons.
- **Validation failures** return `{ok:false, validation_errors:[…]}` (Yii `help-block` / `alert-danger` text).

### `tlc_event_update` — partial update (load-patch-write)
- **Args:** `ref` (`et…`) + any subset of the change parameters above.
- **Semantics:** loads the event's current form and posts **everything back unchanged except the fields you pass**; returns `{ok:true, ref, changed:[field names]}`. Passing no changes is rejected (`"no changes given"`). Ambiguous `event_type` → error with candidates.

### `tlc_event_delete` — hard delete
- **Args:** `ref` (`et…` or `ev…`), `notify?` (bool, default **false** — `true` emails participants).
- **Semantics:** same as the red Delete button (`/calendar/delete/ev…?…&delete=1`). **Authoritative verification:** after the POST the events grid is re-crawled and success requires the `ev…` row to be gone. `{ok:false, still_present:true}` means the delete did **not** happen.
- ⚠️ This is irreversible — there is no undo and notifications cannot be recalled.

### `tlc_event_lessons` — read lesson/activity plans
- **Args:** `refs` (array of `et…` edit refs).
- **Returns:** per-event `[{ref, lessons:[{lesson_id, level, patrols, primary_leader, assistants, activity, notes, game_time}]}]`.

### `tlc_event_add_lesson` — add an activity plan row
- **Args:** `ref` (meeting `et…`), `branch` (e.g. `"Life Skills Branch"`), `item` (branch item label, substring ok, e.g. `"First Aid - Medical"`), `level?` (**default `Woodlands Trail`**, which covers all 3 patrols; also `Foxes`, `Hawks`, `Mountain Lions`, `Navigators`, `Adventurers`), `patrols?` (array — scope the lesson to actual patrols instead of a level: `Fox`, `Hawk`, `Mountain Lion`, `Legends`, `Guidon`, `Adventurer`; overrides `level`), `title?` (defaults to the item name, leading numbering stripped), `notes?`, `game_time?`.
- **Semantics:** replicates the UI cascade — event page badge select → `/databuilder/get-badge-items` (POST `depdrop_parents[0]=<badge id>`) → level/patrol scope → `Lesson[...]` create post → **re-read the grid to verify the row exists**. Branch, item, and each patrol name must each resolve to exactly one match; otherwise you get an error listing the options.
- **Returns:** `{ok:true, lesson_id, activity, level, item}`.

### `tlc_lesson_delete` — delete one activity plan row
- **Args:** `lesson_id` (`les…` id, from `tlc_event_lessons` or `tlc_lessons_report`), `ref` (the `et…` of the event it belongs to — used for the CSRF source).
- **Semantics:** POST `/calendar/delete-lesson?id=les…`, then re-read the event's lesson grid; success requires the row gone.
- **Returns:** `{ok, lesson_id, verified_gone}`.

### `tlc_lessons_report` — lesson coverage report by patrol
- **Args:** `from`, `to` (YYYY-MM-DD), `type_filter?` (event-type substring, default matches meetings, e.g. `"Troop meeting"`).
- **Returns:** per meeting (`date`, `title`, `ref`) its lesson rows with a `covers` list, plus `patrol_coverage` per Woodlands Trail patrol (Foxes / Hawks / Mountain Lions): level-scoped lessons count for all three patrols; patrol-scoped lessons count only for their patrols. Useful for spotting patrols with no planned activity in a window.

### `tlc_advancement_report` — Track Advancement heatmap (read-only)
- **Args:** `badge?` (branch label, **default `Heritage Branch`**; e.g. `"Values Branch"`), `level?` (**default `Woodlands Trail`**; also `Navigators`, `Adventurers`), `patrols?` (default `Foxes, Hawks, Mountain Lions`).
- **Returns:** per advancement step: per-patrol completion `n/total (x%)`, `earned_by` (boy, completion date, tooltip note), per-boy cells with `[purchased]`/`[awarded]` flags, and `per_patrol` totals (`steps_earned n/N` per boy).
- **Safety:** the tool reads only the server-rendered grid fragment (`/advancement/badge-tracker-view`). It **never calls `/advancement/process-advancement`**, which is the site's write/toggle endpoint — treat that route as off-limits in any custom script.

### `tlc_ical_feeds` — iCal subscription URLs
- **Args:** none. **Returns:** `{feeds:[urls]}` — troop/area/region/home-office/all + public feeds.
- 🔒 **Security:** the URL *path* is a bearer secret — anyone holding the URL can read that feed. Never commit, screenshot, or paste these anywhere public.

### `tlc_fetch_page` — authenticated raw GET (discovery/debug)
- **Args:** `path` (e.g. `"/calendar"`). Returns the page HTML **truncated to 30,000 chars**. The escape hatch for mapping routes the tools don't cover yet.

## 8. Verification scripts (run locally, they touch the live account)

| Script | What it does |
|---|---|
| `node test-report.js` | Spawns the MCP server over stdio: `tools/list` + a live `tlc_calendar_report` for 2026-11-19 → 2026-12-31. **Read-only.** |
| `node test-write.js` | Full write loop over stdio: create a labeled `"MCP TEST EVENT (safe to delete)"` on 2026-12-30 → report → details → update → delete → confirm gone. **Writes real data to your account, cleans up after itself.** Don't run it during a live troop meeting window you care about. |
| `node recon.js` | Session validity check + dump `/calendar` and its links to `out/`. |
| `node recon2.js` | Password phase of login; dumps the SMS-verify page and its inputs to `out/`, saves mid-2FA state. |
| `node recon3.js <sms-code>` | Completes 2FA with a code from argv, ticks trust-device, saves the session. |
| `node recon4.js` | Dumps `/calendar/view-events`, `/calendar/create`, `/calendar/ical` to `out/`. |
| `assign-lessons.js` | One-shot batch: assigns a hardcoded Year-2 branch/item plan to 8 meetings (hardcoded `et…` refs). Mirrors `tlc_event_add_lesson`; **writes real data**. Superseded by the tool for ad-hoc use — kept as the batch/plan record. |

`out/` and `state/` are gitignored for a reason: the recon dumps and iCal files contain
real troop data and secret feed URLs.

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `browserType.launch: Executable doesn't exist` | Chromium build missing or version-mismatched → `npx playwright install chromium`. |
| MCP client shows "command not found: node" | Client environment lacks node → absolute path in `command`. |
| Every tool returns `session expired` | Mid-2FA state saved but not completed, or the 30-day trust expired → `tlc_login`, supply `sms_code` on the second call. |
| `TLC login failed` with site text | Wrong password or account lockout message. Check the credentials file; **avoid repeated attempts** (lockout risk). |
| `validation_errors` on create/update | Yii rejected the form. The message list mirrors the site's inline errors; fix the named field. |
| `Branch/item matched N` errors | Substring hit multiple badges/items — narrow the label or use the exact name from the returned options list. |
| Delete reports `still_present: true` | The site did not delete (permission/id mismatch). Find the event via `tlc_calendar_report` and retry with the fresh `et…` ref. |
