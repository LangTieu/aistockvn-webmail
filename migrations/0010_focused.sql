-- 0010_focused.sql — Add focused inbox columns and backfill
--
-- Adds is_focused and focused_reasons columns to messages table,
-- then backfills existing inbox mail based on allowlisted senders
-- and replies to sent mail.

ALTER TABLE messages ADD COLUMN is_focused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN focused_reasons TEXT NOT NULL DEFAULT '[]';

-- Backfill: allowlisted senders → is_focused = 1, focused_reasons = ['allowlisted-sender']
UPDATE messages
SET is_focused = 1,
    focused_reasons = '["allowlisted-sender"]'
WHERE folder = 'inbox'
  AND lower(from_addr) IN ('tranbinhanbr01@gmail.com', 'lethanhdongus@gmail.com', 'admin@aistockvn.com');

-- Backfill: replies to sent mail → is_focused = 1, focused_reasons = ['reply-to-sent']
UPDATE messages
SET is_focused = 1,
    focused_reasons = '["reply-to-sent"]'
WHERE folder = 'inbox'
  AND is_focused = 0
  AND in_reply_to IN (SELECT message_id FROM messages WHERE folder = 'sent' AND message_id IS NOT NULL);