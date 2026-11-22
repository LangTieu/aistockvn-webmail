# Fix: mail gửi từ alias không hiện trong Sent (mailbox_address lưu sai)

## Bug (đã verify bằng dữ liệu thật, 19/11 ~22:00)
- Mail reply gửi tới Yahia (Context.dev) lúc 21:56 từ `contextdev-yp9x@aistockvn.com`:
  Resend đã nhận (resend_id `01a1f44e-bc9e-7187-808a-655ff3247bde`), D1 đã có row
  folder=`sent` — nhưng Sent folder + search trong webmail KHÔNG hiện nó.
- Nguyên nhân: route gửi `/api/send` (worker/index.ts:1469) khi gửi từ alias thì
  `fromAddr` = địa chỉ alias (dòng 1499–1509), và INSERT (dòng 1559–1568) lưu
  `mailbox_address = fromAddr` (tức alias), trong khi mọi chỗ đọc
  (list :827/:1086/:1101, search :844, count :1242/:1251, mở 1 mail :1299/:1353,
  reply-thread :1520) đều lọc `mailbox_address IN (callerMailboxList)` — mà
  callerMailboxList (dòng 800–812) chỉ gồm mailbox của user + shared
  MAILBOX_ADDRESS (admin@aistockvn.com), KHÔNG có alias.
- Bằng chứng D1: sent có 3 row mailbox_address=admin@ (hiện đủ) + 1 row
  mailbox_address=contextdev-yp9x@ (mất tích). Mail inbound của Yahia có
  mailbox_address=admin@ nên vẫn hiện trong Inbox — chỉ phía gửi bị sai.

## Fix (1 chỗ, giữ nguyên mọi thứ khác)
- Trong `/api/send`, INSERT row sent với `mailbox_address = sharedMailbox`
  (env.MAILBOX_ADDRESS, dòng 1479) — cùng quy ước với inbound ingest (mọi mail
  về đều lưu dưới admin@). Giữ nguyên `from_addr = fromAddr` (alias) để From
  hiển thị đúng địa chỉ alias đã gửi.
- Nếu `aliasRow` (lookupAlias) có trường mailbox chủ sở hữu thì dùng mailbox đó
  thay sharedMailbox — kiểm chứng bằng code + D1 trước khi chọn, không đoán.
- KHÔNG đổi: callerMailboxList, list/search/open, From hiển thị, Resend call,
  route count (vòng này không thêm route).

## Data fix (Main đã làm, khỏi làm lại)
- Row id `5b9f991a-d149-4fee-9db3-330f32fe0786` đã UPDATE
  mailbox_address → `admin@aistockvn.com` (22:00 19/11, đã verify bằng SELECT).

## Verify (bắt buộc, độc lập)
- Lệnh đúng: `npx tsc --noEmit && npx vitest run --isolate=false --exclude worker/smoke.e2e.test.ts`
  (exit 0 thật; `vitest run` trần luôn exit 1 vì smoke.e2e thiếu SMOKE_BASE — không báo FAIL vì đó).
- Test hồi quy: gửi thử từ 1 alias → row mới có mailbox_address = sharedMailbox,
  hiện trong Sent list, search tìm thấy, mở được bằng id; gửi từ admin@ vẫn như cũ.
- Baseline: App.tsx dedup 1949 dòng sha 3d653bf6 + shared-mail-views.tsx 376 dòng
  sha 7d68b609 (workdir IB3 /data/home/webmail-r4-neon/ — R4 đang chạy ở đó, làm
  TIẾP SAU khi R4 xong, TUẦN TỰ, không đụng file R4 đang sửa).

## Cấm
- KHÔNG deploy, KHÔNG commit/push, KHÔNG sync VM (Main giữ deploy-gate). Cấm `rm`.
- KHÔNG bịa: mọi con số phải có bằng chứng lệnh/log/D1.
