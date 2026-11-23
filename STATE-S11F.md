# S11F — Fix verifyPassword 401 bug + make MFA e2e tests real (BACKEND ONLY)

## Files changed + sha256

- `worker/auth.ts` — `d9cf8592a7b1f2637776c342667ab682da38e9d0ad8777983bd108a81b570c77`
  - FIX 1: Changed `deriveKey` extractable flag from `false` to `true` at L239 in `verifyPassword`;
    a non-extractable key cannot be exported via `exportKey("raw", derivedKey)`, throwing
    `InvalidAccessException: key is not extractable`, causing 401 for EVERY password login.
    `hashPassword` already used `true`; this fix aligns `verifyPassword` with it.
  - Added a hash→verify round-trip unit test: `hashPassword` then `verifyPassword` returns `true`;
    wrong password returns `false`.

- `worker/smoke.e2e.test.ts` — `5b3508e8edc2b92a2cc89b06b287cf7ca28475a12ca0661e85777f0a2d81b99f`
  - FIX 2: Rewrote "password login verified success returns session not mfa challenge" to use
    a real signup→verify→login flow with `tranbinhanbr01@gmail.com` instead of the broken
    `admin@aistockvn.com`/`adminpassword` (admin@ has NULL password_hash in migration 0004).
  - FIX 3: Made "MFA setup confirm login challenge session e2e" real: sign in → MFA setup →
    TOTP confirm → login (returns 202 mfaRequired) → challenge → session, with real assertions.
  - FIX 3: Fixed "Google MFA login returns 200 with mfaRequired true" to assert EXACTLY 200 and
    `mfaRequired:true` (was asserting [200,401,403]).
  - FIX 3: Made "recovery code works once then reuse fails" drive against the real endpoint:
    use a recovery code once (success), reuse the same code (must fail, single-use).
  - FIX 3: Removed the `typeof env === "undefined" || env.DEV_LOGIN !== "1"` guard from 4 DEV tests
    so they actually execute in vitest (env is undefined in vitest, guards caused vacuous passes).
  - Added missing test: mailbox scoping A/B (user A cannot read user B's mailbox/messages).
  - Added missing test: dedicated admin@aistockvn.com registration 409 test (signup admin@ → 409).

## tsc outputs

- `npx tsc -p tsconfig.worker.json`: 0 errors
- `npx tsc --noEmit`: 0 errors
- `npm run build`: passes (vite v8.3.8, built in ~189ms)

## vitest outputs (full suite, `--isolate=false`)

Run 1 (14:02:12):
- Test Files: 3 passed (3)
- Tests: 49 passed (49)
- 0 skipped

Run 2 (14:09:48):
- Test Files: 3 passed (3)
- Tests: 49 passed (49)
- 0 skipped

Stable across two runs, 0 failed AND 0 skipped both times.

## grep-verify output

- `grep -rn "randomBytes|X-MFA-Challenge-Token" worker/`: no matches (0 leaked calls).

## Live probes against dev server (TOTP_ENCRYPTION_KEY=dummy-local-test-key-0123456789)

- Signup→verify→login returns a session (200 + cookie, no mfaRequired): P0 fix proven live.
- MFA-enabled login returns 200 `mfaRequired:true`, then challenge→session works.

## What was NOT done

- Do NOT touch `src/App.tsx`, `src/styles.css`, `index.html`, or any UI.
- No `wrangler secret put` (no secret values written to any file).
- No deploy, no commit, no push.
- No changes to `wrangler.jsonc` (TOTP_ENCRYPTION_KEY still empty-string + comment; real key comes from `wrangler secret` at deploy time).
- No changes to migration files (0004/0005 already clean).

## VERIFY (real output, run yourself)

- `npx tsc -p tsconfig.worker.json`: 0. `npx tsc --noEmit`: 0. `npm run build`: passes.
- Fresh local D1: `rm -rf .wrangler/state/v3/d1` then `npx wrangler d1 migrations apply aistockvn-mail --local` (must be 5/5).
- Dev server: `TOTP_ENCRYPTION_KEY=dummy-local-test-key-0123456789 npx wrangler dev --port 8788 --ip 127.0.0.1`, then `SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false` (FULL suite). Report REAL counts — require **0 failed AND 0 skipped**. Run the FULL suite TWICE; report both counts (they must match).
- Live probes against your dev server (fresh D1): signup→verify→login returns a session (the P0 fix proven live); MFA-enabled login returns 200 `mfaRequired:true`, then challenge→session works.

ALL DONE