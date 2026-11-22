# Brief cho Codex — Webmail CLI + API key auth

## Mục tiêu
Cho phép điều khiển webmail bằng CLI (không mở browser): liệt kê inbox/sent, đọc mail, gửi mail, tìm kiếm — xác thực bằng API key qua header `X-Api-Key`.

## Bối cảnh (đọc code trước khi sửa)
- Repo: /data/home/webmail-r3-codex/ (Worker `aistockvn-mail`, deploy bằng `npm run deploy`, KHÔNG dùng `wrangler deploy` trực tiếp).
- Auth hiện tại: session cookie `mail_session` (POST /api/auth/password). Các route API mail (messages, search, send, threads) dùng `authUser` từ `verifySession(...)`.
- Secret `MAIL_API_KEY` ĐÃ được nạp vào Worker (người điều phối tự nạp, bạn KHÔNG cần biết giá trị, chỉ đọc `env.MAIL_API_KEY` trong code).
- KHÔNG in/log giá trị key ở bất cứ đâu. KHÔNG commit key. KHÔNG ghi key vào file nào trong repo.

## Việc 1 — API key auth trong Worker (worker/index.ts)
- Thêm helper: nếu request có header `X-Api-Key` và khớp `env.MAIL_API_KEY` (so sánh constant-time nếu có sẵn, tối thiểu so sánh chuỗi thường sau khi trim; key rỗng thì không khớp), thì coi như đã xác thực với `authUser` = mailbox owner (`env.MAILBOX_ADDRESS` đã lowercase; fallback: email đầu tiên trong `env.ALLOWED_EMAILS`).
- Áp dụng cho các route API mail đã dùng session auth: GET /api/messages, GET /api/messages/:id, POST /api/messages/:id/read, POST /api/messages/:id/star, POST /api/messages/batch, GET /api/search, POST /api/send, GET /api/threads, GET /api/threads/:key, POST /api/messages/:id/summary, POST /api/messages/:id/draft-reply, GET /api/config.
- TUYỆT ĐỐI KHÔNG cho API key vào các route admin (/api/admin/*), backup (/api/backup*), auth (/api/auth/*), logout, MFA, external accounts, aliases-admin. Các route đó vẫn chỉ chấp nhận session như cũ.
- API key sai/thiếu + không có session hợp lệ thì trả 401 như cũ. Session hợp lệ vẫn hoạt động bình thường (không phá flow cũ).
- Thêm unit test (vitest) cho: key đúng → 200 trên /api/messages; key sai → 401; không key không session → 401; key đúng trên route admin → vẫn 401/không được vào.

## Việc 2 — CLI Python `mailcli.py` (đặt ở repo root)
- Python 3, chỉ dùng thư viện chuẩn (urllib), không phụ thuộc ngoài.
- Đọc API key từ file `~/.webmail_api_key` (mặc định) hoặc `--key-file <path>`; nếu file không có thì báo lỗi rõ, không hỏi key trên dòng lệnh.
- Base URL mặc định `https://mail.aistockvn.com`, đổi được bằng `--base-url`.
- Header gửi đi: `X-Api-Key: <key>`. KHÔNG in key ra stdout/log, kể cả khi lỗi.
- Các lệnh (in kết quả gọn, dễ đọc, mỗi mail 1 dòng cho list):
  - `mailcli.py inbox [--limit N]` — liệt kê inbox mới nhất: id ngắn (8 ký tự đầu), ngày, người gửi, tiêu đề, trạng thái đã đọc/chưa.
  - `mailcli.py sent [--limit N]` — tương tự cho thư đã gửi.
  - `mailcli.py read <id>` — in đầy đủ: From/To/Subject/Date + nội dung text của mail (id chấp nhận cả id đầy đủ lẫn 8 ký tự đầu nếu duy nhất).
  - `mailcli.py send --to <email> --subject <s> --text <nội dung>` — gửi mail; hỗ trợ `--cc`, `--from` (alias). In ra id mail đã gửi. KHÔNG gửi khi thiếu to/subject/text.
  - `mailcli.py search <từ khóa>` — tìm kiếm full-text, liệt kê kết quả như inbox.
  - `mailcli.py unread` — số mail chưa đọc trong inbox (liệt kê tối đa 20 mail chưa đọc).
  - `mailcli.py status` — kiểm tra key có hoạt động không (gọi /api/config hoặc /api/messages?limit=1), báo OK/FAIL, không in key.
- Xử lý lỗi rõ ràng: 401 → "API key không đúng hoặc chưa nạp, kiểm tra file key và secret MAIL_API_KEY"; lỗi mạng → báo rõ; JSON lỗi từ server → in message của server.
- Viết README ngắn `MAILCLI.md` ở repo root: cách dùng từng lệnh + ví dụ.

## Kiểm tra trước khi báo xong
- `npx tsc --noEmit` = 0 lỗi.
- `npx vitest run --exclude worker/smoke.e2e.test.ts` pass toàn bộ (ghi rõ số test pass).
- Chạy thử CLI với key giả (file tạm) để chứng minh lỗi 401 được báo rõ (không dùng key thật — bạn không có key thật).
- Deploy bằng `npm run deploy` (build frontend trước). Sau deploy, kiểm tra Worker version mới đã live (wrangler version list hoặc gọi /api/config).
- KHÔNG sửa package.json. KHÔNG động vào worker/mail.ts, wrangler.jsonc, thư mục migrations.

## Báo lại
- Tóm tắt thay đổi (file nào, hàm nào), số test pass, Worker version sau deploy, và xác nhận đã deploy bằng npm run deploy.
- Ghi rõ: CLI chưa được test với key thật (người điều phối sẽ test live trên VM).
