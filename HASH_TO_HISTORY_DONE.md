# Hash to History Routing — Done

## Files changed
- `src/App.tsx`: route parsing now reads `location.pathname + location.search`; navigation uses `history.pushState` and `popstate`; internal routes use clean paths. Legacy URLs beginning with `#/` are replaced with the equivalent pathname and query using `history.replaceState`.
- `src/shared-mail-views.tsx`: message links now use `/m/:id`.

## Verification
- `npx vitest run --exclude worker/smoke.e2e.test.ts` — exit 0; 37 test files and 357 tests passed.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0.
- Legacy hash redirect was verified by inspecting the `useRoute` initialization: when `location.hash.startsWith("#/")`, it strips the leading `#` and calls `history.replaceState(null, "", legacyUrl)` before reading pathname and search. This preserves query parameters and replaces the current history entry. No browser based route test was run; the existing test suite has no route parsing test.

No deploy was performed. Worker configuration, migrations, and secrets were not changed.
