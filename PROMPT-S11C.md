# PROMPT-S11C — Backend fix 2: MFA login gating + challenge endpoint + login bug + tests

Workdir on IB1: `/data/home/webmail-omnimail-model`. S11B fixed the migrations
(they now apply cleanly — DO NOT rewrite them again unless a fix below needs a
schema change). BACKEND ONLY. Do NOT touch src/App.tsx, src/styles.css,
index.html, or any UI. NO deploy, NO commit, NO push, NO `wrangler secret put`.

## BUGS TO FIX (all verified by coordinator in the CURRENT code — read the lines)

1. **wrangler.jsonc MUST BE REVERTED**: S11B added
   `"TOTP_ENCRYPTION_KEY": "dummy-local-test-key-0123456789abcdef"` under `vars`.
   That value would DEPLOY to production and make MFA secrets decryptable by
   anyone who reads the repo. REMOVE that line entirely (restore the VM
   version). TOTP_ENCRYPTION_KEY comes from `wrangler secret` at deploy time
   (liaison step); local dev uses an env var / `.dev.vars` only, never
   wrangler.jsonc.
2. **Password login can never succeed** (worker/index.ts L134 + L171):
   `SELECT email, password_hash FROM users` never selects `verified`, then
   `if (userRow.verified !== 1)` is always true → EVERY password login gets
   403 "Email not verified yet". Fix: select `verified` (and `id`, `role` —
   needed below). Add an e2e test: verified user logs in with password → 200
   + session cookie; unverified user → 403.
3. **Login NEVER challenges for MFA** (password L100-177, Google L74-85):
   both issue the session immediately even when MFA is enabled. Fix both:
   after password/Google verification, if MFA is enabled for the user, do NOT
   issue a session — create an MFA challenge (INSERT into `mfa_challenges`:
   token_hash = sha256(token), user_id, channel 'browser', expires_at =
   now + 300s), set the challenge cookie (`mail_mfa_challenge`, httpOnly,
   path `/api/auth/mfa/challenge`, maxAge 300), return 202
   `{ mfaRequired: true, email }`. Follow OmniMail public-routes.ts L88-95.
4. **Challenge endpoint is broken** (worker/index.ts L609-640):
   - `let targetEmail = user;` — `user` is declared LATER (L~636 `const user =
     await verifySession...`) → TDZ ReferenceError → endpoint ALWAYS 500s.
   - `req.json()` is called TWICE (body already consumed).
   - `code.length !== 6` rejects recovery codes (19 chars) — recovery path dead.
   - No `mfa_challenges` lookup, no expiry/attempts check, no rate limit,
     no challenge consumption; `sessionCookie(session, true)` hardcodes secure.
   Rewrite it per OmniMail mfa.ts `completeMfaChallenge`: read the challenge
   cookie, look up `mfa_challenges` by sha256(token) JOIN users, reject if
   missing/expired/attempts ≥ 5/inactive (and DELETE the stale row); verify
   with `verifyMfaForUser` semantics — 6-digit → TOTP (±1 window), anything
   else → recovery code (single-use, mark used_at); rate limit 10 attempts /
   15 min per (ip,user) (reuse the `login_attempts` table, key
   sha256(`mfa\n${ip}\n${userId}`)); on failure increment challenge attempts;
   on success DELETE the challenge row, issue the session with the normal
   `secure` flag, clear the challenge cookie. Return `{ email, mailbox }`.
   (worker/mfa.ts already has the TOTP/recovery helpers — use them, do not
   reimplement crypto in index.ts.)
5. **mfaStatus lies** (L505-513): `const enabled = mfaRow?.enabled_at !== null`
   is TRUE when no row exists (undefined !== null). Fix:
   `enabled = Boolean(mfaRow?.enabled_at)`; `ready` = TOTP_ENCRYPTION_KEY
   configured (length ≥ 32), NOT `enabled`; `recoveryCodesRemaining` =
   `SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = ? AND used_at
   IS NULL` (not hardcoded 8).
6. **Setup must upsert** (L532): plain INSERT fails on second setup (PK
   conflict). Use `ON CONFLICT(user_id) DO UPDATE SET encrypted_secret =
   excluded.encrypted_secret, enabled_at = NULL, updated_at = excluded.updated_at`
   like OmniMail mfa-api.ts.
7. **Disable must accept recovery codes** (L~581): remove the length-6 gate;
   verify via `verifyMfaForUser` (TOTP or recovery code).
8. **Search placeholder check — VERIFIED OK, do NOT "fix"**: the five LIKEs
   reuse numbered param `?${3 + len}` with ONE bind — valid SQLite (same
   parameter reused). Leave it; cover it with an e2e search test under a
   scoped user.

## TESTS (S11B added NONE — suite is still the old 38; this is REQUIRED)
- Unit (worker/mfa.test.ts new, or worker/auth.test.ts): TOTP generate/verify
  (±1 window, wrong code fails), secret encrypt/decrypt round-trip, recovery
  code hash + single-use consume, challenge create/consume.
- E2E (worker/smoke.e2e.test.ts, dev server running — see below): verified
  password login succeeds (bug #2); unverified → 403; MFA setup → confirm →
  password login returns 202 {mfaRequired:true} → challenge with TOTP →
  session; recovery code logs in ONCE, reuse fails; Google login with MFA
  enabled → 202 (bug #3); challenge with wrong/expired code fails; mailbox
  scoping (user A cannot read user B's mail, counts scoped); admin@ signup
  → 409; search under a scoped user returns only their mail.

## FULL VERIFICATION (all of it, real output)
- `rm -rf .wrangler/state/v3/d1` then `npx wrangler d1 migrations apply
  aistockvn-mail --local` MUST succeed (paste output).
- `npx tsc --noEmit` = 0; `npm run build` passes.
- Dev server: `TOTP_ENCRYPTION_KEY=dummy-local-test-key-0123456789
  npx wrangler dev --port 8788 --ip 127.0.0.1` (env var ONLY), then
  `SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false`
  (FULL suite, both files). Kill dev by captured PID. Report the REAL counts
  from the output — 0 skipped expected with the dev server up.
- NEVER write any secret value to a file. Dummy local-only values via env var
  only. Write `STATE-S11C.md` with: files changed + sha256, migrations output,
  tsc/build/vitest outputs (REAL tail lines incl. test count AND skipped
  count), what was NOT done. End with `ALL DONE` only when everything above
  is complete and verified.
