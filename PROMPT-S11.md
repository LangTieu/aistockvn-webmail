# PROMPT-S11 — Webmail OmniMail model (multi-user mailboxes + registration guards + TOTP 2FA)

Workdir on IB1: `/data/home/webmail-omnimail-model` (fresh sync of the VM clone
`~/workspace/aistockvn-webmail`, HEAD 7fb915e + uncommitted phase-1 + admin/English
fix — DO NOT revert anything, work on top).
Design (AUTHORITATIVE, read it first): `docs/omnimail-model-design.md`.
OmniMail reference repo: mibgb65-cloud/OmniMail — read its REAL code when unsure,
do not invent. Relevant files (already verified by coordinator):
`email-worker/src/features/auth/registration/registration-api.ts`,
`session/auth.ts`, `session/password-login.ts`, `features/auth/mfa/mfa.ts`,
`features/auth/mfa/mfa-api.ts`, `features/auth/mfa/mfa-cookie.ts`,
`app/routes/public-routes.ts`, `migrations/0001_initial.sql`.

## PART 1 — Multi-user mailboxes (per design §1)
- Migration 0004: rebuild `users` (id UUID PK, email UNIQUE NOCASE, display_name,
  password_hash NULLABLE, role, status, verified, created_at); new `mailboxes`
  table (address PK NOCASE, user_id FK, is_primary, is_active); `messages` +=
  `mailbox_address` TEXT backfilled `admin@aistockvn.com` for ALL existing rows.
  Pre-seed: admin@aistockvn.com (super_admin, verified=1, primary mailbox
  admin@aistockvn.com); tranbinhanbr01@gmail.com + lethanhdongus@gmail.com
  (role user, verified=1, NO mailbox row).
- `worker/mail.ts`: ingest sets `mailbox_address` from recipient lookup in
  `mailboxes` (NOCASE); no match → drop + log. R2 keys UNCHANGED.
- `worker/index.ts`: scope EVERY mail endpoint to the caller's mailboxes
  (`/api/messages`, `/api/counts`, `/api/messages/:id`, `/read`, attachments,
  raw). `/api/send`: from = caller's primary mailbox; none → 403.
- Keep HMAC `mail_session` cookie; auth middleware resolves email → user row
  (id, role) per request. No cross-mailbox admin view.

## PART 2 — Registration guards (per design §2)
- KEEP ALLOWED_EMAILS (3 fixed emails) + KEEP email verification (migration 0003,
  /api/auth/verify, verified=0, no session until verified, 403 if unverified).
- ADD: block SUPER_ADMIN_EMAIL `admin@aistockvn.com` from external registration
  → 409, checked BEFORE any verification mail is sent.
- Pre-seed makes signup for the other two emails → 409 already registered.
- Google sign-in UNCHANGED (ALLOWED_EMAILS gate, no verification).
- Do NOT add domain policy / toggle / invite mode / Turnstile.

## PART 3 — TOTP 2FA, admin-only like OmniMail (per design §3)
- New `worker/mfa.ts` (port OmniMail `features/auth/mfa/mfa.ts` logic):
  TOTP 30s/SHA-1/6-digit/±1 window; secret 20 random bytes base32; AES-GCM
  encrypt with key = SHA-256(`TOTP_ENCRYPTION_KEY`), format
  `v1.<b64url iv>.<b64url ct>`; 8 recovery codes (10 random bytes base32,
  grouped in 4s, sha256, single-use); challenge 5 min / max 5 attempts;
  rate limit 10 attempts / 15 min per (ip,user).
- Tables in migration 0004/0005: `admin_totp`, `mfa_challenges`,
  `mfa_recovery_codes`.
- Endpoints: GET /api/auth/mfa/status; POST /api/auth/mfa/setup → {secret, uri};
  POST /api/auth/mfa/confirm {code}; POST /api/auth/mfa/disable {code};
  POST /api/auth/mfa/challenge {code}. Setup/confirm/disable/status are
  ADMIN-ONLY (super_admin/admin, else 403) — only admin@ can enable 2FA.
- Login: if MFA enabled → NO session; create challenge + challenge cookie
  (`mail_mfa_challenge`, httpOnly, path /api/auth/mfa/challenge, 5 min) +
  `{mfaRequired:true}` 202; challenge endpoint completes login → session.
  Applies to BOTH password and Google login.
- `TOTP_ENCRYPTION_KEY`: read from env only; if missing/short → 503 on setup.
  NEVER write any secret value to a file. For local dev/e2e, start wrangler dev
  with a dummy value via ENV VAR ONLY
  (e.g. `TOTP_ENCRYPTION_KEY=dummy-local-test-key-0123456789 wrangler dev ...`),
  never in a file.
- Frontend (src/App.tsx, src/api.ts, English only): admin-only Settings section —
  show secret + otpauth URI with copy buttons + manual entry (NO external QR API,
  no QR lib in package.json); confirm/disable forms; login MFA challenge screen;
  recovery codes shown ONCE with copy + warning. Login screen still shows NO
  email address. App name stays "AI Stock VN Mail".

## PART 4 — Login page redesign (Henrry 08:17 18/11, same build)
- REMOVE from the login screen (verified at src/App.tsx L234-235):
  "Sign in to read and send mail." and "Sign in with an authorized Google
  account to read and send mail."
- REDESIGN ChatGPT-style (chatgpt.com login): clean minimal centered layout —
  logo/wordmark on top, simple card, minimal text, Continue + social sign-in
  style — applied to OUR login. All entry points stay present and working:
  Google sign-in button, password login form, signup, forgot password.
- FONT UNCHANGED: keep the exact current stack (src/styles.css L4
  `--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans",
  "Helvetica Neue", Arial, sans-serif;`) — same family/weights/sizes.
- Still NO email address shown anywhere on the pre-sign-in screen.
- E2E must still cover the login flows (Google button present, password
  sign-in/signup/forgot forms present and working).

## HARD RULES
- NO deploy, NO commit, NO push, NO `wrangler secret put`, NO Email Routing/DNS
  changes. Do NOT touch wrangler.jsonc vars/secrets.
- NEVER show or write any key/secret value. Dummy local-only values via env var
  only, as above.
- `npx tsc --noEmit` must be 0; `npm run build` must pass.
- Vitest ALWAYS `--isolate=false`. E2E tests need a running dev server:
  `npx wrangler d1 migrations apply aistockvn-mail --local`, then
  `wrangler dev --port 8788 --ip 127.0.0.1` (with dummy TOTP_ENCRYPTION_KEY env),
  then `SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false`.
  Kill the dev server by its captured PID when done. (Default vitest spawns
  thousands of isolate workers — never run without `--isolate=false`.)
- Update tests for the new model: multi-user scoping (user A cannot read user
  B's mail), pre-seed, admin@ signup block 409, MFA setup/confirm/challenge/
  recovery/disable, MFA challenge on login (password + Google path where
  testable), verification flow still enforced.
- Verify every claim with real command output. Do NOT invent test counts —
  report the REAL count from the vitest output.
- Write `STATE-S11.md` in the workdir with: files changed + sha256 of each,
  tsc/build/vitest outputs (paste the REAL tail lines incl. test count),
  what was NOT done / what needs a follow-up. End the file with the line
  `ALL DONE` when (and only when) everything above is complete and verified.
