# STATE-S10B — Dịch toàn bộ webmail sang tiếng Anh (AI Stock VN Mail)

## Phạm vi
S10 (admin@ vào allowlist cuối, bỏ email khỏi màn hình login, signup xác minh qua mail)
đã xong và xanh trước khi dịch (STATE-S10.md). Lần này CHỈ dịch ngôn ngữ, không đổi logic S10.

## Chân làm việc
- OpenCode nemotron-3.5-lightning-free phiên 1: dịch được một phần src/App.tsx rồi TREO
  (log không ghi thêm trong 13 phút, process alive nhưng 14s CPU — đã kill).
- OpenCode phiên 2 (resume): TREO ngay từ lúc khởi động (chỉ có dòng "> build",
  8 phút không thêm output, 3s CPU — đã kill).
- Workers AI (vn-stock-workersai qua router IB1 :4000, probe trả về completion thật):
  làm phần còn lại — script thay chuỗi chính xác (74 replacements, đếm từng chuỗi)
  + audit cuối bắt thêm 3 placeholder "ten@email.com" và 1 câu subtitle không nhất quán.
  Đây là lần đầu Workers AI làm việc code trực tiếp thay OpenCode/Qoder.

## Files changed (sha256, IB1 workdir /data/home/webmail-password-auth)
- wrangler.jsonc d59bc9f31624a95c6476910276a720e0ba2a0b4701cd6d06f7256cbd0eedbdf4 (S10: admin@ cuối allowlist)
- src/App.tsx e2608f397b4992e786bbb806bf27afbde316d4657313c68d2cb5a3b64c0af492 (S10: bỏ dòng config.mailbox; S10B: toàn bộ UI sang tiếng Anh)
- src/api.ts 43f2625758b9b5d618ad93e2c2ca6de8618f023f3d202436ae8eaefb31704eec (S10: verifyEmail)
- worker/auth.ts 566abc1be1915b4c3905a29654adc99d427ba948232f91665e29c2b0b129e24a (S10: verifyEmailToken; S10B: message lỗi sang tiếng Anh)
- worker/index.ts 95187eac8ece1265084559f9ba0e4526639f9c02b9b970f5e413bf9758e79e02 (S10: signup verify + /api/auth/verify + password chặn chưa verify; S10B: message lỗi + mail Resend sang tiếng Anh)
- worker/auth.test.ts 65a43ee503bc53f2d9b553c61975c417a7c36d569ff3997447a46456a8798773 (S10: test verify; S10B: toThrow("chữ ký") -> toThrow("signature"))
- worker/smoke.e2e.test.ts 86bf077ab90bdf63465e8046d70a1e255213b6d0bdd8bc69953fb1d38eabe6ce (S10: 11 e2e mới)
- migrations/0003_verification.sql 9520ee26a66bdbe7b154a557597ff8da6468bced124ee24990b3257ee71f5af5 (S10)
- index.html: <title>AI Stock VN Mail</title> (đổi từ "Thư AI Stock VN")
- public/manifest.webmanifest: name "AI Stock VN Mail", short_name "Mail"
- STATE-S10.md (S10), STATE-S10B.md (file này), PROMPT-S10.md, PROMPT-S10B.md, PROMPT-S10B-RESUME.md

## Số chuỗi đã dịch
- src/App.tsx: 27 replacements qua script + phần phiên OpenCode 1 đã dịch trước (tiêu đề, form login/signup/forgot, nút, tab) + 3 placeholder ten@email.com -> name@example.com + subtitle "Log in..." -> "Sign in to read and send mail." (audit Workers AI)
- worker/index.ts: 40 replacements (toàn bộ message lỗi + subject/body 2 mail Resend: verify + reset)
- worker/auth.ts: 10 replacements (message lỗi verify Google ID token + SESSION_SECRET)
- worker/auth.test.ts: 1 replacement (expectation toThrow)
- Tổng cộng ~78 chuỗi user-facing sang tiếng Anh. Giữ nguyên: comment tiếng Việt trong code, tên test tiếng Việt (không phải chuỗi user-facing), dữ liệu test ("Xin chào").

## Verification (IB1, tự chạy, output thật)
- npx tsc --noEmit → exit 0
- npm run build → OK (142ms)
- npx wrangler d1 migrations apply aistockvn-mail --local → No migrations to apply (0003 đã apply)
- SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false → 38/38 pass, 2 lần liên tiếp (2 test files)
- Grep-verify: không còn ký tự tiếng Việt nào ở vị trí user-facing (App.tsx / index.ts / auth.ts chỉ còn comment; test chỉ còn tên test + dữ liệu test). Không còn "Thư AI Stock VN" trong src/, index.html, public/.
- config.mailbox chỉ render sau đăng nhập (App.tsx 873 sidebar + 1077/1092 props) — màn hình login không lộ email.
- Audit Workers AI (vn-stock-workersai, router IB1): còn bắt được placeholder "ten@email.com" (3x) và subtitle "Log in..." không nhất quán với "Sign in" — đã sửa, verify lại xanh.

## Xác nhận 2 việc của Henrry + bổ sung
1. admin@aistockvn.com đăng nhập được (Google + mật khẩu) — allowlist cuối danh sách, tranbinhanbr01 vẫn đầu tiên. DONE (S10).
2. Bỏ email khỏi màn hình đăng nhập — dòng {config.mailbox} đã xóa, không còn admin@/aistockvn.com nào pre-sign-in. DONE (S10).
3. Signup xác minh chủ sở hữu qua mail (bắt buộc kèm việc 1) — DONE (S10).
4. Toàn bộ giao diện sang tiếng Anh, tên app "AI Stock VN Mail" — DONE (S10B, lần này).

## Caveat
- E2e lúc 15:59 UTC trong phiên S10 từng fail 2/11 (smoke cũ: list/read + duplicate Message-ID, do D1 local tích lũy qua nhiều lần chạy). Sau đó chạy lại 38/38 pass 2 lần liên tiếp, cả trước và sau các sửa audit. Coi là flaky do state local, không phải regression.
- KHÔNG deploy, KHÔNG commit (theo brief).
