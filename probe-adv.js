// ⚠️ DISABLED 2026-11-19 — DO NOT RUN.
// This probe caused the advancement-grid corruption incident:
// POST /advancement/process-advancement TOGGLES the cell's completed state
// (it is the cell-click write handler; the JSON response echoes the NEW state).
// Its one cell POST flipped Christian Heritage for Abbruzzi, Ethan; the full
// incident (a report tool POSTing every cell) was repaired by re-toggling each
// touched cell exactly once — see fix-advancement.js + out/fix-log.jsonl.
//
// Request shape kept as documentation only:
//   POST /advancement/process-advancement
//   headers: X-CSRF-Token: <meta[name=csrf-token]>, X-Requested-With: XMLHttpRequest
//   body (urlencoded): _csrf, id=<stepid>_<uid>_<levelid>, badge_id, trailmen_id[],
//     event_id, track_attendance, selectedLevel, trackLevel, dateSpecified,
//     commentSpecified, clickedClass
//   → JSON {completed:<new state>, earned_on, comment, award_status, award_count}
//
// READS must parse the badge-tracker-view fragment instead (see
// tlc_advancement_report in src/index.js) — never this endpoint.
