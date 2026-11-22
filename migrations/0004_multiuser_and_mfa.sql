-- 0004: Multi-user and MFA migration for SQLite/D1
-- Real migration: rename old users table, create new schema, copy rows

-- Step 1: Rename existing users table to users_old
ALTER TABLE users RENAME TO users_old;

-- Step 2: Create new users table with expanded schema
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('super_admin','admin','user')),
  status TEXT NOT NULL DEFAULT 'active',
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Step 3: Copy rows from users_old, generating new UUIDs, role='user', status='active', display_name=email
INSERT INTO users (id, email, display_name, password_hash, role, status, verified, created_at)
SELECT
  lower(hex(randomblob(16))),
  email,
  email,
  password_hash,
  'user',
  'active',
  verified,
  created_at
FROM users_old;

-- Step 4: Create mailboxes table
CREATE TABLE mailboxes (
  address TEXT PRIMARY KEY COLLATE NOCASE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Step 5: Index on mailboxes.user_id
CREATE INDEX IF NOT EXISTS idx_mailboxes_user_id ON mailboxes (user_id);

-- Step 6: Add mailbox_address to messages and backfill
ALTER TABLE messages ADD COLUMN mailbox_address TEXT;
UPDATE messages SET mailbox_address = 'admin@aistockvn.com' WHERE mailbox_address IS NULL;

-- Step 7: Add index on messages for mailbox scoping
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_folder_date ON messages (mailbox_address, folder, date DESC);

-- Step 8: Pre-seed the 3 users with FIXED IDs (plain TEXT literals, no ::uuid casts)
-- Admin with primary mailbox
INSERT INTO users (id, email, display_name, password_hash, role, verified, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'admin@aistockvn.com',
  'Admin',
  NULL,
  'super_admin',
  1,
  unixepoch()
);

INSERT INTO mailboxes (address, user_id, is_primary, is_active)
VALUES ('admin@aistockvn.com', '00000000-0000-0000-0000-000000000001', 1, 1);

-- Tran Binh Han (role user, verified=1, NO mailbox row)
INSERT INTO users (id, email, display_name, password_hash, role, verified, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  'tranbinhanbr01@gmail.com',
  'Tran Binh Han',
  NULL,
  'user',
  1,
  unixepoch()
);

-- Le Than Dong (role user, verified=1, NO mailbox row)
INSERT INTO users (id, email, display_name, password_hash, role, verified, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  'lethanhdongus@gmail.com',
  'Le Than Dong',
  NULL,
  'user',
  1,
  unixepoch()
);