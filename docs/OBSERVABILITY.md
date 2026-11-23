# Observability — `aistockvn-mail`

Service: Cloudflare Worker `aistockvn-mail` (`https://mail.aistockvn.com`), D1 database `aistockvn-mail`, R2 raw mail bucket `aistockvn-mail-raw`, R2 backup bucket `aistockvn-mail-backup`.

## How to View Logs

Stream live Worker logs as JSON and filter by the `event` field:

    npx wrangler tail aistockvn-mail --format json

Cloudflare keeps Workers Logs server-side; they cannot be queried from inside the Worker.

## Event Catalog

Events are defined in `worker/observability.ts` (`BACKUP_EVENTS`) and emitted via `logEvent` as one JSON line per event.

| Event | When It Fires |
|---|---|
| `api_unhandled_error` | An unhandled exception occurs in an API request handler |
| `notify_sweep_failed` | A notification sweep fails |
| `notify_delivery_failed` | Delivering a notification fails |
| `notify_enqueue_failed` | Enqueuing a notification fails |
| `ingest_failed` | Incoming mail ingestion fails |
| `forward_failed` | Outbound mail forwarding fails |
| `backup_started` | A backup workflow run starts |
| `backup_succeeded` | A backup workflow run finishes successfully |
| `backup_failed` | A backup workflow run fails |
| `client_error_received` | A client-side error report is received and recorded |

## What Is Never Logged

The following are strictly excluded from logs:

- Passwords and app passwords
- Tokens and secrets
- Authorization headers and cookies
- Mail subjects, bodies, and snippets
- Attachment content
- Raw keys and resend IDs
- Mailbox addresses (only `mailbox_hash` is stored for client errors)

`console.error` output is bounded to 200 characters.

## Looking Up One Crash by `crash_id`

Query the `client_errors` table in D1 (stores `mailbox_hash` only, never mail content):

    npx wrangler d1 execute aistockvn-mail --command "SELECT id, crash_id, message, url, user_agent, created_at FROM client_errors WHERE crash_id = '<id>'"

## Sampling and Cost Guardrail

- **Sampling:** `wrangler.jsonc` sets `head_sampling_rate` to `0.1` (10% of traces kept).
- **Volume pricing:** From 1/12/2026, Cloudflare Observability is volume-priced with a Free tier limit of 0.5 GB/day. Ingestion pauses at the limit with no charge.
- **Daily monitor:** `scripts/observability_guard.py` runs via cron at `08:05 ICT` daily and alerts on Telegram at 0.3 GB/day or more.

## Admin Logs Tab Scope

Because Cloudflare keeps Workers Logs server-side and the Worker cannot query them, the Admin Logs tab only displays D1-backed records from `client_errors`, `backup_runs`, and `audit_logs`. It never pretends to query Workers Logs.
