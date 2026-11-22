# PROMPT-S11F — Fix verifyPassword 401 bug + make MFA e2e tests real (BACKEND ONLY)

Workdir on IB1: `/data/home/webmail-omnimail-model`. Do NOT touch src/App.tsx,
src/styles.css, index.html, or any UI. NO deploy, NO commit, NO push,
NO `wrangler secret put`. NEVER write a secret value to a file.
Read first: `STATE-S11E-VERIFY.md` (the full S11E verification record — it has
the exact failure and every gap listed below), `STATE-S11E.md`,
`docs/omnimail-model-design.md`, `docs/api-contract.md`,
`worker/auth.ts` (the bug), `worker/smoke.e2e.test.ts` (the failing/stub
tests), `worker/mfa.test.ts`.

## CONTEXT (verified by the coordinator, real output)
- S11E static fixes are DONE and verified, do NOT regress them:
  `npx tsc -p tsconfig.worker.json` 0 errors, root tsc 0, build passes,
  P0 fix `Boolean(mfaRow?.enabled_at)` at worker/index.ts L99 (Google) and
  L194 (password), `getRandomValues(new Uint8Array(32))` at L101/L196,
  grep `randomBytes|X-MFA-Challenge-Token` clean, fresh local D1 5/5,
  worker/mfa.ts S11D TOTP fix intact, UI untouched, wrangler.jsonc TOTP key
  still `""` + comment.
- S11E's STATE-S11E.md ends `ALL DONE` but that claim is NOT earned: the leg
  NEVER ran the server-backed suite (its STATE reports 35 passed / 15 skipped,
  no SMOKE_BASE). Do NOT trust it. The suite must go green WITH the dev server.
- Full vitest WITH dev server (fresh D1, run twice, identical):
  **1 failed | 49 passed (50), 0 skipped.** Failing test:
  `password login verified success returns session not mfa challenge`
  (smoke.e2e.test.ts:185) — expected 200, got 401.

## FIX 1 — pre-existing verifyPassword bug (the 401 root cause, NOT from S11E)
`worker/auth.ts` `verifyPassword` calls `crypto.subtle.deriveKey(..., false,
["sign"])` (~L235-241) and then `crypto.subtle.exportKey("raw", derivedKey)`
(~L242). A non-extractable key cannot be exported — it throws
`InvalidAccessException: key is not extractable`. `hashPassword` uses `true`.
The login handler catches the throw → `passwordValid=false` → **401 for EVERY
password login, even correct ones**. Proven by the verifier twice (temp vitest
round-trip + live forgot→reset→login still 401 after the token was marked
used=1). Fix: change that `deriveKey` extractable flag `false` → `true`.
Add a hash→verify round-trip unit test (hashPassword then verifyPassword
returns true; wrong password returns false). No existing test covers this —
that is why the suite never caught it.

## FIX 2 — the failing e2e test uses an impossible login
The test logs in as `admin@aistockvn.com` / "adminpassword", but migration
0004 seeds admin@ with `password_hash = NULL`, so that login can NEVER return
200 on fresh D1. Change the test to a real signup→verify→login flow: sign up
a new allowlisted user via the API, verify it (use the verification flow the
API provides — read how the existing e2e tests handle verification; on fresh
local D1 you may read the token from D1 directly in the test), then log in
and assert 200 + a session (NOT an MFA challenge). This test is also the live
proof of the S11E P0 fix — it must pass for real.

## FIX 3 — make the MFA e2e tests real (read the file, do not just count)
- "MFA setup confirm login challenge session e2e" is a STUB (setup only,
  "skip for now" comment, zero assertions after setup). Drive it end-to-end:
  setup → confirm → login → challenge → session, with real assertions.
- "Google MFA login returns 200 with mfaRequired true" asserts only
  status ∈ [200,401,403]. Assert EXACTLY 200 and `mfaRequired:true`.
- "recovery code works once then reuse fails" never calls any recovery
  endpoint. Drive it against the real endpoint: use a recovery code once
  (success), reuse the same code (must fail).
- 4 DEV tests start with `if (typeof env === "undefined" …) return;` —
  `env` is undefined in vitest, so they return immediately (0ms) and pass
  vacuously. Remove the guard or wire env properly so they actually execute.
- Add the MISSING tests: mailbox scoping A/B (user A cannot read user B's
  mailbox/messages) and a dedicated admin@aistockvn.com registration 409 test
  (a live probe already showed signup admin@ → 409 "Account already exists";
  make it a test).

## KEEP GREEN
- `npx tsc -p tsconfig.worker.json` 0 errors, `npx tsc --noEmit` 0,
  `npm run build` passes, fresh local D1 5/5,
  grep `randomBytes|X-MFA-Challenge-Token` in worker/ prints nothing.
- Do NOT break existing tests. The 8 `worker/mfa.test.ts` unit tests are real
  and pass — keep them passing.

## VERIFY (real output, run it yourself)
- `npx tsc -p tsconfig.worker.json`: 0. `npx tsc --noEmit`: 0.
  `npm run build`: passes.
- Fresh local D1: `rm -rf .wrangler/state/v3/d1` then
  `npx wrangler d1 migrations apply aistockvn-mail --local` (must be 5/5).
- Dev server: `TOTP_ENCRYPTION_KEY=dummy-local-test-key-0123456789 npx wrangler
  dev --port 8788 --ip 127.0.0.1` (env var ONLY, never write the key to a
  file), then `SMOKE_BASE=http://127.0.0.1:8788 npx vitest run
  --isolate=false` (FULL suite). Kill dev by captured PID; leave NO process
  running afterwards. Report REAL counts — require **0 failed AND 0 skipped**.
  Run the FULL suite TWICE; report both counts (they must match).
- Live probes against your dev server (fresh D1): signup→verify→login
  returns a session (the P0 fix proven live); MFA-enabled login returns 200
  `mfaRequired:true`, then challenge→session works.

## DELIVERABLE
Write `STATE-S11F.md` in the workdir with: files changed + sha256, the tsc
outputs (REAL), build output, vitest outputs (REAL tail lines incl. test
count AND skipped count, BOTH runs), the live-probe results, what was NOT
done. End with `ALL DONE` only when the FULL suite is 0 failed, 0 skipped
with the dev server up, twice, AND the live probes pass. If anything blocks
you, write the STATE file with the blocker, the exact failing output, and what
you tried — do NOT write `ALL DONE`, do NOT claim success without the real
output behind it.
