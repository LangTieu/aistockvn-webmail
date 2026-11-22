# PROMPT-S10B — Dịch toàn bộ giao diện webmail sang TIẾNG ANH

## Bối cảnh
Repo: /data/home/webmail-password-auth. S10 vừa xong (PROMPT-S10.md trong workdir, đọc nó + STATE-S10.md nếu có):
- admin@aistockvn.com đã vào ALLOWED_EMAILS (CUỐI danh sách, tranbinhanbr01 vẫn đầu tiên).
- Màn hình login đã bỏ dòng hiện email.
- Signup đã có xác minh chủ sở hữu qua mail (bảng email_verifications, migration 0003, endpoint POST /api/auth/verify, password login chặn tài khoản chưa xác minh bằng 403).
Việc của lần này CHỈ là dịch ngôn ngữ — KHÔNG đổi logic nào của S10.

## Bước 0 — kiểm tra trạng thái S10 trước
- Đọc STATE-S10.md nếu có. Chạy `npx tsc --noEmit` và `npx vitest run --isolate=false` (không cần dev server cho unit test) để xác nhận code S10 đang xanh.
- Nếu S10 còn dở/broken (test fail, tsc fail), sửa cho xong theo PROMPT-S10.md TRƯỚC, rồi mới dịch. Không dịch đè lên code đang hỏng.

## Việc cần làm — dịch TẤT CẢ chuỗi user-facing sang tiếng Anh
Tên app: "AI Stock VN Mail". Giữ nguyên tên thương hiệu "AI Stock VN" bên trong câu tiếng Anh (vd subject mail vẫn nhắc AI Stock VN). Không dịch tên riêng, địa chỉ email, URL, mã lỗi kỹ thuật.

### 1. src/App.tsx — toàn bộ UI
Dịch hết: tiêu đề "Thư AI Stock VN" → "AI Stock VN Mail"; tab "Đăng nhập"/"Đăng ký" → "Sign in"/"Sign up"; "Email" (giữ); "Mật khẩu" → "Password"; "Nhập lại mật khẩu" → "Confirm password"; "Quên mật khẩu?" → "Forgot password?"; "hoặc" → "or"; nút "Đăng nhập bản thử (chỉ môi trường local/preview)" → "Sign in to the demo (local/preview only)"; "Hộp thư đến" → "Inbox"; "Đã gửi" → "Sent"; "Soạn thư" → "Compose"; "Tìm kiếm" → "Search"; "Làm mới" → "Refresh"; "Đăng xuất" → "Sign out"; "Quay lại" → "Back"; mọi placeholder, thông báo thành công/lỗi, trạng thái trống, dòng phụ (vd "Đăng nhập bằng tài khoản Google được cấp quyền để đọc và gửi thư." → "Sign in with an authorized Google account to read and send mail."; "Đã gửi link xác nhận, kiểm tra hộp thư" → "Verification link sent — check your inbox"; "Email đã xác nhận, đăng nhập để tiếp tục" → "Email verified — sign in to continue"; "Thư gửi tới địa chỉ @aistockvn.com sẽ xuất hiện ở đây ngay khi được nhận." → "Mail sent to @aistockvn.com will appear here as soon as it arrives."; "Chưa cấu hình Google Client ID nên chưa thể đăng nhập bằng Google." → "Google Client ID is not configured, so Google sign-in is unavailable."; "Máy chủ chưa được cấu hình khóa gửi thư (Resend), nên chưa gửi được." → "The server is not configured with a sending key (Resend), so sending is unavailable.").
"Nút Sign in with Google" đã là tiếng Anh — giữ nguyên.
KHÔNG đổi: logic hiển thị, layout, sidebar vẫn hiện mailbox của user sau khi đăng nhập (đó là dữ liệu, không phải chuỗi UI).

### 2. worker/index.ts + worker/auth.ts — mọi thông báo lỗi trả về frontend
Dịch sang tiếng Anh, giữ nguyên status code và ý nghĩa:
- "Thiếu header" → "Missing header"; "Thiếu credential" → "Missing credential"; "Đăng nhập Google thất bại: ..." → "Google sign-in failed: ..."; "Tài khoản ${email} không có quyền truy cập" → "Account ${email} does not have access"; "Không khả dụng" → "Not available"; "Thiếu email hoặc mật khẩu" → "Missing email or password"; "Email hoặc mật khẩu không đúng" → "Incorrect email or password"; "Email không được phép đăng ký" → "This email is not allowed to sign up"; "Quá nhiều attempt đăng ký" → "Too many sign-up attempts"; "Mật khẩu yếu (tối thiểu 10 ký tự)" → "Weak password (at least 10 characters)"; "Email đã tồn tại" → "Email already exists"; "Thiếu email" → "Missing email"; "Token không hợp lệ" → "Invalid token"; "Token đã được sử dụng" → "Token already used"; "Token đã hết hạn" → "Token expired"; "Thiếu token hoặc mật khẩu" → "Missing token or password"; "Email chưa xác minh, kiểm tra hộp thư để lấy link xác nhận" → "Email not verified yet — check your inbox for the confirmation link"; "Chưa đăng nhập" → "Not signed in"; "Không tìm thấy thư" → "Message not found"; "Thiếu bản gốc thư" → "Original message missing"; "Không có tệp đính kèm" → "No attachment"; "Không tìm thấy tệp" → "File not found"; "Cần ít nhất một người nhận" → "At least one recipient is required"; "Thư trống" → "Empty message"; "Chưa cấu hình RESEND_API_KEY trên server" → "RESEND_API_KEY is not configured on the server"; "Resend từ chối (...)" → "Resend rejected (...)"; "Không tìm thấy" → "Not found"; "Lỗi máy chủ" → "Server error".
- worker/auth.ts: các message lỗi verify Google ID token ("GOOGLE_CLIENT_ID chưa cấu hình", "token sai định dạng", "alg không hợp lệ", "không tìm thấy khóa ký", "chữ ký không hợp lệ", "iss không hợp lệ", "aud không hợp lệ", "token hết hạn", "email chưa xác minh", "SESSION_SECRET thiếu hoặc quá ngắn") cũng dịch sang tiếng Anh vì chúng có thể hiện ra frontend qua message "Google sign-in failed: ...". Giữ nguyên comment tiếng Việt trong code (chỉ dịch chuỗi trả về user).
- "Too many attempts, try again in X minutes" đã là tiếng Anh — giữ nguyên.

### 3. Mail gửi qua Resend (worker/index.ts)
- Forgot-password: subject "Reset mật khẩu cho tài khoản AI Stock VN" → "Reset your AI Stock VN Mail password"; body (html + text) dịch sang tiếng Anh, giữ link https://mail.aistockvn.com/#/reset?token=...
- Verification (signup): subject "Xác nhận email cho tài khoản AI Stock VN" → "Confirm your email for AI Stock VN Mail"; body dịch sang tiếng Anh, giữ link https://mail.aistockvn.com/#/verify?token=...

### 4. Test — cập nhật expectation theo chuỗi tiếng Anh mới
- worker/auth.test.ts + worker/smoke.e2e.test.ts: test nào assert chuỗi tiếng Việt thì sửa expectation sang chuỗi tiếng Anh mới tương ứng. KHÔNG xóa test nào. Không đổi logic test (luồng signup → verify → login, rate-limit, lockout... giữ nguyên).
- Sau khi sửa, toàn bộ suite phải pass.

## Verify (chạy đủ, không báo số khống)
- npx tsc --noEmit → exit 0
- npm run build → OK
- npx wrangler d1 migrations apply aistockvn-mail --local → sạch
- Khởi động wrangler dev 127.0.0.1:8788 (công thức STATE-S9.md), chạy SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false → toàn bộ pass, chạy 2 lần. Tắt dev server bằng PID đã capture, TUYỆT ĐỐI KHÔNG dùng pkill -f "wrangler dev".
- Grep-verify cuối: không còn chuỗi tiếng Việt nào trong các chuỗi user-facing (src/App.tsx render, message lỗi worker, subject/body mail). Comment tiếng Việt trong code được giữ. Liệt kê các file đã chạm và số chuỗi đã dịch mỗi file.

## Ràng buộc
- KHÔNG deploy, KHÔNG commit. Chỉ làm trong /data/home/webmail-password-auth.
- KHÔNG đổi logic S10 (allowlist, bỏ email khỏi login, signup verify, rate-limit, lockout, session cookie). Chỉ đổi chuỗi hiển thị.
- Không in/log secret, không cat .dev.vars.
- KHÔNG bịa kết quả: chỉ báo test pass khi có output thật.
- Cuối cùng ghi STATE-S10B.md: file nào đổi (kèm sha256 từng file), kết quả tsc/build/migrations/test, xác nhận toàn bộ UI + lỗi worker + mail Resend đã sang tiếng Anh và tên app là "AI Stock VN Mail". Nếu việc nào chưa xong thì ghi rõ còn thiếu gì và vì sao.
