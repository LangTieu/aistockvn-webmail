# PROMPT — Phase 4 Round 7: Gom hộp thư ngoài (Gmail trước)

Bạn làm việc trên repo webmail aistockvn (Worker + React SPA + D1). Đọc kỹ brief này
trước khi code. Repo làm việc: `/data/home/webmail-r4-neon/` trên IB3 (đã sync, baseline
sau R6 — KHÔNG dùng VM clone làm baseline, VM còn ở bản pre-R4).
Grounding OmniMail: `OMNIMAIL-GROUNDING-R4-R8.md` ở repo root — đọc §3 trước khi code.

## 0. Hiện trạng (đã verify trên IB3, workdir `/data/home/webmail-r4-neon/`)

- Live: Worker `aistockvn-mail` tại mail.aistockvn.com, version **bc706f66** (deploy 21:36
  19/11, bản dedup). **R4 + R6 + fix Sent-alias đã xong trên IB3 nhưng CHƯA deploy** —
  vòng này code tiếp trên baseline post-R6, không chờ deploy. Snapshot deploy R4+R6+fix
  đã tách riêng tại `/data/home/webmail-r6-deploy-snapshot/` — **ĐỪNG ĐỤNG VÀO**.
- `npx tsc --noEmit` 0 lỗi, `vitest run --isolate=false` **232/232** (baseline sau R6;
  trừ `smoke.e2e.test.ts`, cần dev server live).
- `worker/index.ts` **2158 dòng** (sha `6e7eed09`), routes `/api` = **47**.
  `src/api.ts` **700 dòng** (sha `62b68ad8`). `src/App.tsx` **2029 dòng**
  (sha `12a46a0a`). `src/admin.tsx` **1531 dòng** (sha `babdfff3`).
  Migration mới nhất `migrations/0014_admin.sql` (sha `8eea379e`).
  **TUYỆT ĐỐI KHÔNG viết lại `worker/index.ts`** — chỉ sửa phẫu thuật: thêm import +
  block route mới + các điểm sửa nhỏ ghi ở §1.4/§1.5. Đếm route trước/sau: sau =
  trước + 4 (xem §1.3).
- `src/api.ts`: `ApiClient` interface ở `src/api.ts:397`, `api` object ở `src/api.ts:476`
  — **KHÔNG còn index signature** (bài học restore 3b + R4: thêm method mới phải sửa
  CẢ interface lẫn object, thiếu một bên là tsc fail). `session()` ở `:399`/`:478`
  trả `{email, mailbox, role}`. `list(folder, q?, before?, tab?)` ở `:412` (impl `:522`),
  `counts()` ở `:418`, `get(id)` ở `:419` (impl `:530`, gọi
  `GET /api/messages/:id`).
- `src/App.tsx`: `Route` union ở `:55` (`admin` ở `:68`), `parseRoute` ở `:70`
  (`/admin` ở `:92`), dispatch `AdminPanel` ở `:2013`, `NotificationsPanel` ở `:2008`.
  Nav desktop: Security ~:1672, Notifications ~:1681, Admin (chỉ khi `isAdmin`) ở
  `:1688-1696`; nav mobile: Security ~:1876, Notifications ~:1884, Admin ở `:1890-1893`.
  `isAdmin` ở `:1620` và `:1744` (từ `role` của session). Danh sách thư lấy qua
  `api.list(...)` ở `:545` và `:615`; `api.counts()` ở `:1946`; `api.session()` ở
  `:1918`. `src/inbox.tsx` (`InboxView` ở `:297`) không gọi API trực tiếp — dữ liệu
  do `App.tsx` truyền xuống.
- **Hệ thống hiện KHÔNG có khái niệm hộp thư ngoài nào** (đã grep toàn workdir):
  không bảng external accounts, không code IMAP/OAuth/sync, không dùng
  `cloudflare:sockets`/`connect()`, không có `imapflow`/`googleapis`/`nodemailer`
  trong `package.json` (dependencies chỉ có `postal-mime`, `react`, `react-dom`).
  Hai địa chỉ `tranbinhanbr01@gmail.com` / `lethanhdongus@gmail.com` trong
  `ALLOWED_EMAILS` chỉ là **tài khoản đăng nhập bằng Google**, KHÔNG phải hộp thư
  ngoài đã kết nối — đừng nhầm. Chuỗi "external" duy nhất trong UI là
  "Images from external sources are hidden" (`src/shared-mail-views.tsx:361`, ảnh
  remote trong thư). `GOOGLE_JWKS_URL` trong `worker/auth.ts:20` chỉ để xác minh
  token đăng nhập Google, không phải Gmail API.
- **Grounding §3 có 2 điểm cũ, đừng làm theo:** (1) grounding viết notification
  outbox "giữ cột source để R7 dùng sau" — **sai**: `migrations/0013_notifications.sql`
  thật KHÔNG có cột `source` nào (`UNIQUE (mailbox_address, message_id, channel)`).
  R7 phải tự thêm cột nguồn/tài khoản (xem §1.1). (2) grounding §2 viết "chưa có
  khái niệm admin" — đã cũ từ R6 (admin đã có: `role` trong bảng `users`, 13 route
  `/api/admin/*` ở `worker/index.ts:881-1074`).
- **`wrangler.jsonc`: 1 Worker duy nhất, KHÔNG có `[triggers] cron`, không Queue,
  không Workflow.** Bindings chỉ có DB + RAW + AI. Secrets đã có: `RESEND_API_KEY`,
  `SESSION_SECRET`, `TOTP_ENCRYPTION_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`,
  `TELEGRAM_BOT_TOKEN`. Vars: `MAILBOX_ADDRESS` = `admin@aistockvn.com`,
  `ALLOWED_EMAILS` = 3 email, `GOOGLE_CLIENT_ID` (Web client để đăng nhập — công
  khai, không phải secret, KHÔNG phải OAuth client cho Gmail API),
  `FORWARD_TO` = `skillshare01br@mail.com`.
- **`export default` (`worker/index.ts:2084`) chỉ có `fetch` + `email()` — KHÔNG có
  handler `scheduled`.** Đồng bộ ngoài phải thêm handler mới + cron trigger (xem §1.5).
- **Đường thư hiện tại (tái dùng, không viết lại):**
  - `ingestInbound(env, raw, envelope, now)` (`worker/mail.ts:74`): parse MIME bằng
    PostalMime → dedup theo `message_id` trong folder `inbox` → lưu raw `.eml` lên
    R2 (`raw/YYYY/MM/<uuid>.eml`) → chấm spam → folder inbox/spam → phân loại
    Focused → `mailbox_address` = `env.MAILBOX_ADDRESS` hoặc `envelope.to` →
    mã hóa `text_body` bằng AES-GCM (`worker/crypto.ts`: `encryptText` ở `:66`,
    prefix `enc:v1:`) → `INSERT OR IGNORE INTO messages`. Trả
    `{id, duplicate, spamScore, spamReasons, folder}`.
  - **Bẫy dedup:** `ingestInbound` dedup theo `message_id` TOÀN CỤC trong folder
    `inbox` (không scope theo mailbox), và bảng `messages` có
    `UNIQUE INDEX idx_messages_folder_msgid ON messages (folder, message_id)`
    (`migrations/0001_init.sql`). Cùng một `Message-ID` về tới 2 tài khoản thì thư
    thứ hai sẽ bị coi là trùng / bị `INSERT OR IGNORE` nuốt mất. R7 PHẢI sửa điểm
    này (xem §1.1 + §1.4) — không được để sync im lặng mất thư.
  - Bảng `messages` (`migrations/0001_init.sql`) **không có cột `source` hay
    `external_account_id`**; `mailbox_address` thêm ở migration 0004, có index
    `(mailbox_address, folder, date DESC)`. Bảng `mailboxes` (`migrations/0004:33`):
    `address` PK, `user_id` FK, `is_primary`, `is_active`.
  - Tìm kiếm: `messages_fts` (FTS5) + trigger `messages_ai/ad/au`
    (`migrations/0008_search_fts.sql`) tự động index mọi row INSERT vào `messages`
    — thư ngoài vào đúng bảng này thì tìm được ngay, không cần code thêm.
    Endpoint `/api/search` ở `worker/index.ts:1287` scope theo `callerMailboxList`.
  - Danh sách thư (`GET /api/messages`, `worker/index.ts:1539`): lọc
    `folder = ? AND date < ? AND mailbox_address IN (callerMailboxList)` + tab
    Focused/Other qua `is_focused`; SELECT các cột `id, folder, from_addr,
    from_name, to_addrs, subject, snippet, date, is_read, is_focused, is_starred,
    attachments`; map qua `listItem` (`worker/index.ts:101`) — **không trả
    `mailbox_address` hay nguồn** (xem §1.4, phải thêm để frontend gắn nhãn).
  - Đọc thư đơn (`GET /api/messages/:id`, handler ở `worker/index.ts:1822`) **đã
    scope theo `callerMailboxList`** (truy vấn ở `:2011`:
    `id = ? AND mailbox_address IN (...)`). Star/batch (`:1732`/`:1752`) và
    `/api/counts` (`:1714`/`:1723`, trùng nhau từ trước — để nguyên) cũng scope
    theo `callerMailboxList`.
  - `callerMailboxList` được dựng ở `worker/index.ts:842-851`: `SELECT address FROM
    mailboxes WHERE user_id = (SELECT id FROM users WHERE email = ?)` + thêm
    mailbox chung `env.MAILBOX_ADDRESS`. Đây là điểm nối duy nhất để thư ngoài
    hiện trong inbox/tìm kiếm/đếm của đúng chủ sở hữu (xem §1.4).
  - Thông báo (R4): `getNotificationSettings` (`worker/notifications.ts:111`) đọc
    theo `mailbox_address`; **chưa có row thì mặc định tất cả TẮT**
    (`toSettingsDto` ở `worker/notifications.ts:71`: `pushEnabled: false,
    telegramEnabled: false, detailLevel: 'basic'`). Hook enqueue trong `email()`
    (`worker/index.ts:2117-2145`): thư mới không trùng + folder inbox +
    `shouldNotify` → `enqueueNotification` theo từng kênh đang bật.
- **KHÔNG commit/push/deploy. KHÔNG `rm` file nào (kể cả `src/App.tsx.bak` có sẵn
  trong workdir — để nguyên). KHÔNG ghi key/secret/token/app password vào code,
  brief, log hay chat.**

## 1. Spec

### 1.0 Bước 0 — Probe IMAP/TCP (BẮT BUỘC, làm trước mọi code sync)

Grounding §3 đề xuất Gmail qua IMAP + App Password, nhưng **chưa ai kiểm chứng IMAP
chạy được trong Workers runtime của mình không**: TCP qua `connect()` của
`cloudflare:sockets` có thể không có trên gói Workers hiện tại, và không có thư viện
IMAP Node nào chạy được trong Workers (không có `net`/`tls`).

- Viết probe TẠM (file riêng ngoài repo, KHÔNG commit, KHÔNG đưa vào brief/code
  chính): một Worker tối thiểu `import { connect } from "cloudflare:sockets"`, chạy
  bằng `wrangler dev` trên IB3, thử mở TCP TLS tới `imap.gmail.com:993`, in kết quả
  (kết nối được/không + thông báo lỗi nguyên văn). Giữ lại log probe làm bằng chứng
  trong báo cáo.
- **Ngã rẽ sau probe (ghi rõ, không tự ý đi tiếp):**
  - Nếu TCP chạy được → làm tiếp các mục dưới theo kênh IMAP + App Password.
  - Nếu TCP KHÔNG chạy được (vd lỗi "Sockets API requires a paid plan" hay runtime
    không có `connect`) → **DỪNG VÒNG, báo cáo FAIL LOUD kèm log probe**. Phương án
    thay thế là Gmail API qua HTTPS (`fetch` tới `gmail.googleapis.com`, luôn chạy
    được) nhưng cần OAuth 2.0 — mà OAuth client/scopes/tài khoản Google Cloud là
    việc cần Henrry quyết (xem §1.8 điểm 2). **Không tự tạo OAuth client, không tự
    dùng token của tài khoản khác, không bịa credential.** Vòng R7 chỉ được tính là
    xong khi sync chạy được thật bằng một kênh đã chốt.
- Không thêm dependency IMAP nào nếu chưa có bằng chứng probe (các lib IMAP Node
  như `imapflow`/`nodemailer` KHÔNG chạy trong Workers — đừng thêm vào
  `package.json`).

### 1.1 Migration `migrations/0015_external.sql` (MỚI)

```sql
CREATE TABLE IF NOT EXISTS external_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('gmail')),
  email TEXT NOT NULL,
  credential_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disabled', 'syncing')),
  last_seen_uid INTEGER NOT NULL DEFAULT 0,
  uid_validity INTEGER,
  last_synced_at INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, provider, email)
);
CREATE INDEX IF NOT EXISTS idx_external_accounts_user ON external_accounts (user_id);

ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'omnimail';
ALTER TABLE messages ADD COLUMN external_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_source_account ON messages (source, external_account_id);

-- Bẫy dedup (§0): thay UNIQUE toàn cục (folder, message_id) bằng UNIQUE theo từng mailbox,
-- để cùng một Message-ID về 2 tài khoản vẫn lưu được 2 row. Dữ liệu hiện tại thỏa UNIQUE cũ
-- (chặt hơn) nên thỏa UNIQUE mới — migration an toàn.
DROP INDEX IF EXISTS idx_messages_folder_msgid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_mailbox_folder_msgid
  ON messages (mailbox_address, folder, message_id) WHERE message_id IS NOT NULL;
```

- `credential_enc`: App Password (vòng này) hoặc refresh token OAuth (vòng sau nếu
  đổi kênh) — **luôn mã hóa bằng `encryptText` của `worker/crypto.ts`, không bao giờ
  lưu plaintext**. Không thêm cột nào chứa secret dạng plaintext.
- Không sửa bảng nào khác. Không dùng D1 trigger (giữ code hiển như mọi vòng trước).

### 1.2 Module mới `worker/gmail.ts` (theo mẫu `worker/notifications.ts`: hàm thuần + `XxxError`, index.ts chỉ import + gọi)

- `GmailError{status}`: 400 validate (`invalid_input`, `invalid_provider`),
  401 credential sai (`gmail_auth_failed`), 403 không phải chủ tài khoản
  (`not_owner`), 404 tài khoản không tồn tại (`account_not_found`), 409 đang sync
  (`already_syncing`), 502 lỗi provider (`gmail_provider_error`).
- `listExternalAccounts(env, userId)`: trả field công khai của tài khoản của user
  đó: `[{id, provider, email, status, lastSyncedAt, lastSeenUid, lastError}]` —
  **KHÔNG bao giờ trả `credential_enc` hay App Password**.
- `connectGmailAccount(env, userId, email, appPassword)`: validate email + App
  Password không rỗng; **thử đăng nhập IMAP thật (LOGIN probe) trước khi lưu** —
  sai credential → 401, không ghi row; đúng → mã hóa credential bằng
  `encryptText` (khóa `ENCRYPTION_KEY` như thư inbound) rồi INSERT
  (`status='active'`, `last_seen_uid=0`, `last_synced_at=NULL`). Trùng
  `(user_id, provider, email)` → 400 `account_exists`.
- `disconnectGmailAccount(env, userId, accountId)`: tài khoản không phải của user
  → 404 (không lộ tài khoản của người khác có tồn tại hay không); đúng chủ →
  `status='disabled'` (chỉ dừng sync, **GIỮ thư đã gom** — xem §1.8 điểm 7).
- `syncGmailAccount(env, accountId, now)`: nhận `accountId` (được cron gọi và route
  sync tay gọi chung một hàm):
  1. Claim lease: `UPDATE external_accounts SET status='syncing', lease_until =
     now + 360000 WHERE id=? AND status='active' AND lease_until <= now` (lease
     6 phút, theo grounding §3); không claim được → trả `{skipped: true}` (lần
     chạy khác đang giữ lease, không đè lên nhau).
  2. Mở IMAP, `SELECT INBOX`, đọc `UIDVALIDITY`: nếu khác `uid_validity` đã lưu
     → reset `last_seen_uid=0` (mailbox đã rebuild, UID cũ vô nghĩa) và đồng bộ
     lại từ đầu mà KHÔNG gửi thông báo cho thư cũ.
  3. Lấy UID > `last_seen_uid`, tối đa **50 thư/lần** (batch theo grounding §3);
     fetch raw MIME từng thư (dùng `postal-mime` đã có để parse — không thêm lib).
  4. Với mỗi thư: gọi `ingestInbound(env, raw, {from, to}, now, {mailboxAddress:
     account.email, source: 'gmail', externalAccountId: account.id})` (xem §1.4
     — opts mới). Cập nhật `last_seen_uid` = UID lớn nhất đã xử lý thành công
     (ghi sau từng batch nhỏ, không đợi hết 50 mới ghi — chết giữa chừng thì lần
     sau resume từ cursor, không kéo lại từ đầu).
  5. Lần sync ĐẦU TIÊN của một tài khoản (`last_synced_at IS NULL`): chỉ đặt
     cursor, **KHÔNG gửi thông báo cho thư lịch sử** (cùng luật với trigger
     Telegram ở grounding §1a). Từ lần sau, thư mới vào inbox thì đi qua hook
     thông báo ở §1.6.
  6. Lỗi từng thư (parse lỗi, fetch lỗi) → đếm vào `errors`, ghi `last_error`,
     tiếp tục thư sau (không để 1 thư hỏng giết cả lần sync). Lỗi kết nối/auth →
     `status='error'` + `last_error` (KHÔNG ghi App Password hay nội dung lỗi thô
     của provider vào DB/log). Trả `{fetched, inserted, duplicates, errors}`.
  7. Luôn giải phóng lease ở cuối (`status` về `active`/`error`, `lease_until=0`),
     kể cả khi lỗi (dùng `finally`).
- Giữ tối đa **500 thư gần nhất/tài khoản** (`INDEX_MESSAGE_LIMIT` theo grounding
  §3): sync chỉ kéo UID mới, không kéo lại lịch sử cũ hơn cursor; số 500 là giới
  hạn của lần sync đầu (chỉ lấy 500 thư mới nhất). Không xóa thư cũ đã gom.

### 1.3 Route mới trong `handleApi()` (thêm import + block, KHÔNG viết lại file)

Tất cả đều yêu cầu session (đi qua middleware session chung ở
`worker/index.ts:838-851`, đã có `callerMailboxList`). Đếm route trước khi sửa và
sau khi sửa bằng `grep -E "path === ['\"]/api" worker/index.ts`; sau = trước + 4
(47 → 51). Ghi số đếm vào báo cáo.

| # | Route | Mô tả |
|---|---|---|
| 1 | `GET /api/external/accounts` | Tài khoản ngoài của chính user gọi: `[{id, provider, email, status, lastSyncedAt, lastSeenUid, lastError}]`. Không trả credential. User khác không thấy tài khoản của nhau (kể cả admin — xem §1.4). |
| 2 | `POST /api/external/gmail/connect` | Body `{email, appPassword}` — cả hai bắt buộc, `email` phải đúng dạng địa chỉ Gmail (`@gmail.com` hoặc Google Workspace — chấp nhận cả hai, validate bằng regex đơn giản, sai → 400). Gọi `connectGmailAccount` (§1.2). Sai credential → 401, không ghi row. |
| 3 | `POST /api/external/gmail/disconnect` | Body `{accountId}` — gọi `disconnectGmailAccount`. Không phải chủ → 404. |
| 4 | `POST /api/external/gmail/sync` | Body `{accountId}` — chạy một lần sync ngay bằng `syncGmailAccount` (cùng hàm cron dùng), trả `{fetched, inserted, duplicates, errors}`. Không phải chủ → 404. Đang có lease → trả `{skipped: true}` (không 409 — nút "Sync now" bấm trùng không phải lỗi). |

Không thêm route nào khác ở R7 (không route trạng thái riêng — trạng thái nằm trong
route 1; không route OAuth — xem §1.8 điểm 2).

### 1.4 Điểm nối vào đường thư hiện tại (phẫu thuật, không viết lại luồng)

**a. `callerMailboxList` (`worker/index.ts:842-851`) — điểm nối duy nhất:**

Sau khi dựng xong `callerMailboxList` từ bảng `mailboxes` + mailbox chung, thêm MỘT
truy vấn: `SELECT email FROM external_accounts WHERE user_id = (SELECT id FROM
users WHERE email = ?) AND provider='gmail' AND status IN ('active','error')`
(đang sync thì vẫn đọc được; `disabled` thì thôi) rồi append các email đó vào
`callerMailboxList` (lowercase, dedup). Nhờ vậy mà KHÔNG cần sửa gì ở các endpoint
đọc: `/api/messages` (`:1539`), `/api/search` (`:1287`), `/api/counts` (`:1714`/`:1723`),
star/batch (`:1732`/`:1752`), đọc thư đơn (`:1822`, đã scope ở `:2011`), threads
(`:1642`) — tất cả đều scope theo `callerMailboxList` sẵn rồi. Thư ngoài tự hiện
trong inbox/tìm kiếm/đếm của đúng chủ sở hữu, và **chỉ chủ sở hữu thấy** (user khác,
kể cả admin, không thấy — `callerMailboxList` là theo từng user).

**b. `ingestInbound` — thêm opts, giữ nguyên hành vi mặc định:**

`worker/mail.ts:74`: thêm tham số thứ 4
`opts?: { mailboxAddress?: string; source?: string; externalAccountId?: string }`.
- Dedup SELECT đổi thành `WHERE mailbox_address = ? AND folder='inbox' AND
  message_id = ?` với mailbox = `opts.mailboxAddress ?? env.MAILBOX_ADDRESS` (luồng
  inbound cũ không truyền opts → hành vi cũ giữ nguyên).
- `mailboxAddress` khi INSERT = `opts.mailboxAddress` nếu có, ngược lại như cũ
  (`env.MAILBOX_ADDRESS || envelope.to`).
- INSERT thêm 2 cột `source` (= `opts.source ?? 'omnimail'`) và
  `external_account_id` (= `opts.externalAccountId ?? NULL`).
- Không đổi gì khác trong `ingestInbound` (spam score, Focused, mã hóa body, lưu
  R2 raw — thư ngoài đi qua đúng pipeline này nên tự có spam/Focused/mã hóa/R2).

**c. `listItem` + SELECT danh sách (`worker/index.ts:101` và `:1539`):**

Thêm `mailbox_address` và `source` vào SELECT ở `:1539` (cả nhánh FTS ở `:1287`
nếu cần cho nhất quán — chỉ khi SELECT đó cũng map qua `listItem`) và thêm 2 field
`mailboxAddress`, `source` vào object `listItem` trả về. Frontend dùng 2 field này
để gắn nhãn nguồn (§1.7). Không đổi tên/sha của field cũ nào.

### 1.5 Đồng bộ định kỳ — cron + `scheduled()` (mới hoàn toàn)

- `wrangler.jsonc`: thêm `"triggers": { "crons": ["*/5 * * * *"] }` (sync 5
  phút/lần, theo grounding §3). Không thêm binding mới (không Queue, không
  Workflow — R7 sống trong giới hạn 1 Worker hiện tại).
- `export default` (`worker/index.ts:2084`): thêm handler
  `async scheduled(event, env, ctx)`: lấy các account `status='active'` (giới hạn
  20 account/lần chạy — đủ cho hệ thống vài user; nhiều hơn thì lần cron sau làm
  tiếp), với mỗi account gọi `ctx.waitUntil(syncGmailAccount(env, account.id,
  Date.now()))`. Lỗi một account không giết các account khác (try/catch từng cái).
- Lưu ý giới hạn CPU Workers: một lần cron chỉ làm tối đa 50 thư/account (§1.2);
  nếu account có hơn 50 thư mới thì lần cron sau (5 phút) làm tiếp từ cursor —
  không kéo dài một lần chạy. Ghi rõ giới hạn này trong báo cáo.
- Nút "Sync now" (route §1.3 #4) dùng đúng hàm `syncGmailAccount` — không viết
  luồng sync thứ hai.

### 1.6 Thông báo cho thư ngoài (tái dùng hook R4, mặc định TẮT)

- Trong `syncGmailAccount`, sau khi `ingestInbound` trả về `duplicate === false`
  và `folder === 'inbox'` (và KHÔNG phải lần sync đầu — §1.2 điểm 5): gọi đúng
  mẫu hook trong `email()` (`worker/index.ts:2117-2145`): `getNotificationSettings`
  với `mailbox_address` = địa chỉ Gmail ngoài → `shouldNotify` → `enqueueNotification`
  theo từng kênh đang bật. Không viết lại logic enqueue/delivery
  (`worker/notify-delivery.ts` giữ nguyên).
- Vì settings mặc định là TẮT khi chưa có row (`toSettingsDto`,
  `worker/notifications.ts:71`), thư ngoài mặc định KHÔNG đẩy thông báo cho tới khi
  user bật — UI bật/tắt cho hộp thư ngoài CHƯA làm ở R7 (xem §1.8 điểm 9). Code
  enqueue vẫn phải có (để khi bật lên là chạy), và test phải chứng minh cả hai phía:
  settings tắt → không enqueue; settings bật (seed row trong test) → có enqueue.

### 1.7 Frontend — THEO GIAO DIỆN ĐÃ KHÔI PHỤC + R6 (không viết lại App.tsx)

**`src/external.tsx` (MỚI, theo mẫu `src/notifications.tsx` / `src/admin.tsx`):**

- `export function ExternalMailPanel({ onBack }: { onBack: () => void })` — panel
  toàn màn hình như Security/Aliases/Notifications/Admin, header có nút Back + tiêu
  đề "External mail" (giữ giao diện tiếng Anh như toàn app), tự fetch danh sách tài
  khoản khi mount (`useEffect` + `useState`), lỗi API hiện bằng chữ trong panel,
  không `alert()`, không crash. Tái dùng các hằng style cục bộ như `mfa.tsx`
  (`focusRing`, `inputClass`, `primaryButton`, `outlineButton`, helper `errorText`).
- Nội dung panel: danh sách tài khoản đã kết nối (provider "Gmail", email, trạng
  thái, lần sync cuối, lỗi cuối nếu có) + form kết nối mới (ô email + ô App Password
  kiểu password, nút "Connect") + mỗi tài khoản có nút "Sync now" và nút
  "Disconnect" (xác nhận 2 bước trong panel như R6: bấm lần 1 nút đổi thành "Xác
  nhận ngắt kết nối?", bấm lần 2 mới gọi API — không dùng `window.confirm`/`alert`).
- Ghi chú ngay trong form (chữ nhỏ, không popup): "Dùng App Password của Google,
  không dùng mật khẩu Gmail thường. Tạo App Password trong tài khoản Google của bạn
  (cần bật 2-Step Verification). App Password chỉ lưu dạng mã hóa, không hiển thị
  lại sau khi lưu." Không dẫn link ngoài lạ — chỉ chữ hướng dẫn.
- **Nhãn nguồn trong hộp thư:** ở hàng thư trong danh sách (`InboxView`,
  `src/inbox.tsx:297`, dữ liệu từ `api.list` ở `App.tsx:545`/`615`), nếu
  `source === 'gmail'` (hoặc `mailboxAddress` khác mailbox chung) thì hiện tag nhỏ
  với địa chỉ Gmail (vd `user@gmail.com`) cạnh tên người gửi — dùng style tag sẵn
  có trong `src/shared-mail-views.tsx` nếu có, không bịa style mới. Thư từ
  `@aistockvn.com` không đổi gì (không gắn tag).

**Đấu nối route (hash routing, `parseRoute` ở `src/App.tsx:70`, `Route` union ở
`:55`, dispatch trong `App()` ~`:2008-2013`) — 4 chỗ, phẫu thuật như R6 §1.7:**

1. Thêm `| { name: "external" }` vào `Route` union, ngay sau `{ name: "admin" }`,
   kèm comment `// PHASE4-R7`.
2. Thêm `if (path === "/external") return { name: "external" };` vào `parseRoute`,
   ngay sau nhánh `/admin`.
3. Thêm import ở đầu file (theo mẫu dòng 27-29):
   `import { ExternalMailPanel } from "./external";`
4. Thêm dispatch trong `App()`, ngay sau nhánh admin (`~dòng 2013`):
   ```tsx
   // PHASE4-R7
   if (route.name === "external") {
     return <ExternalMailPanel onBack={() => go("#/inbox")} />;
   }
   ```

**Vị trí nav — đặt trong nhóm cài đặt, cạnh Security/Notifications/Admin:**

- Sidebar desktop: trong block footer riêng (`<div className="flex flex-col px-2
  pb-1 lg:px-3">`, link Admin ở `:1688-1696`). Thêm link "External mail" NGAY DƯỚI
  link Admin trong cùng block, cùng class, `href="#/external"`,
  `title`/`aria-label="External mail"`, label "External mail". Hiện với MỌI user
  đã đăng nhập (không gate theo role — khác link Admin, vì mỗi user tự kết nối
  Gmail của mình).
- Mobile bottom nav: thêm link "External mail" ngay sau link Admin (`~dòng
  1890-1893`), cùng class, cũng hiện với mọi user.
- Icon: xem icon set `I` ở `src/shared-mail-views.tsx:46` trước — nếu đã có icon
  hợp (vd inbox/mail) thì tái dùng; nếu chưa, thêm 1 dòng theo đúng mẫu R6 (icon
  `tool` thêm sau `bell`): 1 path Feather duy nhất (component `Icon` chỉ render
  một `<path d={d} />`).

**`src/api.ts` — CHỈ THÊM, KHÔNG đổi chữ ký hàm cũ:**

- Thêm 4 method vào **CẢ HAI chỗ**: `ApiClient` interface (`src/api.ts:397`) **VÀ**
  `api` object (`src/api.ts:476`). Bắt buộc cả hai vì interface không còn index
  signature — thiếu một bên là tsc fail.
- 4 method: `listExternalAccounts`, `connectGmail`, `disconnectGmail`,
  `syncGmailNow`. Kiểu trả về theo đúng §1.2–§1.3 (account row công khai,
  `{fetched, inserted, duplicates, errors}` / `{skipped: true}`). Định nghĩa type
  mới trong `src/api.ts` gần các type notifications/admin hiện có.
- Không đổi chữ ký `list()` (`:412`) — thư ngoài hiện qua cùng `list()` nhờ §1.4,
  không cần thêm param.

### 1.8 Những gì KHÔNG làm ở R7 (ghi rõ lý do, đừng tự thêm)

Các điểm dưới đây là **LOẠI TRỪ — cần Henrry quyết, vòng này không tự quyết**:

1. **Gom Gmail của tài khoản nào:** vòng này chỉ xây cơ chế + UI kết nối; tài khoản
   Gmail cụ thể nào được gom là do người dùng tự nhập trong form kết nối. Thiết kế
   mặc định: **mỗi user tự kết nối Gmail của mình, chỉ mình thấy thư của mình**
   (§1.4). Nếu Henrry muốn gom chung MỘT Gmail cho mọi người dùng thấy thì phải
   quyết lại thiết kế (đổi scope `callerMailboxList` + quyền xem) — không tự đổi.
2. **Kênh lấy thư nếu IMAP không chạy được (§1.0):** Gmail API + OAuth 2.0 cần
   OAuth client trên Google Cloud (tài khoản Google nào tạo? consent screen?
   scope `gmail.readonly`?). **Luật tài khoản: trước khi làm việc liên quan tài
   khoản phải hỏi anh dùng tài khoản nào — vòng này KHÔNG tự tạo OAuth client,
   không tự dùng bất kỳ tài khoản Google nào.** Nếu probe bước 0 fail thì vòng
   dừng ở đó, báo cáo để Henrry quyết.
3. **App Password do anh tự tạo:** tạo trong tài khoản Google của anh (cần bật
   2-Step Verification) rồi nhập vào form kết nối trong webmail. **Không bao giờ
   hỏi anh paste App Password vào chat/log**, và vòng này không có cách nào khác
   để lấy credential.
4. **Thư ngoài hiện chung Inbox hay tab riêng:** mặc định R7 là **chung Inbox +
   gắn nhãn nguồn** (§1.7). Nếu Henrry muốn tab "External" riêng thì quyết lại —
   vòng sau.
5. **Gửi thư từ tài khoản Gmail ngoài (reply/send-as):** KHÔNG làm ở R7. Trả lời
   thư ngoài vẫn gửi đi từ mailbox `@aistockvn.com` như hiện tại (`/api/send`
   không đổi). Gửi qua Gmail API/SMTP là vòng riêng sau nếu Henrry quyết.
6. **Provider khác (Outlook / QQ / NAVER / Yandex / iCloud / Linux Do):** mỗi cái
   1 vòng riêng sau Gmail, cùng khung module (`worker/<provider>.ts` +
   `external_accounts.provider` mở rộng sau). R7 chỉ làm Gmail.
7. **Ngắt kết nối có xóa thư đã gom không:** mặc định R7 là **chỉ dừng sync, GIỮ
   thư đã gom** (xóa thư thuộc R6 cleanup / R8). Nếu Henrry muốn ngắt là xóa luôn
   thư đã gom thì quyết riêng.
8. **Giới hạn sync (số brief chọn theo grounding, anh có thể đổi):** batch 50
   thư/lần, cron 5 phút/lần, lần sync đầu lấy tối đa 500 thư mới nhất, lưu raw
   `.eml` lên R2 như thư inbound (tốn dung lượng R2 — nếu anh không muốn lưu raw
   thì quyết lại).
9. **Bật thông báo cho hộp thư ngoài:** data-layer enqueue đã có (§1.6, mặc định
   tắt), nhưng UI bật/tắt trong panel Notifications cho từng hộp thư ngoài CHƯA
   làm ở R7 — vòng sau (cần thêm chọn mailbox vào panel Notifications).
10. **Admin thấy tài khoản ngoài của mọi user:** KHÔNG làm ở R7 (route
    `/api/external/accounts` chỉ trả tài khoản của chính user gọi; panel Admin R6
    không đếm tài khoản ngoài). Nếu Henrry muốn admin giám sát thì vòng sau.

## 2. Test mới (theo mẫu `worker/notifications.test.ts`, `worker/admin.test.ts` + `worker/admin-routes.test.ts`)

- `worker/gmail.test.ts` (module): credential mã hóa round-trip (giá trị lưu bắt
  đầu bằng `enc:v1:` và khác plaintext; giải mã ra đúng App Password); connect sai
  credential (mock IMAP LOGIN fail) → 401, không ghi row; connect trùng
  `(user_id, provider, email)` → 400; sync với transport IMAP mock (không gọi
  Gmail thật): UID mới → insert đủ, `last_seen_uid` cập nhật, resume từ cursor
  không kéo lại; cùng `Message-ID` ở 2 account → 2 row khác `mailbox_address`
  (bẫy §0); cùng `Message-ID` 2 lần trong 1 account → 1 row; lần sync đầu không
  enqueue thông báo; lần sau thư mới vào inbox + settings bật → có enqueue,
  settings tắt → không enqueue; lease đang giữ → lần sync sau trả `skipped`;
  lỗi 1 thư không giết cả batch; lỗi auth → `status='error'`, `last_error`
  không chứa credential.
- `worker/external-routes.test.ts` (route + scope, theo mẫu
  `worker/admin-routes.test.ts`): list chỉ trả tài khoản của chính user (user B
  không thấy tài khoản của user A, kể cả admin); connect/disconnect/sync của tài
  khoản người khác → 404; thư ngoài chỉ hiện trong `/api/messages` + `/api/search`
  + `/api/counts` của chủ sở hữu (user khác gọi vẫn 0 / không thấy); `listItem`
  trả `mailboxAddress` + `source`; migration 0015 apply được trên D1 local (test
  chạy qua là đủ — không chạy migration lên D1 thật).
- Cập nhật test route nếu có (theo mẫu test hiện có). Không sửa test cũ trừ khi
  test cũ sai theo spec mới — nếu phải sửa, ghi rõ lý do trong báo cáo. Riêng test
  nào assert UNIQUE toàn cục `(folder, message_id)` (nếu có) thì phải sửa theo
  UNIQUE mới ở §1.1 và ghi rõ trong báo cáo.

## 3. Verify (bắt buộc, chạy lại độc lập sau mỗi vòng)

```bash
npx tsc --noEmit          # phải 0 lỗi
npx vitest run --isolate=false --exclude worker/smoke.e2e.test.ts   # pass hết: 232 baseline + test mới (trừ smoke.e2e.test.ts, cần dev server live)
```

Đếm route `/api/*` trong `worker/index.ts` trước/sau bằng
`grep -E "path === ['\"]/api" worker/index.ts` (repo dùng cả nháy đơn lẫn nháy kép);
sau = trước + 4 (47 → 51). Kiểm tra `git status` kiểu thủ công: liệt kê file tạo/sửa
+ sha256 từng file. Kiểm tra D1 local: migration 0015 apply được (test chạy qua là đủ
— không chạy migration lên D1 thật). Kiểm tra secret scan: grep toàn workdir tìm
App Password/credential mẫu (phải trống — credential test chỉ dùng giá trị giả trong
file test, không phải credential thật).

Lưu ý: `tsc -p tsconfig.worker.json` có 7 lỗi từ trước trên code live (worker/index.ts
dòng ~1417-1460, có sẵn từ trước R4 — chưa sửa). Lệnh verify chuẩn của vòng này là
`npx tsc --noEmit` ở trên; nếu `tsc -p tsconfig.worker.json` vẫn đúng 7 lỗi cũ đó thì
ghi nhận là "không đổi", KHÔNG sửa trong vòng này, KHÔNG báo FAIL vì đó.

## 4. Ràng buộc nhắc lại

- **Bước 0 trước mọi code sync (§1.0):** probe IMAP/TCP có log làm bằng chứng; nếu
  không chạy được thì DỪNG + báo cáo, không tự chuyển kênh, không tự tạo OAuth.
- KHÔNG viết lại `worker/index.ts`; KHÔNG đổi chữ ký hàm cũ trong `src/api.ts`;
  KHÔNG đổi hành vi mặc định của `ingestInbound` (opts mới chỉ tác động khi được
  truyền vào — luồng inbound cũ không truyền opts thì y nguyên).
- KHÔNG viết lại `src/App.tsx` — chỉ phẫu thuật đúng các điểm ở §1.7 (thêm route
  vào union + parseRoute + import + dispatch, thêm 2 link nav, thêm tag nguồn vào
  hàng thư). KHÔNG thêm External vào mảng folder hay `NavSection`. KHÔNG đụng
  `MailShell`, `currentSection`, `sectionHash`.
- KHÔNG commit/push/deploy. KHÔNG `rm` file nào (kể cả file test hay file tạm,
  kể cả probe bước 0 nếu đã copy vào workdir — probe để ngoài repo).
- KHÔNG đưa key/secret/token/App Password vào prompt, log, file hay chat. Không
  thêm secret mới nào vào `wrangler.jsonc` ở vòng này (credential ngoài lưu trong
  D1 đã mã hóa, không phải secret Worker).
- D1 trigger: KHÔNG dùng (đồng bộ chạy bằng cron + lease, không dùng trigger).
- Không thêm dependency mới vào `package.json` trừ khi probe bước 0 chứng minh
  cần (và lib đó phải chạy được trong Workers runtime — lib Node-only thì cấm).
  Không thêm binding mới vào `wrangler.jsonc` ngoài `[triggers] cron` ở §1.5.
- Không tự tạo/tự dùng bất kỳ tài khoản Google/Google Cloud nào; credential ngoài
  chỉ do user nhập trong form kết nối.
- Mọi con số trong báo cáo phải có bằng chứng (lệnh/log/D1) — không bịa. Riêng log
  probe bước 0 và số route trước/sau phải có trong báo cáo.
