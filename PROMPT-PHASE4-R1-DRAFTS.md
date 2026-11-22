# Phase 4 webmail — plan + brief vòng 1 (nháp tự lưu)

Henrry Chốt 13:04 ICT 19/11: làm các tính năng OmniMail có mà webmail mình chưa có.
So sánh thực tế từ code gốc OmniMail (mibgb65-cloud/OmniMail, clone 19/11) với
webmail mình — danh sách thiếu đã verify bằng grep trên cả 2 repo.

## Phase 4 roadmap (1 tính năng / vòng, làm theo thứ tự)

- **R1 — Nháp tự lưu (vòng này):** soạn dở tự lưu, mở lại soạn tiếp. Chi tiết bên dưới.
- **R2 — Gắn sao + xem theo chuỗi + chọn nhiều mail làm 1 lần (tối đa 50).**
- **R3 — Gửi kèm file:** ĐÃ CHỐT riêng (2 tài khoản Backblaze B2, 2 người khác nhau,
  tổng 20GB free, giữ 25MB/mail) — ĐANG CHỜ 2 email đăng ký B2 từ Henrry, chưa làm
  vòng này. Khi có email: file → B2, Resend lấy qua link, Sent lưu key để tải lại.
- **R4 — Thông báo mail mới:** qua trình duyệt + Telegram DM.
- **R5 — Hạn mức dung lượng từng user + thống kê sử dụng.**
- **R6 — Trang quản trị:** hạn mức, cấm/mở user, mời user (thường + tạm thời có hạn).
- **R7 — Gộp hộp thư ngoài (IMAP):** Gmail, iCloud Hide My Email, Outlook,
  QQ, NAVER, Yandex — mỗi nhà cung cấp là 1 vòng riêng sau.
- **R8 — Sao lưu (backups).**
- **R9 — App Android / desktop / extension trình duyệt:** track riêng, không phải Workers.

Mình đã có mà OmniMail không có (giữ nguyên, không làm lại): AI tóm tắt/soạn trả lời,
Focused Inbox, lọc spam chấm điểm, mã hoá lúc lưu trữ.

## Vòng 1 — Nháp tự lưu: việc cần làm

### DB — migration mới `migrations/0011_drafts.sql`
- Bảng `mail_drafts`: `id` TEXT PK (UUID), `mailbox_address` TEXT NOT NULL,
  `to_addr` TEXT, `cc_addr` TEXT, `subject` TEXT, `text` TEXT,
  `reply_to_id` TEXT NULL, `created_at` INTEGER, `updated_at` INTEGER.
- KHÔNG làm file đính kèm trong nháp ở vòng này (đính kèm đi theo R3).
- Quy tắc giữ: mỗi mailbox tối đa **5 nháp chưa gửi** (theo OmniMail); khi lưu
  nháp thứ 6 thì xoá nháp cũ nhất (updated_at nhỏ nhất) của mailbox đó.
- Index `(mailbox_address, updated_at DESC)`.

### Worker — `worker/drafts.ts` mới + route trong `worker/index.ts`
- `POST /api/drafts` — tạo mới hoặc cập nhật (upsert theo `id` nếu client gửi lên,
  không có `id` thì tạo mới). Body JSON `{id?, to, cc, subject, text, replyToId?}`.
  Chỉ lưu khi có nội dung (to/subject/text ít nhất 1 trường non-empty), ngược lại 400.
- `GET /api/drafts` — list nháp của caller, mới nhất trước.
- `GET /api/drafts/:id` — lấy 1 nháp.
- `DELETE /api/drafts/:id` — xoá nháp.
- Tất cả đều allowlist-gated (như các API hiện có) + mailbox-scoped:
  `mailbox_address IN (mailbox của caller)`, nháp của mailbox khác → 404.
- `/api/send` hiện có: nhận thêm `draftId?` — gửi thành công thì xoá nháp đó.
  Không đổi gì khác ở /api/send.

### Frontend — `src/drafts.tsx` mới + sửa `src/App.tsx`, `src/api.ts`
- Thêm mục **Drafts** vào sidebar desktop + thanh menu dưới trên điện thoại
  (làm giống mục Aliases vừa sửa 19/11: mobile nav grid 4 cột + link Drafts).
- Soạn thư (`#/compose`): tự lưu nháp — debounce ~2s sau khi ngừng gõ, chỉ lưu
  khi có nội dung; hiển thị trạng thái "Saved HH:MM" / "Saving…" nhỏ ở cuối khung soạn.
- Mở 1 nháp từ mục Drafts → nạp vào khung soạn để soạn tiếp; gửi xong thì nháp biến mất.
- Nút "Discard draft" trong khung soạn khi đang sửa nháp.
- Toàn bộ UI TIẾNG ANH (app đang tiếng Anh toàn bộ, giữ nguyên).

### Test — `worker/drafts.test.ts` mới (vitest, LUÔN chạy với `--isolate=false`)
- Tạo/lấy/list/xoá nháp; giữ tối đa 5 nháp (lưu nháp thứ 6 xoá nháp cũ nhất);
  nháp của mailbox khác → 404; gửi mail kèm draftId thì xoá nháp; lưu nháp rỗng → 400.
- Cập nhật smoke e2e nếu cần (suite e2e là stateful — D1 local mới + chạy FULL 1 lần).

### Luật làm việc (bắt buộc)
- Làm trong workdir `/data/home/webmail-s11h-gemini` trên IB3. Chỉ sửa các file
  trong scope vòng này: `migrations/0011_drafts.sql`, `worker/drafts.ts`,
  `worker/drafts.test.ts`, `worker/index.ts` (route + draftId ở /api/send),
  `src/drafts.tsx`, `src/App.tsx`, `src/api.ts`. Không động file khác.
- KHÔNG dùng `rm` / `rm -rf` dưới mọi hình thức. KHÔNG commit, KHÔNG push, KHÔNG deploy.
- KHÔNG ghi secret/key/token vào code, log hay file. KHÔNG thêm npm dep mới
  nếu không thật sự cần (nói rõ lý do nếu thêm).
- Verify: `npx tsc --noEmit` = 0 lỗi; `npx vitest run --isolate=false` toàn bộ
  suite pass (hiện 162 test); báo số test pass/fail cụ thể + file đã đổi.
- 'Xong' chỉ khi có output thật của lệnh đã chạy; lệnh lỗi thì báo lỗi, không báo thành công.
