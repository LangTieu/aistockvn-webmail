# R5 — Vòng sửa: cập nhật test cũ + bổ sung test quota/storage + chạy đủ kiểm chứng

Workdir: `/data/home/webmail-r3-codex/` (code R5 vòng 1 đã nằm ở đây, KHÔNG làm lại từ đầu).
KHÔNG git commit/push, KHÔNG deploy (`wrangler deploy` cấm), KHÔNG hardcode key/secret.

## Trạng thái vòng 1 (đã verify)

- `npx tsc --noEmit` = 0 lỗi (pass).
- `npx vitest run --exclude worker/smoke.e2e.test.ts` = **344 pass, 1 fail**.
- Fail duy nhất: `worker/admin.test.ts` dòng 545, test `getAdminStats` cũ dùng `expect(stats).toEqual({...})`
  với expected KHÔNG có mục `storage`, trong khi `getAdminStats` nay trả thêm `storage`
  (totalBytes/totalMessages/attachmentBytes/quotaMb/quotaBytes/byMailbox/daily 30 ngày).
- Thiếu test mới cho quota và storage theo brief vòng 1 mục 4. `vite build` chưa chạy.
- Chưa tạo `R5-RESULT.md`.

## Việc cần làm (chỉ 3 việc, theo thứ tự)

### 1. Sửa test cũ `worker/admin.test.ts` dòng ~545

- Đọc kỹ mock `env.DB` của test đó + implementation `getAdminStats` trong `worker/admin.ts`
  để tính đúng expected cho mục `storage` (tổng bytes, byMailbox, daily 30 ngày).
- Cập nhật expected `toEqual` để gồm `storage` đầy đủ. CHÚ Ý: `daily` phụ thuộc "hôm nay"
  (ngày cuối = ngày UTC hiện tại) nên expected phải tính động từ ngày hiện tại (hoặc freeze
  `Date.now` theo cách test hiện có trong file đang dùng, nếu có) — KHÔNG hardcode ngày
  2026-11-16..21, nếu không test sẽ fail vào ngày khác.
- KHÔNG sửa implementation để né test, KHÔNG xoá/bỏ qua test cũ, KHÔNG dùng `toMatchObject`
  để lách (giữ `toEqual` toàn bộ object như cũ, chỉ bổ sung expected).

### 2. Bổ sung test mới (brief vòng 1 mục 4)

Trong `worker/admin.test.ts` (ưu tiên mở rộng file hiện có):
- `getAdminStats` trả `storage` đúng: tổng bytes (`SUM(messages.size)`), gom theo mailbox
  (kể cả mailbox null/rỗng -> `"(unknown)"`), `daily` đủ 30 ngày gồm ngày 0 mail,
  `percentOfQuota`/`overQuota` đúng khi quota > 0 và null/false khi quota = 0.
- `getAdminSettings`/`updateAdminSettings` với `storageQuotaMb`: mặc định 0, lưu/đọc lại đúng,
  reject -1 / 102401 / số lẻ / chuỗi, update riêng quota không đổi `sendDailyCap` và ngược lại.
- Nếu `formatBytes` đã tách thành module dùng chung được thì thêm test cho nó; nếu inline
  trong `src/admin.tsx` thì không bắt buộc.

### 3. Chạy đủ kiểm chứng (không báo xong suông)

- `npx tsc --noEmit` phải = **0 lỗi**.
- `npx vitest run --exclude worker/smoke.e2e.test.ts` phải **pass hết** (0 fail).
- `npx vite build` (hoặc đúng script build trong `package.json`) phải pass.
- Nếu fail thì sửa tới khi pass, không dừng ở BLOCKED khi lỗi còn sửa được.
- Viết file `/data/home/webmail-r3-codex/R5-RESULT.md` ghi: danh sách file đã đổi/tạo
  (vòng 1 + vòng sửa) + sha256 từng file, output `tsc` (0 lỗi), số test pass/fail
  (tổng số test + số file test), kết quả `vite build`, mô tả ngắn tính năng
  (endpoint/field thêm nào, UI thêm ở đâu, quota mặc định bao nhiêu, có chặn mail khi vượt quota không).
- Kết thúc bằng đúng một dòng: `R5 DONE` hoặc `R5 BLOCKED: <lý do cụ thể + bằng chứng lệnh/log>`.
  Chỉ báo BLOCKED khi đã thử sửa mà vẫn không pass, kèm log lỗi cụ thể.
