# Email/password sign-in + sign-up — webmail aistockvn-webmail (S8)

## Context
Repo: /data/home/webmail-password-auth — synced to the deployed state
(Worker version fde75fa6, live at https://mail.aistockvn.com).
Current auth is Google-only: worker/auth.ts verifies Google ID tokens (RS256
via JWKS), isAllowed() checks a comma-split ALLOWED_EMAILS allowlist,
session = HMAC mail_session cookie, TTL 30 days. src/App.tsx Login has only
a "Sign in with Google" button. ALLOWED_EMAILS is now
"tranbinhanbr01@gmail.com,lethanhdongus@gmail.com"; mailbox stays
admin@aistockvn.com. A previous attempt to add guidance text is DEAD — do
not do it. This feature replaces it.

Reference design (screenshot from the owner): Numes login (auth.numes.ai) —
Email + Password fields, "Forgot password?" link, "Sign in" button, OR
divider, "Continue with Google" below. Vietnamese UI.

## Task

### 1. Frontend — src/App.tsx Login + src/api.ts
- Login card (Vietnamese labels): "Email", "Mật khẩu", "Quên mật khẩu?",
  "Đăng nhập", "Đăng ký", "hoặc", "Tiếp tục với Google".
- Email + Password fields, "Quên mật khẩu?" link, "Đăng nhập" button.
- Below an "hoặc" divider: the existing "Sign in with Google" button.
  The GIS flow is UNTOUCHED — do not modify the Google button code path.
- Sign in / Sign up toggle on the same card. Sign up mode: Email +
  Password + "Nhập lại mật khẩu" (confirm). NO Apple, NO GitHub, NO passkey.
- Forgot flow: clicking "Quên mật khẩu?" shows an email input + send button;
  after sending, show a "check your email" message. The SPA handles
  #/reset?token=... (hash routing — read App.tsx to see how routes work)
  and shows a new-password + confirm form that calls the reset route.
- Show clear error messages from the API (wrong password, email not
  authorized, duplicate account, account locked, weak password).
- Keep the existing card styling/layout; mobile-first (phone is the main client).

### 2. Worker — worker/auth.ts, worker/index.ts, migrations/0002_users.sql
- New tables in migrations/0002_users.sql:
  - users(email TEXT PRIMARY KEY, password_hash TEXT NOT NULL,
    salt TEXT NOT NULL, created_at INTEGER NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER)
  - password_resets(token_hash TEXT PRIMARY KEY, email TEXT NOT NULL,
    expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL)
- Password hashing: PBKDF2-HMAC-SHA256, 100,000 iterations, 32-byte random
  salt from crypto.getRandomValues, via crypto.subtle. Store salt + hash
  (hex or base64 — pick one, be consistent). NEVER store or log plaintext
  passwords. NEVER log tokens, hashes, or the SESSION_SECRET.
- New routes in worker/index.ts (read the existing route table first):
  - POST /api/auth/password {email, password} → on success issue the SAME
    HMAC mail_session cookie as Google sign-in (reuse the existing cookie
    function in auth.ts) so the rest of the app works unchanged.
    Unknown email and wrong password return the SAME generic 401
    ("Email hoặc mật khẩu không đúng") — do not reveal whether the account exists.
    Rate limit: each failed login increments failed_attempts; at 5 failures
    set locked_until = now + 15 minutes; while locked, return 423 (or 401
    with a "locked, try later" message); successful login resets
    failed_attempts to 0 and clears locked_until.
  - POST /api/auth/signup {email, password} → ONLY emails in ALLOWED_EMAILS
    may sign up (reuse isAllowed()); other emails get a clear 403
    "email not authorized" error. Password minimum 8 chars. Duplicate email
    → 409 error. On success create the user row (hash+salt) and issue the
    session cookie (log the user in directly).
  - POST /api/auth/forgot {email} → if the email has an account, create a
    reset token (32 random bytes, store its SHA-256 hash, expires_at = now
    + 1 hour, used = 0) and send a reset link via the existing Resend setup
    (read worker/mail.ts + index.ts /api/send for the Resend call pattern;
    from admin@aistockvn.com, link https://mail.aistockvn.com/#/reset?token=<raw-token>).
    ALWAYS return success even if the email has no account (do not reveal
    account existence). NOTE: in local dev RESEND_API_KEY is NOT set
    (.dev.vars has only SESSION_SECRET + DEV_LOGIN; /api/send returns 503
    without the key), so the route must still create the token row and
    return success when sending is unavailable; for the e2e test you may
    return the raw token in the forgot JSON response ONLY when
    DEV_LOGIN === "1" (dev/test only, NEVER in production) so the test can
    complete the reset flow — the production path sends the token only by email.
  - POST /api/auth/reset {token, password} → hash the token, look it up:
    must exist, not used, not expired; then set the user's new password
    (new salt + hash), mark the token used (single-use), reset
    failed_attempts/locked_until. Invalid/expired/used token → 400 error.
- Google sign-in allowlist behavior UNCHANGED. Password users' emails are
  allowlist-only (enforced at signup), so the existing session verification
  should work unchanged — confirm by reading auth.ts.

### 3. Tests
- Extend worker/auth.test.ts: hash/verify round-trip; wrong password
  rejected; non-allowlisted signup rejected; duplicate signup rejected;
  lockout after 5 failures (and login blocked while locked; allowed after
  expiry — simulate by manipulating locked_until in the test DB);
  reset token expiry (expired token rejected) and single-use (second use
  rejected).
- Extend worker/smoke.e2e.test.ts: signup → sign in → session cookie works
  → mailbox loads (GET /api/messages with cookie → 200); wrong password
  → 401; forgot → 200 (and a reset row exists); reset with the token
  (use the DEV_LOGIN-only token in the forgot response) → sign in with the
  new password works.
- ALL existing 18 tests must still pass. New tests must pass too.

## Verification (do all of this before finishing)
1. `npx wrangler d1 migrations apply aistockvn-mail --local` — must apply cleanly.
2. `npx wrangler dev --ip 127.0.0.1 --port 8788` in background (capture PID;
   NEVER `pkill -f "wrangler dev"` in a command containing that literal —
   it self-matches and kills your own shell; kill by captured PID).
   Ready when GET /api/messages → 401 without a cookie.
3. `npx tsc --noEmit` → exit 0.
4. `npm run build` → OK.
5. `SMOKE_BASE=http://127.0.0.1:8788 npx vitest run` → all tests pass.
   If the default run is very slow (isolate spawns thousands of workers),
   use `--isolate=false` and note it in STATE-S8.md.
6. Stop the dev server by PID when done.
7. Write STATE-S8.md in the workdir with: files changed, new routes +
   tables, verification numbers (typecheck exit code, build result, test
   counts: X passed / Y total), and anything you could NOT verify.
   When everything above is done, append the line `ALL DONE` to STATE-S8.md
   and stop.

## Rules
- Never read, print, or copy .dev.vars (it holds SESSION_SECRET). Use it
  only via wrangler dev. Never put the Resend key, SESSION_SECRET, tokens,
  hashes, or passwords in code, logs, test output, or STATE-S8.md.
- Never deploy, never commit, never push. Work only in this workdir.
- Read the existing code first (worker/auth.ts, worker/index.ts,
  worker/mail.ts, src/App.tsx, src/api.ts, migrations/0001_init.sql,
  worker/auth.test.ts, worker/smoke.e2e.test.ts, wrangler.jsonc) — do not
  guess the existing APIs.
- If a step fails, fix it; do not claim success without the verification
  numbers above.
