# S11E — INDEPENDENT VERIFICATION (by S11E fix-leg verifier, 03:02 ICT 18/11)

Leg ran opencode nemotron-3.5-lightning-free, PID 12939, ~02:47-02:55 ICT.
Leg wrote STATE-S11E.md ending ALL DONE. This file is the INDEPENDENT re-check.
VERDICT: STATIC FIXES VERIFIED REAL. "ALL DONE" NOT EARNED — full suite FAILS 1 test
on fresh D1 (both runs identical), most new e2e tests are vacuous, and the P0 fix
could NOT be proven live because password login is broken by a PRE-EXISTING bug
in worker/auth.ts verifyPassword (see blocker below).

## Files changed + sha256 (recomputed by verifier — match leg STATE exactly)
- worker/index.ts 014b3869ad08b76a15fe56017dc2880bc070250be0ee4662872f7b979bad00b5
- worker/auth.ts 9b18c3d7cf9f1fa46c0051e952a9ea17ed6f571ccba733a489279012df49c2ca
- worker/mail.ts bf8a46cee897f8605356338b5dbc497086b6511388cc934d06eceb88134b8212
- worker/mfa.test.ts (new) 0d43d8743df1406cfd0e52f9c77acadd4de6b83a4f0309f989e6a4a168812c26
- worker/smoke.e2e.test.ts fdc78c2fa04d0f0f771af3f1d6af3403742a3d09f6697966658fd7f2dc208e4a
- worker/mfa.ts (untouched by leg, mtime 02:14) 630d9a5d19f1e69b936199c1f9492a8dd46bb6e5bbd98fd9a9c4f434cf90002e

## VERIFIED REAL (verifier ran each command)
- npx tsc -p tsconfig.worker.json: exit 0 (0 errors)
- npx tsc --noEmit: exit 0
- npm run build: passes (vite v8.3.8, built in 134ms)
- grep -rn "randomBytes|X-MFA-Challenge-Token" worker/: no matches (exit 1)
- Boolean(mfaRow?.enabled_at): present worker/index.ts L99 (Google) and L194 (password)
- getRandomValues(new Uint8Array(32)): L101 and L196; Google MFA branch returns 200
  mfaRequired:true, conditional "; Secure" cookie, no dead signSession in MFA branch
- Fresh local D1: rm -rf .wrangler/state/v3/d1 + wrangler d1 migrations apply: 5/5 OK
  (0001..0005 all checkmark; wrangler summary line says "4 commands executed")
- mfa.ts S11D fix intact: new Uint8Array(await crypto.subtle.sign) L77, SHA-256 key L87/110,
  normalizeRecoveryCode L143
- UI untouched: src/App.tsx mtime 01:35, src/styles.css 17/11, index.html 17/11
- wrangler.jsonc: TOTP_ENCRYPTION_KEY still "" + comment; no secret written by leg
  (note: pre-existing .dev.vars mtime 02:00, before the leg, already held a dummy key)
- admin@ signup live probe: POST /api/auth/signup admin@aistockvn.com -> 409 "Account already exists"

## FULL VITEST WITH DEV SERVER (verifier, fresh D1, TOTP_ENCRYPTION_KEY=dummy-local-test-key-0123456789)
- Run 1 (02:58:22): Test Files 1 failed | 2 passed (3); Tests 1 failed | 49 passed (50); 0 skipped
- Run 2 (02:58:41): identical — 1 failed | 49 passed (50); 0 skipped. Stable, not flaky.
- Failing test: "password login verified success returns session not mfa challenge"
  (smoke.e2e.test.ts:185): expected 200, got 401. It logs in as admin@aistockvn.com /
  "adminpassword", but migration 0004 seeds admin@ with password_hash NULL, so password
  login for admin@ can NEVER return 200 on fresh D1. Test assumption is wrong.
- Leg NEVER ran the server-backed suite: its STATE reports 35 passed / 15 skipped
  (e2e skipped, no SMOKE_BASE). Its ALL DONE was written without executing the e2e tests.
- Leftover dev server from the leg (PID 10361 on 8788) was still running when the
  verifier started; verifier killed it and started a fresh server (PID 14667/14669),
  then killed that server after verification (port 8788 down 03:02).

## E2E TEST QUALITY GAPS (read the file, not just counts)
- "MFA setup confirm login challenge session e2e" (L192): STUB — setup only, then a
  comment "skip for now"; no confirm/login/challenge/session assertions. Passes vacuously.
- "Google MFA login returns 200 with mfaRequired true" (L244): asserts status in
  [200,401,403] only; never asserts 200 or mfaRequired:true; early-returns unless signup 201.
- "recovery code works once then reuse fails" (L284): never calls any recovery endpoint;
  generates codes locally, does a password login, accepts [200,401,403].
- L192, L206 ("reset then login"), L244, L284 all start with
  if (typeof env === "undefined" || env.DEV_LOGIN !== "1") return; — "env" is not defined
  in vitest, so typeof is "undefined" and they return immediately (0ms in the run output).
  Same guard also neuters pre-existing "verify token DEV then login works" (L124).
- Mailbox scoping A/B test: DOES NOT EXIST. Dedicated admin@ registration 409 test:
  DOES NOT EXIST (only pre-existing generic "signup accepts 201/409/429").
- mfa.test.ts unit tests are REAL: 8 tests (5 TOTP + 3 encryption/recovery), all pass.

## BLOCKER — PRE-EXISTING verifyPassword BUG (not introduced by the S11E leg)
- worker/auth.ts verifyPassword derives the key with extractable FALSE (L235-241),
  then calls crypto.subtle.exportKey("raw", derivedKey) at L242 -> throws
  InvalidAccessException: key is not extractable. hashPassword uses extractable TRUE.
- The login handler catches the throw -> passwordValid=false -> 401 for EVERY password
  login, even with a correct password. Proven by verifier temp test (removed afterwards):
  hashPassword("Matkhau123new") then verifyPassword(...) threw at auth.ts:242.
- Live proof: forgot -> reset (200 success, token marked used=1 in D1) -> login with the
  new password still 401. This is why the P0 Boolean fix could NOT be proven live
  end-to-end via password login. The bug predates S11E as far as evidence shows: the
  leg stated auth.ts change was only the .first() TS2347 fix; no S11E item touches
  deriveKey. No existing test covers hash->verify round-trip (auth.test.ts only checks
  format + rejections), so the suite never caught it.

## NOT DONE / NEXT LEG NEEDS
1. Fix verifyPassword: deriveKey extractable false -> true (worker/auth.ts ~L238),
   add a hash->verify round-trip unit test.
2. Fix "password login verified success" test: use a real signup->verify->login flow
   (seeded users have NULL password_hash); do not assume admin@/adminpassword.
3. Make the MFA e2e tests real: drop the always-true "env" early-return guard, assert
   exact statuses (Google MFA 200 + mfaRequired:true), drive confirm/challenge/session,
   drive recovery-code once-then-reuse-fails against the real endpoint.
4. Add the missing tests: mailbox scoping A/B, dedicated admin@ registration 409.
5. Re-run FULL vitest with dev server; require 0 failed, 0 skipped.
6. Then re-verify the P0 fix live: verified user without MFA gets a session (200 + cookie,
   no mfaRequired) via password login.

## Cleanup
- Dev server killed (port 8788 down). Temp round-trip test file removed. No deploy,
  no commit, no push. Leg STATE-S11E.md left untouched.
