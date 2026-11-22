# PROMPT — Phase 4 Round 8: Sao lưu + quan sát hệ thống (backup + observability)

Bạn làm việc trên repo webmail aistockvn (Worker + React SPA + D1). Đọc kỹ brief này
trước khi code. Repo làm việc: `/data/home/webmail-r4-neon/` trên IB3 (đã sync, baseline
sau R6 — KHÔNG dùng VM clone làm baseline, VM còn ở bản pre-R4).
Grounding OmniMail: `OMNIMAIL-GROUNDING-R4-R8.md` ở repo root — đọc §4 (Sao lưu) và
§5 (Quan sát hệ thống) trước khi code.

## 0. Hiện trạng (đã verify trên IB3, workdir `/data/home/webmail-r4-neon/`)

- Live: Worker `aistockvn-mail` tại mail.aistockvn.com, version **bc706f66** (deploy 21:36
  19/11, bản dedup). **R4 + R6 + fix Sent-alias đã xong trên IB3 nhưng CHƯA deploy** —
  vòng này code tiếp trên baseline post-R6, không chờ deploy. Snapshot deploy R4+R6+fix
  đã tách riêng tại `/data/home/webmail-r6-deploy-snapshot/` — **ĐỪNG ĐỤNG VÀO**.
- **R7 DỪNG tại bước 0** (IMAP chết cả local lẫn edge thật, probe Worker tạm đã xóa;
  đang chờ Henrry quyết Gmail API + OAuth hay bỏ qua R7). **R8 làm độc lập với R7,
  không đụng gì tới Gmail/IMAP/OAuth.** Không có file `worker/gmail.ts`, không có
  bảng `external_accounts`, không có migration 0015 — **R8 dùng migration 0016** (tránh
  đụng số 0015 của R7 nếu R7 sau này làm tiếp).
- `npx tsc --noEmit` 0 lỗi, `vitest run --isolate=false` **232/232** (baseline sau R6;
  trừ `smoke.e2e.test.ts`, cần dev server live). 24 file test trong `worker/`.
- `worker/index.ts` **2158 dòng** (sha `6e7eed09`), routes `/api` = **47**.
  `src/api.ts` **700 dòng** (sha `62b68ad8`). `src/App.tsx` **2029 dòng**
  (sha `12a46a0a`). `src/admin.tsx` **1531 dòng** (sha `babdfff3`).
  Migration mới nhất `migrations/0014_admin.sql` (sha `8eea379e`).
  **TUYỆT ĐỐI KHÔNG viết lại `worker/index.ts`** — chỉ sửa phẫu thuật: thêm import +
  block route mới + handler `scheduled` + các điểm sửa nhỏ ghi ở §1.3/§1.5. Đếm route
  trước/sau: sau = trước + 5 (xem §1.3).
- `src/api.ts`: `ApiClient` interface ở `src/api.ts:397`, `api` object ở `src/api.ts:476`
  — **KHÔNG còn index signature** (bài học restore 3b + R4: thêm method mới phải sửa
  CẢ interface lẫn object, thiếu một bên là tsc fail). Method admin trong interface ở
  `:462-473`, impl ở `:654-695`.
- `src/App.tsx`: `Route` union ở `:55` (`admin` ở `:68`), `parseRoute` ở `:70`
  (`/admin` ở `:92`), dispatch `AdminPanel` ở `:2013`. **R8 KHÔNG thêm route hash mới,
  KHÔNG thêm link nav, KHÔNG sửa `App.tsx` chút nào** — UI backup + log nằm trong
  `AdminPanel` dưới dạng 2 tab mới (xem §1.6).
- `src/admin.tsx`: 6 tab ở `:32-37` (overview | users | domains | cleanup | audit |
  settings); `AdminPanel` ở `:233`; settings state ở `:282-289`, `loadSettings` ở
  `:367`. `getAdminSettings` (`worker/admin.ts:773`) hiện chỉ đọc key
  `send_daily_cap`; `updateAdminSettings` ghi audit action `settings_updated`.
- **Hệ thống hiện KHÔNG có gì về sao lưu hay quan sát hệ thống** (đã grep toàn workdir):
  không bảng `backup_runs`, không module backup, không route health/backup, không
  handler `scheduled`, không cron trigger, không `logEvent`, không endpoint client
  errors, không `ErrorBoundary` (grep `src/` + `worker/` = 0), không thư mục `docs/`.
  Chữ "backup" duy nhất trong code là comment ở `worker/index.ts:2099` ("backup sweep
  of any leftover pending notifications" — dọn thông báo R4, KHÔNG phải sao lưu).
- **`console.error` rải rác, không cấu trúc — 6 chỗ trong `worker/index.ts`:**
  `:2091` (`"api error"`), `:2102` (`"notify sweep failed"`), `:2135`
  (`"notify delivery failed"`), `:2141` (`"notify enqueue failed"`), `:2145`
  (`"ingest failed"`), `:2153` (`"forward failed"` — có log kèm `dest`, là địa chỉ
  email, xem §1.5 cách xử lý). Grounding §5 ghi đúng: log kiểu này có thể lọt dữ liệu
  nhạy cảm. R8 thay cả 6 chỗ bằng `logEvent` (xem §1.5).
- **`wrangler.jsonc`: 1 Worker duy nhất, KHÔNG có `[triggers]` cron, không Queue,
  không Workflow, không mục observability.** Bindings chỉ có DB + RAW + AI.
  D1 `aistockvn-mail` (id `1accd00a-78dc-445b-ada2-52941f14bdbc`), R2 `RAW` =
  `aistockvn-mail-raw`. Secrets đã có: `RESEND_API_KEY`, `SESSION_SECRET`,
  `TOTP_ENCRYPTION_KEY`, `ENCRYPTION_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`,
  `TELEGRAM_BOT_TOKEN`. **Chưa có bucket backup, chưa có 3 secret D1 REST**
  (`CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `D1_REST_API_TOKEN`) — xem §1.0/§1.8.
- **`export default` (`worker/index.ts:2084`) chỉ có `fetch` + `email()` (`:2098`) —
  KHÔNG có handler `scheduled`.** Sao lưu định kỳ phải thêm handler mới + cron trigger
  (xem §1.4). `handleApi` ở `worker/index.ts:117`. Helper lỗi admin `adminErr` ở
  `:876`; 13 route `/api/admin/*` ở `:881-1074`, mẫu chung: `requireAdmin(adminEnv,
  user)` rồi `try { ... return json(...) } catch (e) { return adminErr(e) }` — route
  backup mới theo đúng mẫu này (xem §1.3).
- **`Env` (`worker/mail.ts:6-33`):** `DB`, `RAW`, `ASSETS`, `MAILBOX_ADDRESS`,
  `FROM_NAME`, `ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID`, `FORWARD_TO`, các secret tùy
  chọn (`RESEND_API_KEY`, `SESSION_SECRET`, `TOTP_ENCRYPTION_KEY`,
  `ENCRYPTION_KEY`, `AI`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`,
  `TELEGRAM_BOT_TOKEN`). Thêm binding/secret mới thì thêm field vào đúng interface
  này (xem §1.2).
- **Đường dữ liệu cần sao lưu (tái dùng, không viết lại):**
  - D1 `aistockvn-mail`: 20 bảng (users, mailboxes, messages, mail_drafts, aliases,
    domains, admin_settings, audit_logs, admin_totp, mfa_challenges,
    mfa_recovery_codes, email_verifications, password_resets, registration_attempts,
    login_attempts, notification_settings, notification_outbox, push_subscriptions,
    spam_blocklist, messages_new). **D1 export lấy toàn bộ database nên không cần
    liệt kê từng bảng trong code backup** — liệt kê ở đây để biết phạm vi.
  - R2 `RAW`: file `.eml` gốc, key `raw/YYYY/MM/<uuid>.eml` (`worker/mail.ts:90`,
    `RAW.put` ở `:91`; `RAW.get` ở `worker/index.ts:1780/1839/1859`). **Chưa có
    chỗ nào dùng `RAW.list()`** — bước copy R2 của backup là lần đầu dùng `list()`,
    phải test phân trang (cursor) đàng hoàng.
  - **KHÔNG sao lưu secret** (xem §1.8 điểm 6): `ENCRYPTION_KEY` và các secret Worker
    không nằm trong D1/R2 nên export không chứa chúng — nhưng **nếu mất
    `ENCRYPTION_KEY` thì `text_body` đã mã hóa trong backup không giải được** (xem
    §1.7). Key này đã theo LUẬT KEY (bản sao 0600 trên ≥2 máy, sổ chỉ ghi đường dẫn).
- **Grounding §4 + §5 có 2 điểm cần đọc kỹ, đừng làm theo máy móc:** (1) OmniMail
  dùng Cloudflare Workflow làm engine backup — nặng hơn repo mình (xem §1.4, có 3
  phương án, Henrry chốt); (2) OmniMail log 100% sampling qua `wrangler.jsonc` —
  repo mình chưa bật gì, R8 chỉ cần log có cấu trúc + tài liệu xem log, không cần
  đổi sampling.
- **An toàn dữ liệu — luật riêng của vòng này (đọc kỹ, vi phạm là FAIL):**
  Vòng này **CHỈ ĐỌC dữ liệu thật + TẠO bản sao**. Không xóa, không ghi đè, không sửa
  bất kỳ row thật nào. Các ghi duy nhất lên hệ thống sống: INSERT vào 2 bảng mới
  (`backup_runs`, `client_errors`), INSERT audit log (`audit_logs`, đã có), INSERT/UPDATE
  key mới trong `admin_settings` (đã có), và PUT object vào bucket backup MỚI (chưa
  chứa gì). Retention purge (§1.2) chỉ được xóa object trong bucket backup do chính
  backup tạo ra và đã quá hạn — **không bao giờ DELETE row D1 hay object R2 `RAW`**.
  Khôi phục (restore) không chạy tự động, không ghi đè D1 sống — xem §1.7.
- **KHÔNG commit/push/deploy. KHÔNG `rm` file nào (kể cả `src/App.tsx.bak` có sẵn
  trong workdir — để nguyên). KHÔNG ghi key/secret/token vào code, brief, log hay chat.**

## 1. Spec

### 1.0 Bước 0 — Xác nhận phương án + probe khả thi (BẮT BUỘC, làm trước mọi code engine)

R8 có 3 phương án engine (§1.4) và 3 secret + 1 bucket chưa có (§1.8). Bước 0 gồm 2 việc:

**a. Xác nhận quyết định của Henrry đã ghi ở đâu:**
Đọc quyết định Henrry đã chốt cho §1.8 (phương án engine, tên bucket, lịch chạy, thời
gian giữ, kênh cảnh báo). Quyết định phải có bằng văn bản (brief này được cập nhật,
hoặc tin nhắn của Henrry được trích trong báo cáo). **Nếu chưa có quyết định: làm hết
phần lõi chung (§1.1, §1.2 trừ `runBackup`, §1.3 trừ route 2 + cron, §1.5, §1.6,
§1.7 tài liệu) rồi DỪNG + báo cáo rõ "phần engine còn chờ quyết", KHÔNG tự chọn
phương án, KHÔNG tự tạo bucket/secret/token.** Phần lõi chung vẫn có giá trị độc lập
(UI xem backup, log có cấu trúc, client errors) — vòng không bị tính là fail vì
thiếu quyết định, nhưng phải ghi rõ trong báo cáo là engine chưa xong.

**b. Probe D1 export (không chạm dữ liệu thật):**
Thử `npx wrangler d1 export aistockvn-mail --remote --output /tmp/r8-probe-<ngày>.sqlite`
trên IB3 (dùng token Cloudflare đã có trên máy, nếu có; nếu IB3 không có token thì
ghi rõ "chưa probe được vì thiếu token" và dừng probe ở đó — không tự lấy token từ
máy khác). Ghi lại: chạy được/không + dung lượng file export + số bảng (mở bằng
`sqlite3` chỉ đọc: `.tables`, `PRAGMA integrity_check`) + thời gian chạy. **Xóa file
probe ngay sau khi đo xong, không commit, không đưa vào repo.** Nếu export chạy
được thì kênh D1 REST (cùng API nền) được coi là khả thi; nếu không thì báo cáo kèm
log lỗi nguyên văn để Henrry quyết (đừng tự chuyển phương án).

**Kết quả probe (20/11, ghi bởi Main): CHƯA PROBE ĐƯỢC VÌ THIẾU TOKEN.** IB3 không có
token Cloudflare (`~/.cf_webmail_token` không tồn tại, không có `~/.config/.cloudflare`,
không có biến môi trường `CLOUDFLARE_*`), và `wrangler` không cài sẵn trên IB3
(`command not found`). Theo brief, không tự lấy token từ máy khác — probe dừng ở đây.
Kênh D1 REST sẽ được kiểm chứng ở bước deploy (khi token có mặt); code `runBackup`
dùng `fetch` tới D1 REST API với token đọc từ `env` và được test bằng mock (xem §2),
không gọi Cloudflare thật trong test.

### 1.1 Migration `migrations/0016_backup.sql` (MỚI — 2 bảng duy nhất vòng này thêm)

```sql
CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'cron')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  d1_object_key TEXT NOT NULL DEFAULT '',
  d1_size INTEGER NOT NULL DEFAULT 0,
  r2_copied INTEGER NOT NULL DEFAULT 0,
  r2_errors INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS client_errors (
  id TEXT PRIMARY KEY,
  crash_id TEXT NOT NULL,
  mailbox_hash TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  stack TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_errors_created ON client_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_errors_crash ON client_errors (crash_id);
```

- Không sửa bảng nào khác. Không dùng D1 trigger (giữ code hiển như mọi vòng trước).
- Cài đặt backup dùng bảng `admin_settings` đã có (key/value), thêm bằng
  `INSERT OR IGNORE` trong migration hoặc lần đầu đọc (xem §1.2): `backup_enabled`
  (`'0'`, mặc định TẮT cho tới khi Henrry bật sau khi đã có bucket + secret),
  `backup_retention_days` (`'30'`), `backup_schedule` (chuỗi cron, mặc định
  `'0 20 * * *'` = 03:00 giờ VN hàng ngày — xem §1.8 điểm 4).

### 1.2 Module mới (theo mẫu `worker/notifications.ts` / `worker/admin.ts`: hàm thuần + `XxxError`, index.ts chỉ import + gọi)

**`worker/backup.ts` — `BackupError{status}` (403 `backup_forbidden`, 400 validate,
404 run không tồn tại, 502 lỗi provider/REST):**

- `getBackupSettings(env)`: đọc 3 key trên từ `admin_settings` (thiếu key → giá trị
  mặc định §1.1) + `backupBucketConfigured: boolean` (binding `BACKUP` có tồn tại
  không — kiểm tra bằng `typeof env.BACKUP !== 'undefined'`, không đọc secret) +
  `lastBackup`: row mới nhất trong `backup_runs` (hoặc null).
- `updateBackupSettings(env, actor, {backupEnabled?, backupRetentionDays?})`:
  validate `backupRetentionDays` số nguyên 1..365 (sai → 400); chỉ `super_admin`
  được đổi (dùng `requireSuperAdmin` của `worker/admin.ts`, như `send_daily_cap` ở
  R6); ghi audit `settings_updated` với target `backup_retention_days` /
  `backup_enabled` (theo mẫu `updateAdminSettings` ở `worker/admin.ts`).
- `listBackupRuns(env, {limit?, before?})`: mới nhất trước, `limit` mặc định 50, tối
  đa 100. Trả đúng các cột `backup_runs`, **không trả nội dung backup**.
- `runBackup(env, trigger, nowMs)` (chỉ viết khi phương án đã chốt ở §1.0 — engine
  theo §1.4):
  1. Kiểm tra `backup_enabled === '1'` và binding `BACKUP` tồn tại — chưa đủ điều
     kiện → throw 400 `backup_not_configured` (không chạy nửa vời, không ghi run
     `failed` giả).
  2. INSERT row `backup_runs` `status='running'` trước khi làm (để lần chạy sau
     nhìn thấy lần này đang chạy — nếu đã có row `running` chưa quá 6 giờ thì trả
     `{skipped: true}` thay vì chạy chồng lên nhau; quá 6 giờ thì coi là kẹt và cho
     chạy lại, ghi rõ trong báo cáo).
  3. D1 export qua REST API (`fetch` tới `https://api.cloudflare.com/client/v4/
     accounts/<ACCOUNT_ID>/d1/database/<D1_ID>/export`, header
     `Authorization: Bearer <D1_REST_API_TOKEN>` — 3 giá trị đọc từ `env`, không
     hardcode, không log): tải toàn bộ file export (stream, không giữ cả file trong
     RAM), PUT lên bucket `BACKUP` với key
     `d1/<YYYY-MM-DD>/<run-id>.sqlite` (theo `backupScope` + ngày như grounding §4).
     Ghi `d1_object_key` + `d1_size` vào row.
  4. Copy R2 `RAW` sang `BACKUP`: `RAW.list({ prefix: 'raw/' })` theo từng trang
     (cursor — bắt buộc, không giả định 1 trang đủ), chỉ copy object có
     `uploaded` mới hơn lần backup thành công gần nhất (incremental theo prefix
     `raw/YYYY/MM/` — lần đầu thì copy hết); đích key giữ nguyên đường dẫn
     (`raw/YYYY/MM/<uuid>.eml`); copy bằng `BACKUP.put(key, await RAW.get(key))`
     theo từng batch nhỏ; object nào lỗi thì đếm vào `r2_errors`, ghi tên key lỗi
     vào `error` (tối đa 10 key, cắt ngắn — key không chứa PII), tiếp tục object
     sau (không để 1 object hỏng giết cả lần chạy).
  5. Kết thúc: UPDATE row `status='succeeded'` + `finished_at` + `r2_copied` +
     `r2_errors`; lỗi ở bất kỳ bước nào → `status='failed'` + `error` (thông báo
     lỗi cắt ngắn, KHÔNG ghi body lỗi thô của provider, KHÔNG ghi secret) +
     `finished_at`. Luôn ghi audit `backup_finished` (actor `'system'`, target =
     run id, detail = status) qua `logAdminAction` (`worker/admin.ts:298`).
  6. Retention purge (chạy cuối mỗi lần backup thành công): xóa object trong bucket
     `BACKUP` thuộc các run đã quá `backup_retention_days` (chỉ xóa trong bucket
     backup, chỉ key có prefix `d1/` hoặc `raw/` do backup tạo ra); đếm số object
     đã xóa vào log. **Không bao giờ xóa trong bucket `RAW` hay row D1.**
- `listBackupObjects(env, runId)`: lấy `d1_object_key` của run + `BACKUP.list({
  prefix: 'raw/' })` (giới hạn 100 object/trang, trả kèm cursor) — chỉ liệt kê, không
  tải nội dung. Run không tồn tại → 404.
- `downloadBackupObject(env, runId, key)`: kiểm tra `key` bắt đầu bằng `d1/` và
  khớp `d1_object_key` của run, HOẶC bắt đầu bằng `raw/` (object đã copy trong run
  đó) — key khác → 400 (chống path traversal ra ngoài phạm vi backup); `BACKUP.get`
  rồi stream về client với `Content-Type` phù hợp (`.sqlite` →
  `application/x-sqlite3`, `.eml` → `message/rfc822`).
- `getBackupStats(env)` (cho tab Overview của Admin — tái dùng `getAdminStats` nếu
  tiện, không bắt buộc): số run thành công/thất bại 30 ngày gần nhất, dung lượng
  backup mới nhất, ngày backup gần nhất.

**`worker/observability.ts` (mới, theo grounding §5):**

- `safeLogText(value: unknown, maxLen = 200)`: cắt chuỗi dài, thay ký tự điều khiển
  (`\n`, `\r`, `\t`, ký tự < 0x20) bằng khoảng trắng — theo mẫu `safeLogText` của
  OmniMail. Không bao giờ throw.
- `logEvent(env, event: string, fields?: Record<string, unknown>)`: ghi 1 dòng JSON
  duy nhất qua `console.log` (Workers Logs thu stdout sẵn, không cần binding mới):
  `{event, ts: Date.now(), ...fields}`. **Danh sách khóa cấm (drop trước khi ghi,
  không log giá trị):** `password`, `appPassword`, `app_password`, `token`,
  `secret`, `authorization`, `cookie`, `subject`, `body`, `text_body`, `html_body`,
  `attachment`, `snippet`, `raw_key`, `resend_id`. Giá trị chuỗi dài quá 200 ký tự
  thì cắt qua `safeLogText`. `mailbox` (nếu có) chỉ ghi dạng băm: `mailboxHash =
  await sha256Hex(mailbox)` (tái dùng `sha256Hex` ở `worker/mfa.ts:135`).
  `logEvent` không bao giờ throw (try/catch trong, lỗi thì im lặng — log không được
  giết request chính).
- Các event đặt tên trước (dùng đúng chuỗi này trong code + tài liệu): `api_unhandled_error`,
  `notify_sweep_failed`, `notify_delivery_failed`, `notify_enqueue_failed`,
  `ingest_failed`, `forward_failed`, `backup_started`, `backup_succeeded`,
  `backup_failed`, `client_error_received`.

### 1.3 Route mới trong `handleApi()` (thêm import + block, KHÔNG viết lại file)

Tất cả route admin đều yêu cầu session + `requireAdmin` (theo mẫu
`worker/index.ts:881-891`, `adminErr` ở `:876`). Đếm route trước khi sửa và sau khi
sửa bằng `grep -E "path === ['\"]/api" worker/index.ts`; sau = trước + 5 (47 → 52).
Ghi số đếm vào báo cáo.

| # | Route | Mô tả |
|---|---|---|
| 1 | `GET /api/admin/backups` | Danh sách run backup (admin): `[{id, trigger, status, startedAt, finishedAt, d1ObjectKey, d1Size, r2Copied, r2Errors, error}]`, mới nhất trước; `limit` mặc định 50, tối đa 100. Không trả nội dung backup. |
| 2 | `POST /api/admin/backups/run` | Chạy backup ngay bằng `runBackup(env, 'manual', Date.now())` — **chỉ `super_admin`** (dùng `requireSuperAdmin`, như đổi `send_daily_cap` ở R6: backup là việc hạ tầng, tốn R2 + gọi API Cloudflare). Đang có run `running` → trả `{skipped: true}` (không 409 — bấm trùng không phải lỗi). Chưa cấu hình đủ (bucket/secret/tắt) → 400 `backup_not_configured`. **Chỉ viết route này khi phương án engine đã chốt (§1.0); nếu chưa chốt thì không viết route này.** |
| 3 | `GET /api/admin/backups/objects?runId=` | Liệt kê object của 1 run (admin): `{d1Object, r2Objects: [{key, size}], cursor?}`. Run không tồn tại → 404. |
| 4 | `GET /api/admin/backups/download?runId=&key=` | Tải 1 object backup (admin): stream từ bucket `BACKUP`, kiểm tra key theo §1.2 (sai phạm vi → 400). |
| 5 | `POST /api/client-errors` | **Không qua `requireAdmin`** — mọi user đã đăng nhập đều gửi được (crash xảy ra ở máy user). Body JSON ≤ **16384 byte** (quá → 413 `client_error_too_large`, như OmniMail). Field nhận: `crashId` (bắt buộc, ≤ 64 ký tự), `message` (≤ 500), `stack` (≤ 4000), `url` (≤ 500), `userAgent` (≤ 500). Field lạ (subject/body/token/...) thì **bỏ, không lưu**. `mailboxHash` lấy từ session (băm, không lưu email thô). INSERT vào `client_errors`, trả `{ok: true, crashId}`. Ghi `logEvent('client_error_received', {crashId})`. |

**Mở rộng settings (không thêm route):** `GET /api/admin/settings` thêm
`backupEnabled: boolean`, `backupRetentionDays: number`, `backupSchedule: string`,
`backupBucketConfigured: boolean`, `lastBackupAt: number | null`,
`lastBackupStatus: string | null` (đọc từ `getBackupSettings`, §1.2).
`POST /api/admin/settings` chấp nhận thêm `{backupEnabled?, backupRetentionDays?}`
(chỉ `super_admin`, validate như §1.2; `sendDailyCap` giữ nguyên hành vi R6).
Không đổi chữ ký hàm cũ nào khác.

**`scheduled()` + cron (chỉ viết khi phương án B đã chốt — xem §1.4):**
- `wrangler.jsonc`: thêm `"triggers": { "crons": ["0 20 * * *"] }` (03:00 giờ VN
  hàng ngày = 20:00 UTC hôm trước; đúng chuỗi `backup_schedule` mặc định ở §1.1).
  Không thêm binding nào khác ngoài `BACKUP` (xem §1.4).
- `export default` (`worker/index.ts:2084`): thêm handler
  `async scheduled(event, env, ctx)`: nếu `backup_enabled !== '1'` thì return ngay
  (không chạy); ngược lại `ctx.waitUntil(runBackup(env, 'cron', Date.now()))`.
  Lỗi trong `runBackup` đã được ghi vào `backup_runs` + audit (§1.2) nên
  `scheduled` không cần try/catch riêng ngoài việc không để exception thoát ra.
- Giới hạn CPU Workers: một lần chạy chỉ làm tối đa **500 object R2** (copy theo
  batch, cursor lưu trong row `backup_runs` — lần cron sau làm tiếp từ cursor nếu
  chưa xong; trạng thái dở dang ghi vào `error` dạng `partial: copied N/M`).
  Nếu D1 export quá lớn cho 1 lần chạy Worker thì ghi rõ trong báo cáo (kèm dung
  lượng đo được ở bước 0) để Henrry quyết (chia nhỏ / chuyển phương án C).

### 1.4 Phương án engine — 3 lựa chọn, Henrry chốt (ghi rõ trong brief, vòng code không tự chọn)

| Phương án | Cách chạy | Cần thêm | Ưu | Nhược |
|---|---|---|---|---|
| **A. Cloudflare Workflow** (chuẩn OmniMail) | `WorkflowEntrypoint`, step retry/durable | Binding Workflow trong `wrangler.jsonc` + 3 secret D1 REST + bucket `BACKUP` | Đúng chuẩn OmniMail, retry + bền bỉ có sẵn, không lo giới hạn CPU 1 lần chạy | Nặng nhất, loại binding mới, phức tạp nhất, Workflow có thể tốn thêm chi phí |
| **B. Cron + endpoint nội bộ** (nhẹ, theo grounding §4 "cron gọi endpoint backup nội bộ") | `scheduled()` trong cùng Worker gọi `runBackup` (§1.2-1.3) | `[triggers] cron` + 3 secret D1 REST + bucket `BACKUP` | Ít code nhất, không loại binding mới, sống trong 1 Worker hiện tại | Giới hạn CPU/thời gian 1 lần chạy Worker (phải chia batch + resume bằng cursor); vẫn cần 3 secret |
| **C. Script ngoài** (nhẹ nhất phía Worker) | Cron trên máy (VM/IB3) chạy `wrangler d1 export` + `wrangler r2 object put` lên bucket backup, rồi `wrangler d1 execute` INSERT 1 row `backup_runs` | Bucket `BACKUP` + token Cloudflare trên máy chạy cron; **KHÔNG cần 3 secret D1 REST, KHÔNG cần handler `scheduled`, KHÔNG cần route 2** | Không secret mới trong Worker, không giới hạn CPU Worker, dùng đúng CLI đã có | Phụ thuộc máy chạy cron (VM thay ~mỗi giờ — phải đặt cron + wrapper script như các cron khác, hoặc chạy trên IB3); backup không chạy nếu máy chết; nút "chạy ngay" trong UI không gọi được script (route 2 không làm ở phương án này) |

- **Vòng code chỉ viết engine của phương án đã chốt ở §1.0.** Nếu chưa chốt: làm phần
  lõi chung (§1.1, §1.2 trừ `runBackup`, §1.3 trừ route 2 + cron, §1.5, §1.6, §1.7
  tài liệu) rồi dừng + báo cáo engine còn chờ quyết.
- **Không tự tạo OAuth client / tài khoản Cloudflare mới.** 3 secret D1 REST (phương
  án A/B) cần Henrry tạo token `D1_REST_API_TOKEN` (quyền D1 đọc) hoặc quyết cách
  tạo — vòng này không tự tạo token bằng tài khoản khác, không bịa credential.
  `CLOUDFLARE_ACCOUNT_ID` + `D1_DATABASE_ID` là giá trị đã biết (D1 id có trong
  `wrangler.jsonc`); chỉ nạp bằng `wrangler secret put` khi deploy, không ghi giá trị
  vào code/brief/log.
- Bucket backup: tên đề xuất `aistockvn-mail-backup` (tách riêng theo luật hạ tầng —
  KHÔNG dùng chung bucket `aistockvn-mail-raw` với webmail). Ai tạo bucket (vòng code
  chạy `wrangler r2 bucket create` bằng token trên IB3, hay Henrry tạo) là điểm cần
  quyết (§1.8 điểm 2). Binding thêm vào `wrangler.jsonc`:
  `{ "binding": "BACKUP", "bucket_name": "<tên bucket đã chốt>" }` + field `BACKUP?:
  R2Bucket` vào `Env` (`worker/mail.ts:6-33`).

### 1.5 Quan sát hệ thống — log có cấu trúc + client errors + tài liệu (làm đủ, không phụ thuộc phương án engine)

- **`worker/observability.ts`** (mới, §1.2): `safeLogText`, `logEvent`.
- **Thay 6 chỗ `console.error` trong `worker/index.ts` bằng `logEvent`:**
  `:2091` → `logEvent(env, 'api_unhandled_error', { path })` (path là đường dẫn API,
  không kèm body/query — query có thể chứa dữ liệu nhạy cảm); `:2102` →
  `logEvent(env, 'notify_sweep_failed', {})`; `:2135` →
  `logEvent(env, 'notify_delivery_failed', {})`; `:2141` →
  `logEvent(env, 'notify_enqueue_failed', {})`; `:2145` →
  `logEvent(env, 'ingest_failed', {})`; `:2153` → `logEvent(env, 'forward_failed',
  { mailboxHash })` — **không log `dest` thô** (địa chỉ email), chỉ băm bằng
  `sha256Hex` (`worker/mfa.ts:135`). Không đổi hành vi khác ở 6 chỗ này (vẫn trả lỗi
  như cũ cho client).
- **Client crash:** file mới `src/error-boundary.tsx` — class component
  `ErrorBoundary` (`getDerivedStateFromError` + `componentDidCatch`): khi React crash
  thì POST `/api/client-errors` (fetch, `crash_id = crypto.randomUUID()`, kèm
  `message` + `stack` cắt ngắn) rồi hiện màn hình lỗi thân thiện (chữ + nút tải lại,
  không hiện stack cho user). Bọc `<App />` trong `src/main.tsx` (14 dòng, giữ nguyên
  đăng ký service worker):
  ```tsx
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
  ```
  Không gửi gì khác ngoài 5 field ở §1.3 route 5. Không gửi tiêu đề/nội dung mail,
  không gửi token.
- **Tài liệu mới `docs/OBSERVABILITY.md` (1 trang, theo grounding §5):** cách xem log
  (`npx wrangler tail aistockvn-mail --format json`, lọc theo field `event`),
  bảng danh mục event (§1.2), những gì KHÔNG bao giờ log, cách tra 1 crash bằng
  `crash_id` (truy vấn D1 `client_errors`), lưu ý log Cloudflare giữ phía server
  (không truy vấn được từ trong Worker — vì vậy tab Logs trong Admin chỉ hiện
  `client_errors` + `backup_runs` + `audit_logs`, không giả vờ truy vấn được Workers
  Logs).
- Không bật thêm sampling/config observability nào trong `wrangler.jsonc` ở vòng này.

### 1.6 Frontend — 2 tab mới trong `AdminPanel`, KHÔNG sửa `App.tsx`

**Không thêm route hash, không thêm link nav, không sửa `App.tsx`.** Toàn bộ UI R8
nằm trong `src/admin.tsx` (panel đã có 6 tab ở `:32-37`):

- Thêm 2 tab vào mảng tab (ngay sau `audit`, trước `settings` — thứ tự cuối cùng:
  overview | users | domains | cleanup | audit | **backup** | **logs** | settings):
  `{ id: "backup", label: "Backup" }`, `{ id: "logs", label: "Logs" }`.
- **Tab Backup:** trạng thái hiện tại (bật/tắt, lịch chạy, giữ bao lâu, bucket đã cấu
  hình chưa, lần backup gần nhất + trạng thái) từ `api.getAdminSettings()` (đã mở rộng
  ở §1.3); nút "Chạy backup ngay" (chỉ hiện với `super_admin`, gọi route 2 — gọi xong
  hiện trạng thái run mới; nếu phương án C đã chốt thì nút này không hiện, thay bằng
  dòng chữ "Backup chạy bằng script ngoài theo lịch"); bảng các run gần nhất từ
  `api.listBackupRuns()` (thời gian, trigger, trạng thái, dung lượng D1, số object R2
  đã copy, lỗi); mỗi run có nút "Xem object" (gọi route 3) + nút "Tải file D1"
  (gọi route 4 với key `d1_object_key`). Lỗi API hiện bằng chữ trong panel, không
  `alert()`, không crash (theo mẫu các tab R6).
- **Tab Logs:** 3 bảng chỉ đọc, mới nhất trước, mỗi bảng giới hạn 50 dòng + nút tải
  thêm: (a) Client errors từ `api.listClientErrors()` (thời gian, crash_id, message
  cắt ngắn — không hiện stack đầy đủ trong bảng, bấm vào 1 dòng mới hiện stack);
  (b) Backup runs gần nhất (tái dùng dữ liệu tab Backup, không gọi API thừa);
  (c) Audit logs gần nhất (tái dùng `api.listAuditLogs()` đã có ở R6, không viết
  lại). Kèm dòng ghi chú: "Log hệ thống đầy đủ xem bằng `wrangler tail` — xem
  `docs/OBSERVABILITY.md`".
- **Tab Settings (mở rộng, không viết lại):** thêm mục Backup — ô bật/tắt backup
  (checkbox), ô số ngày giữ (số nguyên 1..365), nút Lưu (gọi `updateAdminSettings`
  đã mở rộng; chỉ hiện với `super_admin`). `send_daily_cap` giữ nguyên.
- **Kiểu dữ liệu:** định nghĩa type mới trong `src/api.ts` gần các type admin hiện
  có (theo mẫu `AdminStats`/`AuditLogEntry` ở `src/admin.tsx:14-27` — type suy ra từ
  `ReturnType<typeof api.*>`, không định nghĩa tay 2 lần).

**`src/api.ts` — CHỈ THÊM, KHÔNG đổi chữ ký hàm cũ:**

- Thêm 6 method vào **CẢ HAI chỗ**: `ApiClient` interface (`src/api.ts:397`) **VÀ**
  `api` object (`src/api.ts:476`). Bắt buộc cả hai vì interface không còn index
  signature — thiếu một bên là tsc fail.
- 6 method: `listBackupRuns`, `runBackupNow`, `listBackupObjects`, `downloadBackupObject`,
  `reportClientError`, `listClientErrors`.
- `downloadBackupObject` trả về `Blob` (không phải JSON — dùng `fetch` + `response.blob()`,
  không đi qua `requestJson`); các method còn lại dùng `requestJson` như các method
  admin hiện có. `reportClientError` gửi `crashId` + 4 field (xem §1.3 route 5).
- Không đổi chữ ký `getAdminSettings`/`updateAdminSettings` — chỉ mở rộng kiểu trả về
  / payload (thêm field backup, các field cũ giữ nguyên).

### 1.7 Khôi phục (restore) — chỉ tài liệu + tải file, KHÔNG nút restore tự động

- **Không làm nút "Khôi phục" trong UI, không làm endpoint restore tự động.**
  Khôi phục sai có thể ghi đè D1 sống — vòng này tuyệt đối không viết code ghi đè
  database thật.
- **Tài liệu mới `docs/BACKUP-RESTORE.md` (1 trang):** backup gồm những gì (file D1
  export + object R2 raw), cách tải file (tab Backup → nút tải, hoặc `wrangler r2
  object get`), quy trình khôi phục THỦ CÔNG gồm 3 bước: (1) tải file export về máy;
  (2) kiểm tra toàn vẹn (`sqlite3 <file> "PRAGMA integrity_check;"` + đếm bảng/row
  đối chiếu với `backup_runs`); (3) khôi phục vào **database thử nghiệm riêng**
  (tạo D1 mới / database local) để kiểm tra trước — **không khôi phục thẳng lên D1
  `aistockvn-mail` đang sống**; chỉ khi đã kiểm tra xong và Henrry quyết thì mới
  khôi phục lên database sống, do người vận hành làm tay bằng `wrangler d1 restore`
  (lệnh mẫu ghi trong tài liệu, không chạy trong vòng này).
- **Drill (diễn tập) ở vòng này:** sau khi có 1 backup thành công (bằng phương án đã
  chốt), tải file export về IB3 `/tmp`, chạy `integrity_check` + đếm bảng/row, ghi
  kết quả vào báo cáo, xóa file ngay sau đó. Drill KHÔNG tạo database mới, KHÔNG
  khôi phục lên D1 sống. Nếu chưa có backup thành công (phương án chưa chốt) thì
  drill để vòng sau, ghi rõ trong báo cáo.

### 1.8 Những gì KHÔNG làm ở R8 (ghi rõ lý do, đừng tự thêm)

### QUYẾT ĐỊNH ĐÃ CHỐT (Henrry 14:45 20/11, tin nhắn: "Làm như omnimail luôn em nhé")
- **1. Phương án engine: A — Cloudflare Workflow** (chuẩn OmniMail: `OmniMailBackupWorkflow extends WorkflowEntrypoint`). Vòng code viết engine A.
- **2. Tên bucket backup: `aistockvn-mail-backup`** (tách riêng theo luật hạ tầng). Bucket + secret nạp ở bước deploy riêng (vòng code KHÔNG tự tạo bucket/secret).
- **4. Lịch chạy + thời gian giữ: hàng ngày 03:00 giờ VN (`0 20 * * *` UTC), giữ 30 ngày** (mặc định brief, Henrry không đổi).
- **5. Phạm vi copy R2: incremental** (chỉ copy object mới hơn lần backup thành công gần nhất, theo prefix `raw/YYYY/MM/`).
- **8. Kênh cảnh báo khi backup lỗi: mặc định** — chỉ ghi `backup_runs` `status='failed'` + audit log (xem trong tab Backup). Không gửi cảnh báo ra ngoài ở vòng này.
- **9. Giữ `client_errors` 30 ngày** (purge cùng lần backup thành công). Chỉ `mailboxHash`, không lưu email thô.
- **Các điểm còn lại (3, 6, 7, 10, 11) giữ nguyên như brief:** 3 secret D1 REST do Henrry tạo/quyết cách tạo (vòng code không tự tạo token); secret không vào backup; không khôi phục tự động; không endpoint health riêng; R8 không đụng Gmail/IMAP/OAuth.

Các điểm dưới đây là **LOẠI TRỪ — cần Henrry quyết, vòng này không tự quyết**:

1. **Phương án engine (§1.4):** A Workflow / B cron + endpoint nội bộ / C script
   ngoài. Chưa chốt thì vòng code làm phần lõi chung rồi dừng trước phần engine
   (§1.0).
2. **Tên bucket backup + ai tạo:** tên đề xuất `aistockvn-mail-backup` (tách riêng
   theo luật hạ tầng). Vòng code chỉ tạo bucket nếu có token Cloudflare trên IB3 và
   Henrry đã chốt tên; nếu không thì Henrry tạo (dashboard/API) rồi báo tên lại.
   Không dùng chung bucket `aistockvn-mail-raw`.
3. **3 secret D1 REST (chỉ phương án A/B):** `D1_REST_API_TOKEN` phải do Henrry tạo
   (token quyền D1 đọc) hoặc quyết cách tạo — vòng này không tự tạo token, không
   dùng token của tài khoản khác, không ghi giá trị token vào code/brief/log.
   Phương án C không cần 3 secret này.
4. **Lịch chạy + thời gian giữ (số brief chọn theo grounding, anh có thể đổi):**
   mặc định chạy hàng ngày 03:00 giờ VN (`0 20 * * *` UTC), giữ 30 ngày (giữ 30 bản
   D1 + object R2 tương ứng). Đổi lịch/giữ bao lâu thì Henrry quyết — vòng code chỉ
   làm đúng số đã chốt.
5. **Phạm vi copy R2:** mặc định incremental (chỉ copy object mới hơn lần backup
   thành công gần nhất, theo prefix `raw/YYYY/MM/`). Nếu Henrry muốn copy toàn bộ
   mỗi lần (đơn giản nhưng tốn R2 + thời gian) thì quyết lại.
6. **Secret không bao giờ vào backup:** `ENCRYPTION_KEY` và mọi secret Worker không
   được sao lưu cùng backup (export D1/R2 không chứa chúng). Nếu mất
   `ENCRYPTION_KEY` thì nội dung thư đã mã hóa trong backup không giải được — key
   này giữ theo LUẬT KEY (bản sao 0600 trên ≥2 máy), không đưa vào vòng R8.
7. **Khôi phục tự động:** không làm (xem §1.7). Khôi phục là việc làm tay, có kiểm
   tra trước, Henrry quyết từng lần.
8. **Kênh cảnh báo khi backup lỗi:** mặc định vòng này chỉ ghi `backup_runs`
   `status='failed'` + audit log (xem trong tab Backup). Gửi cảnh báo ra ngoài
   (Telegram qua bot đã có / email tới admin@) là việc cần Henrry quyết kênh — vòng
   này không tự gửi cảnh báo.
9. **Giữ client_errors bao lâu:** mặc định 30 ngày (purge cùng lần backup thành công
   — xóa row `client_errors` cũ hơn 30 ngày). Đổi số ngày thì Henrry quyết. Không
   lưu email thô trong `client_errors` (chỉ `mailboxHash`).
10. **Health-check endpoint riêng (`GET /api/health`):** không làm ở R8 (Worker đã có
    sẵn tín hiệu sống qua `/api/session` + `wrangler tail`; endpoint health riêng
    không nằm trong grounding §4/§5). Nếu Henrry muốn thì vòng sau.
11. **R7 / hộp thư ngoài:** R8 không đụng Gmail/IMAP/OAuth. Backup D1 export lấy
    toàn bộ database nên nếu R7 sau này thêm bảng `external_accounts` thì tự động
    được sao lưu theo — không cần code thêm.

## 2. Test mới (theo mẫu `worker/admin.test.ts` + `worker/admin-routes.test.ts`)

- `worker/backup.test.ts` (module): settings mặc định (`backup_enabled='0'`,
  retention 30, schedule `'0 20 * * *'`); update settings validate (retention 0 /
  366 / chữ → 400; admin thường đổi → 403); `runBackup` với D1 REST fetch mock +
  R2 mock (không gọi Cloudflare thật): export thành công → row `succeeded` + đúng
  `d1_object_key`/`d1_size`; D1 REST lỗi → row `failed` + `error` không chứa
  secret; run đang `running` → lần 2 trả `skipped`; copy R2 incremental (object cũ
  hơn lần backup trước thì không copy lại); 1 object lỗi không giết cả lần chạy
  (`r2_errors` tăng, vẫn `succeeded` nếu D1 xong — ghi rõ quy tắc này); retention
  purge chỉ xóa object trong bucket backup quá hạn, không xóa object trong bucket
  `RAW` (mock assert `RAW.delete` không bao giờ được gọi); `downloadBackupObject`
  với key ngoài phạm vi (`../`, key không thuộc run) → 400.
- `worker/observability.test.ts` (module + route): `logEvent` ra đúng 1 dòng JSON có
  `event` + `ts`, cắt ký tự điều khiển, drop khóa cấm (`password`, `token`,
  `subject`, `body`, ...), cắt giá trị dài, không bao giờ throw; client-errors
  endpoint: body > 16KB → 413, thiếu `crashId` → 400, field lạ (`subject`, `token`)
  bị bỏ không lưu, `mailboxHash` là băm (khác email thô, đúng 64 ký tự hex).
- `worker/backup-routes.test.ts` (route + scope, theo mẫu
  `worker/admin-routes.test.ts`): list/run/objects/download của user thường → 403;
  `POST /api/admin/backups/run` của admin thường → 403 (chỉ super_admin);
  `POST /api/client-errors` của user thường đã đăng nhập → 200 (không cần admin);
  chưa đăng nhập → 401; migration 0016 apply được trên D1 local (test chạy qua là
  đủ — không chạy migration lên D1 thật).
- Cập nhật test route nếu có (theo mẫu test hiện có). Không sửa test cũ trừ khi test
  cũ sai theo spec mới — nếu phải sửa, ghi rõ lý do trong báo cáo.

## 3. Verify (bắt buộc, chạy lại độc lập sau mỗi vòng)

```bash
npx tsc --noEmit          # phải 0 lỗi
npx vitest run --isolate=false --exclude worker/smoke.e2e.test.ts   # pass hết: 232 baseline + test mới (trừ smoke.e2e.test.ts, cần dev server live)
```

Đếm route `/api/*` trong `worker/index.ts` trước/sau bằng
`grep -E "path === ['\"]/api" worker/index.ts` (repo dùng cả nháy đơn lẫn nháy kép);
sau = trước + 5 (47 → 52; nếu phương án C đã chốt thì route 2 không làm → sau =
trước + 4, ghi rõ trong báo cáo). Kiểm tra `git status` kiểu thủ công: liệt kê
file tạo/sửa + sha256 từng file. Kiểm tra D1 local: migration 0016 apply được (test
chạy qua là đủ — không chạy migration lên D1 thật). Kiểm tra secret scan: grep toàn
workdir tìm tên 3 secret mới + giá trị mẫu (chỉ được xuất hiện dạng `env.X`, không
được có giá trị thật). Kiểm tra P2 cross-talk: grep output tìm `qwen`, `checkpoint`,
`hoplite`, `vn-stock-ai`, `training`, `eval`, `colab` (phải = 0 — workdir webmail
không dính code P2). **Bằng chứng backup:** số liệu probe bước 0 (dung lượng export
+ số bảng + `integrity_check`) và kết quả drill §1.7 phải có trong báo cáo (file
probe đã xóa sau khi đo — chỉ giữ số liệu, không giữ file).

Lưu ý: `tsc -p tsconfig.worker.json` có 7 lỗi từ trước trên code live (worker/index.ts
dòng ~1417-1460, có sẵn từ trước R4 — chưa sửa). Lệnh verify chuẩn của vòng này là
`npx tsc --noEmit` ở trên; nếu `tsc -p tsconfig.worker.json` vẫn đúng 7 lỗi cũ đó thì
ghi nhận là "không đổi", KHÔNG sửa trong vòng này, KHÔNG báo FAIL vì đó.

## 4. Ràng buộc nhắc lại

- **Bước 0 trước mọi code engine (§1.0):** xác nhận phương án + probe D1 export có
  bằng chứng; nếu chưa chốt thì làm phần lõi chung rồi DỪNG, không tự chọn phương án,
  không tự tạo bucket/secret/token.
- **An toàn dữ liệu (§0):** chỉ đọc dữ liệu thật + tạo bản sao. Không xóa, không ghi
  đè, không sửa row thật nào. Không DELETE row D1, không DELETE object R2 `RAW`.
  Không khôi phục lên D1 sống, không làm endpoint restore tự động.
- KHÔNG viết lại `worker/index.ts`; KHÔNG đổi chữ ký hàm cũ trong `src/api.ts`.
- KHÔNG sửa `src/App.tsx` chút nào ở vòng này (không route hash mới, không link nav).
  Chỉ sửa `src/admin.tsx` (thêm 2 tab + mục Backup trong tab Settings), `src/api.ts`
  (thêm 6 method), `src/main.tsx` (bọc `ErrorBoundary`), và 2 file mới
  (`src/error-boundary.tsx`, `docs/OBSERVABILITY.md`, `docs/BACKUP-RESTORE.md`).
- KHÔNG commit/push/deploy. KHÔNG `rm` file nào (kể cả file test hay file tạm, kể cả
  file probe bước 0 nếu đã copy vào workdir — probe để ở `/tmp`, xóa sau khi đo).
- KHÔNG đưa key/secret/token vào prompt, log, file hay chat. Không thêm secret mới
  nào vào code — secret (nếu cần, phương án A/B) chỉ nạp bằng `wrangler secret put`
  khi deploy, do người giữ token làm.
- D1 trigger: KHÔNG dùng (đồng bộ chạy bằng cron + lease/run-row, không dùng trigger).
- Không thêm dependency mới vào `package.json` (D1 REST export dùng `fetch` có sẵn,
  R2 copy dùng binding có sẵn, cron dùng `wrangler.jsonc`). Không thêm binding mới
  vào `wrangler.jsonc` ngoài `BACKUP` (+ Workflow nếu phương án A đã chốt) và
  `[triggers] cron` (nếu phương án B đã chốt).
- Không tự tạo/tự dùng bất kỳ tài khoản Cloudflare/Google nào; credential/token chỉ
  do Henrry tạo/quyết.
- Mọi con số trong báo cáo phải có bằng chứng (lệnh/log/D1) — không bịa. Riêng số
  route trước/sau, số liệu probe bước 0 và kết quả drill phải có trong báo cáo.
