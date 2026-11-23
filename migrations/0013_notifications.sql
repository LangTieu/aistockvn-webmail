CREATE TABLE IF NOT EXISTS notification_settings (
  mailbox_address TEXT PRIMARY KEY,
  push_enabled INTEGER NOT NULL DEFAULT 0 CHECK (push_enabled IN (0, 1)),
  telegram_enabled INTEGER NOT NULL DEFAULT 0 CHECK (telegram_enabled IN (0, 1)),
  telegram_chat_id TEXT NOT NULL DEFAULT '',
  detail_level TEXT NOT NULL DEFAULT 'basic' CHECK (detail_level IN ('basic', 'full')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  mailbox_address TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subs_mailbox ON push_subscriptions (mailbox_address);
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  mailbox_address TEXT NOT NULL,
  message_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('push', 'telegram')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  last_error_code TEXT NOT NULL DEFAULT '',
  UNIQUE (mailbox_address, message_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_notif_outbox_due ON notification_outbox (status, next_attempt_at);
