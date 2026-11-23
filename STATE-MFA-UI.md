# STATE-MFA-UI — UI MFA (TOTP) thật cho frontend webmail

Ngày: 2026-11-18. Chân làm: Gemini web chat trên IB3 (CDP 9222, tk Hieu Le Thien).
KHÔNG dùng Agent Router / Qoder / Workers AI. KHÔNG deploy / commit / push.
Base: src/App.tsx v0 từ IB1 (sha 39052ad0…, 1109 dòng) + src/api.ts (sha 788943d7…)
đồng bộ byte-exact lên IB3 workdir /data/home/webmail-s11h-gemini. Workdir thật trên IB1
(/data/home/webmail-omnimail-model) KHÔNG bị ghi đè — file đổi nằm ở thư mục riêng này.

## File đổi (src/ trong /data/home/webmail-mfa-ui/)

| File | Dòng | sha256 |
|---|---|---|
| App.tsx | 1162 | 623b1d9c03559a7027718d074c8f03f2f05b99fa43906fa75d789071fffd0ac6 |
| api.ts | 80 | 85603711770ce606a1a7d852dea74ca18fd0a98f706cfd9d657bef5ca0cac384 |
| mfa.tsx (mới) | 407 | ab39715a7abaeebe8200ec3299ec8efe2b474dae6db8420c71b436e8ae964c7b |
| qr.ts (mới) | 673 | 9c319e579a62a79ba7b0d10a752f122d9b67e99c1b6b3cb81d88a778fc52eb50 |
| qr.test.ts (mới) | 152 | 155cededfdfbb569cf20b126e59e86061103199b5bc387f856f04c9485b2ebad |

## Luồng UI đã làm (tất cả gọi api.mfa* thật, không dữ liệu giả)

- Settings/Bảo mật: route mới `#/security`, link "Security" ở Sidebar (desktop) +
  bottom nav (mobile). `MfaSettingsPanel` gọi `api.mfaStatus()` hiện trạng thái +
  số recovery code còn lại; `ready=false` thì báo MFA chưa khả dụng, không có nút bật.
- Bật: `api.mfaSetup(email)` → QR otpauth render LOCAL bằng qr.ts (không gửi secret
  ra ngoài) + secret hiện tay kèm nút Copy → nhập mã 6 số → `api.mfaConfirm(code)`
  → hiện đúng 8 recovery code 1 lần duy nhất + nút "I have saved them" xóa khỏi state.
- Tắt: nhập mã TOTP 6 số hoặc recovery code → `api.mfaDisable(code)`.
- Login: `loginPassword`/`loginGoogle` trả `mfaRequired:true` → hiện
  `MfaChallengeForm` (nhập mã 6 số hoặc recovery code) → `api.mfaChallenge(code)` →
  xong mới vào mailbox. Type login trong api.ts đã mở rộng `mfaRequired?: boolean`.
- Không copy logic mockup cũ (App.tsx.pre-v0-ib1-backup: recovery "code-1..8" giả,
  nút chết) — chỉ tham khảo vị trí đặt mục MFA.

## Verify trên IB3 (workdir /data/home/webmail-s11h-gemini)

- `npm run typecheck` (tsc app + worker): 0 lỗi.
- `npm run build` (vite): pass; bundle dist có chuỗi "Two-factor authentication"
  và endpoint mfa/challenge, mfa/confirm.
- Full vitest trên fresh D1 (`bash verify-s11h.sh`: migrations --local mới,
  dev server 8788, tsc worker, vitest): lần 1 = 58/58 pass, lần 2 = 58/58 pass.
  Gồm 50 test backend (mfa 8 + auth 28 + smoke e2e 14) + 8 test QR mới.
- QR kiểm chứng độc lập (ngoài vitest): matrix cho URI otpauth khớp 100% encoder
  chuẩn (python qrcode, EC M, version 5); matrix "HELLO" giải mã được bằng OpenCV
  thành "HELLO" và khớp đúng encoder chuẩn mask 2. (Round đầu encoder sai: OpenCV
  decode rỗng, format-info + data lệch; đã sửa qua golden test. Không dùng ảnh QR
  từ dịch vụ ngoài — secret không rời trình duyệt.)
- Grep: mfa.tsx gọi đủ 5 api.mfa* (status/setup/confirm/disable/challenge);
  không còn chuỗi mock ("code-1", dummy, fake) trong 5 file trên.

## Ghi chú

- Runner Gemini trên IB3: run-mfa-ui-1.py (tạo mfa.tsx/qr.ts/qr.test.ts),
  run-mfa-ui-1b.py + run-mfa-ui-1c.py (sửa QR), run-mfa-ui-2.py (mfa_wire.py nối
  vào App.tsx/api.ts). Log: run-mfa-ui-*.log trong workdir IB3.
- mfa_wire.py còn nằm trong workdir IB3 (idempotent, marker `// MFA-UI-WIRED`).
- Chưa kiểm live bằng đăng nhập thật trên production (cần tay anh).
- Bước tiếp theo (khi anh cho): merge 5 file này vào workdir thật IB1
  /data/home/webmail-omnimail-model/src/ rồi build + deploy như luồng S11H.
