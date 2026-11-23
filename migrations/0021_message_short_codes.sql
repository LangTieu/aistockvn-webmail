-- Short links for mail: mỗi message có một short code 8 ký tự base62, duy nhất,
-- dùng cho URL /m/<code>. UUID cũ vẫn hoạt động (API nhận cả hai).
ALTER TABLE messages ADD COLUMN short_code TEXT;

CREATE UNIQUE INDEX idx_messages_short_code ON messages (short_code) WHERE short_code IS NOT NULL;

-- Backfill: sinh mã base62 8 ký tự ngẫu nhiên cho các message đã có.
-- LƯU Ý: KHÔNG dùng scalar subquery / CTE ở đây — D1 tính subquery không
-- tham chiếu cột ngoài đúng 1 lần cho cả câu UPDATE nên mọi hàng nhận cùng
-- 1 mã rồi vỡ UNIQUE index (dính 23/11). Gọi random() trực tiếp 8 lần
-- trong biểu thức SET: mỗi lần gọi là 1 lần tính riêng cho từng hàng.
UPDATE messages
SET short_code =
  substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 1 + (abs(random()) % 62), 1) ||
  substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 1 + (abs(random()) % 62), 1) ||
  substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 1 + (abs(random()) % 62), 1) ||
  substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 1 + (abs(random()) % 62), 1) ||
  substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 1 + (abs(random()) % 62), 1) ||
  substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 1 + (abs(random()) % 62), 1) ||
  substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 1 + (abs(random()) % 62), 1) ||
  substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 1 + (abs(random()) % 62), 1)
WHERE short_code IS NULL;
