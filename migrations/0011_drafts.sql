CREATE TABLE IF NOT EXISTS mail_drafts (
  id TEXT PRIMARY KEY,
  mailbox_address TEXT NOT NULL,
  to_addr TEXT NOT NULL DEFAULT '',
  cc_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_drafts_mailbox_updated
  ON mail_drafts (mailbox_address, updated_at DESC);
