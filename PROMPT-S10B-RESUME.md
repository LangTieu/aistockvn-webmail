# PROMPT-S10B-RESUME — Tiếp tục dịch webmail sang tiếng Anh (phiên trước bị treo)

## Bối cảnh
Phiên S10B trước đã bị treo (log không ghi thêm gì trong 13 phút, process đã bị kill). File trên đĩa còn dở dang, KHÔNG làm lại từ đầu — kiểm tra trạng thái hiện tại rồi làm tiếp.
Đọc PROMPT-S10B.md trong workdir trước — nó là brief đầy đủ (tên app "AI Stock VN Mail", phạm vi dịch, verify). Nhiệm vụ lần này: HOÀN THÀNH phần còn lại.

## Trạng thái đã biết (kiểm chứng lại, đừng tin mù)
- src/App.tsx: tiêu đề dòng 233 đã là "AI Stock VN Mail", nhưng dòng 915 vẫn còn "Thư AI Stock VN" (còn sót). Một số chuỗi ở khu vực compose/forward đã được dịch bằng sed (vd "Forwarded message", "From:", "Subject:", "To:", "Date:", "(Empty mail)"). Còn ~161 ký tự tiếng Việt rải rác trong file.
- worker/index.ts: các chuỗi lỗi err(...) VẪN CÒN tiếng Việt toàn bộ (vd "Thiếu header", "Email hoặc mật khẩu không đúng", "Email chưa xác minh..."). Chưa dịch.
- worker/auth.ts: còn chuỗi lỗi tiếng Việt (verify Google ID token...). Chưa dịch.
- Test: worker/smoke.e2e.test.ts hiện không còn ký tự tiếng Việt; worker/auth.test.ts còn ~73 ký tự tiếng Việt trong expectation — cần cập nhật theo chuỗi tiếng Anh mới.
- S10 (allowlist admin@ cuối, bỏ email khỏi login, signup verify) đã xong và xanh (38/38 test, tsc 0, build OK) — KHÔNG đụng logic này.

## Việc cần làm
1. Audit: grep toàn bộ chuỗi user-facing còn tiếng Việt trong src/App.tsx, worker/index.ts, worker/auth.ts (chuỗi lỗi + subject/body mail Resend) và expectation trong test. Comment tiếng Việt trong code ĐƯỢC GIỮ — chỉ dịch chuỗi hiện ra cho user.
2. Kiểm tra các sửa sed của phiên trước: chạy `npx tsc --noEmit` ngay đầu; rà lại các chỗ sed đã thay ("Từ:"→"From:", "Tiêu đề:"→"Subject:", "Tới:"→"To:", "Ngày:"→"Date:", "(Thư trống)"→"(Empty mail)") — chỉ được nằm ở đúng chỗ UI nó thuộc về (khối header thư chuyển tiếp / compose), sửa lại nếu sed chạm nhầm chỗ khác.
3. Dịch nốt phần còn lại theo đúng bảng dịch trong PROMPT-S10B.md (dịch cả: tiêu đề dòng 915, mọi chuỗi UI App.tsx còn lại, mọi message lỗi worker, subject/body mail Resend reset + verify).
4. Cập nhật expectation test sang chuỗi tiếng Anh mới (không xóa test nào).
5. Verify: `npx tsc --noEmit` exit 0; `npm run build` OK; `npx wrangler d1 migrations apply aistockvn-mail --local` sạch; khởi động wrangler dev 127.0.0.1:8788 (công thức STATE-S9.md), chạy SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false toàn bộ pass, chạy 2 lần. Tắt dev server bằng PID đã capture, TUYỆT ĐỐI KHÔNG dùng pkill -f "wrangler dev".
6. Grep-verify cuối: không còn chuỗi tiếng Việt nào trong các chuỗi user-facing (render App.tsx, message lỗi worker, subject/body mail). Liệt kê file đã chạm + số chuỗi đã dịch mỗi file.

## Ràng buộc
- KHÔNG deploy, KHÔNG commit. Chỉ làm trong /data/home/webmail-password-auth.
- KHÔNG đổi logic S10. Chỉ đổi chuỗi hiển thị.
- Không in/log secret, không cat .dev.vars. Không bịa kết quả: chỉ báo test pass khi có output thật.
- Cuối cùng ghi STATE-S10B.md: file nào đổi (kèm sha256 từng file), kết quả tsc/build/migrations/test, xác nhận toàn bộ UI + lỗi worker + mail Resend đã sang tiếng Anh, tên app "AI Stock VN Mail". Nếu việc nào chưa xong thì ghi rõ còn thiếu gì và vì sao.
- LƯU Ý: phiên trước treo ở một lệnh gọi model kéo dài. Làm việc theo bước nhỏ, ghi log tiến độ thường xuyên (cập nhật STATE-S10B.md tạm sau mỗi mục lớn) để nếu treo nữa thì phiên sau nối tiếp được.
