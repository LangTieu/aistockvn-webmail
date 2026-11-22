Workdir: /data/home/webmail-r3-codex. FIX-UP cho vòng vừa rồi — có regression, sửa ngay.

BẰNG CHỨNG (probe trực tiếp API send.dev bằng key thật):
- Gửi kèm field `headers` → 400 validation_error: "'headers' is not supported. Custom headers cannot be set on send.dev messages."
- Gửi không có `headers` → 403 sender_not_verified (payload hợp lệ, chỉ kẹt xác minh sender — vấn đề khác, không liên quan vòng này).

Vòng vừa rồi bạn đã thêm `...(Object.keys(headers).length ? { headers } : {})` vào sendPayload của nhánh send.dev trong `worker/index.ts` — ĐÂY LÀ LỖI: mọi mail reply (có In-Reply-To/References) gửi qua send.dev sẽ bị 400 thay vì gửi được. Bản trước khi sửa đã cố tình KHÔNG gửi headers cho send.dev.

Sửa:
1. `worker/index.ts`, nhánh `provider === "senddev"`: XÓA dòng spread headers khỏi sendPayload. Nhánh send.dev chỉ gửi: from{email,name}, to, cc (nếu có), subject, text, html, attachments (nếu có). KHÔNG gửi headers. Nhánh Resend giữ nguyên (vẫn gửi headers).
2. `worker/send.test.ts`, test "routes istockvn.eu.cc through send.dev with attachments and reply headers": bỏ kỳ vọng `headers` trong payload; thêm assertion payload KHÔNG có key `headers` (để chống regression này quay lại). Giữ lại việc mail reply vẫn lưu in_reply_to/references vào DB Sent (binds) — chỉ bỏ headers khỏi payload gửi đi.
3. Chạy `npx tsc --noEmit` = 0 lỗi; `npx vitest run --exclude worker/smoke.e2e.test.ts` pass hết, ghi rõ số file + số test.
4. Grep `mailchannels` trong worker/ vẫn phải rỗng.

Báo cáo cuối: xác nhận đã xóa headers khỏi payload send.dev + sha256 của worker/index.ts và worker/send.test.ts sau fix + kết quả tsc/vitest. KHÔNG deploy, KHÔNG commit, KHÔNG push.
