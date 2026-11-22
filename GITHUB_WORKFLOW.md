# GitHub workflow — aistockvn-webmail

Repo: https://github.com/LangTieu/aistockvn-webmail (private, branch `main`)

## Roles

- **IB4 (`/data/home/webmail-r3-codex`)** — source of truth for code. Code,
  test, and deploy happen here. IB4 has NO GitHub auth, so it never pushes
  or pulls directly.
- **VM (`~/workspace/webmail-push`)** — liaison + mirror. Pushes to GitHub
  via the `custom.github` PAT (LangTieu, full `repo` scope) and the helper
  `~/workspace/custom-connectors/custom.github/bin/github_api.py`.
  Push script: `~/workspace/webmail-push/push_webmail.py`
  (Git Data API: blobs → tree → commit → ref, ~40 files per commit).
  File manifest: `~/workspace/webmail-push/manifest.json`.
- **GitHub** — the coordination point. A phase is "synced" only when its
  commit is on `main`.
- **Connector (Muse GitHub App, lethienhieuhcm-web)** — has NO access to
  this repo (`list_commits` → 404). Do not rely on it for this repo; all
  pushes/reads go through `custom.github` (LangTieu PAT).

## After each phase

1. On IB4: `npm test && npm run typecheck && npm run build`
   (all must exit 0, run bare, no pipes), then `npm run deploy`
   (ALWAYS `npm run deploy`, never bare `wrangler deploy`).
2. Sync changed files IB4 → VM (instabox download, sha256 check).
3. On VM: commit + push via the API helper (see push script).
4. Verify: remote tree (recursive) vs IB4 file list — same paths, same
   blob shas. A sync that replaces the whole tree must build the first
   chunk WITHOUT `base_tree` so files deleted from IB4 disappear from
   the repo too.

## Never commit

Secrets (`.dev.vars`, any key/token/password value), `*.log`,
`*.bak`, `*.pre-dedup`, `*.done` round markers, `design/v0-output/`
(v0 snapshot — the live UI is `src/`), `restore-backup/` (old UI copies),
`node_modules/`, `dist/`, `.wrangler/`, `scripts/__pycache__/`.
`wrangler.jsonc` is safe: it holds only resource IDs, no secrets.

## Notes

- Test files contain FABRICATED test credentials only (test API key in
  `worker/api-key-auth.test.ts`, test passwords in
  `worker/smoke.e2e.test.ts`, 16-char mock D1 token in
  `worker/backup.test.ts`) — none of them match live secrets. Repo is
  private. Do not copy live secrets into tests.
- First full sync (22/11): repo was public with 26 stale files from
  17/11; switched to private, then replaced the whole tree with the
  current 196 files from IB4 (migrations to 0020).
