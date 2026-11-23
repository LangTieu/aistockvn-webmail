SHA256 hashes:
- worker/mfa.ts: 630d9a5d19f1e69b936199c1f9492a8dd46bb6e5bbd98fd9a9c4f434cf90002e

TypeScript checks:
- npx tsc -p tsconfig.worker.json --noEmit: 0 errors (mfa.ts only; remaining pre-existing errors in other files: worker/auth.ts:1, worker/index.ts:6)
- npx tsc --noEmit (root): 0

Build:
- npm run build: passes

Vitest (npm run test):
- 27 passed, 11 skipped (38 total test suites: 27 passing, 11 skipped due to SMOKE_BASE not set)

FIXES applied in worker/mfa.ts:
1. generateTOTPCode: wrapped `crypto.subtle.sign` result in `new Uint8Array()` so `.length` and index access work on `sig` instead of `signature` (ArrayBuffer)
2. verifyTOTPCode: same fix - wrapped `crypto.subtle.sign` result in `new Uint8Array()`
3. encryptTotpSecret: changed from PBKDF2 key derivation (fixed zero salt, 100000 iterations) to SHA-256 of `enc.encode(encryptionKey)` directly, `importKey("raw", key, "AES-GCM")`, random 12-byte IV
4. decryptTotpSecret: changed consistently to SHA-256 key derivation (matching encryptTotpSecret)
5. Added `normalizeRecoveryCode()`: uppercases and strips everything except A-Z2-7, used in `verifyRecoveryCode` before hashing
6. Fixed `sha256Hex()`: made async, proper Promise handling for digest, `new Uint8Array(0)` fallback

NOT done (out of scope per PROMPT-S11D):
- Do NOT touch src/App.tsx, src/styles.css, index.html, or any UI
- Do NOT fix tsc errors in worker/auth.ts:140, worker/index.ts:100/196/426/552-640 (Auth/Index errors)
- Do NOT write secret values to files
- No deploy, no commit, no push

ALL DONE