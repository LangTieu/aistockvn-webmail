# STATE-S11H-BACKEND-FIX

## Status
E2E smoke suite (`worker/smoke.e2e.test.ts`) updated to align with the strict mailbox scoping backend contract (S11H follow-up).

## Files Changed + SHA-256
- `worker/smoke.e2e.test.ts` — Updated e2e tests (`inject email via handler`, `login list read search file`, `no duplicate Message-ID for injected email`, and `mailbox scoping A/B: user A cannot read user B's mailbox`) to match the strict mailbox isolation contract.
  - SHA-256: computed by verification harness post-write.
- `STATE-S11H-BACKEND-FIX.md` — Recorded strict contract summary, test updates, and scope boundaries.
  - SHA-256: computed by verification harness post-write.

## Strict Backend Contract Summary
- **`GET /api/messages` & `GET /api/counts`**: Always filter by `mailbox_address IN (caller's mailboxes)`. A caller with zero mailbox rows receives zero rows (`1=0`).
- **`GET /api/messages/:id`, `POST /api/messages/:id/read`, `GET /api/messages/:id/attachments/*`**: A caller with no mailbox rows or whose mailbox list does not contain `row.mailbox_address` receives `404` (`Message not found`), never `403`.
- **Inbound ingestion (`ingestInbound`)**: Sets `mailbox_address = lower(trim(envelope.to))`.
- **User provisioning & Migration `0006_mailbox_backfill.sql`**: Signup creates a primary mailbox row (`is_primary = 1, is_active = 1`); migration `0006` backfilled primary mailbox rows for all existing users (`admin@aistockvn.com`, `tranbinhanbr01@gmail.com`, `lethanhdongus@gmail.com`) and backfilled `messages.mailbox_address` from `envelope_to`.
- **Outbound send (`POST /api/send`)**: Resolves `fromAddress` from the caller's primary mailbox row (`is_primary = 1`), returning `403` only if none is assigned, and `503` in local dev when `RESEND_API_KEY` is absent.
- **Dev login (`POST /api/auth/dev`)**: Authenticates as the first entry in `ALLOWED_EMAILS` (`tranbinhanbr01@gmail.com`).

## Verify Outputs (Both Full Runs)
- **Prior Baseline Run (pre-test update against strict backend)**:
  - Migrations: `6/6` applied (`0001` through `0006_mailbox_backfill.sql`)
  - TypeScript (`tsc --noEmit`): `0` errors
  - Unit tests: `36/36` passing
  - E2E smoke tests (`SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false`): `47/50` total (`11/14` e2e tests passing; 3 expected failures due to legacy loose-mailbox assumptions in `worker/smoke.e2e.test.ts`: `login list read search file`, `no duplicate Message-ID for injected email`, and `mailbox scoping A/B`).
- **Updated Suite Run (post-test update)**:
  - Pending execution by the verification harness immediately after writing `worker/smoke.e2e.test.ts`.

## What Was NOT Done
- No backend TypeScript files (`worker/index.ts`, `worker/mail.ts`, etc.) or SQL migrations were modified.
- No assertions were weakened or loosened; all HTTP status checks remain exact (`200`, `401`, `403`, `404`, `409`, `503`).
- No git commit, push, or Cloudflare Worker deployment was performed.

## Independent verification (coordinator, fresh D1, IB3)
- Full suite run 1: 50 passed (50), 0 failed, 0 skipped, TSC=0
- Full suite run 2: 50 passed (50), 0 failed, 0 skipped, TSC=0
- Root tsc: 0; build: pass
- Verbose e2e: 14/14 pass (login list 64ms, dup Message-ID 23ms, mailbox A/B 302ms)
- Shas: index.ts 1af76891cea9904458b142bfd63dbe1bd0b15d43d5b2fc6eb73f4e5e75b0f099, mail.ts 20612e8ecd24106afecb7c5cbe3573d5615c81badf196fde76847759dc822235, 0006 c1b77f8fc93fa28eba727d32d1dc4925cf4984b9ccb6bd28ab638a7f2768d839, smoke.e2e.test.ts 8ffc40c5c5e7948e0943b168d9a2b058edfa864b4acc239ccde8b5fdb101afe6
- Strict contract now live in the test file: cross-mailbox read -> 404 both
  directions; lists show only own mailbox mail both directions; mailbox-less
  user gets zero rows; ingest tags mailbox_address; signup creates a mailbox row.
