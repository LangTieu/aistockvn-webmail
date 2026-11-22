# PROMPT-S10 — Webmail login: cho admin@ đăng nhập + bỏ email khỏi màn hình đăng nhập + signup xác minh email

## Bối cảnh
Repo: /data/home/webmail-password-auth (đã đồng bộ từ VM clone, khớp byte-for-byte, sha256 đã kiểm).
Phase 1 (S9) vừa xong: đăng nhập mật khẩu + đăng ký + quên mật khẩu, 33/33 test pass, đã deploy production.
Đọc STATE-S9.md trước khi làm — nó ghi công thức chạy e2e (wrangler dev 127.0.0.1:8788, SMOKE_BASE, vitest --isolate=false, chạy suite 2 lần) và các lỗi đã gặp.

## Lệnh của Henrry (2 việc, làm ngay)
1. Cho admin@aistockvn.com đăng nhập được (cả Google lẫn mật khẩu). Trước đây admin@ bị chặn vì ALLOWED_EMAILS chỉ có 2 Gmail kia — giờ Henrry chốt admin@ PHẢI đăng nhập được, không cãi nữa.
2. Bỏ email khỏi màn hình đăng nhập. Hiện tại màn hình login show công khai admin@aistockvn.com — Henrry bảo không ai show email ra như vậy.

## Rủi ro bắt buộc phải xử lý kèm (việc 3)
Signup hiện tại KHÔNG xác minh chủ sở hữu email: chỉ cần email nằm trong ALLOWED_EMAILS là tạo tài khoản + nhận session ngay. Địa chỉ admin@ là công khai, nên nếu chỉ thêm admin@ vào allowlist thì bất kỳ ai cũng đăng ký giả mạo admin@ và đọc được hộp thư. Vì vậy việc 1 BẮT BUỘC đi kèm xác minh chủ sở hữu khi đăng ký (việc 3 dưới). Không được bỏ qua việc này.

## Việc cần làm

### 1. wrangler.jsonc — thêm admin@ vào allowlist
ALLOWED_EMAILS thành: "tranbinhanbr01@gmail.com,lethanhdongus@gmail.com,admin@aistockvn.com"
— admin@ ĐẶT CUỐI danh sách. tranbinhanbr01 PHẢI giữ đầu tiên vì endpoint /api/auth/dev dùng phần tử [0] làm tài khoản dev. Không đổi gì khác trong file này.

### 2. src/App.tsx — bỏ email khỏi màn hình đăng nhập
- XÓA dòng 234: <p className="mt-1 text-sm text-slate-500">{config.mailbox}</p>
- Giữ tiêu đề "Thư AI Stock VN". Dòng phụ 236 "Đăng nhập bằng tài khoản Google được cấp quyền để đọc và gửi thư." đã chung chung (không có địa chỉ) — giữ nguyên hoặc rút gọn thành "Đăng nhập để đọc và gửi thư.", tự chọn.
- Kiểm tra mọi chỗ khác render TRƯỚC khi đăng nhập: không được còn chuỗi admin@ hay aistockvn.com nào trên màn hình login (kể cả text gợi ý, placeholder, footer).
- GIỮ NGUYÊN, KHÔNG ĐỤNG: sidebar sau khi đăng nhập vẫn hiện mailbox của chính user (dòng ~875, ~940-942, 1079, 1094). Dòng 462 "Thư gửi tới địa chỉ @aistockvn.com sẽ xuất hiện ở đây ngay khi được nhận." nằm trong trạng thái hộp thư trống SAU khi đăng nhập — kiểm tra ngữ cảnh, nếu đúng là post-sign-in thì GIỮ.
- Endpoint /api/config vẫn trả về mailbox (sidebar post-sign-in cần) — chỉ không render nó trước khi đăng nhập.
- Grep-verify cuối: component Login (pre-sign-in) không render config.mailbox và không chứa chuỗi "admin@" / "aistockvn.com".

### 3. Signup xác minh chủ sở hữu (dùng lại machinery của forgot-password)
- Migration MỚI migrations/0003_verification.sql — KHÔNG sửa migrations/0002_users.sql (đã apply lên D1 production):
  - CREATE TABLE IF NOT EXISTS email_verifications (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  - ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
- POST /api/auth/signup — giữ nguyên: allowlist gate, 3 bucket rate-limit đăng ký (ip-day 10, ip-hour 3, email-hour 3), validate mật khẩu (tối thiểu 10, tối đa 128). Thay đổi phần sau:
  - User đã tồn tại VÀ verified=1 → 409 "Email đã tồn tại" (như cũ).
  - User đã tồn tại VÀ verified=0 → tạo token xác minh MỚI, gửi lại mail xác minh, trả 201 KHÔNG kèm session cookie (cho đăng ký lại khi chưa xác minh).
  - User mới: hash mật khẩu, INSERT với verified=0, tạo token (32 byte ngẫu nhiên, b64url, lưu sha256Hex — đúng pattern của /api/auth/forgot), lưu vào email_verifications (hết hạn 1 giờ), gửi mail xác minh qua Resend (from giống forgot: FROM_NAME <MAILBOX_ADDRESS>, subject "Xác nhận email cho tài khoản AI Stock VN", link https://mail.aistockvn.com/#/verify?token=TOKEN, kèm cả bản text). Trả 201 KHÔNG kèm Set-Cookie. Ở chế độ DEV_LOGIN=1 thì trả thêm token thô trong JSON (giống forgot) để e2e test dùng được.
- POST /api/auth/verify — body {token}: tra email_verifications theo sha256Hex(token). Không thấy → 400 "Token không hợp lệ"; đã dùng → 400 "Token đã được sử dụng"; hết hạn → đánh dấu used rồi 400 "Token đã hết hạn". Hợp lệ → UPDATE users SET verified=1 WHERE email, đánh dấu token used, trả {success:true, email}. KHÔNG cấp session cookie (user đăng nhập sau bằng mật khẩu).
- POST /api/auth/password — sau khi mật khẩu đúng, nếu user.verified !== 1 → 403, message rõ ràng ví dụ "Email chưa xác minh, kiểm tra hộp thư để lấy link xác nhận". Giữ nguyên hành vi dummy PBKDF2 cho email không tồn tại (401 như cũ). Chỉ kiểm tra verified SAU khi mật khẩu đúng.
- /api/auth/forgot và /api/auth/reset: GIỮ NGUYÊN, không đổi. Reset KHÔNG tự động verify email.
- Google sign-in: KHÔNG cần đổi code ngoài allowlist (việc 1) — Google ID token đã tự chứng minh chủ sở hữu (email_verified=true). Không tạo dòng users cho Google sign-in.
- src/api.ts: thêm verifyEmail(token) gọi POST /api/auth/verify; sửa kiểu trả về của signup cho khớp worker mới (không còn session/email trực tiếp).
- src/App.tsx:
  - Đăng ký thành công → hiện trạng thái "Đã gửi link xác nhận, kiểm tra hộp thư" (không tự đăng nhập, không gọi onDone).
  - Route mới #/verify?token=... theo đúng pattern route #/reset hiện có (App.tsx dòng ~13, ~23, ~1019-1055): khi mở trang thì gọi api.verifyEmail(token); thành công → hiện "Email đã xác nhận, đăng nhập để tiếp tục" rồi chuyển về form đăng nhập; thất bại → hiện lỗi trả về. Tái dùng layout của trang reset.

### 4. Test — cập nhật worker/auth.test.ts + worker/smoke.e2e.test.ts
Bao phủ:
- Signup email allowlisted mới → 201, KHÔNG có header Set-Cookie, dòng users có verified=0.
- Đăng nhập mật khẩu trước khi xác minh → 403 (không phải 401, không phải 200).
- Verify bằng token DEV → 200; sau đó đăng nhập mật khẩu → 200 + Set-Cookie.
- Verify bằng token sai / đã dùng / hết hạn → 400.
- Đăng ký lại email chưa xác minh → 201 lại, không session, token mới dùng được.
- Google admin@ được phép: unit test isAllowed("admin@aistockvn.com", "tranbinhanbr01@gmail.com,lethanhdongus@gmail.com,admin@aistockvn.com") === true.
- Toàn bộ 33 test cũ phải pass. Chạy toàn bộ suite 2 lần liên tiếp (e2e phải chịu được D1 local tồn tại qua các lần chạy — học cách S9 làm: chấp nhận 201/409/429, dùng email test riêng; đọc file e2e hiện tại trước).

### 5. Verify (chạy đủ, không báo số khống)
- npx tsc --noEmit → exit 0
- npm run build → OK
- npx wrangler d1 migrations apply aistockvn-mail --local → sạch (0003 apply được)
- Khởi động wrangler dev 127.0.0.1:8788 (theo công thức STATE-S9.md), chạy SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false → toàn bộ pass, chạy 2 lần. Tắt dev server bằng PID đã capture, TUYỆT ĐỐI KHÔNG dùng pkill -f "wrangler dev" (tự match chính mình).

## Ràng buộc
- KHÔNG deploy, KHÔNG commit. Chỉ làm trong /data/home/webmail-password-auth.
- KHÔNG đụng: sidebar mailbox post-sign-in, /api/auth/dev, luồng forgot/reset, luồng Google (ngoài allowlist), from-address Resend, định dạng session cookie.
- Không in/log secret, không cat .dev.vars.
- KHÔNG bịa kết quả: chỉ báo test pass khi có output thật của lệnh đã chạy.
- Cuối cùng ghi STATE-S10.md: file nào đổi (kèm sha256 từng file), kết quả tsc/build/migrations/test, xác nhận 2 việc của Henrry đã xong + signup giờ xác minh qua mail. Nếu việc nào chưa xong thì ghi rõ còn thiếu gì và vì sao, không báo xong khống.
