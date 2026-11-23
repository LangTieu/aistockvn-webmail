CREATE TABLE IF NOT EXISTS ingest_failures (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  recipient TEXT NOT NULL DEFAULT '',
  raw_key TEXT,
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_failures_created ON ingest_failures (created_at DESC);
