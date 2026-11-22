# R5 — Hạn mức dung lượng từng user + thống kê sử dụng (Webmail Phase 4, vòng cuối)

Workdir: `/data/home/webmail-r3-codex/` (đã đồng bộ với VM `~/workspace/aistockvn-webmail`,
đã verify sha256 khớp VM cho worker/index.ts, worker/admin.ts, src/api.ts, src/admin.tsx,
worker/admin.test.ts, package.json ngày 21/11/2026).
Chạy Codex tại workdir này. KHÔNG git commit/push, KHÔNG deploy, KHÔNG sửa file ngoài workdir này
(trừ đọc tham khảo). KHÔNG hardcode key/secret, KHÔNG đọc giá trị key thật.

## Bối cảnh đã verify (đừng đoán lại, đọc code để chắc)

- `GET /api/admin/stats` (`worker/index.ts` ~dòng 916) gọi `getAdminStats` (`worker/admin.ts` ~dòng 332),
  hiện chỉ trả SỐ LƯỢNG (users, mailboxes, messages total/unread/spam/trash, domains, aliases,
  notifications). Chưa có dung lượng/quota/thống kê theo thời gian.
- `messages.size INTEGER NOT NULL DEFAULT 0` (`migrations/0001_init.sql` dòng 21).
  **QUAN TRỌNG: `messages.size` = `raw.byteLength` (toàn bộ MIME thô, ĐÃ gồm attachments được mã hoá
  bên trong) — xem `worker/mail.ts` chỗ `.bind(..., raw.byteLength, JSON.stringify(attachmentMeta(email)), ...)`.
  Vì vậy tổng dung lượng = `SUM(messages.size)`, KHÔNG được cộng thêm tổng size attachments
  (sẽ double-count). Có thể báo riêng `attachmentBytes` (tổng `size` trong JSON cột `attachments`)
  chỉ để tham khảo, nhưng `totalBytes` = `SUM(messages.size)`.
- `messages.mailbox_address TEXT` (thêm ở `migrations/0004_multiuser_and_mfa.sql` dòng 44),
  `messages.date INTEGER` (epoch mili-giây), `messages.folder` ∈ inbox/sent/spam/trash (+ focused là cờ riêng).
- Admin Settings đã có mẫu `sendDailyCap` (`worker/admin.ts` dòng ~114, ~178-185 const
  DEFAULT/MIN/MAX, `getAdminSettings` ~dòng 776, `updateAdminSettings` ~dòng 794):
  đọc + ghi + log `settings_updated` vào bảng `admin_settings` (key-value). Làm quota theo ĐÚNG mẫu này.
- Route settings: `GET/POST /api/admin/settings` (`worker/index.ts` ~dòng 1090-1175), hiện chỉ
  xử lý `sendDailyCap` (+ backup fields). Response trả `sendDailyCap`, `allowedEmails`, ...
- Frontend: `src/api.ts` có `AdminStats` (~dòng 82) + `AdminSettings` (~dòng 176) + `getAdminStats`
  (~dòng 741) + `getAdminSettings`/`updateAdminSettings` (~dòng 792-794).
  `src/admin.tsx`: `AdminStats = Awaited<ReturnType<typeof api.getAdminStats>>` (dòng 17),
  tab Overview render stats qua `extractStatGroups()` (~dòng 180) — hàm này CHỈ render số (number)
  và object lồng nhau, **array bị bỏ qua**, và số byte thô sẽ hiện dạng số dài khó đọc.
  Tab Settings có input `sendDailyCap` (~dòng 293, 514, 787-805). Style sẵn: Tailwind + class
  `inputClass`, `primaryButton`, `outlineButton` ở đầu file. Dùng đúng style/component sẵn có,
  KHÔNG thêm thư viện mới. GIỮ GIAO DIỆN CŨ, chỉ bổ sung, KHÔNG viết lại App.tsx/admin.tsx.
- Test hiện có: `worker/admin.test.ts` (tham khảo cách mock D1 `env.DB` cho `getAdminStats` /
  settings). Chạy test: `npx vitest run --exclude worker/smoke.e2e.test.ts`.

## Việc cần làm

### 1. Backend — mở rộng `getAdminStats` (ƯU TIÊN mở rộng stats hiện có, KHÔNG thêm endpoint mới)

Thêm mục `storage` vào object trả về của `getAdminStats` (`worker/admin.ts` + type `AdminStats`
trong `src/api.ts` — giữ 2 bên khớp nhau):

```ts
storage: {
  totalBytes: number;        // SUM(messages.size) toàn hệ thống
  totalMessages: number;     // COUNT(*) messages (để đối chiếu)
  attachmentBytes: number;   // tổng size trong JSON cột attachments (tham khảo, best-effort; parse lỗi thì bỏ qua mail đó)
  quotaMb: number;           // storageQuotaMb hiện tại (0 = không giới hạn)
  quotaBytes: number;        // quotaMb * 1024 * 1024 (0 khi không giới hạn)
  byMailbox: Array<{
    mailbox: string;         // mailbox_address (rỗng/null -> gom vào "(unknown)")
    messages: number;
    bytes: number;           // SUM(size) của mailbox đó
    percentOfQuota: number | null; // bytes/quotaBytes*100 làm tròn 1 chữ số thập phân, null khi quota = 0
    overQuota: boolean;      // bytes > quotaBytes (false khi quota = 0)
  }>;                        // sắp xếp bytes giảm dần
  daily: Array<{
    date: string;            // 'YYYY-MM-DD' UTC
    received: number;        // folder='inbox' trong ngày đó
    sent: number;            // folder='sent' trong ngày đó
  }>;                        // 30 ngày gần nhất (tính theo UTC, kể cả ngày 0 mail), ngày mới nhất cuối cùng
}
```

- Gom `byMailbox` bằng `GROUP BY mailbox_address` (1 query). Gom `daily` bằng 1 query
  `GROUP BY` ngày UTC từ cột `date` (ms) — dùng `strftime('%Y-%m-%d', date/1000, 'unixepoch')`
  của SQLite/D1, rồi điền đủ 30 ngày (ngày thiếu = 0). Tính ngày trong JS theo UTC cho chắc.
- `messages.size` có thể NULL ở dữ liệu cũ -> dùng `COALESCE(SUM(size),0)`.
- Trả số byte dạng `number`, frontend tự format. KHÔNG chặn nhận/gửi mail khi vượt quota
  ở bất kỳ đâu (chỉ hiển thị + cảnh báo).

### 2. Hạn mức (quota) — `storageQuotaMb` trong Admin Settings

- Thêm `storageQuotaMb` vào `AdminSettings` (`worker/admin.ts`): mặc định **0 = không giới hạn**.
  Lưu vào bảng `admin_settings` key `'storage_quota_mb'`, theo đúng mẫu `sendDailyCap`
  (đọc trong `getAdminSettings`, ghi upsert `ON CONFLICT(key) DO UPDATE`, log `settings_updated`
  với target `'storage_quota_mb'`). KHÔNG cần migration mới (bảng `admin_settings` đã là key-value).
- Validation: số nguyên, `0 <= storageQuotaMb <= 102400` (tối đa 100 GB/user). Sai -> `AdminError(400,
  'invalid_storage_quota_mb')` giống mẫu `invalid_send_daily_cap`.
- `updateAdminSettings`: cho phép cập nhật RIÊNG TỪNG field — `sendDailyCap` và `storageQuotaMb`
  đều optional, chỉ validate + ghi + log field nào được truyền lên; không truyền field nào
  thì giữ nguyên giá trị cũ (không reset về default). Cập nhật type `UpdateAdminSettingsInput`
  và mọi chỗ gọi hàm này cho khớp.
- Route `POST /api/admin/settings` (`worker/index.ts`): nhận thêm `storageQuotaMb` trong body,
  cho phép update khi CHỈ có `storageQuotaMb` (sửa điều kiện `"Nothing to update"` cho đủ),
  trả `storageQuotaMb` trong cả GET và POST response. Type `AdminSettings` trong `src/api.ts`:
  thêm `storageQuotaMb?: number` (optional để tương thích response cũ).
- Chỉ super_admin được đổi quota (giữ nguyên `requireSuperAdmin` của route POST hiện tại).

### 3. Frontend — `src/admin.tsx` (chỉ bổ sung)

- Tab **Overview**: thêm section "Storage" (đặt ngay sau nhóm stats hiện có):
  - Dòng tổng: tổng dung lượng đã dùng (format bytes), tổng số mail, hạn mức/user hiện tại
    (hiển thị "Unlimited" khi quota = 0).
  - Bảng dung lượng từng user/mailbox: cột Mailbox | Messages | Used (format bytes) | Quota |
    % (thanh tiến trình ngang, dùng div + Tailwind sẵn có, KHÔNG thư viện chart) | trạng thái.
    Hàng vượt quota: tô đỏ + nhãn "Over quota". Khi `byMailbox` rỗng thì hiện "No messages yet."
  - Bảng thống kê 30 ngày: cột Date | Received | Sent (ngày mới nhất lên đầu). Đơn giản dạng
    bảng, không cần biểu đồ.
  - Viết helper `formatBytes(n: number): string` trong `src/admin.tsx` (B/KB/MB/GB/TB, 1 chữ số
    thập phân, ví dụ `1.5 MB`, `0 B` khi 0; số âm/null -> `"—"`). Đặt gần `formatStatLabel`.
  - **Tránh trùng lặp khó đọc:** `extractStatGroups()` sẽ tự render `storage.totalBytes`... dạng số
    thô. Hãy loại mục `storage` khỏi phần auto-render (ví dụ truyền stats đã bỏ `storage` vào
    `extractStatGroups`, hoặc skip key `storage` trong hàm) và chỉ render section Storage chuyên biệt.
- Tab **Settings**: thêm input "Storage quota per user (MB)" ngay cạnh input `sendDailyCap`,
  dùng đúng `inputClass` + pattern save/error/message sẵn có của tab Settings (xem code
  `sendDailyCap` ~dòng 787-805 làm mẫu). Nhập 0 = không giới hạn. Validate client: số nguyên >= 0;
  lỗi thì hiện `settingsError`, không gọi API. Sau khi lưu thành công thì refresh cả settings
  lẫn stats (để Overview cập nhật % quota).
- Mọi text UI giữ tiếng Anh như giao diện hiện tại.

### 4. Test (vitest)

- Mở rộng `worker/admin.test.ts` (hoặc thêm file test mới nếu hợp lý hơn, nhưng ưu tiên mở rộng
  file hiện có): test `getAdminStats` trả `storage` đúng — tổng bytes, gom theo mailbox
  (kể cả mailbox null/rỗng -> "(unknown)"), `daily` đủ 30 ngày gồm ngày 0 mail, `percentOfQuota`/
  `overQuota` đúng khi quota > 0 và null/false khi quota = 0; test `getAdminSettings`/
  `updateAdminSettings` với `storageQuotaMb` (mặc định 0, lưu/đọc lại đúng, reject -1 / 102401 /
  số lẻ / chuỗi, update riêng quota không đổi `sendDailyCap` và ngược lại).
- Nếu viết helper `formatBytes` tách riêng thành module dùng chung được thì thêm test cho nó;
  nếu để inline trong `admin.tsx` thì không bắt buộc test riêng.

### 5. Kiểm chứng bắt buộc (không báo xong suông)

- `npx tsc --noEmit` phải = **0 lỗi**.
- `npx vitest run --exclude worker/smoke.e2e.test.ts` phải **pass hết**. Nếu fail thì sửa tới khi pass.
- `npx vite build` phải pass (để chắc frontend build được; nếu script build khác thì dùng đúng
  script trong `package.json`).
- Kiểm tra nhanh bằng tay (không cần deploy): `npx wrangler dev` KHÔNG bắt buộc; thay vào đó
  verify bằng test + `tsc` + `vite build` là đủ. Tuyệt đối KHÔNG deploy (`wrangler deploy` cấm).

## DONE khi nào

- Đủ 3 phần (backend stats+quota, frontend Overview+Settings, test) + `tsc` 0 lỗi + vitest pass hết
  + `vite build` pass.
- Viết file `/data/home/webmail-r3-codex/R5-RESULT.md` ghi: danh sách file đã đổi/tạo + sha256 từng file,
  output `tsc` (0 lỗi), số test pass/fail (tổng số test + số file test), mô tả ngắn tính năng
  (endpoint/thêm field nào, UI thêm ở đâu, quota mặc định bao nhiêu, có chặn mail khi vượt quota không).
- Kết thúc bằng đúng một dòng: `R5 DONE` hoặc `R5 BLOCKED: <lý do cụ thể + bằng chứng lệnh/log>`.
  Nếu lỗi/quota Codex thì báo BLOCKED rõ ràng, KHÔNG bịa kết quả.
