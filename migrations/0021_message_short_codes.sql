-- Short links for mail: mỗi message có một short code 8 ký tự base62, duy nhất,
-- dùng cho URL /m/<code>. UUID cũ vẫn hoạt động (API nhận cả hai).
ALTER TABLE messages ADD COLUMN short_code TEXT;

CREATE UNIQUE INDEX idx_messages_short_code ON messages (short_code) WHERE short_code IS NOT NULL;

-- Backfill: sinh mã base62 8 ký tự ngẫu nhiên cho các message đã có.
UPDATE messages
SET short_code = (
  WITH RECURSIVE gen(n, s) AS (
    SELECT 1, substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 1 + (abs(random()) % 62), 1)
    UNION ALL
    SELECT n + 1, s || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 1 + (abs(random()) % 62), 1) FROM gen WHERE n < 8
  )
  SELECT s FROM gen WHERE n = 8
)
WHERE short_code IS NULL;
