# PROMPT — Phase 4 R3: Gửi file đính kèm (Attachments) qua Backblaze B2

## Mục tiêu
Người dùng soạn thư trong webmail có thể đính kèm file (nút kẹp giấy ở Compose),
gửi đi kèm file, giới hạn **25MB/mail**. Nhận + tải file đính kèm đã làm được
từ trước (đọc từ R2 raw + `/api/messages/:id/attachments/:index`); R3 chỉ làm
chiều **GỬI**.

## Hạ tầng B2 — ĐÃ XONG, không tạo lại
- Tài khoản: backblaze01-4z4b@aistockvn.com (TK1). TK2 (backblaze02) chưa có.
- Bucket: `aistockvn-mail-attachments`, loại **Private** (Private KHÔNG cần thẻ;
  chỉ Public mới đòi thẻ/$1 — đã kiểm chứng live 21/11). Endpoint
  `s3.eu-central-003.backblazeb2.com`. Mã hoá SSE-B2 bật. Object Lock tắt.
- Application key: `webmail-attachments`, giới hạn theo bucket, quyền Read+Write
  (listFiles/readFiles/writeFiles/deleteFiles + đọc/ghi bucket metadata).
  Key lưu file 0600 tại `~/.b2_webmail_attachments.json` (VM + IB3).
- Worker secrets đã nạp cho Worker `aistockvn-mail` (đừng đổi tên):
  `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`, `B2_S3_ENDPOINT`.
  Kiểm bằng `wrangler secret list`. Giá trị key KHÔNG ghi vào code/log/repo/chat.

## Thiết kế (vì bucket là Private, không phải Public)
- Resend KHÔNG tải được từ URL công khai. Worker phải tự lấy file từ B2 rồi
  đính kèm vào lời gọi Resend (base64 `content`). Trước khi code, xác minh
  Resend API hiện tại có nhận attachment qua URL không; nếu có thì dùng URL
  có chữ ký (presigned, hết hạn ngắn) cho nhẹ, nếu không thì đi đường base64.
  Đường nào cũng phải chạy được với file tới 25MB trong giới hạn Worker.
- Luồng gửi: browser → Worker (multipart/form-data, nhiều file) → Worker
  upload từng file lên B2 (S3-compatible API, key = random uuid + tên gốc) →
  Worker gọi Resend kèm file (base64 hoặc presigned URL) → lưu thư đã gửi
  vào D1 + raw vào R2 như luồng gửi hiện tại (kèm metadata attachments).
- Giới hạn: tổng file ≤ 25MB/mail (chặn ở cả UI lẫn Worker, báo rõ bằng
  tiếng Anh); chặn file thực thi (.exe/.bat/.sh/.js... — danh sách rõ trong
  code); tên file giữ nguyên, không cho đường dẫn lắt léo (`../`).
- Dọn dẹp + rào B2: file đính kèm ở B2 giữ theo thư đã gửi. Theo dõi dung
  lượng B2 đã dùng (đếm qua B2 API hoặc D1); khi ≥ 9GB/10GB thì chặn upload
  mới và báo rõ, nhưng vẫn cho gửi thư không kèm file. TK2 thêm sau: code
  phải đọc được secret nhóm 2 (`B2_KEY_ID_2`...) khi có, nhưng v1 chỉ chạy
  TK1 — không chặn v1 vì thiếu TK2.

## Frontend (giữ giao diện cũ, chỉ gắn thêm)
- Nút đính kèm (kẹp giấy) trong Compose, chọn nhiều file; danh sách file đã
  chọn kèm tên + dung lượng + nút xoá; hiển thị tổng dung lượng + giới hạn
  25MB; lỗi vượt giới hạn hiện ngay trong Compose. Không viết lại App.tsx,
  không đổi layout Proton hiện tại.

## Backend
- Route upload nhận multipart (nhiều file), trả về danh sách file đã lên B2
  (key + tên + size). Route gửi (`/api/send`) nhận thêm danh sách file đính
  kèm (key B2) và đính kèm khi gọi Resend. Dùng S3-compatible API của B2
  (endpoint + key/secret đã có), không dùng SDK nặng nếu fetch thuần đủ.
- Không đổi hành vi gửi hiện tại khi không có file đính kèm. Không đụng
  rào billing R2 (`worker/r2-guard.ts`), R8 backup, FTS (migration 0020).

## Kiểm thử + bàn giao
- Vitest: upload 1 file + nhiều file; gửi kèm file (mock B2 S3 + Resend);
  vượt 25MB bị chặn; file thực thi bị chặn; gửi không file vẫn như cũ.
  `npx vitest run` phải pass (dùng isolated; `--isolate=false` gây fail giả).
- Bàn giao file về kèm STATE.md: danh sách file đổi + sha256, cách test,
  giới hạn còn lại (TK2, dọn dẹp B2). Không deploy, không commit, không push.
  Đồng bộ theo `R8_SYNC_GUARD.md`: KHÔNG sync `worker/mail.ts` +
  `wrangler.jsonc` từ IB3; KHÔNG sync cả thư mục migrations từ IB3
  (IB3 chỉ tới 0017, VM có 0018/0019/0020).

## Cấm
- Không dùng Master Application Key (quyền quá rộng). Không ghi giá trị key
  vào code/log/repo/chat/session. Không đổi bucket sang Public (sẽ đòi thẻ).
  Không premium-gate tính năng này (luật: tính năng mới miễn phí).
