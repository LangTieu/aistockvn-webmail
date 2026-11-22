# OmniMail grounding — bản đồ kiến trúc cho Phase 4 (R4 / R6 / R7 / R8 / quan sát hệ thống)

Nguồn: `~/workspace/omnimail-upstream` (github.com/mibgb65-cloud/OmniMail, clone mới về VM 19/11, 11M).
Bản này chỉ là nguồn tham khảo KIẾN TRÚC — không copy code mù, chỉ học cơ chế rồi thiết kế
theo stack của mình (1 Worker + React SPA + D1, repo `~/workspace/aistockvn-webmail`).

## 0. Điểm khác biệt lớn cần nhớ

- OmniMail chạy **Hono + nhiều Worker/Queue/Workflow** (email-worker riêng, `NOTIFICATION_QUEUE`,
  `OmniMailBackupWorkflow`); mình chạy **1 Worker duy nhất, không queue, không cron, không workflow**
  (`wrangler.jsonc` của mình chỉ có DB + RAW + AI). Mọi thiết kế R4–R8 phải sống được trong
  giới hạn này (Workers Free, CPU 10ms/request) — hoặc ghi rõ binding mới cần thêm.
- OmniMail **KHÔNG có browser push (Web Push / VAPID)**. Tính năng "notifications" của họ
  (`email-worker/src/features/notifications/mail-notification-api.ts`) là **API danh sách
  thông báo trong app, kiểu poll** (client gọi `GET` lấy thư chưa đọc mới nhất, có cache theo
  version). Browser push cho R4 là thiết kế mới của mình theo chuẩn Web Push, không có mẫu
  sẵn trong OmniMail.
- OmniMail đa nguồn ngay từ đầu (8 nguồn: omnimail, icloud, linuxdo, gmail, microsoft, qq,
  naver, yandex); mình hiện chỉ có 1 nguồn (mail @aistockvn.com vào D1). R7 vì vậy là việc lớn,
  làm từng provider một.

---

## 1. R4 — Thông báo trình duyệt + Telegram

### 1a. Telegram (có mẫu đầy đủ — học theo)

**Tài liệu:** `docs/TELEGRAM_NOTIFICATIONS.md` (61 dòng, đủ đọc),
`docs/TELEGRAM_NOTIFICATION_INTEGRATION_PLAN.md` (159 dòng).

**Module:**
- `email-worker/src/features/telegram/telegram-client.ts` (129 dòng) — gọi Bot API:
  `POST https://api.telegram.org/bot<token>/<method>`, timeout 10s (20s cho document),
  `getMe`, `setWebhook`, `sendMessage`, `sendRichMessage` (không tồn tại trong Bot API
  chuẩn — đây là API mở rộng riêng của họ, bỏ qua), `sendDocument`. Lỗi map thành
  `TelegramApiError{code, retryable, retryAfter}`: 429 → `telegram_rate_limited`
  (retryable, tôn trọng `retry_after`), 403 → `telegram_forbidden` (không retry, endpoint
  chuyển `blocked`), 5xx → `telegram_server` (retryable). Token validate bằng regex
  `^\d{5,20}:[A-Za-z0-9_-]{20,200}$` TRƯỚC khi gọi; token nằm trong URL nên **không bao
  giờ ghi raw error vào log**.
- `email-worker/src/features/telegram/telegram-delivery.ts` (256 dòng) — consumer của queue:
  claim bằng lease (`lease_until`, 120s) + `attempts`, tối đa 5 lần, backoff
  `min(3600, 30 * 2^(attempts-1))` giây. Nội dung mặc định CHỈ có nguồn + link mở thư
  trong web (không tên người gửi, không tiêu đề — người dùng bật thêm mới có, `detail_level`:
  `basic | sender | subject`). Body chỉ gửi khi bật `include_body`, chỉ cho mailbox chính,
  text ≤ 1MB (dài hơn → gửi file `.txt`), rich HTML có fallback về text. DND (quiet hours +
  IANA timezone): thư trong giờ im lặng bị **bỏ luôn, không bù**. Thư đã đọc → skip.
  `sendMessage` dùng `link_preview_options: {is_disabled: true}`, `protect_content: true`.
- `email-worker/src/features/telegram/telegram-routes.ts` (34 dòng),
  `telegram-api.ts` (266 dòng), `telegram-common.ts` (100 dòng) — route đăng ký webhook,
  tạo mã pairing, cài đặt.
- `email-worker/src/features/telegram/telegram-rich-html.ts` (101 dòng) — chuyển HTML mail
  sang định dạng Telegram, không chạy CSS/script, không load ảnh remote.

**Trigger (cái hay nhất — học theo):** D1 trigger trong
`email-worker/src/platform/d1/schema-migration-telegram.ts` (`0038_telegram_notifications.sql`):
- `trg_telegram_omnimail_ready`: `AFTER UPDATE OF status ON messages WHEN OLD.status !=
  'ready' AND NEW.status = 'ready' AND direction='incoming' AND folder='inbox' AND is_read=0`
  → `INSERT OR IGNORE INTO notification_outbox` (dedup bằng `UNIQUE(endpoint_id, source,
  account_id, message_id)`).
- Các trigger `AFTER INSERT` cho từng bảng external: chỉ khi `imap_uid > last_seen_uid`
  VÀ `last_synced_at IS NOT NULL` (lần sync đầu / rebuild index không đẩy lịch sử).
- Điều kiện chung trong trigger: `endpoint.enabled = 1`, `status = 'active'`,
  `message.created_at >= endpoint.enabled_at` (thư cũ hơn lúc bật không gửi),
  nguồn có trong `sources_json`.
- Hàng đợi: `notification_outbox` (pending/sent/skipped/failed) + `enqueuePendingNotifications`
  (claim tối đa 20/lần, cooldown 120s) + queue consumer `consumeNotificationQueue`
  (gọi từ `email-worker/src/index.ts`, cả queue handler lẫn scheduled handler) +
  `purgeOldNotifications` (xóa bản ghi done > 7 ngày, xóa pairing code hết hạn).
  Queue riêng + DLQ, không chung với queue nhận/gửi mail.

**Setting lưu ở đâu:**
- `notification_endpoints` (1 row / user): `user_id UNIQUE`, `chat_id UNIQUE`, `enabled`,
  `status active|blocked`, `sources_json`, `detail_level`, `include_body`, `body_format`,
  `quiet_enabled`, `quiet_start/end` (mặc định 22:00–07:00), `timezone` (mặc định UTC),
  `enabled_at`, `last_error_code`.
- `telegram_pairing_codes`: `code_hash PK`, `user_id UNIQUE`, `expires_at` (10 phút),
  `consumed_at` (dùng 1 lần).
- Setting admin: `telegramSetting(db, 'telegram_site_origin')` (origin để sinh link mở thư).

**Secret cần:** `TELEGRAM_BOT_TOKEN` (1 bot / 1 instance, tạo qua @BotFather),
`TELEGRAM_WEBHOOK_SECRET` (16–256 ký tự `[A-Za-z0-9_-]`, đăng ký webhook
`/api/webhooks/telegram` với `secret_token`, `allowed_updates: ['message']`).
Webhook phải là HTTPS public (localhost không được); đổi domain/bot phải đăng ký lại.

**Luồng pairing:** user bấm "Kết nối Telegram" → web mở deep-link `t.me/<bot>?start=<code>`
→ user bấm Start trong private chat → bot nhận code → bind `chat_id` ↔ user. Bot không thể
chủ động nhắn user chưa từng Start. Test message giới hạn 1/phút.

**Map sang repo mình:**
- Trigger: **không dùng D1 trigger** (mình chưa dùng trigger bao giờ; giữ code hiển).
  Hook là `email()` trong `worker/index.ts:1600` → sau `ingestInbound()` (trả
  `{id, duplicate, spamScore, folder}`) thành công, chỉ khi `duplicate === false` và
  `folder === 'inbox'` thì ghi 1 row vào outbox (dedup bằng UNIQUE).
- Outbox + settings: migration mới `0013_notifications.sql`, theo đúng tên bảng/cột của
  OmniMail nhưng rút gọn cho 1 nguồn (`source` luôn `'omnimail'` ở R4; giữ cột để R7 dùng sau).
- Gửi: **không có Queue binding** → gửi trong `waitUntil` của handler `email()` (fan-out
  push + Telegram), kèm sweep dự phòng: đầu mỗi lần `email()` chạy, xử lý nốt các row
  `pending` còn sót (nếu lần trước chết giữa chừng). Retry: tối đa 3 lần, backoff theo
  `next_attempt_at`; 403 Telegram → tắt endpoint (blocked).
- Secret: `TELEGRAM_BOT_TOKEN` nạp bằng `wrangler secret put` (KHÔNG ghi giá trị vào
  code/brief/log). **Blocker: webmail chưa có bot riêng** — phải tạo bot mới qua @BotFather;
  code nhận token từ secret + chat-id từ setting, không tự bịa. (Bot stock
  @stock_pocket_bot trên IB2 là bot khác, KHÔNG dùng chung.)
- Nội dung mặc định (học OmniMail): chỉ "có thư mới" + link mở webmail; sender/subject
  chỉ khi user bật `detail_level = full`. Không gửi body ở R4.

### 1b. Browser push (OmniMail KHÔNG có — thiết kế mới theo chuẩn Web Push)

- OmniMail chỉ có: notification list API poll-based (mục trên) + nhắc tới push trong
  `extension/README.md` / `extension/ROADMAP.md` và `docs/releases/float/float-v0.4.0.md`
  (không có code). Không có `webpush`, `vapid`, `PushSubscription` nào trong repo.
- Thiết kế cho mình (chuẩn Web Push, không cần lib ngoài — Workers runtime có WebCrypto):
  - Frontend đăng ký Service Worker (`public/sw.js`, đăng ký trong `src/main.tsx`),
    `pushManager.subscribe({userVisibleOnly: true, applicationServerKey: <VAPID public key>})`.
  - Lưu subscription vào D1: bảng `push_subscriptions`
    (`id`, `mailbox_address`, `endpoint UNIQUE`, `p256dh`, `auth`, `created_at`).
  - Gửi: Worker tự ký VAPID JWT (ES256 qua `crypto.subtle`, header `Authorization: vapid
    t=<jwt>, k=<public key>`, `TTL`, `Urgency: normal`) rồi `fetch(endpoint, {method: 'POST',
    body: <payload mã hóa>})`. Payload mã hóa theo RFC 8291 (aes128gcm) — hoặc v1 chỉ gửi
    push "trống" (no payload) để Service Worker tự fetch `/api/counts` rồi hiện "Bạn có
    thư mới" (đơn giản, tránh code mã hóa; quyết trong brief: v1 = no-payload + SW fetch
    counts, đủ cho R4).
  - Key: sinh cặp VAPID mới bằng `openssl`/`npx web-push generate-vapid-keys` (làm tay,
    ngoài repo); private key → secret `VAPID_PRIVATE_KEY`, public key → vars
    `VAPID_PUBLIC_KEY` (public, không phải secret) + endpoint `GET /api/notifications/push/vapid-key`
    hoặc gộp vào `/api/config`. **KHÔNG ghi giá trị key vào brief/file/log.**
  - Endpoint push trả 404/410 → xóa subscription đó (hết hạn). Hủy đăng ký: frontend
    `unsubscribe()` + `DELETE /api/notifications/push/subscribe`.
  - Ràng buộc CPU 10ms: mỗi thư mới tối đa 1 fetch push + 1 fetch Telegram trong `waitUntil`
    (không chặn inbound); ký JWT 1 lần / lần gửi.

---

## 2. R6 — Admin panel

**Frontend:** `src/features/admin/` — `shell/AdminWorkspace.tsx`, `users/` (quản user),
`domains/` (`DomainManagement.tsx`, `DomainMailboxPanel.tsx`), `invitations/`
(`InvitationManagement.tsx`), `mail/` (`AdminMailManagement.tsx`,
`AdminMessageDrawer.tsx`, `FailedMailCenter.tsx`, `MailStatistics.tsx`,
`MailStorageStatistics.tsx`), `settings/` (`AdminRegistrationSettings.tsx`,
`MailWorkspaceSettings.tsx`, `OutboundRateLimitSettings.tsx`,
`RandomMailboxSettings.tsx`, `StoragePolicySettings.tsx`, `VersionStatusCard.tsx`,
`OfficialExtensionSettings.tsx`), `audit/AuditLogs.tsx`.

**Backend:** `email-worker/src/app/routes/admin-routes.ts` — toàn bộ route đều
`/api/admin/*`, yêu cầu quyền admin (`super-admin.ts`, `configuredSuperAdminEmail`):
- Domains: CRUD domain + mailbox theo domain + cleanup domain (preview/submit/status/retry).
- Users: `createManagedUser`, `listManagedUsers`, `updateManagedUser` (ban/unban nằm đây).
- Invites: tạo/liệt kê/thu hồi invite tạm (`/api/admin/invites`, `/api/invitations/:token`).
- Mail: thống kê (`/api/admin/statistics`), thư lỗi + retry (`/api/admin/failed-messages`),
  dọn mail hàng loạt có preview (`/api/admin/mail-cleanup/preview|POST`).
- Audit: `/api/admin/audit-logs`. Hệ thống: `/api/admin/deployment-check`, version routes.
- Settings: storage policy + backup (`storagePolicy`, `startManualBackup`), registration,
  rate limit gửi, random mailbox prefix, remote images, extension.
- Mail credentials: migration endpoint (`/api/admin/mail-credentials/migration`).

**Map sang repo mình:** mình chưa có khái niệm admin (chỉ có `ALLOWED_EMAILS` allowlist
trong `wrangler.jsonc` + `admin@aistockvn.com` là mailbox chung). R6 cần trước hết:
định nghĩa "admin" (đề xuất: user có email `admin@aistockvn.com`, hoặc cột `role` mới
trong bảng `users`), rồi mới thêm route `/api/admin/*` theo mẫu trên, ưu tiên:
thống kê + user list/ban + invites + domain/mailbox (mình đã có API domains/aliases
thường, admin chỉ cần thêm góc nhìn toàn hệ thống) + audit log (bảng mới). Frontend:
mục Admin trong sidebar theo mẫu `src/App.tsx` hiện tại.

## 3. R7 — Gom hộp thư ngoài (Gmail / Outlook / QQ / NAVER / Yandex / iCloud / Linux Do)

**Mẫu chung (mỗi provider một thư mục riêng, cùng 1 khung):**
`email-worker/src/features/<provider>/` gồm: `<provider>-imap.ts` (client IMAP),
`<provider>-sync.ts` (vòng sync), `<provider>-store.ts` (lưu D1 + giải mã credential),
`<provider>-credentials.ts` (lưu app password/OAuth token đã mã hóa),
`<provider>-routes.ts` (kết nối/ngắt/cài đặt), `<provider>-message-parser.ts`,
`<provider>-sync-control.ts`. Khung chung: `email-worker/src/features/external-mail/
external-mail-sync.ts` + `email-worker/src/platform/imap/` (index-writes, sync-limit,
imap-errors).

**Gmail cụ thể** (`docs/GMAIL_MULTI_ACCOUNT_INTEGRATION_PLAN.md`, 355 dòng):
- Kết nối bằng **IMAP + app password** (không phải Gmail API / OAuth):
  `imap.gmail.com:993`, `GmailImapClient(email, appPassword)`, credential mã hóa lưu D1.
- Sync: `SYNC_INTERVAL_SECONDS = 5*60`, lease 6 phút, batch 50, `INDEX_MESSAGE_LIMIT = 500`;
  thư mới nhận diện bằng `imap_uid > last_seen_uid` + `uid_validity` khớp (lần đầu sync
  không tính là mới — khớp với trigger Telegram ở §1a).
- Bảng riêng mỗi provider (`gmail_imap_messages`, `gmail_imap_accounts`, ...), rồi
  notification list API hợp nhất qua `MESSAGE_SELECTS` (mục 1a).

**Map sang repo mình:** R7 làm từng provider một, vòng 1 nên là **Gmail** (người dùng
của mình đã có Gmail): cần `gmail_accounts` (credential mã hóa — tái dùng `worker/crypto.ts`
AES-GCM sẵn có) + `gmail_messages` + vòng sync (cron trigger — wrangler hiện KHÔNG có
`[triggers] cron`, phải thêm; Workers Free cron tối thiểu 1 phút/lần, sync 5 phút/lần
là hợp lý) + UI kết nối trong Settings + hợp nhất vào inbox (hoặc tab riêng trước).
QQ/NAVER/Yandex/Microsoft/iCloud/Linux Do: cùng khung, mỗi cái 1 vòng riêng sau Gmail.
Lưu ý: OmniMail dùng `imapflow`-style client chạy trong Worker — thư viện IMAP trong
Workers bị giới hạn (TCP qua `connect()` chỉ có trên Workers Paid? — cần kiểm chứng
khi tới R7, không kết luận trước).

## 4. R8 — Sao lưu

**Module:** `email-worker/src/features/backups/` — `backup.ts`
(`OmniMailBackupWorkflow extends WorkflowEntrypoint`, Cloudflare Workflows),
`backup-target.ts`, `backup-scope.ts`, `backup-retention.ts`, `backup-browser-api.ts`,
`backup-retention.test.ts`, ... + `email-worker/src/platform/d1/d1-export.ts` +
`email-worker/src/features/messages/mail-archive.ts` (`copyStoredMail`,
`copyStoredAttachments`).

**Cơ chế:** Workflow (manual hoặc scheduled): kiểm tra setting bật (`backupEnabled`
từ storage-policy) → gọi **D1 export qua REST API** (cần 3 secret:
`CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `D1_REST_API_TOKEN`) → lưu file export
vào R2 bucket riêng (`BACKUP_BUCKET`, key theo `backupScope(identity)` + ngày) →
copy mail + attachment đã lưu (từ R2 mail bucket) sang bucket backup → ghi
`backup_runs` (trigger, status, started_at) → retention purge theo quy tắc
(`BACKUP_RETENTION_RULES`). API trình duyệt: liệt kê/tải file backup, chạy drill
(`runBackupDrill`, `downloadBackupObject`, `listBackupObjects`).

**Map sang repo mình:** mình đã có R2 `aistockvn-mail-raw` (raw `.eml`) + D1
`aistockvn-mail`. R8 cần: bucket backup RIÊNG (luật tách hạ tầng — không dùng chung
bucket webmail), 3 secret D1 REST như trên, Workflow hoặc cron đơn giản hơn (cron gọi
endpoint backup nội bộ). Vòng R8 quyết sau: Workflow là chuẩn OmniMail nhưng nặng;
phương án nhẹ là script ngoài (cron VM → `wrangler d1 export` + `rclone` R2) — ghi
rõ 2 phương án trong brief R8, để lúc làm mới chốt.

## 5. Quan sát hệ thống (observability)

**Tài liệu:** `docs/OBSERVABILITY.md` (28 dòng). **Module:**
`email-worker/src/features/observability/client-error-api.ts` (nhận crash report từ
client, tối đa 16KB, trả 413 khi quá lớn) + `src/shared/observability/structured-log`
(`safeLogText` — cắt + khử ký tự điều khiển).

**Cơ chế:** Cloudflare Workers Logs, `wrangler.jsonc` bật 100% log sampling; log có
cấu trúc theo field `event` (vd `qq_mail_sync_failed`, `client_ui_crash`,
`api_unhandled_error`); xem bằng Dashboard → Observability → Logs hoặc
`npx wrangler tail omni-mail --format json`, lọc theo `event`. **Không log:**
mã auth, app password, tiêu đề/nội dung mail, tên file đính kèm, response gốc.
Client crash: frontend bắt lỗi React, gửi kèm `crash_id` → tra cứu bằng `crash_id`.

**Map sang repo mình:** mình hiện chỉ có `console.error("api error", e)` rải rác trong
`worker/index.ts` (không cấu trúc, có thể lọt dữ liệu nhạy cảm). Việc cần làm (gọn):
hàm `logEvent(env, event, fields)` trong `worker/` (JSON 1 dòng, field `event` +
`ts` + `mailbox` băm/không PII), thay các `console.error` ở đường API/inbound;
endpoint `POST /api/client-errors` nhận crash report frontend (giới hạn 16KB như
OmniMail) + ErrorBoundary trong `src/`; tài liệu 1 trang cách xem log bằng
`wrangler tail`. Không cần thêm binding (Workers Logs có sẵn theo Worker).
