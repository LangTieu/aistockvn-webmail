# Multi-domain — POST /api/domains + enable/disable + inbound domain check + Domains UI

Workdir: /data/home/webmail-s11h-gemini (full repo; vitest + tsc run here). A wrangler dev server is already running on port 8787 for smoke checks.

## Context (verified by coordinator — do not re-diagnose)
Feature: multi-domain support (plan feature 3/3). The DB layer already exists: migration 0007 created table domains (domain TEXT PRIMARY KEY, enabled INTEGER, created_at) seeded with aistockvn.com, and table aliases (local_part, domain, label, enabled, created_by, created_at, UNIQUE local_part+domain). NO new migration needed.
Already working: GET /api/domains lists domains; POST /api/aliases accepts a domain param and validates it with lookupDomain (must exist + enabled); send-from-alias checks alias + domain enabled; the Aliases UI (src/aliases.tsx) has a domain picker fed by GET /api/domains; the compose From dropdown offers the mailbox + enabled aliases; the inbound email handler (worker/index.ts, email method) drops mail to disabled aliases via isAliasDisabled.
Gap: there is NO API to add a domain. Adding istockvn.com today needs a manual SQL insert. The goal: adding a domain must be a no-code-change action (UI + API), so when Checkdomain unlocks the istockvn.com nameserver, the admin just adds it here.

## Your job (do ONLY this; do not change any other route, auth, search, alias, or existing behavior)
1. POST /api/domains — add a domain. Body: { domain }. Normalize: trim + lowercase. Validate: must match a domain shape (labels of letters/digits/hyphens separated by dots, at least one dot, no leading/trailing dot or hyphen, max 253 chars); invalid returns 400 with a clear error. INSERT OR IGNORE into domains with enabled=1 and created_at=now; if the domain already exists, return the existing row (200, not an error). Return { domain: { domain, enabled } }. Same session auth as the other /api routes (verifySession allowlist gate).
2. POST /api/domains/:domain/enable and POST /api/domains/:domain/disable — toggle enabled (mirror the existing alias enable/disable route pattern). Unknown domain returns 404. Return the updated row.
3. Inbound: in the email handler in worker/index.ts, after the existing disabled-alias check, drop mail whose recipient domain is explicitly disabled in the domains table (use the existing lookupDomain helper; if the row exists and enabled is 0, return early without storing or forwarding — same as the disabled-alias behavior). If the recipient domain is NOT in the domains table, keep current behavior (store + forward as today) — Email Routing is the authority on which domains reach the Worker, and dropping unknown-domain mail could lose legitimate mail.
4. Frontend: in src/aliases.tsx, add a Domains section: list all domains with enabled state, an add-domain form (text input + Add button; show the server error message on failure), and Enable/Disable buttons per domain. Add api.addDomain(domain) and api.setDomainEnabled(domain, enabled) in src/api.ts. The existing domain picker for alias creation must keep working and must refresh after a domain is added/toggled. Add a short hint text: adding a domain here does not configure DNS or Email Routing — that is still done in Cloudflare.
5. Tests: new file worker/domains.test.ts following the existing test conventions (read worker/aliases.test.ts and worker/search-endpoint.test.ts for the mock env pattern). Cover: add valid domain (200 + row in DB), duplicate add returns existing, invalid formats return 400 (missing dot, leading dot, spaces, empty), unauthenticated request is rejected, enable/disable toggle + unknown domain 404, alias creation on a disabled domain returns 400, inbound mail to a disabled domain is dropped (not stored), inbound mail to an unknown domain is still stored (current behavior). Do NOT break any existing test.

## Anti-fabrication (standing rule, follow verbatim)
Every claim of success must come with the exact command output that proves it (paste the output, do not summarise it). Never invent a URL, ID, file path, or output value — use only values a real command returned. After writing a file, verify it exists with ls/cat before claiming it was written. After running a command, report its exit code and output. A failed step is reported as failed, with the error text — never as success.

## Verify before finishing
1. npx vitest run --isolate=false — FULL suite green (no failures).
2. npx tsc --noEmit -p tsconfig.worker.json — 0 errors.
3. Smoke: with the dev server on port 8787, exercise the new endpoints (add a domain, list domains, toggle, create an alias on the new domain) and confirm they work; if the dev server is not running, start it with the repo dev command first.
4. Grep-check your own changes for P2 contamination keywords (qwen, checkpoint, hoplite, vn-stock-ai, training, eval, colab) — must be 0 matches. If any round mixes in unrelated content, discard it and redo.
5. Paste the full vitest + tsc outputs in your final message with exit codes.

## Constraints
Never run rm or rm -rf; never put any key/secret/token value in chat, logs, repo, or files; do not commit or push; do not deploy (the liaison deploys). Keep the UI in English (the app UI is English throughout). Use the model selected by the coordinator (Argon) — do not switch models mid-task.
