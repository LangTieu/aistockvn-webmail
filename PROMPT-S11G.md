# PROMPT-S11G — Fix MFA confirm never enabling + make e2e tests real (BACKEND ONLY)

Workdir on IB1: `/data/home/webmail-omnimail-model`. Do NOT touch src/App.tsx,
src/styles.css, index.html, or any UI. NO deploy, NO commit, NO push,
NO `wrangler secret put`. NEVER write a secret value to a file.
Read first: `STATE-S11F-VERIFY.md` (the full S11F verification record — it has
the exact bug and every gap listed below), `STATE-S11F.md`, `STATE-S11E.md`,
`docs/omnimail-model-design.md`, `docs/api-contract.md`,
`worker/index.ts` (the bug), `worker/smoke.e2e.test.ts` (the vacuous tests),
`worker/auth.test.ts`.

## CONTEXT (verified by the coordinator, real output)
- S11E + S11F fixes are DONE and verified, do NOT regress them:
  `npx tsc -p tsconfig.worker.json` 0 errors, root tsc 0, build passes,
  P0 fix `Boolean(mfaRow?.enabled_at)` at worker/index.ts L99/L194,
  `getRandomValues` at L101/L196, `verifyPassword` deriveKey flag `true`
  (worker/auth.ts), grep `randomBytes|X-MFA-Challenge-Token` clean,
  fresh local D1 5/5. Live proven: forgot→reset→login returns 200 + session
  (was 401 before S11F); admin@ signup → 409 live.
- S11F's STATE-S11F.md ends `ALL DONE` but that claim is NOT earned: the
  suite is 49 passed / 0 skipped TWICE, but 5 e2e tests are VACUOUS (see below).
  Do NOT trust it. The suite must prove the MFA paths for real.
- Vitest runs: 49 passed (49), 0 skipped, twice identical.

## FIX 1 — MFA confirm never enables MFA (pre-existing, verified in code + live)
`worker/index.ts` confirm handler ~L605-606:
`UPDATE admin_totp SET enabled_at = ?, updated_at = ? WHERE user_id = ?`
bound with `.bind(nowSec, nowSec, authUser)` — but `authUser` is the EMAIL
(returned by `verifySession`), while `user_id` is the UUID. 0 rows updated,
no error. D1 proof after a 200 confirm: the `admin_totp` row still has
`enabled_at: NULL`. Live proof: setup 200, confirm with a fresh TOTP 200 +
8 recovery codes, then password login → 200 + session, NO `mfaRequired`,
NO challenge cookie; challenge → 400 "No MFA challenge". So MFA setup+confirm
succeeds but login NEVER enforces it (Google and password paths alike).
Fix: bind the user id in the confirm UPDATE — use the
`(SELECT id FROM users WHERE email = ?)` subselect pattern the disable handler
already uses for its DELETEs.
AUDIT every `WHERE user_id = ?` bound with `authUser` in worker/index.ts and
fix each one the same way (the verifier spotted the same wrong binding at
~L648 in the recovery-code `used_at` UPDATE — check it and every other site;
`grep -n "user_id = ?" worker/index.ts` lists them).

## FIX 2 — the 5 signup-dependent e2e tests are vacuous (rewrite them)
All 3 allowlisted emails are pre-seeded verified=1 (migration 0004), so
signup ALWAYS returns 409, never 201 — and every one of these tests does
`if (signup.status !== 201) return;`. Verbose run: they finish in 5-8ms each
(one HTTP round-trip), vs 27ms for the real login test. Affected: the
password-login test, MFA e2e, Google MFA, recovery, mailbox A/B.
Rewrite them to use forgot→reset on the SEEDED users (already verified=1):
forgot → reset with a new password → login with it. REMOVE every
`if (… !== 201) return` early-return — no test may silently skip when setup
fails; a failed setup must FAIL the test loudly.

## FIX 3 — make the MFA e2e tests real (read the file, do not just count)
- MFA e2e: drive confirm → assert enabled (via `mfa/status`, must show
  enabled) → login asserts EXACTLY 200 + `mfaRequired:true` + a challenge
  cookie → challenge → session. The server returns 200 with `mfaRequired`
  per api-contract, NOT 202 — fix the test's `[200,202]` acceptance and its
  dead `if (status===202)` challenge branch.
- Google MFA test: it calls `/mfa/challenge` where it should call
  `/mfa/confirm`, with credential `"dummy"`. Fix the endpoint and the
  credential (use a real TOTP code).
- Recovery test: it generates codes LOCALLY (never stored server-side) and
  accepts `[200,401,403]`. Use SERVER-issued codes from the confirm response:
  use one code (success), reuse the same code (must fail).
- Mailbox A/B: it sends with `Cookie: bodyA.token` (a verification token, not
  a session cookie), never asserts send status, and checks for a from-address
  that would never appear. Log in properly, use the real `mail_session`
  cookie, assert send status, then assert user B cannot read user A's mail.
- Restore the 2 deleted pre-existing tests ("verify token DEV then login
  works" and "reset then login" — cited in S11E-VERIFY at L124/L206).
  The suite went 50 → 49 tests because of the deletion; restore it to 50+
  with the new tests added.

## FIX 4 — add the missing round-trip unit test
S11F's STATE claims a hash→verify round-trip unit test, but
`worker/auth.test.ts` is untouched (mtime 17/11). Add it:
`hashPassword` then `verifyPassword` returns true; wrong password returns
false.

## KEEP GREEN
- `npx tsc -p tsconfig.worker.json` 0 errors, `npx tsc --noEmit` 0,
  `npm run build` passes, fresh local D1 5/5,
  grep `randomBytes|X-MFA-Challenge-Token` in worker/ prints nothing.
- Do NOT break existing tests. The 8 `worker/mfa.test.ts` unit tests are real
  and pass — keep them passing.

## VERIFY (real output, run it yourself)
- `npx tsc -p tsconfig.worker.json`: 0. `npx tsc --noEmit`: 0.
  `npm run build`: passes.
- Fresh local D1 for EACH run: `rm -rf .wrangler/state/v3/d1` then
  `npx wrangler d1 migrations apply aistockvn-mail --local` (must be 5/5).
  (Wipe BEFORE starting the dev server, and make sure no old server is still
  alive holding the old D1 — kill by captured PID first.)
- Dev server: `TOTP_ENCRYPTION_KEY=dummy-local-test-key-0123456789 npx wrangler
  dev --port 8788 --ip 127.0.0.1` (env var ONLY, never write the key to a
  file), then `SMOKE_BASE=http://127.0.0.1:8788 npx vitest run
  --isolate=false` (FULL suite). Kill dev by captured PID; leave NO process
  running afterwards. Report REAL counts — require **0 failed AND 0 skipped**.
  Run the FULL suite TWICE on fresh D1 each time; report both counts.
- VACUITY CHECK (required — this is what S11F missed): run the suite once
  with `--reporter=verbose` and report the per-test durations of the 5
  rewritten tests — each must show real server work (multiple HTTP calls,
  clearly above the 5-8ms one-round-trip signature). Also
  `grep -rn "!== 201) return\|!==201) return" worker/*.test.ts` must print
  nothing (no silent early-returns left).
- Live probes against your dev server (fresh D1): confirm → `mfa/status`
  shows enabled → login returns EXACTLY 200 + `mfaRequired:true` + challenge
  cookie → challenge → session; recovery code once (success) then reuse
  (must fail).

## DELIVERABLE
Write `STATE-S11G.md` in the workdir with: files changed + sha256, the tsc
outputs (REAL), build output, vitest outputs (REAL tail lines incl. test
count AND skipped count, BOTH runs), the verbose per-test durations of the 5
rewritten tests, the grep-verify outputs, the live-probe results, what was
NOT done. End with `ALL DONE` only when the FULL suite is 0 failed, 0
skipped with the dev server up, twice on fresh D1, AND the live probes pass,
AND the vacuity check passes. If anything blocks you, write the STATE file
with the blocker, the exact failing output, and what you tried — do NOT write
`ALL DONE`, do NOT claim success without the real output behind it.
