# STATE-S11B — Backend fix: migrations to SQLite + backend tests + FULL e2e

## Files changed

| File | SHA-256 |
|------|---------|
| `migrations/0004_multiuser_and_mfa.sql` | `39c98594ee5fc0040ebc52609e1ebffb3979d7ff97c527a8c22f4b3267fb89e5` |
| `migrations/0005_mfa_tables.sql` | `61161acda1ee08b4757a0e0cc665108fdf543179215d9be95d5f42fb493d00d1` |
| `worker/index.ts` | `f42fda15af16b41cd5bbc408819889b2074126ad181d1ff9a719896b7ac0c30a` |
| `worker/mfa.ts` | `87a02c3368e74636061eaa9ce7a2c70a3d7a1616f8341c8caaeda77b4801b5e0` |
| `wrangler.jsonc` | `80092b81d5b9d339c9801d0db7f7e9d908e8b5f079119e0e920879b49632b047` |

## Migrations apply output

Fresh `rm -rf .wrangler/state/v3/d1` then `npx wrangler d1 migrations apply aistockvn-mail --local`:

```
[... truncated: migration list displayed ...]
? About to apply 5 migration(s)
Your database may not be available to serve requests during the migration, continue?
🤖 Using fallback value in non-interactive context: yes
🌀 Executing on local database aistockvn-mail (1accd00a-78dc-445b-ada2-52941f14bdbc) from .wrangler/state/v3/d1:
🌀 To execute on your remote database, add a --remote flag to your wrangler command.
🚣 4 commands executed successfully.
[...]
🚣 5 commands executed successfully.
[...]
🚣 3 commands executed successfully.
[...]
🚣 13 commands executed successfully.
[...]
🚣 4 commands executed successfully.
```

Full success: all 5 migrations (0001–0005) applied without error. Verified tables: `users` (3 pre-seeded rows with fixed UUIDs), `mailboxes` (admin with primary mailbox), `messages` (with `mailbox_address` column and index), `admin_totp`/`mfa_challenges`/`mfa_recovery_codes` (correct SQLite dialect), old tables `login_attempts`/`registration_attempts`/`password_resets`/`email_verifications` untouched.

## `npx tsc --noEmit` output

```
<no errors - exit code 0>
```

## `npm run build` output

```
vite v8.3.8 building client environment for production...
transforming...
✓ 17 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html 0.69 kB │ gzip: 0.39 kB
dist/assets/index-2GHeuLPj.css 22.05 kB │ gzip: 5.08 kB
dist/assets/index-DP9VZoer.js 253.65 kB │ gzip: 77.33 kB
✓ built in 115ms
```

## E2E vitest output (dev server running)

```
SMOKE_BASE=http://127.0.0.1:8788 npx vitest run worker/smoke.e2e.test.ts --isolate=false

 Test Files  1 passed (1)
   Tests  11 passed (11)
    Start at  01:49:41
   Duration  270ms (tests 94%, import 3%, transform 1%, worker 1%)
```

All 11 e2e tests pass with the dev server up. 0 skipped.

## What was NOT done

- No deploy, no commit, no push, no `wrangler secret put`, no Email Routing/DNS config
- No `src/App.tsx`, `src/styles.css`, `index.html` or any UI changes
- No production D1 database migration
- Manual dev server required for e2e (automated CI+e2e pipeline not configured)

ALL DONE