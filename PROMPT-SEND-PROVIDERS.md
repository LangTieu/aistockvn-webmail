# PROMPT: Route /api/send theo domain — Resend + MailChannels + send.dev

## Bối cảnh
Webmail Cloudflare Worker trong thư mục này (`/data/home/webmail-r3-codex/`).
Hiện tại `POST /api/send` gửi TẤT CẢ mail qua Resend. Resend từ chối domain
`.eu.cc` ("free public domain") nên phải route theo domain của địa chỉ From.

## Phân công cuối (KHÔNG đổi)
- `aistockvn.com` → **Resend** (giữ nguyên behaviour, kể cả đính kèm).
- `istockvn.eu.cc` → **MailChannels**.
- `icalendar.eu.cc` và `inotion.eu.cc` → **send.dev** (cùng 1 tài khoản, cùng 1 key).
- Domain khác (alias đã enabled nhưng không thuộc 3 loại trên) → **Resend** (fallback,
  behaviour cũ). Không crash, không báo lỗi lạ.

## Code hiện tại (đã đồng bộ với VM, sha đã khớp — KHÔNG cần sync lại)
- Handler `POST /api/send` trong `worker/index.ts` (khoảng dòng 2139): đọc body
  `{from, to, cc, subject, text, replyToId, clientId, draftId, attachments[]}`,
  `attachments` là `{key, filename, size, mimeType}` (file đã upload lên B2,
  `key` là đường dẫn B2). Resolve `fromAddr` qua alias (worker/aliases.ts:
  `lookupAlias` SELECT FROM aliases WHERE local_part=? AND domain=?;
  `lookupDomain` SELECT domain, enabled FROM domains WHERE domain=?).
  Sau đó load bytes đính kèm bằng `loadAttachment(env, key)` (worker/attachments.ts),
  base64 rồi POST `https://api.resend.com/emails`, lưu row Sent với `resend_id`.
- `Env` trong `worker/mail.ts` dòng 7 (`RESEND_API_KEY?: string` dòng 16).
- `MAX_ATTACHMENT_BYTES` = 25MB, `validateAttachmentName`, `loadAttachment` trong
  `worker/attachments.ts`. `textToHtml` trong `worker/mail.ts:257`.
- Test mẫu trong `worker/send.test.ts`: `makeEnv()` + mock D1 + `vi.stubGlobal("fetch", ...)`.
  Chú ý: mock DB hiện tại CHƯA hỗ trợ lookup alias/domain (first() trả null cho
  SELECT aliases/domains) — cần mở rộng mock để test gửi từ alias .eu.cc.
- `resendId` trong response `{id, resendId}` KHÔNG được frontend dùng — trả `null`
  cũng an toàn khi provider không trả id.
- CHỈ sửa handler `/api/send`. Các chỗ gọi Resend khác (mail xác minh tài khoản…)
  GIỮ NGUYÊN trên Resend.

## MailChannels — istockvn.eu.cc (đã kiểm chứng docs.mailchannels.com + blog Cloudflare)
- `POST https://api.mailchannels.net/tx/v1/send`, **KHÔNG header Authorization,
  KHÔNG API key** (xác thực bằng IP Cloudflare; Worker chạy trên Cloudflare).
  Tuyệt đối không tự bịa key.
- Body:
  `{personalizations: [{to: [{email, name}], cc?: [{email, name}]}], from: {email, name}, subject, content: [{type: "text/plain", value}, {type: "text/html", value}], attachments?: [...], headers?: {...}}`
- Attachments: `{type (MIME), filename, content (base64)}`, tối đa 1000 file,
  tổng cộng (file + nội dung) tối đa 30MB — giới hạn 25MB hiện tại vẫn trong ngưỡng.
- Header bị cấm (KHÔNG được set): Authentication-Results, BCC, CC,
  Content-Transfer-Encoding, Content-Type, DKIM-Signature, From, Message-ID,
  Received, Reply-To, Subject, To. `In-Reply-To` và `References` ĐƯỢC PHÉP —
  truyền qua khi reply (như code Resend hiện tại).
- Thành công: HTTP 200, body `{data: [...]}` — **KHÔNG có message id**.
  Lưu `resend_id = NULL`, trả `resendId: null`.
- Lỗi: non-2xx → 502 với message `MailChannels rejected (status): <thông báo>`,
  và ghi audit `send_failed` như code hiện tại.

## send.dev — icalendar.eu.cc + inotion.eu.cc (đã kiểm chứng docs.do.dev)
- `POST https://api.do.dev/v1/send/emails/send`,
  header `Authorization: Bearer <env.SENDDEV_API_KEY>`.
- **TUYỆT ĐỐI KHÔNG hardcode key, KHÔNG đọc/in giá trị key, KHÔNG tìm key trên máy
  này** — key thật không có trên IB4, sẽ được nạp làm Worker secret riêng sau.
  Trong test dùng key giả (vd `"senddev_test_dummy_key"`).
- Body CHỈ gồm các field sau (field lạ bị reject 400 validation_error):
  `{from: {email, name}, to: [string], cc?: [string], subject, text, html, attachments?: [...]}`
  **KHÔNG BAO GIỜ gửi `headers`, `track_opens`, `track_clicks`** — send.dev
  không nhận custom header (kể cả In-Reply-To/References: bỏ qua cho send.dev).
- Attachments: `{filename, contentType, content (base64)}`, tối đa 10 file.
  **Toàn bộ request JSON phải < 241664 bytes** (~236KB, kể cả base64 → ~170KB file thô).
  Cách làm: build xong payload, `JSON.stringify`, nếu độ dài >= 241664 thì trả 400
  với message rõ ràng: đính kèm quá lớn cho send.dev (giới hạn ~170 KB/mail),
  hãy gửi file lớn từ aistockvn.com hoặc istockvn.eu.cc. KHÔNG tự ý bỏ đính kèm.
- Số người nhận: to+cc+bcc tối đa 5 (gói Hobby) — nếu hơn thì trả 400 với message
  rõ ràng TRƯỚC khi gọi API.
- Thành công: HTTP 202, body `{id: "msg_...", status: "queued"}`.
  Provider id = `out.id`, lưu `resend_id`, trả `resendId: out.id`.
- Lỗi: non-2xx → 502 với message `send.dev rejected (status): <thông báo>`,
  và ghi audit `send_failed` như code hiện tại.

## Yêu cầu refactor
1. Thêm `SENDDEV_API_KEY?: string` vào `Env` trong `worker/mail.ts`.
2. Bỏ guard `if (!env.RESEND_API_KEY)` ở đầu handler (nó chặn TẤT CẢ khi thiếu key
   Resend). Thay bằng kiểm tra key THEO provider SAU KHI đã resolve `fromAddr`:
   Resend → cần `RESEND_API_KEY` (503 nếu thiếu); send.dev → cần `SENDDEV_API_KEY`
   (503 nếu thiếu); MailChannels → không cần key.
3. Load bytes đính kèm MỘT LẦN (giữ nguyên check: tổng 25MB, tên file hợp lệ,
   size khớp) thành danh sách chung `{filename, mimeType, base64}`, rồi map sang
   format từng provider (Resend: `{filename, content, content_type}` — giữ nguyên;
   MailChannels: `{type, filename, content}`; send.dev: `{filename, contentType, content}`).
4. Giữ nguyên toàn bộ phần còn lại của handler: validate alias, rate limit ngày,
   reply headers (chỉ truyền cho provider nào cho phép), xóa draft, INSERT row Sent
   (`resend_id` = provider id hoặc NULL), response `{id, resendId}`.
5. Nên (không bắt buộc): tách hàm thuần `pickProvider(fromDomain)`,
   `buildMailChannelsPayload(...)`, `buildSendDevPayload(...)` vào file mới nhỏ
   `worker/send-providers.ts` để dễ test. KHÔNG viết lại `worker/index.ts` từ đầu —
   chỉ sửa đúng đoạn cần sửa (add-only càng tốt).
6. KHÔNG đụng `package.json`, `wrangler.jsonc`, migrations, `STATE.md`.

## Test (bắt buộc)
Thêm test vào `worker/send.test.ts` hoặc file mới `worker/send-routing.test.ts`
(dùng pattern mock có sẵn; mở rộng mock DB để lookup alias/domain trả row enabled):
- MailChannels: gửi từ `admin@istockvn.eu.cc` → fetch đúng 1 lần tới
  `https://api.mailchannels.net/tx/v1/send`, KHÔNG có header Authorization,
  payload có personalizations/from/subject/content; có đính kèm → attachments
  đúng format base64; reply có In-Reply-To trong headers; 200 → response 200,
  row Sent được lưu, `resendId` là null.
- send.dev: gửi từ `admin@icalendar.eu.cc` VÀ từ `admin@inotion.eu.cc` → fetch tới
  `https://api.do.dev/v1/send/emails/send` với `Authorization: Bearer <key giả>`,
  payload có `from: {email, name}`, `to` là array string, và **KHÔNG có key
  `headers`** trong JSON; 202 `{id: "msg_xxx"}` → response 200, `resendId` là "msg_xxx".
- send.dev đính kèm nhỏ → có trong payload; đính kèm lớn (tổng > ~170KB thô) → 400,
  fetch KHÔNG được gọi.
- send.dev > 5 người nhận → 400, fetch KHÔNG được gọi.
- send.dev thiếu `SENDDEV_API_KEY` → 503.
- Resend không đổi: gửi từ `admin@aistockvn.com` → vẫn qua Resend như cũ
  (test hiện có phải vẫn pass).
- Fallback: alias enabled trên domain khác → qua Resend (test qua hàm pickProvider
  nếu mock DB khó dựng).
- **KHÔNG test bằng key thật, KHÔNG gọi API thật** — mọi fetch đều mock.

## Kiểm chứng (bắt buộc, in toàn bộ output)
1. `npx tsc --noEmit` — phải 0 lỗi.
2. `npx vitest run` — toàn bộ test phải pass (ghi rõ số file / số test).
3. Nếu fail thì sửa tới khi pass, không báo xong khi chưa pass.

## Báo cáo cuối (bắt buộc)
Liệt kê: từng file đã đổi + `sha256sum` + số dòng đổi (ngắn gọn), kết quả
`tsc` và `vitest` (số test pass/fail), và bất kỳ điểm nào chưa chắc chắn.
KHÔNG deploy — chỉ sửa code + test tại chỗ.
