# PROMPT-S11E — Fix P0 MFA login bug + worker tsc 0 errors + MFA tests (BACKEND ONLY)

Workdir on IB1: `/data/home/webmail-omnimail-model`. Do NOT touch src/App.tsx,
src/styles.css, index.html, or any UI. NO deploy, NO commit, NO push,
NO `wrangler secret put`. NEVER write a secret value to a file.
Read first: `docs/omnimail-model-design.md`, `docs/api-contract.md`,
`STATE-S11-COORDINATOR.md` (section "S11E — NEXT LEG"), `worker/mfa.ts`
(TOTP was fixed in S11D — do NOT regress it: `new Uint8Array` around
`crypto.subtle.sign`, SHA-256 AES-GCM key, `normalizeRecoveryCode`).

## CONTEXT (verified by the coordinator, real output)
- STEP 0 re-sync is DONE: the VM clone now matches IB1 byte-exact (sha256 verified).
  Work on IB1 only; the coordinator syncs back afterwards.
- `npx tsc --noEmit` (root) = 0 already. `npm run build` passes already.
- `npx tsc -p tsconfig.worker.json` currently has 10 errors (real output):
  - worker/auth.ts(140,21): TS2347 Untyped function calls may not accept type arguments.
  - worker/index.ts(100,28) + (196,28): TS2339 Property 'randomBytes' does not exist on type 'Crypto'.
  - worker/index.ts(426,26): TS2304 Cannot find name 'verifyEmailToken'.
  - worker/index.ts(552,26), (552,53), (570,31), (600,87), (640,89), (705,95):
    TS2339 Property 'TOTP_ENCRYPTION_KEY' does not exist on type 'Env' (x6).

## THE P0 BUG (verified by the coordinator reading the code)
Both login handlers push users into the MFA challenge with
`mfaRow?.enabled_at !== null` — that expression is TRUE when NO MFA row
exists (undefined !== null), so EVERY verified user WITHOUT MFA gets pushed
into the MFA challenge instead of receiving a session:
- Google login handler ~L99 (challenge creation ~L100)
- Password login handler ~L193 (challenge creation ~L196)
Fix: use `Boolean(mfaRow?.enabled_at)` in BOTH handlers.

## FIX (worker/ only, plus tests)
1. (a) P0 above, both login handlers.
2. (b) `crypto.randomBytes(32)` → `crypto.getRandomValues(new Uint8Array(32))`
   + b64url encode, in BOTH challenge-creation sites (~L100, ~L196).
   Node's `randomBytes` is unproven in Workers; `getRandomValues` is the
   Web Crypto API that runs in Workers.
3. (c) In the MFA branch of BOTH login handlers: remove the dead
   `signSession()` call; cookie `Secure` must be conditionally included
   (never the invalid `Secure=${...}` form); DROP the
   `X-MFA-Challenge-Token` response header (it leaks the token hash);
   fix the Google MFA cookie's duplicate `Secure` attribute.
4. (d) Fix ALL 10 worker-tsc errors above so
   `npx tsc -p tsconfig.worker.json` exits 0. This includes auth.ts:140,
   the `verifyEmailToken` scope/import problem, and adding
   `TOTP_ENCRYPTION_KEY` to the `Env` type (type declaration in worker code
   ONLY — do NOT put any key value in wrangler.jsonc; its current
   empty-string entry + comment stays as-is; the real key comes from
   `wrangler secret` at deploy time, which is the liaison's step, not yours).
5. (e) Root `npx tsc --noEmit` stays 0; `npm run build` stays passing.

## TESTS (required — the current 38-test suite covers NONE of this)
- New `worker/mfa.test.ts` (unit, runs without a server): TOTP
  generate→verify round-trip (already covered in S11D — keep passing);
  MFA challenge-token creation uses `getRandomValues` (no `randomBytes`
  call remains in worker code — grep-verify zero matches).
- E2E (extend `worker/smoke.e2e.test.ts` or add `worker/mfa.e2e.test.ts`,
  following the existing e2e pattern — read it first):
  verified-password-login success returns a session (NOT an MFA challenge);
  MFA setup→confirm→login→challenge→session end-to-end; recovery code
  works once then reuse fails; Google MFA login returns 200 with
  `mfaRequired:true` (NOT 202); mailbox scoping A/B (user A cannot read
  user B's mailbox/messages); admin@aistockvn.com registration returns 409.
- Do NOT break existing tests.

## VERIFY (real output, run it yourself)
- `npx tsc -p tsconfig.worker.json`: 0 errors. `npx tsc --noEmit`: 0.
  `npm run build`: passes.
- Fresh local D1: `rm -rf .wrangler/state/v3/d1` then
  `npx wrangler d1 migrations apply aistockvn-mail --local` (must be 5/5).
- Dev server: `TOTP_ENCRYPTION_KEY=dummy-local-test-key-0123456789 npx wrangler
  dev --port 8788 --ip 127.0.0.1` (env var ONLY, never write the key to a
  file), then `SMOKE_BASE=http://127.0.0.1:8788 npx vitest run
  --isolate=false` (FULL suite). Kill dev by captured PID.
  Report REAL counts — 0 skipped expected with the dev server up.
  Run the FULL suite TWICE if the first run is flaky; report both counts.
- `grep -rn "randomBytes\|X-MFA-Challenge-Token" worker/` must print nothing.

## DELIVERABLE
Write `STATE-S11E.md` in the workdir with: files changed + sha256, the tsc
outputs (REAL error lists / 0), build output, vitest outputs (REAL tail lines
incl. test count AND skipped count, both runs if run twice), the grep-verify
output, what was NOT done. End with `ALL DONE` only when everything above
is complete and verified. If anything blocks you (a test that cannot pass, an
error you cannot fix), write the STATE file with the blocker, the exact
failing output, and what you tried — do NOT write `ALL DONE`, do NOT claim
success without the real output behind it.
