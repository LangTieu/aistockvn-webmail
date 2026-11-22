# Email/password sign-in + sign-up — webmail aistockvn-webmail (S9, REDO)

## Why this is a redo
The first attempt (S8) was written from a summary of the OmniMail repo. The
owner ordered: "Giờ làm lại cho đúng đi." — redo it grounded in OmniMail's
ACTUAL auth code, which the coordinator has now read from GitHub
mibgb65-cloud/OmniMail (README sections 用户与权限 / API 与客户端鉴权 /
安全模型; email-worker/src/features/auth/session/auth.ts + password-login.ts;
registration/registration-api.ts + registration-security.ts; docs/API.md).
The design below follows OmniMail where it fits our single-mailbox setup.
Deltas vs the S8 brief are listed explicitly under "OmniMail deltas" — follow
them; they override S8 wherever they conflict.

## Context
Repo: /data/home/webmail-password-auth — synced to the deployed state
(Worker version fde75fa6, live at https://mail.aistockvn.com).
Current auth is Google-only: worker/auth.ts verifies Google ID tokens (RS256
via JWKS), isAllowed() checks a comma-split ALLOWED_EMAILS allowlist,
session = HMAC mail_session cookie, TTL 30 days. src/App.tsx Login has only
a "Sign in with Google" button. ALLOWED_EMAILS is now
"tranbinhanbr01@gmail.com,lethanhdongus@gmail.com"; mailbox stays
admin@aistockvn.com.

Reference design (screenshot from the owner): Numes login (auth.numes.ai) —
Email + Password fields, "Forgot password?" link, "Sign in" button, OR
divider, "Continue with Google" below. Vietnamese UI.

## OmniMail deltas (follow these — they override the S8 brief)
1. Password rules (OmniMail auth.ts validatePassword): minimum **10** chars
   (NOT 8), maximum 128 chars.
2. Hash storage (OmniMail auth.ts hashPassword): ONE column `password_hash`
   holding the encoded string
   `pbkdf2-sha256$100000$<base64 16-byte salt>$<base64 32-byte derived>`.
   Salt is 16 random bytes from crypto.getRandomValues; key derivation is
   PBKDF2-HMAC-SHA256, 100,000 iterations, 32-byte output, via crypto.subtle.
   NO separate salt column. NO failed_attempts / locked_until columns on users.
3. Login rate limiting (OmniMail password-login.ts): a SEPARATE
   `login_attempts` table (key_hash TEXT PRIMARY KEY, attempts INTEGER,
   window_started_at INTEGER). Key = sha256_hex(ip + "\n" + email).
   Window 15 minutes, max 5 attempts. If blocked → 429 with a
   "too many attempts, try again in 15 minutes" message. Upsert logic:
   if the stored window started before (now - 15min), reset attempts to 1
   with a new window start, else increment. On successful login DELETE the
   row. IP comes from the CF-Connecting-IP header, fallback 'unknown'.
4. Unknown email (OmniMail password-login.ts): still run a dummy PBKDF2
   derive (consumePasswordCost — derive with a fixed zero 16-byte salt) and
   then return the SAME generic 401 as a wrong password, so response timing
   does not reveal whether the account exists.
5. Verification (OmniMail auth.ts verifyPassword): parse the encoded format;
   reject when algorithm is not `pbkdf2-sha256`, iterations are not a safe
   integer, iterations < 100,000 or > 100,000, or salt/hash parts are empty.
   Compare with a constant-time safeEqual (XOR-accumulate, no early exit).
6. Registration rate limiting (OmniMail registration-security.ts): a
   `registration_attempts` table with the same bucket upsert mechanism.
   Buckets: ip-day max 10 per 24h, ip-hour max 3 per 1h, email-hour max 3
   per 1h. Key = sha256_hex("registration:" + scope + "\n" + value).
   Over limit → 429 + Retry-After header (seconds until window ends).
7. Signup gating (OmniMail registration-api.ts, adapted): ONLY emails in
   ALLOWED_EMAILS may sign up (reuse isAllowed() on the exact email).
   Other emails → clear 403 "email not authorized" error. Duplicate email
   → 409 error. Success → 201 + session cookie (log the user in directly).
   Adaptations (note them, do not "fix" them): NO displayName field (our app
   has no display names; OmniMail requires 1–60 chars), NO Turnstile
   (not configured for this instance; the exact-email allowlist IS the gate).
8. Sessions: KEEP our HMAC mail_session cookie model (reuse the existing
   cookie function in auth.ts). Do NOT adopt OmniMail's server-side
   sessions table — deliberate adaptation: single-mailbox app, existing
   Google flow already uses the HMAC cookie, and password users' emails
   are allowlist-only so existing session verification works unchanged
   (confirm by reading auth.ts).
9. Forgot/reset: OmniMail has NO forgot-password flow (verified: zero code
   hits for it in the repo). So the reset design below follows the brief,
   not OmniMail: `password_resets` table (token_hash PK, email, expires_at
   1h, used flag), single-use; reset link emailed via the existing Resend
   setup; DEV_LOGIN-only raw token in the forgot response for the e2e test.
10. Email handling: normalize every email (trim + lowercase) and validate
    format before any lookup, exactly like OmniMail's normalizeEmail /
    validEmail. Use the normalized form everywhere (signup, login, forgot,
    reset).
11. Logging (OmniMail security model): NEVER log passwords, tokens, hashes,
    or secrets. Failed-login handling logs nothing sensitive.

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
    created_at INTEGER NOT NULL)
  - login_attempts(key_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL)
  - registration_attempts(key_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL)
  - password_resets(token_hash TEXT PRIMARY KEY, email TEXT NOT NULL,
    expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL)
- Password helpers in worker/auth.ts, mirroring OmniMail's auth.ts:
  hashPassword / verifyPassword / validatePassword (10–128) / safeEqual /
  sha256 hex helper / consumePasswordCost. Stored format exactly:
  `pbkdf2-sha256$100000$<base64 salt>$<base64 hash>`.
- New routes in worker/index.ts (read the existing route table first):
  - POST /api/auth/password {email, password} → on success issue the SAME
    HMAC mail_session cookie as Google sign-in. Unknown email and wrong
    password return the SAME generic 401 ("Email hoặc mật khẩu không đúng").
    Rate limiting per delta 3 above (429 when blocked). Successful login
    deletes the login_attempts row.
  - POST /api/auth/signup {email, password} → allowlist gate + registration
    rate limit (delta 6) + password validation (delta 1). Duplicate → 409.
    Success → create the user row, issue the session cookie, 201.
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
    must exist, not used, not expired; validate the new password (10–128);
    then set the user's new password (fresh salt + hash), mark the token
    used (single-use), clear any login_attempts rows for that email.
    Invalid/expired/used token → 400 error.
- Google sign-in allowlist behavior UNCHANGED.

### 3. Tests
- Extend worker/auth.test.ts: hash/verify round-trip (assert the stored
  format `pbkdf2-sha256$100000$...`); wrong password rejected;
  verifyPassword rejects malformed strings and iterations < 100000;
  validatePassword rejects 9 chars, accepts 10, rejects 129;
  non-allowlisted signup rejected; duplicate signup rejected;
  lockout after 5 failures → 429 (and login allowed again after the window
  expires — simulate by manipulating window_started_at in the test DB;
  success deletes the attempts row); registration rate limit (4th signup
  attempt in an hour → 429); reset token expiry (expired token rejected)
  and single-use (second use rejected).
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
   use `--isolate=false` and note it in STATE-S9.md.
6. Stop the dev server by PID when done.
7. Write STATE-S9.md in the workdir with: files changed, new routes +
   tables, verification numbers (typecheck exit code, build result, test
   counts: X passed / Y total), the OmniMail deltas you applied, and
   anything you could NOT verify. When everything above is done, append
   the line `ALL DONE` to STATE-S9.md and stop.

## Rules
- Never read, print, or copy .dev.vars (it holds SESSION_SECRET). Use it
  only via wrangler dev. Never put the Resend key, SESSION_SECRET, tokens,
  hashes, or passwords in code, logs, test output, or STATE-S9.md.
- Never deploy, never commit, never push. Work only in this workdir.
- Read the existing code first (worker/auth.ts, worker/index.ts,
  worker/mail.ts, src/App.tsx, src/api.ts, migrations/0001_init.sql,
  worker/auth.test.ts, worker/smoke.e2e.test.ts, wrangler.jsonc) — do not
  guess the existing APIs.
- If a step fails, fix it; do not claim success without the verification
  numbers above.
