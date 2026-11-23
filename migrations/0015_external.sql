CREATE TABLE IF NOT EXISTS external_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('gmail')),
  email TEXT NOT NULL,
  credential_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disabled', 'syncing')),
  last_seen_uid INTEGER NOT NULL DEFAULT 0,
  uid_validity INTEGER,
  last_synced_at INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, provider, email)
);
CREATE INDEX IF NOT EXISTS idx_external_accounts_user ON external_accounts (user_id);

ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'omnimail';
ALTER TABLE messages ADD COLUMN external_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_source_account ON messages (source, external_account_id);

-- Bẫy dedup (§0): thay UNIQUE toàn cục (folder, message_id) bằng UNIQUE theo từng mailbox,
-- để cùng một Message-ID về 2 tài khoản vẫn lưu được 2 row. Dữ liệu hiện tại thỏa UNIQUE cũ
-- (chặt hơn) nên thỏa UNIQUE mới — migration an toàn.
DROP INDEX IF EXISTS idx_messages_folder_msgid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_mailbox_folder_msgid
  ON messages (mailbox_address, folder, message_id) WHERE message_id IS NOT NULL;
