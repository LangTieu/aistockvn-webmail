# S11 coordinator checkpoint (written ~08:37 ICT 18/11)

## Done
- Design: `docs/omnimail-model-design.md` (VM clone + IB1 workdir). Corrections
  applied: verification KEPT, eligibility = 3 fixed emails (correction 3 overrides
  correction 2), login redesign §5 (remove 2 lines, ChatGPT-style, font unchanged).
- Brief: `PROMPT-S11.md` (VM clone + IB1 workdir).
- IB1 workdir: `/data/home/webmail-omnimail-model` (fresh tarball sync from VM
  clone, sha256 tarball 17c3914cf92d7c60e53e2263cd71bacf91f6f18959c96d7d9adf82da39ef6178;
  node_modules symlinked from /data/home/webmail-password-auth/node_modules).
- Router IB1: liveliness OK ("I'm alive!"), LiteLLM PID 2833, watchdog running.
- Qoder leg 1 DISPATCHED 08:36 ICT via qoder_auto_switch.py (wrapper PID 4591),
  model freemodel-opus-5, session UUID 8fe1f327-a8d6-43fe-a210-fd9bf829cbea,
  log /data/home/webmail-s11.log, done-file STATE-S11.md / done-text "ALL DONE".
- Qoder FAILED 8/21 models in 9 min (each exit code 1 after ~60s:
  freemodel-opus-5, freemodel-deepseek-v4-1-flash, Tuoke 6.1/6 Sol,
  GLM 5.3 Flash, DeepSeek, FOSTA Sol/Astra; router liveliness OK). Wrapper
  KILLED by PID 4591 at ~08:28 ICT per LUẬT CHÂN — NEVER cycle back to Qoder.
- OpenCode leg 2 DISPATCHED ~08:49 ICT: `opencode run --auto -m
  opencode/nemotron-3.5-lightning-free --dir /data/home/webmail-omnimail-model
  --title S11-webmail-omnimail -f=PROMPT-S11.md` (PID 5692),
  log /data/home/webmail-s11-opencode.log. Confirmed running, reading design doc.
- S11 DONE ~08:35 ICT (STATE-S11.md, ALL DONE): tsc 0, build OK, vitest
  27 passed + 11 skipped (e2e SKIPPED — no dev server ran). NO new tests added.
- COORDINATOR VERIFICATION 08:41 ICT FOUND A REAL BUG: migrations 0004/0005 are
  PostgreSQL dialect — `wrangler d1 migrations apply aistockvn-mail --local`
  FAILS `near "(": syntax error at offset 80: SQLITE_ERROR`; 0004's CREATE TABLE
  IF NOT EXISTS users is also a no-op on an existing DB. S11 "verification"
  never ran migrations. Design note §6 + PROMPT-S11B.md written.
- OpenCode leg 3 (S11B backend fix) DONE ~08:54 ICT (STATE-S11B.md, ALL DONE):
  migrations apply clean from fresh state, tsc 0, build OK, e2e 11 passed /
  0 skipped (dev server up). BUT coordinator verification found S11B PARTIAL:
  (a) wrangler.jsonc VIOLATION — dummy TOTP_ENCRYPTION_KEY written into vars
  (would deploy to production; MUST be reverted, secret only via wrangler
  secret at deploy); (b) NO new tests added (suite still old 38; the 11 e2e
  are the old ones); (c) password-login verified bug NOT fixed (SELECT lacks
  verified → all password logins 403); (d) login MFA gating NOT implemented
  (password + Google issue sessions directly); (e) challenge endpoint still
  broken (TDZ `user` reference, double req.json(), length-6 gate blocks
  recovery codes, no challenge lookup/rate limit); (f) mfaStatus lies
  (enabled true when no row; ready=recovery hardcoded 8); (g) setup has no
  upsert; (h) disable rejects recovery codes. 0005 enabled_at NULLABLE fixed.
  Search placeholder reuse verified OK (valid SQLite, do not "fix").
- OpenCode leg 4 (S11C MFA fix) DONE ~09:03 ICT (STATE-S11C.md, ALL DONE):
  fixes a–h claimed. BUT coordinator verification (own run 09:07 ICT) found:
  FULL vitest WITH dev server = **38 passed, 0 skipped** (my run — e2e now
  actually runs, incl. "verify token DEV then login works" → password-login
  verified bug FIXED empirically); migrations 5/5 apply clean (my run);
  tsc root 0; build OK; wrangler.jsonc dummy REMOVED (now empty-string entry
  + comment — safe). STILL OPEN: `npx tsc -p tsconfig.worker.json` exits 1
  (~26 errors: auth.ts:140, index.ts randomBytes/verifyEmailToken/Env
  TOTP_ENCRYPTION_KEY, mfa.ts ArrayBuffer indexing etc.); NO new tests added
  (suite still old 38 — MFA/scoping/admin@-block untested); **TOTP runtime
  bug in worker/mfa.ts: `crypto.subtle.sign` returns ArrayBuffer, code
  indexes it directly → TOTP is ALWAYS "000000"** (setup/login MFA only ever
  accepts "000000"); encrypt uses PBKDF2+fixed zero salt, not SHA-256 key
  per design; recovery codes not normalized.
- OpenCode leg 5 (S11D TOTP fix) DONE ~09:15 ICT (STATE-S11D.md, ALL DONE):
  Uint8Array wrap in both TOTP fns, SHA-256 key form, recovery normalize,
  sha256Hex async. Coordinator verification (own run 09:21 ICT): tsc root 0;
  **tsc worker down to 7 errors** (auth.ts:140 + index.ts randomBytes x2,
  verifyEmailToken, Env TOTP x6 — mfa.ts CLEAN); build OK; migrations 5/5;
  FULL vitest with dev server **38 passed, 0 skipped**. BUT leg again added
  NO tests (no mfa.test.ts) and again ran vitest WITHOUT the dev server.
- **CRITICAL DEFECTS found by coordinator reading the synced worker/index.ts
  (02:33-02:40 ICT, NOT covered by the 38 tests):** (1) BOTH login MFA
  branches use `mfaRow?.enabled_at !== null` — TRUE when no MFA row exists
  (same bug S11C fixed in mfaStatus but NOT here): every verified user
  WITHOUT MFA would be pushed into the MFA challenge instead of getting a
  session (Google L99, password L193); (2) challenge creation uses
  `crypto.randomBytes(32)` (L100, L196) — Node API, tsc-worker flags it,
  runtime in production UNPROVEN (works in local wrangler dev; must become
  crypto.getRandomValues); (3) MFA branch creates an UNUSED session via
  signSession (dead code, throws if SESSION_SECRET short); (4) password MFA
  cookie uses `Secure=${...}` (invalid attribute form) + leaks tokenHash in
  `X-MFA-Challenge-Token` header; Google MFA cookie has duplicate Secure.
  mfaRequired returns **200, not 202** (contract corrected). The 38/38 suite
  does NOT exercise verified-password-login success or any MFA path, so the
  "verified login fixed" claim is UNPROVEN. **NEXT LEG (S11E, OpenCode):
  fix (1)-(4) + ADD the MFA/scoping e2e tests + run FULL suite with dev
  server; then re-verify.**
- SYNC STATUS (VM clone, 09:40 ICT): synced = migrations 0004/0005,
  worker/index.ts (sha VM 5600fd11… vs IB1 283136d1… — 10-byte delta,
  1000 lines both, no truncation marker; likely Unicode normalization in
  Vietnamese comments — re-diff before use), worker/mfa.ts, src/api.ts,
  wrangler.jsonc, STATE-S11B.md, STATE-S11D.md, PROMPT-S11C.md, PROMPT-S11D.md,
  docs/api-contract.md (new), docs/omnimail-model-design.md (VM version).
  NOT synced (still only on IB1): src/App.tsx (S11 frontend, sha 2d07a243…),
  STATE-S11.md, STATE-S11C.md, PROMPT-S11B.md. NOT synced by design:
  .dev.vars (gitignored, dummy local key only). worker/auth.ts identical
  both sides (sha 566abc1b…).
- IB1 window: runStartedAt 00:41:50Z, maxRun 120 min → ended ~02:41:50Z
  (09:41:50 ICT). All legs done; no process left running on IB1 (verify
  script completed; opencode PIDs gone).
- RE-SCOPE 08:39 ICT (Henrry): FRONTEND MOVES TO v0, BACKEND ONLY from here.
  No more frontend legs. Reply/Forward duplication recorded in design §6 for v0.

## IB1 window
- Started 07:41:50 ICT, maxRun 120 min → ends ~09:41 ICT. If window ends
  mid-work: resume on next IB1 window with `--resume-uuid
  8fe1f327-a8d6-43fe-a210-fd9bf829cbea` (if Qoder died) or re-dispatch per leg rule.

## Leg rule (LUẬT CHÂN)
- Qoder error → OpenCode nemotron-3.5-lightning-free via `opencode run --auto`
  (workdir /data/home/webmail-omnimail-model). Then Workers AI vn-stock-workersai
  via router API DIRECTLY (never via Qoder). NEVER cycle back to Qoder.
- NEVER show any key/secret value to any model.

## Resume point (if interrupted)
1. Check /data/home/webmail-s11.log tail + wrapper status (ps aux | grep
   qoder_auto_switch); check STATE-S11.md in /data/home/webmail-omnimail-model.
2. If Qoder done (ALL DONE in STATE-S11.md): verify files (sha256), run tsc +
   build + vitest --isolate=false INDEPENDENTLY on IB1, then sync back to VM
   clone (tarball up from IB1, extract over ~/workspace/aistockvn-webmail —
   NEVER overwrite the design note / PROMPT-S11.md with older copies; sync
   only code+migrations+tests+STATE-S11.md).
3. If Qoder dead/failed: follow leg rule to the next leg with the SAME brief,
   resume prompt pointing at STATE-S11.md progress.
4. NO deploy, NO commit, NO push — deploy is the liaison's step.

## Final report must contain
- What changed (parts 1-4), sha256 list of changed files, REAL tsc/build/vitest
  outputs (real test count from output), what remains.

## S11E — NEXT LEG (added 09:31 ICT 18/11 by liaison, after coordinator 7dd78b7c completed)
- **SCOPE:** (1) fix P0 MFA login bug: `mfaRow?.enabled_at !== null` is TRUE when no
  MFA row exists — every verified user WITHOUT MFA gets pushed into the MFA
  challenge instead of a session (Google login ~L99, password login ~L193 in
  worker/index.ts). Use `Boolean(mfaRow?.enabled_at)`. (2) `crypto.randomBytes(32)`
  → `crypto.getRandomValues(new Uint8Array(32))` + b64url (Node API unproven in
  Workers). (3) remove dead `signSession()` in MFA branch; cookie `Secure`
  conditional (no `Secure=${...}` form); drop `X-MFA-Challenge-Token` header
  (leaks token hash); fix Google MFA cookie duplicate `Secure`. (4) ADD tests:
  worker/mfa.test.ts + e2e for verified-password-login success, MFA
  setup→confirm→login→challenge→session, recovery-code once-then-reuse-fails,
  Google MFA 200, mailbox scoping A/B, admin@ registration 409. (5) FULL suite
  with dev server, 0 skipped; `tsc -p tsconfig.worker.json` must be 0 errors
  (was 7: auth.ts:140; index.ts randomBytes ×2, verifyEmailToken scope,
  Env.TOTP_ENCRYPTION_KEY ×6).
- **⚠️ VM SYNC IS CORRUPTED — re-sync FIRST, before any fix:** the VM copy of
  worker/index.ts contains 5 literal `<redacted>` placeholders (lines 357, 395,
  483, 484, 577) because it was written from a `files` read whose display
  redacted secret-looking spans. The VM file does NOT parse (tsc worker:
  TS1005 at 362/366/369). **NEVER sync code by reading file content through
  the chat/tool display and re-writing it.** Re-sync byte-exact from IB1:
  tarball up from IB1 (per resume point §2) or scp, extract over the VM clone,
  then `sha256sum` MUST match IB1's hashes exactly
  (worker/index.ts 283136d1…, worker/mfa.ts 630d9a5d…, worker/auth.ts 566abc1b…,
  migrations 0004/0005, wrangler.jsonc 80092b81…). Only then start the S11E fix.
  worker/mfa.ts also differs (VM 12090879… vs IB1 630d9a5d…, 0 redacted hits) —
  diff it after the byte-exact sync; do NOT hand-edit the VM copy to match.
- **Deploy (liaison's step, AFTER S11E verification):** `wrangler secret put
  TOTP_ENCRYPTION_KEY` (≥32 chars), `migrations apply --remote` on production
  D1 (0 users, pre-seed applies cleanly), Email Routing catch-all. Then v0
  integration per docs/api-contract.md.
- Leg rule unchanged: OpenCode nemotron-3.5-lightning-free via `opencode run
  --auto` (workdir /data/home/webmail-omnimail-model); Qoder already failed
  8/8 — do NOT cycle back to Qoder. NEVER show any key/secret value to any model.
