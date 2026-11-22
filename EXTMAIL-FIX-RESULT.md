# External Gmail App Password fix

## Files changed and SHA-256

- `worker/gmail.ts` — `e91be40d943c2e22ea7fe456e915b2512b9d4c7c14ab1d4370b380ef9fba2a18`
- `worker/index.ts` — `6dbc64e5518a8ec72f83fa6a522f521bbe90a247668cfc5b748aec996ca5d852`
- `src/api.ts` — `8580e002dadf4c99f54936525b91159e415134f769a4bed7739c7320a4c2ccfb`
- `worker/gmail.test.ts` — `fe4a1a714fe6fe748ec9c7d7b038e2b7a60944d81574951fdc41b2473e9d8db5`
- `worker/external-routes.test.ts` — `0af075dccbf0511f7b7d079f64597509a5363070c606fcb301aac9e700fcfa4b`

## Verification

- `npx tsc --noEmit` — passed (exit code 0).
- `npx vitest run --exclude worker/smoke.e2e.test.ts` — passed: 36 test files, 353 tests.

## User-facing error messages

Invalid App Password (400):

> Enter the 16-character App Password Google generated (Google Account > Security > 2-Step Verification > App passwords), not your regular Gmail password.

Gmail rejected sign-in (`gmail_auth_failed`):

> Gmail rejected the sign-in. Create a fresh 16-character App Password in Google Account > Security > 2-Step Verification > App passwords, then try again.
