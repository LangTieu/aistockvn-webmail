# Phase 4 — Vòng 2: Starred + Thread view + Batch ops (tối đa 50)

Brief cho model free làm code. Làm đúng spec dưới đây, không tự thêm tính năng ngoài spec.
Repo: `~/workspace/aistockvn-webmail` (VM) / `/data/home/webmail-s11h-gemini` (IB3).
UI tiếng Anh toàn bộ. Không commit/push/deploy. Cấm `rm` mọi file. Không đưa key/secret vào prompt/log/chat.

## Bối cảnh code hiện tại (đã verify, đừng đoán lại)

- Baseline test: `vitest --isolate=false` **167 pass** (162 gốc + 5 drafts). Chạy verify luôn với cờ này.
- `worker/index.ts` 1512 dòng, đã khôi phục đủ 27 pattern `/api/*` sau sự cố vòng R1.
  **BÀI HỌC XƯƠNG MÁU VÒNG R1: TUYỆT ĐỐI KHÔNG viết lại `worker/index.ts` từ đầu.**
  Chỉ sửa phẫu thuật: thêm 1 dòng import + chèn các block route mới. Sau khi sửa, đếm lại số pattern `/api/*`
  phải bằng trước + số route mới, và vitest phải pass hết. Nếu lỡ làm mất route cũ thì dừng, báo fail.
- `GET /api/messages` (`worker/index.ts` ~1062): params `folder` (inbox/sent/spam), `q`, `before`, `limit` (1–100,
  mặc định 30), `tab` (focused/other, chỉ khi folder=inbox). SELECT hiện lấy
  `id, folder, from_addr, from_name, to_addrs, subject, snippet, date, is_read, is_focused, attachments`,
  map qua `listItem`. Mọi query đều scope theo `mailbox_address IN (callerMailboxList)`; rỗng thì `AND 1=0`.
- `POST /api/messages/:id/(summary|draft-reply)` đã có sẵn (~1173) — route star/batch mới đặt theo cùng mẫu.
- Bảng `messages`: `id, folder, message_id, in_reply_to, references_hdr, envelope_from, envelope_to,
  from_addr, from_name, to_addrs, cc_addrs, reply_to, subject, snippet, text_body, html_body, date,
  is_read, raw_key, size, attachments, resend_id, mailbox_address` (+ `is_focused`, `spam_score`,
  `spam_reasons` từ migration 0009/0010). **Chưa có cột starred.**
- Mẫu module theo `worker/drafts.ts`: file module riêng với hàm thuần + class `XxxError`, `index.ts` chỉ import
  và gọi; test riêng `worker/<feature>.test.ts`. `src/api.ts`: **KHÔNG đổi chữ ký hàm cũ** (vòng R1 đã gãy
  `createAlias`/`mfaSetup` vì đổi chữ ký — chỉ thêm hàm mới).
- Frontend `src/App.tsx`: hash routes (`inbox`, `drafts`, `aliases`, `compose`), sidebar desktop + mobile
  bottom nav 4 cột (inbox, drafts, aliases, compose). Thêm mục mới thì làm theo mẫu Drafts (sidebar + mobile nav).
- Migration mới nhất: `0011_drafts.sql` (bảng `mail_drafts`). Migration mới đánh số tiếp `0012_...`.
- D1 local: migration fail UNIQUE nếu local users đã có tranbinhanbr01 (xóa user đó bằng SQL hoặc xóa sqlite
  local `.wrangler/state/v3/d1/...` rồi chạy lại `npm run dev`); `.dev.vars` phải có `TOTP_ENCRYPTION_KEY`.

## Spec vòng 2 (3 tính năng, làm hết)

### 1. Starred (đánh dấu sao)
- Migration `0012_starred.sql`: `ALTER TABLE messages ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0;`
  + `CREATE INDEX IF NOT EXISTS idx_messages_mailbox_starred_date ON messages (mailbox_address, is_starred, date DESC);`
- Module mới `worker/starred.ts` (theo mẫu drafts.ts): `setStarred(db, mailboxList, id, starred)`,
  `StarredError`. Chỉ star/unstar message thuộc mailbox của caller, khác mailbox → 404.
- Route mới (chèn phẫu thuật vào `index.ts`, không viết lại file):
  - `POST /api/messages/:id/star` body `{starred: boolean}` → 200 `{id, is_starred}`; id không thuộc caller → 404.
  - `GET /api/messages?starred=1`: liệt kê message đã star của caller **qua mọi folder** (inbox/sent/spam),
    `ORDER BY date DESC`, phân trang bằng `before`/`limit` như list thường; khi `starred=1` thì bỏ lọc `folder`.
- `GET /api/messages` thường: SELECT thêm `is_starred`, `listItem` trả thêm `is_starred` để list hiển thị trạng thái sao.
- Frontend: nút sao ở mỗi dòng message trong list + trong reading pane (bấm là toggle, cập nhật ngay không cần reload);
  mục **Starred** ở sidebar desktop + mobile nav (theo mẫu Drafts); trang Starred dùng lại list, gọi `?starred=1`.
- `src/api.ts`: thêm `setStarred(id, starred)`, `fetchStarred(before?)`. Không đổi hàm cũ.

### 2. Thread view (xem theo chuỗi)
- Thread key: đi theo chuỗi `in_reply_to` / `references_hdr` về message gốc nhất; message không có cha
  thì tự làm root. `threadKey` = `message_id` của root, nếu root không có `message_id` thì dùng `id` của root.
- Module mới `worker/threads.ts`: `resolveThreadRoot(row, byMessageId)`, `listThreads(db, mailboxList, folder, before, limit)`,
  `getThread(db, mailboxList, threadKey)`, `ThreadsError`.
- Route mới:
  - `GET /api/threads?folder=inbox&before=&limit=` (limit mặc định 30, tối đa 100): mỗi thread 1 dòng
    `{threadKey, subject, participants, count, unreadCount, latestDate, latestId, starred, snippet}`,
    sắp xếp theo `latestDate DESC`. Lấy tối đa 200 message mới nhất trong folder rồi gom nhóm phía server
    (ghi rõ giới hạn này trong comment code); thread chỉ tính message thuộc mailbox của caller.
  - `GET /api/threads/:key`: toàn bộ message trong thread, `ORDER BY date ASC`, đủ field để đọc.
- Frontend: toggle **List / Threads** ở đầu trang Inbox; chế độ Threads liệt kê thread (subject, số message,
  người tham gia, ngày mới nhất, badge unread, sao nếu có message nào trong thread được star); bấm vào thread
  mở các message xếp chồng theo thời gian (mới nhất cuối), mỗi message có nút sao + nút trả lời như cũ.
- `src/api.ts`: thêm `fetchThreads(folder, before?)`, `fetchThread(key)`. Không đổi hàm cũ.

### 3. Batch ops (tối đa 50)
- Module: gom vào `worker/threads.ts` hoặc file riêng `worker/batch.ts` — chọn 1, ghi rõ trong báo cáo:
  `applyBatch(db, mailboxList, ids, action)`, `BatchError`.
- Route mới: `POST /api/messages/batch` body `{ids: string[], action: 'read'|'unread'|'star'|'unstar'|'spam'}`.
  - `ids` rỗng hoặc > 50 → 400. `action` ngoài danh sách → 400.
  - Chỉ tác động message thuộc mailbox của caller; id lạ → bỏ qua (không fail cả batch), trả `{updated: n}`.
  - `spam` = chuyển `folder` thành `'spam'`.
- Frontend: checkbox ở mỗi dòng message trong list (cả chế độ List và Threads — ở Threads thì checkbox chọn cả thread);
  checkbox "chọn tất cả trang này"; khi có lựa chọn thì hiện thanh batch với 5 nút
  (Mark read / Mark unread / Star / Unstar / Move to spam); client chặn chọn quá 50 (báo rõ khi vượt).
- `src/api.ts`: thêm `batchMessages(ids, action)`. Không đổi hàm cũ.

## Verify (bắt buộc, chạy lại độc lập, không tin lời model)

- `npx tsc --noEmit` → **0 lỗi**.
- `npx vitest run --isolate=false` → **pass hết**: 167 baseline + test mới (`worker/starred.test.ts`,
  `worker/threads.test.ts`, test batch trong 1 trong 2 file). Không sửa/xóa test cũ để cho qua.
- Test mới phải cover: star/unstar + 404 khác mailbox; `?starred=1` chỉ trả message đã star;
  thread gom đúng cha-con qua `in_reply_to`/`references_hdr`; batch > 50 → 400; batch action `spam` đổi folder.
- Đếm route `/api/*` trong `index.ts` trước/sau: sau = trước + route mới (star 1 + threads 2 + batch 1 = 4),
  không mất route cũ nào.

## File tạo/sửa (dự kiến)

- Mới: `migrations/0012_starred.sql`, `worker/starred.ts`, `worker/starred.test.ts`,
  `worker/threads.ts`, `worker/threads.test.ts`, `src/starred.tsx` (nếu cần tách view Starred).
- Sửa phẫu thuật: `worker/index.ts` (chỉ thêm import + 4 block route), `src/App.tsx` (nav Starred + toggle
  Threads + checkbox/batch bar), `src/api.ts` (chỉ thêm hàm mới, không đổi hàm cũ).
