# PROMPT-S11D — Fix TOTP runtime bug in worker/mfa.ts + unit tests (BACKEND ONLY)

Workdir on IB1: `/data/home/webmail-omnimail-model`. Do NOT touch src/App.tsx,
src/styles.css, index.html, or any UI. NO deploy, NO commit, NO push,
NO `wrangler secret put`. NEVER write a secret value to a file.

## THE BUG (verified by coordinator reading the code)
`crypto.subtle.sign` returns a `Promise<ArrayBuffer>`. In `worker/mfa.ts`
both `generateTOTPCode` and `verifyTOTPCode` do:
`const signature = await crypto.subtle.sign(...);`
`const offset = signature[signature.length - 1] & 0x0f;`
`const truncated = signature.slice(offset, offset + 4);`
`truncated[0]`, `truncated[1]`...
An ArrayBuffer has NO `.length` and NO index access, so `signature.length`
is `undefined`, every byte reads as `undefined`, and the TOTP code is ALWAYS
`"000000"`. MFA is functionally broken: setup confirm and login challenge only
ever accept "000000". (OmniMail's original wraps the digest in
`new Uint8Array(...)` — mfa.ts L~80 in the reference.)

## FIX (worker/mfa.ts only, plus tests)
1. In BOTH `generateTOTPCode` and `verifyTOTPCode`, wrap the digest:
   `const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBuf));`
   then use `sig[sig.length - 1]`, `sig.slice(offset, offset + 4)`,
   `truncated[0..3]` (truncated is now a Uint8Array, indexable).
2. `encryptTotpSecret`: derive the AES-GCM key as SHA-256 of the encryption
   key per the design (OmniMail mfa.ts): `key = SHA-256(enc.encode(
   encryptionKey))`, `importKey("raw", key, "AES-GCM")`, random 12-byte IV,
   format `v1.<base64url iv>.<base64url ciphertext>`. Do NOT use PBKDF2 with
   a fixed zero salt (current code) — change both encrypt and decrypt to the
   SHA-256 form so round-trip works. Keep `decryptTotpSecret` consistent.
3. Recovery codes: normalize (uppercase, strip everything except A-Z2-7)
   BEFORE hashing and BEFORE comparing (OmniMail `normalizeRecoveryCode`), so
   a code typed with or without dashes works.
4. Fix the mfa.ts-only tsc errors reported by
   `npx tsc -p tsconfig.worker.json --noEmit` (ArrayBuffer indexing,
   `salt` in importKey algorithm, digest argument type). The OTHER worker
   errors (auth.ts:140, index.ts randomBytes/verifyEmailToken/Env
   TOTP_ENCRYPTION_KEY) are OUT OF SCOPE for this run — list them as remaining,
   do not fix them here.

## TESTS (required — none exist for MFA today)
- New `worker/mfa.test.ts` (or extend `worker/auth.test.ts`): TOTP
  generate→verify round-trip (generated code verifies true; wrong code
  false); two different timestamps give different codes; generated code is
  6 digits and NOT always "000000" (regression test for this bug);
  encrypt→decrypt round-trip returns the original secret; recovery-code
  normalize + hash + single-use consume.
- Do NOT break existing tests.

## VERIFY (real output)
- `npx tsc -p tsconfig.worker.json --noEmit`: mfa.ts errors must be 0
  (paste the remaining pre-existing errors in other files, if any).
- `npx tsc --noEmit` (root) = 0; `npm run build` passes.
- Dev server: `TOTP_ENCRYPTION_KEY=dummy-local-test-key-0123456789 npx wrangler
  dev --port 8788 --ip 127.0.0.1` (env var ONLY), then
  `SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false`
  (FULL suite). Kill dev by captured PID. Report REAL counts — 0 skipped
  expected with the dev server up.
- Write `STATE-S11D.md` with: files changed + sha256, tsc/build/vitest outputs
  (REAL tail lines incl. test count AND skipped count), what was NOT done.
  End with `ALL DONE` only when everything above is complete and verified.
