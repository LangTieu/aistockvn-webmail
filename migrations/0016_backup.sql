-- migrations/0016_backup.sql
CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'cron')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  d1_object_key TEXT NOT NULL DEFAULT '',
  d1_size INTEGER NOT NULL DEFAULT 0,
  r2_copied INTEGER NOT NULL DEFAULT 0,
  r2_errors INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS client_errors (
  id TEXT PRIMARY KEY,
  crash_id TEXT NOT NULL,
  mailbox_hash TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  stack TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_errors_created ON client_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_errors_crash ON client_errors (crash_id);

INSERT OR IGNORE INTO admin_settings (key, value, updated_at) VALUES
  ('backup_enabled', '0', 0),
  ('backup_retention_days', '30', 0),
  ('backup_schedule', '0 20 * * *', 0);
