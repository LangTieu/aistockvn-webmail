# Inbox search crash fix

## Result

- **PASS** — fixed the Inbox search rendering crash with a backend mapping correction and frontend guards.
- **Confirmed root cause:** `worker/index.ts:1486` maps FTS rows through `listItem`, then the old `worker/index.ts:1551` mapped the combined rows through `listItem` a second time. The second mapping read `from_addr` / `from_name` from a MessageItem object, yielding undefined address fields. In `src/App.tsx:142`, the old `displayName` could consequently return undefined; `src/shared-mail-views.tsx:32` then called `.trim()` on it.
- Search order remains FTS results first in bm25 order, followed by decrypted matches sorted by descending date. The existing limit, count, and `{ items, total }` response are preserved.

## Files changed

- `worker/index.ts` — map only decrypt-pass raw rows, then concatenate them with already-mapped FTS items and apply the limit.
- `src/App.tsx` — make `displayName` return an empty string when name and address are both falsy.
- `src/shared-mail-views.tsx` — normalize nullable/missing Avatar labels before trimming; make `MessageRowContent.avatarLabel` nullable/optional.
- `worker/search-endpoint.test.ts` — add a handler-level Inbox search regression asserting returned `from.address` is a string.
- `src/search-crash-repro.test.tsx` — render search rows with an undefined sender address/name and a missing sender; assert neither throws and the Avatar fallback appears.
- `STATE.md` — record this fix, verification, and untouched files.

## Verification

- `npx tsc --noEmit` — **PASS**, exit code 0.
- `npx vitest run --exclude worker/smoke.e2e.test.ts` — **PASS**, 35 files passed, 336 tests passed, 0 failed.
- New regressions — **PASS**: both Inbox API sender-address coverage and frontend malformed/missing sender render coverage pass. The frontend malformed-sender assertion would throw on the previous unguarded `label.trim()` path.
- `git diff --check` — unavailable because this synced workdir's `.git` is an empty directory, not a Git repository.

## Considered but not changed

- `wrangler.jsonc` — not relevant to the mapping/render fix; deployment configuration must remain untouched.
- `migrations/` — message data is already correct and no schema change is needed.
- `worker/r2-guard.ts` — unrelated to search result mapping.
- `.dev.vars` — credentials/configuration are unrelated and must remain untouched.
