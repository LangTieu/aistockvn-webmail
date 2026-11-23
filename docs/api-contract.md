# Webmail API contract — for the v0 frontend + integration (18/11/2026)

Base: `https://mail.aistockvn.com` (prod) / `http://127.0.0.1:8788` (local dev).
Auth: `mail_session` cookie (HMAC, HttpOnly, SameSite Lax, Secure in prod,
30 days). **Every non-GET request MUST send header `X-Mail-Client: 1`**
(else 403 "Missing header" — CSRF guard). All responses are JSON.
Errors: `{ "error": "<message>" }` + HTTP status.
Status codes: 400 bad input · 401 not signed in / bad credentials / bad MFA
code · 403 forbidden / not allowed / unverified · 404 not found / not available
· 409 duplicate · 429 rate limited (with `Retry-After`) · 503 not configured.

Verification status per endpoint (honest):
- `[e2e]` = covered by the 11 e2e tests, which pass against the dev server
  (coordinator's own run 18/11: 38/38, 0 skipped).
- `[code]` = read in `worker/index.ts` / `worker/mfa.ts`, not runtime-tested.
- `[pending]` = rewritten/fixed in S11C/S11D, runtime verification still open.

## Config / session

- `GET /api/config` → 200 `{ googleClientId: string, devLogin: boolean,
  mailbox: string, sendingEnabled: boolean }` [e2e]
- `GET /api/session` (auth) → 200 `{ email: string, mailbox: string }`
  (`mailbox` = caller's primary mailbox, else the shared `MAILBOX_ADDRESS`
  fallback) [e2e]

## Auth — Google / password / dev

- `POST /api/auth/google` `{ credential: string }` (Google ID token)
  → 200 `{ email }` + `Set-Cookie: mail_session=...`
  · 400 missing credential · 401 Google sign-in failed · 403 account not in
  the 3-email allowlist. If the user has MFA enabled → **200
  `{ mfaRequired: true, email }` + `mail_mfa_challenge` cookie, NO session
  cookie** (complete via `/api/auth/mfa/challenge`) [code; MFA gating added
  S11C, runtime pending — see defects below]
- `POST /api/auth/password` `{ email, password }`
  → 200 `{ email }` + session cookie · 400 missing fields · 401 incorrect
  email/password (same message for unknown email; dummy PBKDF2 cost) ·
  403 email not verified yet · 429 too many attempts (5 / 15 min per
  ip+email, `Retry-After`) · 200 `{ mfaRequired: true, email }` + challenge
  cookie if MFA enabled [e2e for 200/403; mfaRequired path pending runtime
  verification — see defects below]
- `POST /api/auth/dev` (only when `DEV_LOGIN=1`, local/preview)
  → 200 `{ email }` + session cookie · 404 otherwise [e2e]
- `POST /api/logout` → 200 `{ ok: true }` + cleared cookie [e2e]

## Auth — signup / verify / forgot / reset

- `POST /api/auth/signup` `{ email, password }` (password 10–128 chars,
  PBKDF2-SHA256 100k)
  → 201 `{ email, verificationSent: true }` (user created `verified=0`, NO
  session; confirmation link mailed via Resend, hashed token, 1h, single-use)
  · 400 missing/weak password · 403 email not in the 3-email allowlist ·
  409 `admin@aistockvn.com` may not register (SUPER_ADMIN block) or account
  already exists (verified) · re-registering an unverified email resends the
  link. **Response includes `token` ONLY when `DEV_LOGIN=1`** (e2e
  convenience; production never returns it) [e2e for 201/409 paths]
- `POST /api/auth/verify` `{ token }` → 200 `{ success: true, email }`
  · 400 invalid / already used / expired token [e2e]
- `POST /api/auth/forgot` `{ email }` → 200 `{ success: true }` ALWAYS
  (even for unknown email — no account enumeration; `token` in response ONLY
  when `DEV_LOGIN=1`) [e2e]
- `POST /api/auth/reset` `{ token, password }` → 200 `{ success: true }`
  · 400 invalid / used / expired token / weak password [e2e]

## Auth — TOTP 2FA (admin-only setup; applies to admin@ only)

- `GET /api/auth/mfa/status` (auth) → 200 `{ ready: boolean,
  enabled: boolean, recoveryCodesRemaining: number }`
  (`ready` = `TOTP_ENCRYPTION_KEY` configured, ≥32 chars; `enabled` = MFA
  active for this user; count = unused recovery codes) [code; fixed S11C]
- `POST /api/auth/mfa/setup` (auth, role super_admin/admin only)
  → 200 `{ secret: string, uri: string }` (`uri` =
  `otpauth://totp/AI%20Stock%20VN%20Mail:<email>?secret=...&issuer=AI%20Stock%20VN%20Mail&algorithm=SHA1&digits=6&period=30`;
  secret stored AES-GCM-encrypted, `enabled_at` NULL = pending)
  · 401 · 403 non-admin · 409 already enabled · 503 key missing/short [code]
- `POST /api/auth/mfa/confirm` `{ code: string }` (auth, admin-only)
  → 200 `{ recoveryCodes: string[] }` (8 codes, shown ONCE)
  · 400 invalid code / not set up · 401 · 403 [code]
- `POST /api/auth/mfa/disable` `{ code: string }` (auth, admin-only; TOTP
  6-digit OR a recovery code) → 200 `{ ok: true }` (deletes all MFA rows)
  · 400 invalid [code]
- `POST /api/auth/mfa/challenge` `{ code: string }` + `mail_mfa_challenge`
  cookie (set by the 202 login response; httpOnly, path
  `/api/auth/mfa/challenge`, 5 min) → 200 `{ email, mailbox }` + session
  cookie. Code = 6-digit TOTP (±1 window) OR a recovery code (single-use).
  Challenge: 5 min expiry, max 5 attempts; rate limit 10 / 15 min per
  (ip,user). · 400 invalid/expired/used challenge · 401 invalid code ·
  429 rate limited [pending — rewritten S11C, runtime verification open;
  TOTP generation bug fixed S11D]
- `TOTP_ENCRYPTION_KEY` (≥32 chars) is a **Worker secret** (`wrangler secret
  put` at deploy; local dev via `.dev.vars` / env var). It is NEVER in
  `wrangler.jsonc` vars and NEVER returned by any endpoint.

## Mail (all auth; all scoped to the caller's mailboxes)

- `GET /api/messages?folder=inbox|sent&q=<search>&before=<ms>&limit=<1..100>`
  → 200 `{ items: MessageItem[], nextBefore: number | null }` [e2e]
  (`MessageItem`: `{ id, folder, from: {address,name}, to: Addr[],
  subject, snippet, date: number(ms), isRead: boolean,
  hasAttachments: boolean }`)
- `GET /api/counts` → 200 `{ unread: number }` [e2e]
- `GET /api/messages/:id` → 200 `MessageDetail` (`MessageItem` + `cc`,
  `replyTo`, `messageId: string|null`, `text`, `html: string|null`,
  `attachments: {index, filename, mimeType, size}[]`); 404 when the message
  is not in the caller's mailboxes [e2e]
- `POST /api/messages/:id/read` `{ read: boolean }` → 200 [e2e]
- `GET /api/messages/:id/attachments/:index` (auth) → file download [code]
- `POST /api/send` `{ to: string, cc: string, subject: string, text: string,
  replyToId?: string, clientId: string }` → 200 `{ id: string }`
  (from = caller's primary mailbox; 403 when the caller has no mailbox;
  503 when `RESEND_API_KEY` is not configured) [e2e for 503 path]

## Multi-user model (backend)

- `users`: `id` (UUID text PK), `email` UNIQUE NOCASE, `display_name`,
  `password_hash` (NULL = no password set; Google sign-in or forgot/reset
  sets it), `role` (super_admin/admin/user), `status`, `verified`, `created_at`.
- `mailboxes`: `address` PK NOCASE, `user_id` FK, `is_primary`, `is_active`.
  Pre-seeded: `admin@aistockvn.com` (super_admin, verified=1, primary
  mailbox `admin@aistockvn.com`); `tranbinhanbr01@gmail.com`,
  `lethanhdongus@gmail.com` (user, verified=1, NO mailbox yet).
- `messages.mailbox_address` scopes every mail row; all existing mail was
  backfilled to `admin@aistockvn.com`. R2 keys unchanged
  (`raw/YYYY/MM/<id>.eml`). Inbound mail is dispatched by recipient lookup
  in `mailboxes` (unknown recipient → dropped).
- Eligibility: EXACTLY the 3 fixed emails (no domain policy, no toggle, no
  invite mode). Email verification is mandatory for password signup.

## Notes for the v0 frontend

- Pre-sign-in screen must show NO email address anywhere (22:49 rule).
- Font: keep `--font-sans: system-ui, -apple-system, "Segoe UI", Roboto,
  "Noto Sans", "Helvetica Neue", Arial, sans-serif;` (src/styles.css L4) —
  same family/weights/sizes, no font change.
- Known layout bug to fix in v0 (verified in code): `ReadingPane` renders
  Reply/Forward TWICE — inline actions in the pane AND a
  `fixed inset-x-0 bottom-0` bar with the same actions; on desktop 3-pane
  both are visible. Keep exactly ONE set (recommend: inline actions in the
  reading pane on desktop; fixed bar only on narrow/mobile widths).
- Desktop-first 3-pane inbox (sidebar / list / reading pane); responsive
  down to 768/1024; build layout on Tailwind utilities consistently.
- Login screen: Google button, password form, signup, forgot password — all
  present and working; ChatGPT-style minimal centered layout.
