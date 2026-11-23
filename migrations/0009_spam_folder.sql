-- 0009_spam_folder.sql — Extend folder CHECK and add spam scoring columns
--
-- FIX (23:21 18/11): the first version used `INSERT INTO messages_new
-- SELECT * FROM messages` into a table whose column order/set did not match
-- the live table (live has html_body + resend_id, mailbox_address LAST).
-- Positional mapping put mailbox_address (NULL) into spam_score -> NOT NULL
-- failed. This version lists every column explicitly and keeps html_body
-- and resend_id (dropping them would lose data / break reads).

CREATE TABLE IF NOT EXISTS messages_new (
  id TEXT PRIMARY KEY,
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'spam')),
  message_id TEXT,
  in_reply_to TEXT,
  references_hdr TEXT,
  envelope_from TEXT,
  envelope_to TEXT,
  from_addr TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  to_addrs TEXT NOT NULL DEFAULT '[]',
  cc_addrs TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT,
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT,
  date INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  raw_key TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  attachments TEXT NOT NULL DEFAULT '[]',
  resend_id TEXT,
  mailbox_address TEXT,
  spam_score INTEGER NOT NULL DEFAULT 0,
  spam_reasons TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO messages_new (id, folder, message_id, in_reply_to, references_hdr, envelope_from, envelope_to, from_addr, from_name, to_addrs, cc_addrs, reply_to, subject, snippet, text_body, html_body, date, is_read, raw_key, size, attachments, resend_id, mailbox_address, spam_score, spam_reasons)
SELECT id, folder, message_id, in_reply_to, references_hdr, envelope_from, envelope_to, from_addr, from_name, to_addrs, cc_addrs, reply_to, subject, snippet, text_body, html_body, date, is_read, raw_key, size, attachments, resend_id, mailbox_address, 0, '[]' FROM messages;

DROP TABLE messages;

ALTER TABLE messages_new RENAME TO messages;

-- Create spam_blocklist table
CREATE TABLE IF NOT EXISTS spam_blocklist (
  value TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('domain', 'address')),
  created_at INTEGER NOT NULL
);

-- Seed with test fixtures
INSERT OR IGNORE INTO spam_blocklist (value, kind, created_at) VALUES ('spam-example.invalid', 'domain', CAST(strftime('%s', 'now') AS INTEGER));
INSERT OR IGNORE INTO spam_blocklist (value, kind, created_at) VALUES ('scammer@evil.example', 'address', CAST(strftime('%s', 'now') AS INTEGER));
