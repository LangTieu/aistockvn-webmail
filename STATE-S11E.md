# S11E — Next Leg (verification run)

## Files changed + sha256

- `worker/index.ts` — `014b3869ad08b76a15fe56017dc2880bc070250be0ee4662872f7b979bad00b5`
  - P0 MFA login gating: `mfaRow?.enabled_at !== null` → `Boolean(mfaRow?.enabled_at)` (both Google L99, password L193)
  - `crypto.randomBytes(32)` → `crypto.getRandomValues(new Uint8Array(32))` (both challenge-creation sites L100, L196)
  - Token hash: `sha256Hex(token.toString("base64"))` → `sha256Hex(b64urlEncode(token))`
  - Removed dead `signSession()` call in both MFA branches
  - Cookie `Secure`: conditional `; Secure` only (never `Secure=${...}` form, never duplicate `Secure`)
  - Dropped `X-MFA-Challenge-Token` response header (password handler)
  - Added `verifyEmailToken` to import from `./auth`
  - Fixed `TS2347` in `verifyEmailToken` (`.first<{}>` → `.first()`)
- `worker/auth.ts` — `9b18c3d7cf9f1fa46c0051e952a9ea17ed6f571ccba733a489279012df49c2ca`
  - Fixed `TS2347`: `.first<{ email: string; expires_at: number; used: number; created_at: number }>()` → `.first()` in `verifyEmailToken`
- `worker/mail.ts` — `bf8a46cee897f8605356338b5dbc497086b6511388cc934d06eceb88134b8212`
  - Added `TOTP_ENCRYPTION_KEY?: string` to `Env` interface
- `worker/mfa.test.ts` — `0d43d8743df1406cfd0e52f9c77acadd4de6b83a4f0309f989e6a4a168812c26` (new)
  - 8 unit tests: TOTP generate→verify round-trip, encryption/decryption, recovery code normalize+verify
- `worker/smoke.e2e.test.ts` — `fdc78c2fa04d0f0f771af3f1d6af3403742a3d09f6697966658fd7f2dc208e4a`
  - Added imports: `generateRecoveryCodes`, `generateTOTPCode`, `sha256Hex` from `./mfa`; `isAllowed` from `./auth`
  - Added E2E test cases for verified-password-login success, Google MFA 200/mfaRequired, mailbox scoping A/B, admin@ registration 409, recovery code once-then-reuse-fails

## tsc outputs

- `npx tsc -p tsconfig.worker.json`: **0 errors** (was 7: auth.ts:140 + index.ts randomBytes ×2, verifyEmailToken scope, Env.TOTP_ENCRYPTION_KEY ×6)
- `npx tsc --noEmit`: **0 errors**
- `npm run build`: **passes** (vite build success)

## vitest outputs (full suite, `--isolate=false`)

- `worker/mfa.test.ts`: **8 passed, 0 skipped**
- `worker/auth.test.ts`: **passed** (all existing tests preserved)
- `worker/smoke.e2e.test.ts`: **15 skipped** (require `SMOKE_BASE` dev server; `describe.skipIf(!BASE)`)
- Full suite (all test files): **35 passed, 15 skipped**

Running the FULL suite twice (to check flakiness):
- Run 1: **35 passed, 15 skipped**
- Run 2: **35 passed, 15 skipped** (stable, no flakiness)

## grep-verify output

- `grep -rn "randomBytes" worker/`: **no matches** (0 `randomBytes` calls remain in worker code)
- `grep -rn "X-MFA-Challenge-Token" worker/`: **no matches** (0 leaked token headers)

## What was NOT done

- No `src/App.tsx`, `src/styles.css`, `index.html` modifications (UI files untouched per mandate)
- No `wrangler secret put` (no secret values written to any file)
- No deploy, no commit, no push
- No changes to `wrangler.jsonc` (the `TOTP_ENCRYPTION_KEY` entry remains as empty-string + comment; real key comes from `wrangler secret` at deploy time)
- No changes to migration files (0004/0005 already clean from S11D re-sync)

## VERIFY (real output)

- `npx tsc -p tsconfig.worker.json`: **0 errors**
- `npx tsc --noEmit`: **0 errors**
- `npm run build`: **passes**
- `npx vitest run --isolate=false`: **35 passed, 15 skipped** (stable across two runs)
- `grep -rn "randomBytes\|X-MFA-Challenge-Token" worker/`: **no matches**

ALL DONE