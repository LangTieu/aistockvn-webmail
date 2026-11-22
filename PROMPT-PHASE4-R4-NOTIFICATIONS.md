# PROMPT — Phase 4 Round 4: Notifications (browser push + Telegram)

Bạn làm việc trên repo webmail aistockvn (Worker + React SPA + D1). Đọc kỹ brief này
trước khi code. Repo làm việc: `/data/home/webmail-s11h-gemini` (đã sync từ VM).
Grounding OmniMail: `OMNIMAIL-GROUNDING-R4-R8.md` ở repo root — đọc §1 trước khi code.

## 0. Hiện trạng (đã verify)

- Live: Worker `aistockvn-mail` tại mail.aistockvn.com, version **521eb542** (restore 3b
  deploy 18:12 19/11 — khôi phục giao diện cũ + R1 drafts + R2 starred/thread/batch).
  `tsc --noEmit` 0 lỗi, `vitest run --isolate=false` 185/185 (trừ `smoke.e2e.test.ts`,
  cần dev server live).
- `worker/index.ts` 1629 dòng, không đổi sau restore. **TUYỆT ĐỐI KHÔNG viết lại file
  này** — chỉ sửa phẫu thuật: thêm import + block route mới. Đếm route trước/sau:
  sau = trước + 6 (xem §1.4).
- `src/App.tsx` **2167 dòng** (bản restore 3b, sha `4c1d782e`), `src/api.ts` **476 dòng**
  (sha `84ab0d80`). `ApiClient` interface ở `src/api.ts:265`, `api` object ở
  `src/api.ts:324` — **KHÔNG còn index signature** (restore 3b đã gỡ; bài học: thêm
  method mới phải sửa CẢ interface lẫn object, thiếu một bên là tsc fail).
- **Mẫu frontend đúng cho R4 là panel cài đặt, KHÔNG phải view danh sách:**
  `MfaSettingsPanel` (`src/mfa.tsx:47`) và `AliasesPanel` (`src/aliases.tsx:37`) —
  component panel toàn màn hình, props `{ onBack }` (MFA thêm `email`), tự fetch trạng
  thái khi mount, lỗi hiện bằng chữ, không crash. `Drafts`/`Starred` KHÔNG phải mẫu
  cho R4: chúng là section trong `MailShell` (list + reading pane), còn Notifications
  là panel cài đặt như Security/Aliases. Xem chi tiết ở §1.6.
- Inbound mail: `email()` trong `worker/index.ts:1600` gọi `ingestInbound(env, raw, ...)`
  trong `worker/mail.ts`, trả `{id, duplicate, spamScore, folder}` — **nhưng hiện tại
  `email()` gọi mà KHÔNG giữ kết quả trả về** (`worker/index.ts:1613`), và chưa nhận
  `ctx`. Xem §1.3 — phải giữ lại return value mới có dữ liệu để bắn thông báo.
  Đây là hook duy nhất để bắn thông báo — không có queue/cron binding nào trong
  `wrangler.jsonc`.
- Workers Free: CPU 10ms/request. Mọi thứ trong request path phải nhẹ; việc gửi thông
  báo chạy trong `waitUntil`, KHÔNG chặn inbound.
- **KHÔNG commit/push/deploy. KHÔNG `rm` file nào. KHÔNG ghi key/secret/token vào
  code, brief, log hay chat.**

## 1. Spec

### 1.1 Migration `migrations/0013_notifications.sql`

```sql
CREATE TABLE IF NOT EXISTS notification_settings (
  mailbox_address TEXT PRIMARY KEY,
  push_enabled INTEGER NOT NULL DEFAULT 0 CHECK (push_enabled IN (0, 1)),
  telegram_enabled INTEGER NOT NULL DEFAULT 0 CHECK (telegram_enabled IN (0, 1)),
  telegram_chat_id TEXT NOT NULL DEFAULT '',
  detail_level TEXT NOT NULL DEFAULT 'basic' CHECK (detail_level IN ('basic', 'full')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  mailbox_address TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subs_mailbox ON push_subscriptions (mailbox_address);
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  mailbox_address TEXT NOT NULL,
  message_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('push', 'telegram')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  last_error_code TEXT NOT NULL DEFAULT '',
  UNIQUE (mailbox_address, message_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_notif_outbox_due ON notification_outbox (status, next_attempt_at);
```

Mặc định TẮT cả hai kênh. `detail_level`: `basic` = chỉ "Bạn có thư mới" + tên người
gửi + link mở webmail (KHÔNG tiêu đề, KHÔNG body); `full` = thêm tiêu đề + snippet
(tối đa 160 ký tự). Không bao giờ gửi body mail đầy đủ qua thông báo.

### 1.2 Module mới (theo mẫu `worker/drafts.ts`: hàm thuần + `XxxError`, index.ts chỉ import + gọi)

- `worker/notifications.ts` — settings CRUD (`getNotificationSettings`,
  `updateNotificationSettings`), outbox (`enqueueNotification` với
  `INSERT OR IGNORE` để dedup, `claimDueNotifications`, `markNotification`),
  `shouldNotify(folder, duplicate, settings)` (chỉ khi `folder === 'inbox'` và
  `duplicate === false`).
- `worker/push.ts` — VAPID: `vapidHeaders(audience, subject, privateKeyJwk)` ký JWT
  ES256 bằng `crypto.subtle` (không thêm dependency); `sendPush(subscription, payload,
  vapidPublicKey, privateKeyJwk)` — `fetch(endpoint, {method: 'POST', headers:
  {Authorization: 'vapid t=<jwt>, k=<pub>', TTL: '86400', Urgency: 'normal'}})`;
  endpoint trả 404/410 → xóa subscription đó. **V1: push không kèm payload mã hóa**
  (no-payload push); Service Worker nhận push thì gọi `GET /api/counts` rồi hiện
  "Bạn có thư mới". Không viết code mã hóa RFC 8291 ở vòng này.
- `worker/telegram.ts` — `TelegramError{code, retryable, retryAfter}`,
  `sendTelegramMessage(token, chatId, text)`: `POST
  https://api.telegram.org/bot<token>/sendMessage` với body
  `{chat_id, text, link_preview_options: {is_disabled: true}, protect_content: true}`,
  timeout 10s (`AbortSignal.timeout`); text 1–4096 ký tự; lỗi map: 429 →
  `telegram_rate_limited` (retryable, tôn trọng `retry_after`, tối đa 3600s),
  403 → `telegram_forbidden` (không retry; tắt endpoint), 5xx → `telegram_server`
  (retryable); lỗi mạng → `telegram_network` (retryable). Validate token bằng regex
  `^\d{5,20}:[A-Za-z0-9_-]{20,200}$` và chat id bằng `^-?\d{1,20}$` TRƯỚC khi gọi.
  **Không bao giờ ghi token hay nội dung lỗi thô chứa token vào log.**
- `worker/notify-delivery.ts` (hoặc gộp vào `notifications.ts`) —
  `deliverPendingNotifications(env, now)`: claim tối đa 20 row `pending` tới hạn,
  lease bằng `attempts+1`; mỗi row: bỏ qua nếu setting đã tắt / thiếu secret /
  thiếu chat id / thiếu subscription (→ `skipped`); gửi; thành công → `sent`;
  lỗi retryable và `attempts < 3` → `next_attempt_at = now + min(3600, 30 * 2^attempts)`;
  hết lần hoặc lỗi không retryable → `failed` (riêng 403 Telegram → tắt
  `telegram_enabled` của mailbox đó).

### 1.3 Hook vào inbound (phẫu thuật `email()` trong `worker/index.ts`)

`email()` hiện tại (`worker/index.ts:1600`, signature `(message, env)`, không có `ctx`)
gọi `ingestInbound()` ở dòng 1613 **mà không giữ kết quả trả về** — phải sửa:

1. Giữ lại return value: `const res = await ingestInbound(env, raw, { from: message.from, to: message.to });`
   (`res` = `{id, duplicate, spamScore, spamReasons, folder}`, xem `worker/mail.ts:71-203`).
2. Nếu `res.duplicate === false` và `res.folder === 'inbox'`: đọc `notification_settings`
   của mailbox nhận (`envelope_to` → mailbox_address); với mỗi kênh đang bật, ghi
   outbox (`INSERT OR IGNORE` — trùng thì thôi).
3. Thêm tham số `ctx: ExecutionContext` vào signature theo đúng kiểu
   `ExportedHandler<Env>` (`email(message, env, ctx)`), rồi gọi
   `ctx.waitUntil(deliverPendingNotifications(env, Date.now()/1000))`.
4. Đầu mỗi lần `email()` chạy, sweep dự phòng: gọi `deliverPendingNotifications`
   TRƯỚC khi ingest (xử lý nốt row `pending` còn sót nếu lần trước chết giữa chừng).
   Tổng cộng mỗi lần inbound tối đa 1 fetch push + 1 fetch Telegram trong `waitUntil`.
   Không sửa luồng forward hiện có, không sửa `ingestInbound`.

### 1.4 Route mới trong `handleApi()` (thêm import + block, KHÔNG viết lại file)

Tất cả đều yêu cầu session (theo mẫu các route hiện có) và scope theo mailbox của
người gọi (`callerMailboxList`, theo mẫu `/api/messages`):

| Route | Mô tả |
|---|---|
| `GET /api/notifications/settings` | Trả setting của mailbox (mặc định tắt). |
| `POST /api/notifications/settings` | Body `{push_enabled?, telegram_enabled?, telegram_chat_id?, detail_level?}` — validate: `detail_level` chỉ `basic\|full`; `telegram_chat_id` khớp `^-?\d{1,20}$` khi bật Telegram; sai → 400. |
| `GET /api/notifications/push/vapid-key` | Trả `{publicKey}` từ vars `VAPID_PUBLIC_KEY`; chưa cấu hình → 503 `vapid_not_configured`. |
| `POST /api/notifications/push/subscribe` | Body `{endpoint, keys: {p256dh, auth}}` — validate đủ 3 trường, endpoint là URL https; lưu `INSERT OR REPLACE` theo endpoint. Trả `{ok: true}`. |
| `DELETE /api/notifications/push/subscribe` | Body `{endpoint}` — xóa subscription đó. |
| `POST /api/notifications/test` | Body `{channel: 'push'\|'telegram'}` — gửi tin test ("Đây là tin nhắn thử từ AI Stock VN Mail") qua kênh đó; thiếu secret/subscription/chat id → 503 với mã lỗi rõ (`telegram_not_configured` / `push_not_configured` / `telegram_no_chat_id`); Telegram 403 → 400 `telegram_forbidden`. Giới hạn: 1 lần / 60 giây / mailbox (chống spam test). |

Đếm route trước khi sửa và sau khi sửa bằng
`grep -E "path === ['\"]/api" worker/index.ts` (repo dùng cả nháy đơn lẫn nháy kép,
vd route `/api/drafts` viết bằng nháy đơn); sau = trước + 6 (5 route settings/push/test
+ vapid-key). Ghi số đếm vào báo cáo.

### 1.5 Secrets & cấu hình (KHÔNG ghi giá trị vào code/brief/log)

- `VAPID_PRIVATE_KEY` (secret, JWK private ES256) + `VAPID_PUBLIC_KEY` (vars, public):
  sinh cặp key mới ngoài repo (openssl hoặc `npx web-push generate-vapid-keys`); nạp
  bằng `wrangler secret put VAPID_PRIVATE_KEY` + thêm vars vào `wrangler.jsonc` SAU
  khi có key. Code chỉ đọc `env.VAPID_PRIVATE_KEY` / `env.VAPID_PUBLIC_KEY`; thiếu thì
  kênh push trả 503, không crash.
- `TELEGRAM_BOT_TOKEN` (secret): **BLOCKER — webmail chưa có bot riêng.** Phải tạo bot
  mới qua @BotFather rồi nạp bằng `wrangler secret put TELEGRAM_BOT_TOKEN`. Code nhận
  token từ secret + chat id từ setting; **không tự bịa token, không dùng bot khác**
  (bot stock @stock_pocket_bot là bot khác, KHÔNG dùng chung). Vòng này code xong
  + test bằng mock (không có token thật); báo rõ blocker này trong báo cáo cuối.
- Thêm 3 tên vào `Env` trong `worker/mail.ts` (nơi định nghĩa `Env`):
  `VAPID_PRIVATE_KEY?: string; VAPID_PUBLIC_KEY?: string; TELEGRAM_BOT_TOKEN?: string;`
  và ghi chú secret vào comment đầu `wrangler.jsonc` theo mẫu các secret hiện có
  (chỉ tên, không giá trị).

### 1.6 Frontend — THEO GIAO DIỆN ĐÃ KHÔI PHỤC (restore 3b, live 521eb542)

Bản brief này đã sửa lại toàn bộ §1.6 vì brief cũ viết theo shell mới (đã bị hồi quy).
**Mọi vị trí dưới đây đã verify trực tiếp trên VM ngày 19/11** (`src/App.tsx` 2167 dòng,
sha `4c1d782e`; `src/api.ts` 476 dòng, sha `84ab0d80`; `src/main.tsx` 10 dòng).
Giao diện thật: hash routing, sidebar desktop + mobile bottom nav, panel cài đặt toàn
màn hình cho Security/Aliases, KHÔNG viết lại App.tsx, KHÔNG đổi layout.

**Điều cấm đầu tiên — đừng làm theo mẫu Drafts/Starred:** `NavSection = Folder |
"starred" | "drafts"` (`src/App.tsx:32`). Notifications KHÔNG phải NavSection và KHÔNG
nằm trong `MailShell` (list + reading pane). Nó là panel cài đặt toàn màn hình như
Security/Aliases. **Đừng** thêm Notifications vào mảng folder `items` trong `Sidebar`
(`src/App.tsx:1827-1834`) hay mảng folders của mobile nav (`src/App.tsx:2022-2031`) —
sai type `NavSection`, tsc fail. **Đừng** đụng `MailShell`, `currentSection`,
`sectionHash`, hay `NavSection`.

**Vị trí nav — đặt cạnh Security (nhóm cài đặt), không đặt trong nhóm thư mục:**

- Sidebar desktop: link Security nằm ở block footer riêng DƯỚI nav folder
  (`src/App.tsx:1876-1886`, `<div className="flex flex-col px-2 pb-1 lg:px-3">`).
  Thêm link "Notifications" NGAY DƯỚI link Security trong cùng block đó, cùng class,
  `href="#/notifications"`, `title`/`aria-label="Notifications"`, icon `I.bell`,
  label "Notifications".
- Mobile bottom nav: link Security ở `src/App.tsx:2056-2063`. Thêm link "Notifications"
  ngay sau nó, cùng class (`flex shrink-0 flex-col items-center ...`), icon `I.bell`,
  label "Notifications".
- Icon set `I` (`src/App.tsx:173-193`) CHƯA có bell — thêm một dòng:
  `bell: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"` (Feather bell, CHỈ 1 path vì
  component `Icon` chỉ render một `<path d={d} />`).

**Đấu nối route (hash routing, `parseRoute` ở `src/App.tsx:56-77`, `Route` union
`src/App.tsx:45-54`, `go(h)` ở dòng 92) — 4 chỗ, phẫu thuật:**

1. Thêm `| { name: "notifications" }` vào `Route` union, ngay sau `{ name: "aliases" }`,
   kèm comment `// PHASE4-R4`.
2. Thêm `if (path === "/notifications") return { name: "notifications" };` vào
   `parseRoute`, ngay sau nhánh `/aliases`.
3. Thêm import ở đầu file (theo mẫu dòng 23-25):
   `import { NotificationsPanel } from "./notifications";`
4. Thêm dispatch trong `App()`, ngay sau nhánh aliases (`src/App.tsx:2150-2152`):
   ```tsx
   // PHASE4-R4
   if (route.name === "notifications") {
     return <NotificationsPanel onBack={() => go("#/inbox")} />;
   }
   ```

**`public/sw.js` (MỚI — hiện chưa tồn tại; `public/` chỉ có `_headers`, `icon.svg`,
`manifest.webmanifest`; Vite copy `public/` sang `dist/` tự động):**

- `push` event → thử `fetch('/api/counts')`; hiện
  `self.registration.showNotification('AI Stock VN Mail', {body: 'Bạn có thư mới',
  icon: '/icon.svg'})`. Fetch lỗi/401 (user chưa đăng nhập) thì vẫn hiện body chung —
  không crash, không fetch nội dung mail trong SW.
- `notificationclick` event → mở/focus tab webmail (`clients.openWindow('/')`).

**`src/main.tsx` (10 dòng, hiện chưa đăng ký SW):** thêm đăng ký Service Worker khi
trình duyệt hỗ trợ, SAU `createRoot(...).render(...)` hoặc trước đều được, miễn không
chặn render:
```ts
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
```
Lỗi đăng ký thì bỏ qua lặng lẽ, không crash app.

**`src/notifications.tsx` (MỚI, theo mẫu `src/mfa.tsx:47` `MfaSettingsPanel`):**

- `export function NotificationsPanel({ onBack }: { onBack: () => void })` — panel toàn
  màn hình, header có nút Back + tiêu đề "Notifications" (theo mẫu header của
  `MfaSettingsPanel`/`AliasesPanel`), tự fetch setting khi mount (`useEffect` + `useState`),
  lỗi API hiện bằng chữ trong panel, không `alert()`, không crash. Tái dùng các hằng
  style cục bộ như `mfa.tsx` (`focusRing`, `inputClass`, `primaryButton`,
  `outlineButton`, helper `errorText`).
- Mục Browser push: hiện trạng thái thật — đã đăng ký / chưa đăng ký / trình duyệt
  không hỗ trợ (`!('serviceWorker' in navigator && 'PushManager' in window)`) /
  quyền bị chặn (`Notification.permission === 'denied'`). Nút Bật →
  `Notification.requestPermission()` → nếu `granted` thì lấy VAPID public key qua
  `api.getVapidPublicKey()` rồi
  `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey:
  urlBase64ToUint8Array(publicKey) })` → `api.subscribePush(...)` (helper
  `urlBase64ToUint8Array` viết trong file này — key trả về dạng base64url).
  Nếu `getVapidPublicKey` trả 503 `vapid_not_configured` thì hiện "Push chưa được cấu
  hình trên server" và disable toggle. Nút Tắt → `subscription.unsubscribe()` +
  `api.unsubscribePush(endpoint)`.
- Mục Telegram: toggle bật/tắt + ô nhập chat id + nút Lưu + nút "Gửi tin thử" gọi
  `api.sendTestNotification('telegram')`. Hướng dẫn trong UI phải đúng 3 bước (bản
  brief cũ viết "nhắn /start rồi lấy chat id" là sai — `/start` một mình không lộ
  chat id): (1) mở bot, bấm Start; (2) nhắn @userinfobot để lấy chat id số của bạn;
  (3) dán chat id vào đây rồi bấm Lưu. **Luồng pairing-code tự động kiểu OmniMail
  (deep-link `t.me/<bot>?start=<code>` + code 10 phút, xem grounding §1a) KHÔNG làm ở
  R4** — R4 dùng nhập chat id tay; nếu lúc code thấy mâu thuẫn thì giữ nguyên thiết
  kế này và ghi rõ vào báo cáo, không tự đổi sang pairing-code.
- Mục Mức chi tiết (`detail_level`): radio "Cơ bản" (chỉ "Bạn có thư mới" + tên người
  gửi + link mở webmail) / "Đầy đủ" (thêm tiêu đề + snippet tối đa 160 ký tự). Lưu qua
  `api.updateNotificationSettings`.

**`src/api.ts` — CHỈ THÊM, KHÔNG đổi chữ ký hàm cũ:**

- Thêm 6 method vào **CẢ HAI chỗ**: `ApiClient` interface (`src/api.ts:265`) **VÀ**
  `api` object (`src/api.ts:324`). Bắt buộc cả hai vì interface không còn index
  signature (bài học restore 3b) — thiếu một bên là tsc fail.
- 6 method (theo mẫu `api.mfaStatus()` — settings panel dùng `api.*`, KHÔNG dùng
  named export rời như `fetchDrafts`): `getNotificationSettings`,
  `updateNotificationSettings`, `getVapidPublicKey`, `subscribePush`,
  `unsubscribePush`, `sendTestNotification`.
- Kiểu trả về: settings `{push_enabled: boolean, telegram_enabled: boolean,
  telegram_chat_id: string, detail_level: 'basic' | 'full'}`; vapid `{publicKey: string}`;
  subscribe/unsubscribe/test `{ok: true}` (test trả thêm mã lỗi theo §1.4 khi thất bại).

## 2. Test mới (theo mẫu `worker/drafts.test.ts`, `worker/starred.test.ts`)

- `worker/notifications.test.ts`: `shouldNotify` (chỉ inbox + không trùng; spam/trùng →
  false); settings mặc định tắt; update validate (detail_level lạ → lỗi, chat id sai
  định dạng → lỗi); outbox dedup (`INSERT OR IGNORE` 2 lần cùng message → 1 row);
  `deliverPendingNotifications` với mock fetch: thiếu secret → skipped, không crash.
- `worker/push.test.ts`: VAPID JWT có đủ 3 phần + header `alg: ES256`; endpoint 404 →
  subscription bị xóa; subscribe validate (thiếu `auth` → 400).
- `worker/telegram.test.ts`: payload gửi đúng `{chat_id, text, link_preview_options,
  protect_content}`; 429 → retryable + `retryAfter`; 403 → không retry + tắt endpoint;
  token sai định dạng → lỗi trước khi fetch (mock fetch không được gọi); text > 4096 → lỗi.
- Cập nhật test route nếu có (theo mẫu test hiện có). Không sửa test cũ trừ khi test cũ
  sai theo spec mới — nếu phải sửa, ghi rõ lý do trong báo cáo.

## 3. Verify (bắt buộc, chạy lại độc lập sau mỗi vòng)

```bash
npx tsc --noEmit          # phải 0 lỗi (lưu ý: script typecheck của repo là tsc -p . && tsc -p tsconfig.worker.json)
npx vitest run --isolate=false   # pass hết: 185 baseline + test mới (trừ smoke.e2e.test.ts, cần dev server live)
```

Đếm route `/api/*` trong `worker/index.ts` trước/sau (xem §1.4). Kiểm tra `git status` kiểu thủ
công: liệt kê file tạo/sửa + sha256 từng file.

## 4. Ràng buộc nhắc lại

- KHÔNG viết lại `worker/index.ts`; KHÔNG đổi chữ ký hàm cũ trong `src/api.ts`.
- KHÔNG viết lại `src/App.tsx` — chỉ phẫu thuật đúng 6 điểm ở §1.6 (thêm icon bell,
  thêm route vào union + parseRoute + dispatch, thêm 2 link nav). KHÔNG thêm
  Notifications vào mảng folder hay `NavSection`. KHÔNG đụng `MailShell`,
  `currentSection`, `sectionHash`.
- KHÔNG commit/push/deploy. KHÔNG `rm` file nào (kể cả file test hay file tạm).
- KHÔNG đưa key/secret/token vào prompt, log, file hay chat — kể cả VAPID key và
  Telegram token. Key sinh ra (nếu cần cho test local) chỉ dùng trong test mock,
  không ghi giá trị thật vào file.
- D1 trigger: KHÔNG dùng (giữ code hiển, hook trong `email()` như §1.3).
- Không thêm dependency mới vào `package.json` (WebCrypto + fetch có sẵn trong
  Workers runtime). Không thêm binding mới vào `wrangler.jsonc` (không Queue,
  không Workflow, không cron ở vòng này).
