-- 0006: Backfill primary mailboxes for users without one and backfill messages.mailbox_address

INSERT OR IGNORE INTO mailboxes (address, user_id, is_primary, is_active)
SELECT lower(trim(email)), id, 1, 1
FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM mailboxes WHERE mailboxes.user_id = users.id
);

UPDATE messages
SET mailbox_address = lower(trim(envelope_to))
WHERE mailbox_address IS NULL
  AND envelope_to IS NOT NULL
  AND trim(envelope_to) != '';
