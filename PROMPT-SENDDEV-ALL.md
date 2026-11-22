Workdir: /data/home/webmail-r3-codex (repo webmail, đã đồng bộ với VM, đừng sync lại từ VM).

NHIỆM VỤ: Chuyển istockvn.eu.cc từ MailChannels sang send.dev. MailChannels free API đã chết từ 30/06/2024 (trả 401) — GỠ HẲN provider này khỏi code.

Thay đổi:
1. `worker/send-providers.ts`: `pickProvider` trả "senddev" cho cả 3 domain .eu.cc (istockvn.eu.cc, icalendar.eu.cc, inotion.eu.cc); aistockvn.com và domain khác vẫn "resend". Xóa type "mailchannels" khỏi union nếu không còn dùng.
2. `worker/index.ts`: gỡ sạch hàm/nhánh gửi qua MailChannels (endpoint api.mailchannels.net, payload personalizations, xử lý resend_id NULL cho MailChannels). Chỉ còn 2 đường gửi: Resend và send.dev. Giữ nguyên mọi guard send.dev đã có: thiếu SENDDEV_API_KEY → 503; tổng người nhận (to+cc) > 5 → 400; JSON request >= 241664 byte (~170KB file thô) → 400 kèm hướng dẫn gửi file lớn từ aistockvn.com. Đính kèm KHÔNG được bỏ lặng. Giữ nguyên behaviour Resend (kể cả Idempotency-Key, đính kèm).
3. `worker/send.test.ts`: bỏ các test MailChannels; thêm test routing istockvn.eu.cc → send.dev (gửi thành công qua send.dev, đính kèm, reply headers); giữ lại các test send.dev (icalendar, inotion, guard size/recipient/key) và fallback Resend. Mock DB lookup alias/domain mở rộng sẵn có thì dùng lại, đừng viết lại file.
4. Grep toàn bộ worker/ sau khi sửa: KHÔNG còn chuỗi "mailchannels" (không phân biệt hoa thường) ở bất cứ đâu — kể cả comment, test, tên biến. Nếu còn chỗ nào bắt buộc giữ (ví dụ migration cũ không được đụng) thì liệt kê rõ trong báo cáo cuối; còn không thì xóa hết.

RÀNG BUỘC:
- Chỉ sửa file cần thiết, phẫu thuật từng chỗ, KHÔNG viết lại file nào từ đầu. KHÔNG đụng package.json, wrangler.jsonc, migrations/, STATE.md.
- KHÔNG hardcode API key, KHÔNG đọc giá trị key thật (key send.dev chỉ có trên VM, không có trên máy này — trong test chỉ dùng key giả).
- `worker/mail.ts` đã có `SENDDEV_API_KEY?: string` trong Env — giữ nguyên, không cần đổi trừ khi type MailChannels còn sót.

KIỂM CHỨNG (bắt buộc, không báo xong suông):
- `npx tsc --noEmit` phải = 0 lỗi.
- `npx vitest run --exclude worker/smoke.e2e.test.ts` phải pass hết (ghi rõ số file + số test).
- Nếu fail thì sửa tới khi pass.

Báo cáo cuối: liệt kê file đổi + sha256 từng file, kết quả tsc, số test pass, xác nhận grep "mailchannels" trong worker/ trả về rỗng. KHÔNG deploy, KHÔNG commit, KHÔNG push.
