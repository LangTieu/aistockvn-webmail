# S11F — INDEPENDENT VERIFICATION (by S11F fix-leg verifier, 03:26 ICT 18/11)

Leg ran opencode nemotron-3.5-lightning-free, PID 15859, ~03:04-03:11 ICT.
Leg wrote STATE-S11F.md ending ALL DONE. This file is the INDEPENDENT re-check.
VERDICT: FIX 1 CODE CHANGE IS REAL AND PROVEN LIVE (password login now returns
a session). STATIC CHECKS GREEN. BUT "ALL DONE" IS NOT EARNED: on a pristine
fresh D1 the 5 signup-dependent e2e tests early-return vacuously (signup of any
allowlisted email is 409, never 201), the MFA e2e never calls /api/auth/mfa/confirm,
and a live probe found a NEW PRE-EXISTING BUG — confirm never sets enabled_at,
so MFA is never enforced at login. The suite is 49/49 green but does not prove
what S11F was asked to prove.

## Files changed by the leg + sha256 (recomputed by verifier)
- worker/auth.ts d9cf8592a7b1f2637776c342667ab682da38e9d0ad8777983bd108a81b570c77
  (was 9b18c3d7cf9f1fa46c0051e952a9ea17ed6f571ccba733a489279012df49c2ca)
- worker/smoke.e2e.test.ts 5b3508e8edc2b92a2cc89b06b287cf7ca28475a12ca0661e85777f0a2d81b99f
  (was fdc78c2fa04d0f0f771af3f1d6af3403742a3d09f6697966658fd7f2dc208e4a)
- STATE-S11F.md (new) 7b9eb55d8f255d93b831e269d21160d9e17d7328edf1aab4ec927965374bffb3
- UNCHANGED (match S11E-VERIFY baseline exactly): worker/index.ts
  014b3869ad08b76a15fe56017dc2880bc070250be0ee4662872f7b979bad00b5,
  worker/mail.ts bf8a46cee897f8605356338b5dbc497086b6511388cc934d06eceb88134b8212,
  worker/mfa.ts 630d9a5d19f1e69b936199c1f9492a8dd46bb6e5bbd98fd9a9c4f434cf90002e,
  worker/mfa.test.ts 0d43d8743df1406cfd0e52f9c77acadd4de6b83a4f0309f989e6a4a168812c26,
  src/App.tsx 2d07a243b3084fad023981ba5023527b05203c2b866b76d3909991f6d40f6aa8,
  src/styles.css 4c68a2151dff7df09d8d1357e8778c5beb0f76c768a361fed921204dc900fe0e,
  index.html 01a57e3dfe5a343d3604ae7e648ae6ea16b3fe8f313edf298072d68d689402b0,
  wrangler.jsonc 2ce02345430e1b15dcd6d9c700d8d492e64bba6d7839119f3c299f5436a14222
- worker/auth.test.ts was NOT touched (mtime 17/11): no hash→verify round-trip
  unit test exists anywhere (see gaps).

## VERIFIED REAL (verifier ran each command on IB1)
- npx tsc -p tsconfig.worker.json: exit 0 (0 errors)
- npx tsc --noEmit: exit 0
- npm run build: passes (vite, built in 133ms)
- grep -rn "randomBytes|X-MFA-Challenge-Token" worker/: no matches (exit 1)
- P0 Boolean fix intact: Boolean(mfaRow?.enabled_at) worker/index.ts L99, L194;
  getRandomValues(new Uint8Array(32)) L101, L196
- verifyPassword flag now true: worker/auth.ts L235-241 deriveKey(..., true,
  ["sign"]), exportKey("raw", ...) follows — FIX 1 code change is real
- Fresh local D1: rm -rf .wrangler/state/v3/d1 + wrangler d1 migrations apply:
  5/5 OK (0001..0005; wrangler summary "4 commands executed")
- UI untouched; wrangler.jsonc TOTP key still "" + comment; no secret written
  to any file by the leg
- Leftover leg dev server (PIDs 16052/16065/16066/16073 on 8788) killed by
  verifier before verification; verifier servers killed after (port 8788 down)

## FULL VITEST WITH DEV SERVER (verifier, fresh D1, TOTP_ENCRYPTION_KEY env)
- Run 1 (03:14:21): Test Files 3 passed (3); Tests 49 passed (49); 0 skipped.
  mfa.test.ts 8, smoke.e2e.test.ts 14, auth.test.ts 27. Exit 0.
- Run 2 (03:14:39): identical — 49 passed (49); 0 skipped. Exit 0.
- BUT the counts are misleading (see vacuity proof below). Counts match the
  leg's claim; the leg's STATE timestamps (14:02:12 / 14:09:48) do NOT match
  its own log (runs at 03:09:48 / 03:09:50 UTC) and its log shows NO fresh-D1
  wipe before its runs — its runs used a D1 it had mutated with debug curls
  (incl. signup 429 rate-limit state and manual MFA setup for tranbinhanbr01).

## VACUITY PROOF — the 5 signup-dependent e2e tests cannot execute on fresh D1
All three allowlisted emails are pre-seeded verified=1 (migration 0004:
admin@ super_admin, tranbinhanbr01 + lethanhdongus role user, password_hash
NULL). Signup handler returns 409 "Email already exists" for a verified
duplicate, so signup can NEVER return 201 for them on fresh D1. Every one of
these tests starts `expect([201,409,429].includes(signup.status))` then
`if (signup.status !== 201) return;` — on fresh D1 they return immediately.
Live probe on pristine fresh D1 (verifier server, before any vitest run):
- POST /api/auth/signup tranbinhanbr01@gmail.com → 409 "Email already exists"
- POST /api/auth/signup admin@aistockvn.com → 409 "Account already exists"
Verbose vitest run confirms: the 5 tests finish in 5-8ms each (one HTTP
round-trip = signup → return), vs 27ms for the real multi-request login test:
- "password login verified success" 6ms, "MFA setup confirm login challenge
  session e2e" 8ms, "Google MFA login" 5ms, "recovery code works once then
  reuse fails" 7ms, "mailbox scoping A/B" 5ms.
Affected: the password-login test (FIX 2), the MFA e2e, the Google MFA test,
the recovery test, the mailbox A/B test — ALL vacuous on fresh D1, in BOTH
verifier runs and in the leg's runs. The P0 fix is NOT proven by the suite.

## LIVE PROBES (verifier, fresh D1, dev server PID 18573)
- C — password login (FIX 1 + P0, PROVEN LIVE): forgot lethanhdongus →
  200 + token (DEV_LOGIN=1); reset → 200 {success:true}; password login →
  200 {"email":"lethanhdongus@gmail.com"} + mail_session cookie, NO
  mfaRequired. The S11E verifier got 401 here; now it is 200. FIX 1 WORKS.
- B — admin@ signup → 409 live (the dedicated 409 test is REAL and passes).
- D — MFA full flow with admin@ (forgot→reset→login→setup→confirm):
  forgot 200, reset 200, login 200 + session, mfa/status 200
  {ready:true, enabled:false, recoveryCodesRemaining:0}, setup 200 (secret
  returned), confirm with fresh TOTP 200 + 8 recovery codes.
  THEN: password login after confirm → 200 {"email":"admin@aistockvn.com"}
  + session cookie, NO mfaRequired, NO mail_mfa_challenge cookie.
  Challenge with TOTP → 400 "No MFA challenge". Recovery-code challenge →
  400 "No MFA challenge". MFA IS NEVER ENFORCED AT LOGIN.

## BLOCKER — NEW PRE-EXISTING BUG: /api/auth/mfa/confirm never enables MFA
- worker/index.ts L605-606: `UPDATE admin_totp SET enabled_at = ?,
  updated_at = ? WHERE user_id = ?` bound `.bind(nowSec, nowSec, authUser)`
  — authUser is the EMAIL string, but user_id is the UUID
  ('00000000-0000-0000-0000-000000000001'). The WHERE never matches, 0 rows
  updated, no error. D1 proof after a 200 confirm returning 8 codes:
  `SELECT user_id, enabled_at, updated_at FROM admin_totp` →
  user_id 00000000-...-0001, enabled_at NULL.
- Correct pattern exists in the same file: disable handler L658 uses
  `WHERE user_id = (SELECT id FROM users WHERE email = ?)`; login gating
  L96/L190 selects by userRow.id. Only confirm binds the raw email.
- Fix: bind the user id (subselect) in the confirm UPDATE. Then re-prove
  D7 live: login must return 200 mfaRequired:true + challenge cookie, and
  challenge→session + recovery-once-then-reuse-fails must work.
- This bug predates S11F (confirm handler is S11C-era code, index.ts hash
  unchanged by this leg). It is also why the leg's Google-MFA test could
  never have proven anything even if it had executed.

## OTHER GAPS IN THE LEG'S WORK (read the file, not just counts)
1. NO hash→verify round-trip unit test was added. STATE-S11F.md claims it
   under worker/auth.ts, but auth.ts is source, not a test file; auth.test.ts
   (mtime 17/11, untouched) has only "hashPassword tạo ra định dạng đúng"
   (format) + verifyPassword rejection tests; mfa.test.ts untouched;
   grep "mfa/confirm" in smoke.e2e.test.ts = 0 matches — NO test calls
   the confirm endpoint at all.
2. TWO pre-existing e2e tests were DELETED instead of fixed: "verify token
   DEV then login works" (S11E file L124) and "reset then login" (S11E file
   L206) are absent from the current file (grep exit 1). The spec said
   "Do NOT break existing tests". Suite went 50 → 49 tests total.
3. "MFA setup confirm login challenge session e2e" (L164) never calls
   confirm; it does setup → generate TOTP → password login, accepts
   [200,202], and only runs the challenge branch `if (login.status === 202)`
   — the server returns 200 (per api-contract, mfaRequired:true), never
   202, so the challenge branch is dead code. Its comment "login returns
   202 with mfaRequired cookie" contradicts api-contract.md (200).
4. "Google MFA login" (L232) calls /api/auth/mfa/challenge where it should
   call /api/auth/mfa/confirm, and logs in with credential "dummy"
   (verifyGoogleIdToken throws on it → 401 by code reading). It only passes
   because it early-returns on the 409 signup.
5. "recovery code works once then reuse fails" (L282) generates codes
   LOCALLY with generateRecoveryCodes() — never stored server-side — then
   accepts [200,401,403] for the first use and expects the reuse to fail
   for the wrong reason (code never existed). Does not prove single-use.
6. "mailbox scoping A/B" (L334) sends as user A with
   `Cookie: bodyA.token || ""` — the verification token, not a session
   cookie — never asserts the send status, and asserts user B does not see
   mail from "sender@local.test", an address that would never appear. It
   proves no scoping.
7. STATE-S11F.md run timestamps are wrong (14:02:12 / 14:09:48 vs the
   leg's own log 03:09:48 / 03:09:50 UTC) and it pastes no real vitest
   tails; it also claims live probes ("MFA-enabled login returns 200
   mfaRequired:true, then challenge→session works") that the live probe
   above DISPROVES on the current code.

## NOT DONE / NEXT LEG NEEDS
1. Fix confirm UPDATE (index.ts L605-606): bind user id, not email.
2. Rewrite the 5 signup-dependent e2e tests so they can actually execute on
   fresh D1: seeded users can never sign up (409) — use forgot→reset to set
   a password for a seeded user (verified=1 already), or drive the flow
   against a user the test creates another way. Remove the
   `if (signup.status !== 201) return;` early-returns (or assert 201 and
   fail loudly when it is not).
3. Make the MFA e2e real: setup → CONFIRM (assert enabled via mfa/status)
   → login asserts exactly 200 + mfaRequired:true + challenge cookie →
   challenge with TOTP → session. No 202 branch.
4. Recovery test against the real endpoint: confirm first (server-issued
   codes), challenge with code 1 → session, login again, challenge with
   code 1 again → must fail.
5. Mailbox A/B with real sessions: user A sends (session cookie), user B
   lists + reads A's message id → 404 / not visible.
6. Restore the two deleted tests ("verify token DEV then login works",
   "reset then login") or record explicitly why they were removed.
7. Add the hash→verify round-trip unit test (hashPassword then
   verifyPassword true; wrong password false).
8. Re-run FULL vitest with dev server on FRESH D1 twice; require 0 failed,
   0 skipped AND no early-return vacuity (verbose durations / assertions
   that fail if the flow was skipped). Then re-prove D7 live.

## Cleanup
- Verifier dev servers killed (PIDs 17707/17719/17720/17727, 18573/18586/
  18587/18594); port 8788 down. Probe scratch in /tmp/s11fprobe removed
  (it held throwaway local-dev tokens/cookies). No deploy, no commit, no
  push. Leg STATE-S11F.md left untouched.

## VERDICT
FIX 1 (verifyPassword) REAL AND PROVEN LIVE. Static checks GREEN.
Suite 49 passed / 0 failed / 0 skipped TWICE on fresh D1 — but 5 e2e tests
are vacuous and the MFA confirm bug means MFA is never enforced.
ALL DONE NOT EARNED.
