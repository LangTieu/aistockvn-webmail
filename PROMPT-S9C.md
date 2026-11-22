# Fix rate-limit logic + e2e test syntax — webmail aistockvn-webmail (S9C)

## Context
The S9/S9B runs built the password-auth feature (OmniMail-grounded, PROMPT-S9.md
in this workdir — read it first). The coordinator's independent verification
found tsc exit 0 and build OK, but the test suite FAILS (exit 1): the e2e file
has syntax errors so 0 e2e tests ran, and the rate-limit logic in
worker/index.ts deviates from OmniMail in a way that blocks legitimate logins.
Fix exactly the items below, nothing else. Do NOT rewrite App.tsx, auth.ts,
api.ts, or the migration. Do NOT deploy, commit, or push.

## Environment
- A wrangler dev server is ALREADY RUNNING on http://127.0.0.1:8788
  (started detached by the coordinator; GET /api/messages → 401 without a
  cookie). DO NOT start another one — a second instance fails with
  "Address already in use". Use the running server for all test runs.
- If the server is down when you check, restart it ONLY like this (detached,
  new session — plain `&` dies when your shell times out):
  `cd /data/home/webmail-password-auth && setsid nohup npx wrangler dev --ip 127.0.0.1 --port 8788 > /tmp/wrangler-s9d.log 2>&1 < /dev/null &`
  then wait ~12s and curl http://127.0.0.1:8788/api/messages (expect 401).
- NEVER `pkill -f "wrangler dev"` in a command containing that literal —
  it self-matches and kills your own shell; kill by captured PID only.

## Fix 1 — Login rate limit (worker/index.ts, POST /api/auth/password)
Current code increments login_attempts on EVERY request and blocks when
attempts >= 5 BEFORE checking the password. That means a correct password on
the 5th attempt gets 429, and only 4 failures are ever allowed. Restructure
to OmniMail's exact semantics (see password-login.ts, which the coordinator
read from GitHub mibgb65-cloud/OmniMail):
- Key = sha256Hex(ip + "\n" + email), ip from the CF-Connecting-IP header,
  fallback 'unknown'. (Current code keys by email only — add the IP.)
- FIRST check blocked: a row exists AND now - window_started_at < 900 AND
  attempts >= 5 → return 429 with Retry-After = window_started_at + 900 -
  now (SECONDS remaining, minimum 1). The current Retry-After math mixes
  minutes and seconds — fix it.
- THEN verify the password. On failure ONLY, record the failure with the
  window-reset upsert (if the stored window started before now - 900, reset
  attempts to 1 with a new window start, else attempts + 1). On success,
  DELETE the login_attempts row and issue the cookie.
- Remove the pre-increment block and the redundant post-password-check
  block. Keep: dummy PBKDF2 derive (consumePasswordCost) + same generic 401
  for unknown email, same generic 401 for wrong password.

## Fix 2 — Registration rate limit off-by-one (worker/index.ts, POST /api/auth/signup)
Same pattern bug in all three buckets (ip-day max 10, ip-hour max 3,
email-hour max 3): the code increments first and blocks when attempts >= max,
so only max-1 attempts are allowed. Change it to OmniMail's consumeBucket
semantics: the max-th attempt is ALLOWED, the (max+1)-th is blocked
(allowed = attempts <= maximum after increment). Keep the 429 + Retry-After
header (seconds remaining — already correct here).

## Fix 3 — E2E test syntax + logic (worker/smoke.e2e.test.ts)
The file currently fails to parse, so ZERO e2e tests run. Fix surgically:
- The signup test, the wrong-password test, and the forgot test each end
  with `};` — change each to `});`.
- The reset test declares `async () {` — change to `async () => {` — and
  its ending `};` to `});`.
- The forgot test references `env.DEV_LOGIN`, which is not defined in this
  file (ReferenceError). This file only ever runs against the local dev
  server (which always returns the raw token when DEV_LOGIN=1), so replace
  that conditional with a direct assertion: `expect(body.token).toBeDefined()`.
- The reset test signs up `newuser@test.com`, which is NOT in ALLOWED_EMAILS
  (signup would 403, no token would be created, reset would fail). Use
  `lethanhdongus@gmail.com` (the other allowlisted email) instead. After the
  new-password login, capture its set-cookie and use it for the mailbox
  check (currently the test never reads the login cookie).
- Re-run tolerance (the local dev D1 persists across runs, so a second run
  sees state from the first): the signup assertions must accept 201 OR 409
  (already registered); the wrong-password assertion must accept 401 OR 429
  (failed attempts accumulate across runs and can trip the 15-min lockout).

## Verification (do all of this before finishing)
1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → OK.
3. `SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false` → exit 0,
   ALL test files pass INCLUDING worker/smoke.e2e.test.ts (check the
   "Test Files" line: 2 passed, 0 failed). Run the suite TWICE in a row to
   prove the re-run tolerance works (second run must also be exit 0).
4. Live-probe the fixed login lockout against the running dev server with
   curl (do NOT use real user passwords — use a fresh wrong password
   against an allowlisted email and observe 401s then 429 on the 6th
   attempt, then confirm a correct login still works after the window or
   with the other allowlisted email). Record the observed statuses.
5. Update STATE-S9.md: correct the test numbers (the previous "24/24" was
   unit tests only — the e2e file was broken), list these three fixes, and
   keep `ALL DONE` at the end only if everything above is green.

## Rules
- Never read, print, or copy .dev.vars (it holds SESSION_SECRET). Use it
  only via wrangler dev. Never put the Resend key, SESSION_SECRET, tokens,
  hashes, or passwords in code, logs, test output, or STATE-S9.md.
- Never deploy, never commit, never push. Work only in this workdir.
- If a step fails, fix it; do not claim success without the verification
  numbers above.
