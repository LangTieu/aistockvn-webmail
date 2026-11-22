# Brief: Webmail — remove `#` from URLs (hash routing → history routing)

## Context
- Project: /data/home/webmail-r3-codex (aistockvn-mail, https://mail.aistockvn.com)
- This is the working copy that produced the live Worker. Before changing
  anything, verify src/App.tsx matches the VM copy: its sha256 must be
  071ef7f361d4cc16153f859745fb812b6a81157d2f042a555664a5c7f7714a28.
  If it differs, STOP and write that in the DONE marker.
- The app currently uses hash routing: URLs look like `mail.aistockvn.com/#/inbox`.
- The Worker ALREADY serves index.html for unknown paths: wrangler.jsonc has
  `"assets": {"directory": "./dist", "not_found_handling": "single-page-application",
  "run_worker_first": ["/api/*"]}`. Do NOT change wrangler.jsonc or anything
  under worker/.

## Task
Switch the frontend from hash routing to history (pathname) routing so URLs
become clean: `/inbox`, `/sent`, `/spam`, `/starred`, `/drafts`,
`/compose?reply=<id>`, `/compose?forward=<id>`, `/compose?draft=<id>`, plus any
other routes the app has (admin, external, search — grep for them). No `#`
anywhere in app URLs.

## Known hash usages (src/App.tsx — search the whole src/ for more)
- Line ~76: route parsed from hash (`hash.replace(/^#/, "").split("?")`).
- Lines ~105-109: `useState(location.hash)` + `hashchange` listener.
- Line ~114: `go(h)` sets `location.hash`.
- Links: `#/inbox`, `#/sent`, `#/spam`, `#/starred`, `#/drafts`,
  `#/compose?reply=...`, `#/compose?forward=...`, `#/compose?draft=...`,
  `back("#/inbox")`, `go("#/sent")`, `location.hash = "#/compose?..."`.
- Rewrite: parse `location.pathname + location.search`; listen to `popstate`;
  `go` uses history.pushState; links use clean paths.

## Rules
- Behaviour must stay identical: back/forward, deep links, refresh on any
  route, compose/reply/forward/draft flows, admin/external/search views.
  Only the URL format changes.
- Legacy hash URLs must keep working: on load, if location.hash starts with
  `#/`, redirect (replace) to the equivalent clean path.
- Do NOT change features, UI, styles, API calls, or the Worker.
- Do NOT deploy. Do NOT change wrangler.jsonc, migrations, or secrets.
- If you get stuck on anything, STOP at the DONE marker below and write
  exactly what you need — do not skip ahead or improvise a different design.

## Verify (all must pass, run them yourself)
- npx vitest run --exclude worker/smoke.e2e.test.ts (baseline 357 pass),
  npm run typecheck, npm run build — all exit 0. Run each command directly
  (no pipe to tail/head before checking the exit code — piping hides failures).
  Check the real exit code of every command.
- If a route test exists, update it; otherwise add a small test for the
  route parsing if the structure allows it without restructuring the app.

## Done marker
Write HASH_TO_HISTORY_DONE.md in /data/home/webmail-r3-codex listing: files
changed, test/typecheck/build results, and how you verified legacy `#/...`
URLs redirect.
