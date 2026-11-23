# Backup and Restore — `aistockvn-mail`

Service: Cloudflare Worker `aistockvn-mail` (`https://mail.aistockvn.com`), D1 database `aistockvn-mail`, R2 raw mail bucket `aistockvn-mail-raw`, R2 backup bucket `aistockvn-mail-backup`.

## Backup Engine (query-based)

The D1 snapshot is a **SQL dump** (`.sql`), not a SQLite binary export. The engine (`exportD1SnapshotToBackup` in `worker/backup.ts`) reads every table through the D1 REST query API (`POST /client/v4/accounts/{id}/d1/database/{id}/query`), paginated (`LIMIT 500 OFFSET ...`), and streams `INSERT` statements into R2.

Why not the D1 export API: the export API **cannot export databases with virtual tables** — the live D1 has the FTS5 table `messages_fts`, so every export attempt fails. The query-based engine skips `messages_fts` and its shadow tables (`messages_fts_*`), `_cf_KV`, `sqlite_sequence`, and any other `CREATE VIRTUAL TABLE`; the FTS index is rebuilt at restore time (below).

## What a Backup Contains

Each backup run stores the following in `aistockvn-mail-backup`:

- A D1 SQL dump file at key `d1/<date>/<run-id>.sql`
- Copies of the R2 raw mail objects (from `aistockvn-mail-raw`) for that run

All runs are recorded in the D1 table `backup_runs` (including `d1Size` and `r2Copied`).

## Schedule, Retention, and Off-by-Default

- **Schedule:** Triggered via the main Worker's cron */5 (`*/5 * * * *`) during the daily 03:00–03:04 VN (20:00–20:04 UTC) window. Deduplication checks `backup_runs` for any run already started in the current VN day before calling `BACKUP_WORKFLOW.create()`. Workflow-level `schedules` is not used (and was removed from `wrangler.jsonc`) because the Cloudflare Free plan does not support scheduled Workflows.
- **Retention:** 30 days.
- **Off by default:** Backups are disabled (`backup_enabled` = `'0'`) until the `aistockvn-mail-backup` bucket and the 3 D1 REST secrets exist.

## How to Download a Backup File

Download via the web UI:

- Open **Admin -> Backup** tab and click a run's **Download D1** button.

Or download via Wrangler CLI:

    npx wrangler r2 object get aistockvn-mail-backup <key> <local-file>

## Manual Restore

> **WARNING: NEVER restore straight onto the live D1 database `aistockvn-mail`.** Always verify and test against a separate database first.

The dump is plain SQL (schema + `INSERT`s, wrapped in a transaction). It does **not** contain `messages_fts` — rebuild it after replay.

1. **Download the SQL dump** using the Admin Backup tab or `wrangler r2 object get` above.
2. **Replay the dump into a separate test database first** (a new D1 database or a local SQLite file), then verify the data:

    sqlite3 test.db < <file>
    sqlite3 test.db "PRAGMA integrity_check;"

    or, into a test D1 database:

    npx wrangler d1 execute <test-db> --file <file>

3. **Rebuild full-text search** in the restored database (the dump footer carries the same commands):

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      subject,
      text_body,
      from_addr,
      from_name,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61'
    );
    INSERT INTO messages_fts(messages_fts) VALUES('rebuild');

4. **Verify counts** — compare table/row counts and file size against the corresponding `backup_runs` row (`d1Size`, `r2Copied`), and spot-check that full-text search works (`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'test' LIMIT 5;`).
5. Only after it checks out **AND Henrry decides**, the operator restores to the live database by hand (replay the same `.sql` file against a fresh import target, then rebuild FTS as in step 3). There is no `wrangler d1 restore` for SQL dumps — do not run anything blindly against the live database.

## Restore Drill

Perform a restore drill after the first successful backup:

1. Download the D1 SQL dump.
2. Replay it into a local SQLite file, rebuild FTS5, run `PRAGMA integrity_check;`, and count tables/rows, comparing against `backup_runs`.
3. Delete the local file.

The drill creates no new database and never touches the live D1 database `aistockvn-mail`.

## What Is Not Done

- There is no automatic restore.
- There is no automatic restore button in the UI and no restore endpoint in the Worker.
