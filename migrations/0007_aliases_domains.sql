-- 0007: Masked email aliases and supported domains

CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO domains (domain, enabled, created_at)
VALUES ('aistockvn.com', 1, 1763460000000);

CREATE TABLE IF NOT EXISTS aliases (
  id TEXT PRIMARY KEY,
  local_part TEXT NOT NULL,
  domain TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(local_part, domain)
);

CREATE INDEX IF NOT EXISTS idx_aliases_domain ON aliases(domain, local_part);
