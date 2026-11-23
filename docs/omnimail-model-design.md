# Webmail — OmniMail model design (18/11/2026)

Henrry Chốt 08:10–08:15 ICT 18/11: hộp thư + đăng ký + 2FA "làm giống họ".
Corrections applied: (1) verification KEPT; (3) eligibility = 3 fixed emails — correction 3
OVERRIDES correction 2 (no domain policy / toggle / invite mode).
Grounding: OmniMail mibgb65-cloud/OmniMail, read live 18/11
(registration-api.ts, registration-security.ts, session/auth.ts, password-login.ts,
mfa.ts, mfa-api.ts, mfa-cookie.ts, public-routes.ts, public-config.ts,
temporary-invite-api.ts, migrations/0001_initial.sql).

## 1. Multi-user mailboxes

- New `mailboxes` table (OmniMail 0001_initial.sql L41-48): `address` PK NOCASE,
  `user_id` FK → users(id), `is_primary`, `is_active`; index on `user_id`.
- Rebuild `users` in migration 0004: `id` UUID PK, `email` UNIQUE NOCASE,
  `display_name`, `password_hash` NULLABLE (NULL = no password set; Google sign-in
  or forgot/reset sets it), `role` (super_admin/admin/user), `status`, `verified`
  (kept from 0003), `created_at`. Prod `users` is EMPTY (verified 06:18 18/11:
  0 rows), so rebuild is safe.
- `messages`: add `mailbox_address` TEXT; backfill `admin@aistockvn.com` for ALL
  existing rows (all mail today belongs to admin@); index
  `(mailbox_address, folder, date DESC)`. R2 keys UNCHANGED (`raw/YYYY/MM/<id>.eml`,
  worker/mail.ts L79-80) — scoping is D1-only, no R2 rename/migration.
- Pre-seed (migration 0004 data): `admin@aistockvn.com` (super_admin, verified=1,
  primary mailbox `admin@aistockvn.com`); `tranbinhanbr01@gmail.com` +
  `lethanhdongus@gmail.com` (role user, verified=1, NO mailbox row yet — no
  @aistockvn.com address assigned).
- Inbound `email()`: look up `mailboxes` by recipient (NOCASE); match → ingest with
  that `mailbox_address`; no match → drop (log). Existing Email Routing rule
  admin@ → Worker UNCHANGED in this change; catch-all → Worker is a deploy-time
  step, NOT done here.
- Outbound `/api/send`: from = caller's primary mailbox address; no primary
  mailbox → 403. (Resend domain aistockvn.com is verified, so any @aistockvn.com
  from-address works; gmail from-addresses NOT allowed.)
- All read endpoints (`/api/messages`, `/api/counts`, `/api/messages/:id`, `/read`,
  attachments, raw) scoped: `mailbox_address IN (caller's mailboxes)`.
  NO cross-mailbox admin view in this change (admin reads admin@ only) — DECISION.
- Consequence (flag): tranbinhanbr01/lethanhdongus still sign in, but no longer see
  admin@ mail; they start with an empty mailbox list until admin assigns an
  @aistockvn.com address.
- Sessions: KEEP our HMAC `mail_session` cookie (worker/auth.ts) — do NOT adopt
  OmniMail server-side sessions (session/auth.ts `storeSession`). Auth middleware
  resolves email → user row (id, role) per request.

## 2. Registration (final: corrections 1+3)

- Eligibility = EXACTLY the 3 fixed emails (`ALLOWED_EMAILS` unchanged):
  tranbinhanbr01@gmail.com, lethanhdongus@gmail.com, admin@aistockvn.com.
  NO domain allowlist/blocklist, NO admin on/off toggle, NO invite mode.
  (OmniMail's toggle/domain-policy NOT adopted; its temporary-invite-api issues
  temporary @domain addresses, not invite-to-register.)
- Verification KEPT: signup → verified=0, Resend confirmation link (hashed token,
  1h, single-use), NO session until verified; password login 403 if unverified;
  re-register unverified → resend link. Migration 0003 + `email_verifications` +
  POST /api/auth/verify stay.
- ADD: block `SUPER_ADMIN_EMAIL` (admin@aistockvn.com) from external registration
  → 409 (OmniMail registration-api.ts L181-184 does exactly this). Pre-seed makes
  it 409-duplicate anyway; the explicit block runs first so no verification mail
  is ever sent for admin@.
- ADD: pre-seed the 3 users (§1) → signup for tranbinhanbr01/lethanhdongus → 409
  already registered; identities can't be squatted.
- Google sign-in UNCHANGED: gated on ALLOWED_EMAILS, no verification (ID token
  proves ownership), maps to the pre-seeded row (verified=1 already).
- How the 3 keep access: pre-seeded verified=1; Google sign-in works as today;
  password login needs a password — set via forgot/reset (reset link goes to their
  own inbox) or keep using Google.
- NOT adopted: Turnstile (OmniMail requires it for registration; we keep email
  verification + rate limits + allowlist as abuse control).

## 3. TOTP 2FA (OmniMail mfa.*)

- Tables (migration 0004/0005): `admin_totp` (user_id PK, encrypted_secret,
  enabled_at, updated_at), `mfa_challenges` (token_hash PK, user_id, channel,
  expires_at, attempts), `mfa_recovery_codes` (id PK, user_id, code_hash, used_at).
- Crypto (mfa.ts): TOTP 30s, SHA-1, 6 digits, ±1 window (L4, L68-100); secret =
  20 random bytes, base32; encrypted AES-GCM, key = SHA-256(TOTP_ENCRYPTION_KEY),
  format `v1.<b64url iv>.<b64url ct>` (L105-140); `TOTP_ENCRYPTION_KEY` ≥32 chars
  required, 503 if missing. NEW Worker secret — set via `wrangler secret put` at
  DEPLOY time (liaison step); NEVER put a value in code/repo.
- Admin-only setup like OmniMail (mfa-api.ts L13-18 `administrator()` gate:
  super_admin/admin only, else 403). Only admin@ (super_admin) can enable 2FA;
  the other two users cannot in this change — DECISION, faithful to OmniMail.
- Endpoints: GET /api/auth/mfa/status `{ready, enabled, pending,
  recoveryCodesRemaining}`; POST /api/auth/mfa/setup → `{secret, uri}`
  `otpauth://totp/<issuer>:<email>?secret&issuer&algorithm=SHA1&digits=6&period=30`,
  stores encrypted secret with enabled_at NULL (pending); POST
  /api/auth/mfa/confirm `{code}` → verify → enabled_at set + 8 recovery codes
  (returned ONCE); POST /api/auth/mfa/disable `{code}` → verify → delete rows in
  all 3 tables.
- Login: if `mfaEnabled(user)` → NO session; `createMfaChallenge` (5 min, mfa.ts
  L5) + challenge cookie (mfa-cookie.ts: `omnimail_mfa_challenge`, httpOnly, path
  /api/login/mfa, 5 min) + `{mfaRequired:true}` 202 (public-routes.ts L88-95,
  L106-130); POST /api/auth/mfa/challenge `{code}` → `completeMfaChallenge` →
  session. Applies to BOTH password and Google login when enabled.
- Recovery: 8 codes, 10 random bytes base32 grouped in 4s, sha256 hash, single-use
  (mfa.ts L169-180, L196-210); non-6-digit input tries the recovery path.
  Rate limit: 10 attempts/15 min per (ip,user) (L7-8, L213-240); challenge max
  5 attempts (L6).
- Frontend: Settings section (admin only): show secret + otpauth URI with copy
  buttons + manual entry; NO external QR API (would leak the secret).
  Confirm/disable forms; login MFA challenge screen; show recovery codes once
  with copy + warning.

## 4. What this change does NOT do

- NO deploy, NO commit, NO push. NO Email Routing/DNS changes. NO Turnstile.
- NO server-side sessions. NO cross-mailbox admin view. NO new npm deps unless
  justified (no qrcode lib in package.json today).
- Tests: update auth.test.ts + smoke.e2e.test.ts for the new model (multi-user
  scoping, pre-seed, admin@ block, MFA setup/confirm/challenge/recovery);
  vitest ALWAYS `--isolate=false`; e2e needs a running dev server.

## 5. Login page redesign (Henrry 08:17 18/11, same build)

- REMOVE these two lines from the login screen (verified present at
  src/App.tsx L234-235): "Sign in to read and send mail." and "Sign in with an
  authorized Google account to read and send mail."
- REDESIGN ChatGPT-style (chatgpt.com login): clean minimal centered layout —
  logo/wordmark on top, simple card, minimal text, Continue + social sign-in
  style — applied to OUR login. All entry points stay present and working:
  Google sign-in button, password login form, signup, forgot password.
- FONT UNCHANGED: keep the exact current stack (src/styles.css L4
  `--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans",
  "Helvetica Neue", Arial, sans-serif;`) — same family/weights/sizes, no font
  change anywhere in the redesign.
- Still NO email address shown anywhere on the pre-sign-in screen (22:49 rule).
- Verified by: build + vitest + e2e (auth flows still present and working).
