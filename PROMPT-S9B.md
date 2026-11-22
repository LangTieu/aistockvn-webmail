# Finish + verify password auth — webmail aistockvn-webmail (S9B)

## Context
A previous OpenCode run (PROMPT-S9.md, OmniMail-grounded) already wrote all
the code, but died before finishing verification (its shell kept timing out
on the dev server). Your job is ONLY to finish and verify — do not rewrite
code that already works.

Current state (read the files to confirm, do not assume):
- migrations/0002_users.sql exists (users, login_attempts,
  registration_attempts, password_resets).
- worker/auth.ts has hashPassword / verifyPassword / validatePassword (10–128) /
  safeEqual / sha256Hex / consumePasswordCost, stored format
  `pbkdf2-sha256$100000$<base64 16-byte salt>$<base64 32-byte derived>`.
- worker/index.ts has POST /api/auth/password, /api/auth/signup,
  /api/auth/forgot, /api/auth/reset.
- src/api.ts has loginPassword, signup, forgotPassword (+ resetPassword if present).
- src/App.tsx Login card rewritten (Email + Password, "Quên mật khẩu?",
  "Đăng nhập"/"Đăng ký" toggle, "hoặc" divider, "Sign in with Google"
  untouched). App.tsx is 1109 lines (was 858) — the rewrite is done; do NOT
  rewrite it again. Fix type errors surgically if any remain.
- worker/auth.test.ts + worker/smoke.e2e.test.ts extended with the new tests.
- PROMPT-S9.md in this workdir has the full spec (OmniMail deltas, routes,
  tables, test list) — read it first and follow it.

## Environment (important)
- A wrangler dev server is ALREADY RUNNING on http://127.0.0.1:8788
  (started detached by the coordinator; GET /api/messages → 401 without a
  cookie). DO NOT start another one — a second instance fails with
  "Address already in use". Use the running server for all test runs.
- If the server is down when you check, restart it ONLY like this (detached,
  new session — plain `&` dies when your shell times out):
  `cd /data/home/webmail-password-auth && setsid nohup npx wrangler dev --ip 127.0.0.1 --port 8788 > /tmp/wrangler-s9c.log 2>&1 < /dev/null &`
  then wait ~12s and curl http://127.0.0.1:8788/api/messages (expect 401).
- NEVER `pkill -f "wrangler dev"` in a command containing that literal —
  it self-matches and kills your own shell; kill by captured PID only.

## Verification (do all of this)
1. `npx wrangler d1 migrations apply aistockvn-mail --local` — must apply
   cleanly (it may already be applied — that is fine).
2. `npx tsc --noEmit` → exit 0. Fix any errors surgically.
3. `npm run build` → OK.
4. `SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false` → all
   tests pass (existing 18 + new password-auth tests). Fix failures; do not
   weaken or delete tests to make them pass. If a test fails because the
   server is down, check the server first (see above) instead of editing code.
5. Sanity-check the OmniMail deltas from PROMPT-S9.md are actually in the
   code: password min 10 (not 8); single-column encoded hash format;
   login_attempts table + 429 (not failed_attempts columns); dummy derive on
   unknown email; registration buckets ip-day 10 / ip-hour 3 / email-hour 3.
   Fix anything that deviates.
6. Write STATE-S9.md in the workdir with: files changed, new routes +
   tables, verification numbers (typecheck exit code, build result, test
   counts: X passed / Y total), the OmniMail deltas applied, and anything
   you could NOT verify. When everything above is done, append the line
   `ALL DONE` to STATE-S9.md and stop.

## Rules
- Never read, print, or copy .dev.vars (it holds SESSION_SECRET). Use it
  only via wrangler dev. Never put the Resend key, SESSION_SECRET, tokens,
  hashes, or passwords in code, logs, test output, or STATE-S9.md.
- Never deploy, never commit, never push. Work only in this workdir.
- If a step fails, fix it; do not claim success without the verification
  numbers above.
