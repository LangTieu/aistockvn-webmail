-- 0012_starred.sql — Starred messages (Phase 4 round 2)
--
-- Adds the per-message starred flag used by:
--   POST /api/messages/:id/star
--   GET  /api/messages?starred=1
--   POST /api/messages/batch (action = star / unstar)
-- Existing rows default to 0 (not starred).

ALTER TABLE messages ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_messages_mailbox_starred_date
  ON messages (mailbox_address, is_starred, date DESC);