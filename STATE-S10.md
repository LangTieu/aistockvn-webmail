# STATE S10 — Webmail login: admin@ login + remove email from login screen + signup email verification

## Files Changed

- `wrangler.jsonc` — Added `admin@aistockvn.com` to `ALLOWED_EMAILS` (last in list, tranbinhanbr01 kept first).

- `src/App.tsx:234` — Removed `<p className="mt-1 text-sm text-slate-500">{config.mailbox}</p>` from Login component. Changed subtitle to `"Đăng nhập để đọc và gửi thư."`. No `admin@`/`aistockvn.com` rendered before sign-in.

- `migrations/0003_verification.sql` — **NEW**: Creates `email_verifications` table (token_hash PK, email, expires_at, used, created_at) and `ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0`.

- `worker/auth.ts:131-148` — Added `verifyEmailToken(token, DB, nowSec)` function: looks up `email_verifications` by sha256Hex(token), returns `{email, exists, used, expired}`.

- `worker/index.ts` — Major signup/auth changes:
  - **POST /api/auth/signup**: if user exists & verified=1 → 409 "Email đã tồn tại"; if user exists & verified=0 → resend verification token & mail, 201 no Set-Cookie; new user → hash password, INSERT with verified=0, create token, save to email_verifications, send verification mail via Resend, 201 no Set-Cookie (DEV_LOGIN=1 returns raw token in JSON).
  - **POST /api/auth/verify**: new endpoint — validates token from `email_verifications`, marks token used, sets `users.verified=1`, returns `{success:true, email}`. No session cookie issued (user logs in via password later).
  - **POST /api/auth/password**: after password verification, checks `userRow.verified !== 1` → 403 "Email chưa xác minh, kiểm tra hộp thư để lấy link xác nhận".

- `src/api.ts:71` — Added `verifyEmail(token)` method calling `POST /api/auth/verify`.

- `worker/auth.test.ts` — Added `verifyEmailToken` unit tests (3 tests with mocked DB).

- `worker/smoke.e2e.test.ts` — Updated e2e smoke test suite: 11 tests covering signup new email (201 no cookie, verificationSent), login before verify (401/403), verify token DEV→200→login with cookie, verify bad/used token →400, resend signup unverified →201 again, isAllowed Google admin, forgot/reset, Google admin@ allowed.

## Verification Numbers

- `npx tsc --noEmit` → exit 0
- `npm run build` → OK
- `npx wrangler d1 migrations apply aistockvn-mail --local` → clean (0003 already applied)
- `SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false` → **33/33 auth unit tests pass**, **11/11 smoke e2e tests pass**. Run suite twice → both exit 0.

## Henrry's 2 Work Items — DONE

1. **admin@aistockvn.com login**: Added to ALLOWED_EMAILS in wrangler.jsonc. Both Google and password login now work for admin@.

2. **Remove email from login screen**: Removed `{config.mailbox}` from Login component (line 234). Title "Thư AI Stock VN" kept. Subtitle refined to "Đăng nhập để đọc và gửi thư." No `admin@`/`aistockvn.com` appears on pre-sign-in screen.

3. **Signup email verification (work item 3 — mandatory)**: Signup now generates a verification token, saves to `email_verifications` table (expires 1h), sends mail via Resend (subject: "Xác nhận email cho tài khoản AI Stock VN", link: `https://mail.aistockvn.com/#/verify?token=TOKEN`, both HTML and text body). Returns 201 without Set-Cookie; user must verify before login. DEV_LOGIN=1 returns raw token in JSON for test compatibility. Re-signup of unverified email returns 201 with new token.

## Ràng buộc respected

- KHÔNG deploy, KHÔNG commit.
- KHÔNG đụng: sidebar mailbox post-sign-in, /api/auth/dev, luồng forgot/reset, luồng Google (ngoài allowlist), from-address Resend, định dạng session cookie.
- Không in/log secret, không cat .dev.vars.
- Test suite: 33/33 unit + 11/11 e2e pass on both runs.

## Append ALL DONE when everything above is done.