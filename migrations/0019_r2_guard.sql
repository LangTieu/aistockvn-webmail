-- migrations/0019_r2_guard.sql
-- R2 billing HARD guard (20/11/2026, Henrry 19:08: rào cứng, không chỉ báo động).
-- R2 là dịch vụ DUY NHẤT trên tài khoản Skillshare01br có thể TỰ TÍNH TIỀN khi
-- vượt mức free: subscription `r2_paid` đang active, vượt 10 GB-month /
-- 1M Class A / 10M Class B thì trừ tiền theo giá niêm yết
-- ($0.015/GB-month, $4.50/M Class A, $0.36/M Class B). Workers / D1 /
-- Workers AI / Observability đều hard-cap trên Free (vượt thì fail/chặn,
-- KHÔNG trừ tiền) nên không cần rào dừng ghi ở đó.
-- Cơ chế: mỗi lần ingest ghi 1 file .eml vào R2 thì cộng dồn vào bảng này.
-- Chạm 8 GB (80% free) hoặc 800K Class A/tháng thì `blocked` = 1 và
-- ingestInbound DỪNG ghi R2 (mail vẫn lưu D1, chỉ thiếu file raw .eml) —
-- không để vượt rồi mới báo. Monitor ngày (cloudflare_billing_guard.py)
-- đọc bảng này để báo WARN 60% / HARD 80% trước khi rào cứng kích hoạt.
CREATE TABLE IF NOT EXISTS r2_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bytes_total INTEGER NOT NULL DEFAULT 0,
  objects_total INTEGER NOT NULL DEFAULT 0,
  class_a_month TEXT NOT NULL DEFAULT '',
  class_a_count INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
-- Seed với mức dùng thật đo ngày 20/11 (bucket aistockvn-mail-raw):
-- 571,746 bytes, 27 objects. Bucket tạo 2026-11-17 nên cả 27 object đều
-- thuộc tháng 2026-11 (Class A tháng này = 27).
INSERT OR IGNORE INTO r2_usage (id, bytes_total, objects_total, class_a_month, class_a_count, blocked, updated_at)
VALUES (1, 571746, 27, '2026-11', 27, 0, unixepoch() * 1000);
