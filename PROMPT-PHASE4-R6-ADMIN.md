# PROMPT — Phase 4 Round 6: Admin panel (trang quản trị)

Bạn làm việc trên repo webmail aistockvn (Worker + React SPA + D1). Đọc kỹ brief này
trước khi code. Repo làm việc: `/data/home/webmail-r4-neon/` trên IB3 (đã sync, baseline
sau R4 + fix Sent-alias — KHÔNG dùng VM clone làm baseline, VM còn ở bản pre-R4).
Grounding OmniMail: `OMNIMAIL-GROUNDING-R4-R8.md` ở repo root — đọc §2 trước khi code.

## 0. Hiện trạng (đã verify trên IB3, workdir `/data/home/webmail-r4-neon/`)

- Live: Worker `aistockvn-mail` tại mail.aistockvn.com, version **bc706f66** (deploy 21:36
  19/11, bản dedup). **R4 đã xong trên IB3 nhưng CHƯA deploy** — vòng này code tiếp trên
  baseline post-R4, không chờ deploy.
- `npx tsc --noEmit` 0 lỗi, `vitest run --isolate=false` **200/200** (baseline sau R4 +
  fix Sent-alias; trừ `smoke.e2e.test.ts`, cần dev server live).
- `worker/index.ts` **1869 dòng** (sha `c3efd94b`), routes `/api` = **34** (6 route R4 ở
  dòng 833/849/901/909/936/949). **TUYỆT ĐỐI KHÔNG viết lại file này** — chỉ sửa phẫu
  thuật: thêm import + block route mới + 2 điểm sửa nhỏ ở §1.5/§1.6. Đếm route
  trước/sau: sau = trước + 13 (xem §1.4).
- `src/api.ts` **530 dòng** (sha `a870ab5a`). `ApiClient` interface ở `src/api.ts:287`,
  `api` object ở `src/api.ts:353` — **KHÔNG còn index signature** (bài học restore 3b +
  R4: thêm method mới phải sửa CẢ interface lẫn object, thiếu một bên là tsc fail).
- `src/App.tsx` **1977 dòng** (sha `74e4c007`). `src/notifications.tsx` mới 479 dòng
  (sha `e8bc2db0`), `public/sw.js` mới 40 dòng (sha `a84c054b`).
  **Mẫu frontend đúng cho R6 là panel cài đặt, KHÔNG phải view danh sách:**
  `MfaSettingsPanel` (`src/mfa.tsx`) và `NotificationsPanel` (`src/notifications.tsx`)
  — component panel toàn màn hình, props `{ onBack }`, tự fetch trạng thái khi mount,
  lỗi hiện bằng chữ, không crash. Xem chi tiết ở §1.7.
- **Admin ĐÃ có khái niệm trong code (grounding §2 viết "chưa có" là cũ — đừng làm theo):**
  bảng `users` có cột `role TEXT CHECK (role IN ('super_admin','admin','user'))` và
  cột `status` (không CHECK) từ migration 0004; user `admin@aistockvn.com` đã seed sẵn
  role `super_admin` (id `00000000-0000-0000-0000-000000000001`). Các route MFA đã gate
  bằng mẫu `SELECT role FROM users WHERE email = ?` rồi kiểm
  `role === "super_admin" || role === "admin"` (`worker/index.ts:606-609`, `628-631`,
  `666-669`) — R6 tái dùng đúng mẫu này, KHÔNG định nghĩa lại "admin".
- **Chưa có gì về admin:** `grep -c 'api/admin' worker/index.ts` = 0 (chưa có route
  `/api/admin/*` nào); không có bảng audit log, không có bảng settings, không có rate
  limit gửi đi, không có mail cleanup, không có failed-mail store. Login
  (`worker/index.ts:~185`, SELECT gồm `role` nhưng KHÔNG gồm `status`) hiện không chặn
  user bị ban — xem §1.5.
- `/api/session` (`worker/index.ts:828`) hiện chỉ trả `{email, mailbox}` — KHÔNG có
  `role` (xem §1.7, phải thêm `role` để frontend ẩn/hiện link Admin).
- `/api/counts` (`worker/index.ts:1450` và `1459`, trùng nhau từ trước — để nguyên,
  không sửa trong vòng này) chỉ trả `{unread}` theo mailbox của người gọi.
- `wrangler.jsonc`: `MAILBOX_ADDRESS` = `admin@aistockvn.com` (:31),
  `ALLOWED_EMAILS` = 3 email (:34). **Allowlist đăng ký nằm ở env, KHÔNG nằm trong D1**
  (xem §1.8 — admin UI chỉ hiển thị, không sửa được).
- **KHÔNG commit/push/deploy. KHÔNG `rm` file nào (kể cả `src/App.tsx.bak` có sẵn trong
  workdir — để nguyên). KHÔNG ghi key/secret/token vào code, brief, log hay chat.**

## 1. Spec

### 1.1 Migration `migrations/0014_admin.sql` (MỚI — bảng duy nhất vòng này thêm)

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC);
CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO admin_settings (key, value, updated_at)
VALUES ('send_daily_cap', '200', unixepoch());
```

Không sửa bảng `users` (đã có `role` + `status`). Không sửa bảng nào khác.
`send_daily_cap` mặc định 200 lượt gửi/ngày/mailbox — xem §1.6.

### 1.2 Module mới (theo mẫu `worker/notifications.ts`: hàm thuần + `XxxError`, index.ts chỉ import + gọi)

- `worker/admin.ts` — `AdminError{status}` (403 `admin_forbidden`, 400 validate):
  `requireAdmin(env, user)`: `SELECT role FROM users WHERE email = ?`; cho qua chỉ khi
  `role` là `super_admin` hoặc `admin`, còn lại throw 403. (Theo đúng mẫu MFA ở §0.)
  `requireSuperAdmin(env, user)`: chỉ `super_admin` mới qua (dùng cho đổi role, §1.3).
  `getAdminStats(env)`, `listUsers(env)`, `setUserRole(env, actor, email, role)`,
  `setUserStatus(env, actor, email, status)`, `listDomains(env)`, `toggleDomain(env,
  actor, domain, enabled)`, `listAliases(env)`, `toggleAlias(env, actor, id, enabled)`,
  `previewCleanup(env, {mailbox?, folder, olderThanDays})`, `runCleanup(env, actor,
  {...})`, `logAdminAction(env, actor, action, target, detail)`,
  `listAuditLogs(env, {action?, limit, before?})`, `getAdminSettings(env)`,
  `updateAdminSettings(env, actor, {sendDailyCap})`, `countSentToday(env, mailbox,
  dayStartMs)`.
- Mọi hàm đọc admin đều đọc TOÀN HỆ THỐNG (không scope `callerMailboxList`) — đó chính
  là ý nghĩa của admin. Mọi hàm đổi (mutation) đều gọi `logAdminAction` trước khi trả về.

### 1.3 Users — list / đổi role / ban (KHÔNG tạo user mới ở R6)

- `GET /api/admin/users` → `[{email, display_name, role, status, verified, created_at,
  mailbox}]` (`mailbox` join từ bảng `mailboxes` theo `user_id`, có thể null).
  Sắp xếp theo `created_at`.
- `POST /api/admin/users/role` body `{email, role}` — `role` chỉ `super_admin | admin |
  user`, sai → 400. **Chỉ `super_admin` được đổi role** (`requireSuperAdmin`); admin
  thường gọi → 403. Cấm tự đổi role của chính mình (→ 400 `cannot_change_self`). Cấm
  hạ cấp super_admin cuối cùng (đếm `role='super_admin'` còn > 1 mới cho hạ — nếu chỉ
  còn 1 → 400 `last_super_admin`).
- `POST /api/admin/users/status` body `{email, status}` — `status` chỉ `active |
  banned`, sai → 400. Admin và super_admin đều được. Cấm tự ban chính mình (→ 400).
  Ban có hiệu lực theo §1.5, không chỉ đổi cờ trong DB.
- Tạo user mới KHÔNG làm ở R6: đăng ký hiện đi qua allowlist `ALLOWED_EMAILS` + xác
  minh email, không có luồng tạo user tay. Ghi rõ trong báo cáo là đã loại trừ.

### 1.4 Route mới trong `handleApi()` (thêm import + block, KHÔNG viết lại file)

Tất cả đều yêu cầu session + `requireAdmin` (trừ ghi chú riêng). Đếm route trước khi
sửa và sau khi sửa bằng `grep -E "path === ['\"]/api" worker/index.ts` (repo dùng cả
nháy đơn lẫn nháy kép); sau = trước + 13 (34 → 47). Ghi số đếm vào báo cáo.

| # | Route | Mô tả |
|---|---|---|
| 1 | `GET /api/admin/stats` | Tổng toàn hệ thống: users (tổng / theo role / theo status), messages theo folder (inbox/sent/spam, toàn hệ thống), unread tổng, domains + aliases (tổng / đang bật), push_subscriptions + telegram endpoints đang bật (đọc từ bảng R4). KHÔNG đếm object R2 (list R2 đắt — ghi rõ là không có). |
| 2 | `GET /api/admin/users` | Xem §1.3. |
| 3 | `POST /api/admin/users/role` | Xem §1.3 (chỉ super_admin). |
| 4 | `POST /api/admin/users/status` | Xem §1.3 (ban/unban). |
| 5 | `GET /api/admin/domains` | `[{domain, enabled, aliasCount}]` (alias count join bảng `aliases`). Hiện chỉ có `aistockvn.com` trong DB — trả đúng dữ liệu thật, không bịa thêm domain. |
| 6 | `POST /api/admin/domains/toggle` | Body `{domain, enabled}` — bật/tắt domain. Domain không tồn tại → 404. |
| 7 | `GET /api/admin/aliases` | Toàn bộ aliases mọi user: `[{id, address, label, enabled, created_by, created_at}]`, mới nhất trước. |
| 8 | `POST /api/admin/aliases/toggle` | Body `{id, enabled}` — bật/tắt alias. Id không tồn tại → 404. |
| 9 | `GET /api/admin/mail-cleanup/preview?mailbox=&folder=&olderThanDays=` | Chỉ đếm, KHÔNG xóa: `{count}`. `folder` bắt buộc (`inbox\|sent\|spam`), `olderThanDays` bắt buộc, số nguyên ≥ 1; `mailbox` tùy chọn (trống = mọi mailbox). Sai → 400. |
| 10 | `POST /api/admin/mail-cleanup` | Body `{mailbox?, folder, olderThanDays}` (validate như preview). Xóa đúng các row khớp preview + xóa object R2 tương ứng khi có `raw_key` (best-effort, đếm số object xóa lỗi vào response `{deleted, r2Errors}`). Trả `{deleted}` + ghi audit. |
| 11 | `GET /api/admin/audit-logs?action=&limit=&before=` | `[{id, actor, action, target, detail, created_at}]`, mới nhất trước; `limit` mặc định 50, tối đa 100; `action` lọc chính xác (vd `action=send_failed` chính là view "thư gửi lỗi" — KHÔNG làm route failed-sends riêng). |
| 12 | `GET /api/admin/settings` | `{allowedEmails: string[] (chỉ đọc, từ env), mailboxAddress (chỉ đọc, từ env), vapidConfigured: boolean, telegramConfigured: boolean, sendDailyCap: number}`. |
| 13 | `POST /api/admin/settings` | Body `{sendDailyCap}` — số nguyên 1..10000, sai → 400. Chỉ `super_admin` được đổi (rate limit là cấu hình hệ thống). |

### 1.5 Ban có hiệu lực thật (phẫu thuật 2 điểm, không viết lại luồng auth)

- Login (`worker/index.ts:~185`): thêm `status` vào SELECT userRow; sau khi mật khẩu
  đúng nhưng `status === 'banned'` → 403 `account_banned` (không set session cookie).
  Sai mật khẩu vẫn 401 như cũ (không lộ user có tồn tại hay không).
- `/api/session` (`worker/index.ts:828`): sau `verifySession`, đọc `status` của user;
  nếu `banned` → 401 (SPA boot ra màn đăng nhập ở lần tải lại). Đồng thời thêm `role`
  vào response (xem §1.7) — cùng một SELECT `role, status`.
- KHÔNG thêm truy vấn DB vào middleware session chung (mọi request đều qua đó — đắt).
  Session đang sống của user vừa bị ban sẽ hết hiệu lực ở lần tải lại app tiếp theo
  (qua `/api/session`) + không đăng nhập lại được. Ghi rõ giới hạn này trong báo cáo.

### 1.6 Giới hạn gửi đi (rate limit — setting duy nhất R6 cho sửa)

- `/api/send`: trước khi gọi Resend, đếm `SELECT COUNT(*) FROM messages WHERE
  folder='sent' AND mailbox_address = ? AND date >= ?` (mailbox = `sharedMailbox`,
  mốc = 00:00 hôm nay theo giờ UTC); nếu số đếm ≥ `send_daily_cap` (đọc từ
  `admin_settings`, mặc định 200) → 429 `send_rate_limited`, không gọi Resend, không
  ghi row. Dùng helper `countSentToday` trong `worker/admin.ts`.
- Khi Resend trả lỗi (nhánh đã có ở `worker/index.ts:~1759`, `return err(...502)`):
  ghi 1 row audit `action='send_failed'`, `actor` = mailbox người gửi, `target` = địa
  chỉ nhận đầu tiên, `detail` = `res.status` (KHÔNG ghi body lỗi thô — có thể chứa
  dữ liệu nhạy cảm). Đây là nguồn dữ liệu cho view thư gửi lỗi ở §1.4 route 11.
- Không đổi gì khác trong `/api/send` (INSERT ở dòng 1768 đã lưu
  `mailbox_address = sharedMailbox` sau fix Sent-alias — giữ nguyên).

### 1.7 Frontend — THEO GIAO DIỆN ĐÃ KHÔI PHỤC + R4 (không viết lại App.tsx)

Mọi vị trí dưới đây đã verify trực tiếp trên IB3 (workdir post-R4):
`src/App.tsx` 1977 dòng (sha `74e4c007`), `src/api.ts` 530 dòng (sha `a870ab5a`),
`src/shared-mail-views.tsx` (icon set `I` ở dòng 46, `bell:` ở dòng 64).

**Điều cấm đầu tiên — đừng làm theo mẫu Drafts/Starred:** Admin KHÔNG phải NavSection
và KHÔNG nằm trong `MailShell`. Nó là panel cài đặt toàn màn hình như
Security/Aliases/Notifications. **Đừng** thêm Admin vào mảng folder hay `NavSection`.
**Đừng** đụng `MailShell`, `currentSection`, `sectionHash`.

**Vị trí nav — đặt cạnh Security/Notifications (nhóm cài đặt), không đặt trong nhóm thư mục:**

- Sidebar desktop: block footer riêng DƯỚI nav folder
  (`<div className="flex flex-col px-2 pb-1 lg:px-3">`), link Security dùng
  `I.shield` (~dòng 1664-1671), link Notifications dùng `I.bell` (~dòng 1672-1681).
  Thêm link "Admin" NGAY DƯỚI link Notifications trong cùng block đó, cùng class,
  `href="#/admin"`, `title`/`aria-label="Admin"`, icon `I.tool`, label "Admin".
  **Chỉ render link này khi `role` là `admin` hoặc `super_admin`** (xem `role` ở dưới).
- Mobile bottom nav: link Security (~dòng 1855-1859, `I.shield`), link Notifications
  (~dòng 1862-1866, `I.bell`). Thêm link "Admin" ngay sau link Notifications, cùng
  class, icon `I.tool`, label "Admin", cũng chỉ render khi là admin.
- Icon set `I` (`src/shared-mail-views.tsx:46`, KHÔNG phải App.tsx — icon đã dọn sang
  file chung từ vòng dedup; `bell:` ở dòng 64): thêm một dòng sau `bell`:
  `tool: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"`
  (Feather wrench, CHỈ 1 path vì component `Icon` chỉ render một `<path d={d} />` —
  giống `bell` ở R4).

**Đấu nối route (hash routing, `parseRoute` ở `src/App.tsx:~67-90`, `Route` union
`~dòng 55-64`, dispatch trong `App()` ~dòng 1950-1962) — 4 chỗ, phẫu thuật:**

1. Thêm `| { name: "admin" }` vào `Route` union, ngay sau `{ name: "notifications" }`,
   kèm comment `// PHASE4-R6`.
2. Thêm `if (path === "/admin") return { name: "admin" };` vào `parseRoute`, ngay sau
   nhánh `/notifications`.
3. Thêm import ở đầu file (theo mẫu dòng 23-27):
   `import { AdminPanel } from "./admin";`
4. Thêm dispatch trong `App()`, ngay sau nhánh notifications (`~dòng 1960-1962`):
   ```tsx
   // PHASE4-R6
   if (route.name === "admin") {
     return <AdminPanel onBack={() => go("#/inbox")} />;
   }
   ```

**`role` từ session — để ẩn/hiện link Admin:**

- Sửa `/api/session` (worker, §1.5) trả thêm `role` (lấy từ bảng `users`, không có row
  thì `'user'`). Sửa kiểu trả về của `api.session()` trong `src/api.ts` tương ứng
  (`{email, mailbox, role}`).
- `App()` đã gọi `api.session()` khi boot — dùng `role` từ đó (không gọi thêm API).
  Non-admin không thấy link Admin; nếu gõ tay `#/admin` thì panel vẫn mở nhưng lần
  fetch đầu tiên trả 403 → hiện dòng "Chỉ dành cho quản trị viên", không crash.

**`src/admin.tsx` (MỚI, theo mẫu `src/notifications.tsx` 479 dòng):**

- `export function AdminPanel({ onBack }: { onBack: () => void })` — panel toàn màn
  hình, header có nút Back + tiêu đề "Admin" (theo mẫu header của
  `MfaSettingsPanel`/`NotificationsPanel`), tự fetch stats khi mount (`useEffect` +
  `useState`), lỗi API hiện bằng chữ trong panel, không `alert()`, không crash. Tái
  dùng các hằng style cục bộ như `mfa.tsx` (`focusRing`, `inputClass`,
  `primaryButton`, `outlineButton`, helper `errorText`).
- Tab nội bộ trong panel (state cục bộ, KHÔNG thêm route riêng): Overview | Users |
  Domains | Cleanup | Audit | Settings.
- Overview: các con số từ `api.getAdminStats()` (users, messages theo folder, unread,
  domains/aliases, push/Telegram đang bật). Số 0 hiển thị 0, không giấu mục.
- Users: bảng (email, display_name, role, status, verified, created_at, mailbox);
  đổi role bằng select (chỉ hiện với super_admin — frontend check `role` từ session;
  server vẫn chặn lại, §1.3); ban/unban bằng nút (xác nhận 2 bước trong panel: bấm
  lần 1 nút đổi thành "Xác nhận ban user này?", bấm lần 2 mới gọi API — không dùng
  `window.confirm`/`alert`); không cho bấm đổi role/ban chính mình (disable nút).
- Domains: bảng (domain, enabled, aliasCount) + toggle bật/tắt. Aliases: bảng toàn bộ
  (address, label, enabled, created_by, created_at) + toggle bật/tắt.
- Cleanup: form chọn folder + số ngày + mailbox (tùy chọn) → bấm "Xem trước" gọi
  preview, hiện "Sẽ xóa N thư" → bấm "Xóa" (xác nhận 2 bước như trên) mới gọi API xóa;
  hiện kết quả `{deleted, r2Errors}`.
- Audit: bảng (thời gian, actor, action, target, detail) + ô lọc theo action (mặc
  định trống = tất cả; gõ `send_failed` để xem thư gửi lỗi) + nút tải thêm (limit 50).
- Settings: hiện allowlist + mailbox + trạng thái VAPID/Telegram (chỉ đọc, kèm ghi
  chú "đổi bằng cấu hình server, cần deploy") + ô sửa `sendDailyCap` (chỉ hiện với
  super_admin) + nút Lưu.

**`src/api.ts` — CHỈ THÊM, KHÔNG đổi chữ ký hàm cũ:**

- Thêm 13 method vào **CẢ HAI chỗ**: `ApiClient` interface (`src/api.ts:287`) **VÀ**
  `api` object (`src/api.ts:353`). Bắt buộc cả hai vì interface không còn index
  signature — thiếu một bên là tsc fail.
- 13 method (theo mẫu `api.getNotificationSettings()` — panel dùng `api.*`, KHÔNG dùng
  named export rời): `getAdminStats`, `listAdminUsers`, `setUserRole`, `setUserStatus`,
  `listAdminDomains`, `toggleDomain`, `listAdminAliases`, `toggleAlias`,
  `previewMailCleanup`, `runMailCleanup`, `listAuditLogs`, `getAdminSettings`,
  `updateAdminSettings`.
- Kiểu trả về: theo đúng §1.3–§1.4 (stats object, user/domain/alias row, `{count}`,
  `{deleted, r2Errors}`, audit row, settings object). Định nghĩa type mới trong
  `src/api.ts` gần các type notifications hiện có.

### 1.8 Những gì KHÔNG làm ở R6 (ghi rõ lý do, đừng tự thêm)

- **Invites (tạo/liệt kê/thu hồi lời mời):** hệ thống mình KHÔNG có luồng invite nào
  (không bảng, không code — đã grep toàn repo, 0 kết quả). Đăng ký đi qua allowlist
  `ALLOWED_EMAILS` + xác minh email. Làm invites = xây hệ thống mới (bảng invite +
  token + đăng ký bằng invite) — để vòng riêng sau nếu Henrry quyết.
- **Tạo user tay:** cùng lý do invites (không có luồng tạo user tay).
- **Storage policy + backup:** thuộc R8 (sao lưu) — R6 không đụng.
- **Random mailbox prefix:** tính năng không tồn tại trong hệ thống mình — không bịa.
- **Remote images / extension settings / version / deployment-check:** không có tính
  năng tương ứng, Worker cũng không có nguồn version thật để trả — không bịa.
- **Mail-credentials migration:** của OmniMail cho hộp thư ngoài — thuộc R7 (chưa có
  credential ngoài nào để migrate).

## 2. Test mới (theo mẫu `worker/notifications.test.ts`, `worker/telegram.test.ts`)

- `worker/admin.test.ts`: `requireAdmin` (user thường → 403, admin → qua,
  super_admin → qua, email không có trong bảng users → 403); `requireSuperAdmin`
  (admin → 403); đổi role (role lạ → 400; admin đổi role → 403; tự đổi role → 400;
  hạ super_admin cuối cùng → 400); đổi status (status lạ → 400; tự ban → 400);
  users list chỉ trả đúng cột, không lộ `password_hash`; stats đếm đúng trên dữ liệu
  test (seed vài row rồi đếm); cleanup preview chỉ đếm không xóa; cleanup xóa đúng
  row khớp điều kiện + ghi audit + gọi xóa R2 khi có `raw_key` (mock R2); audit list
  lọc theo `action=send_failed`; settings cap validate (0, -1, 10001, chữ → 400;
  200 → ok); `countSentToday` đếm đúng trong ngày, không đếm ngày hôm qua.
- Ban có hiệu lực: login với user `status='banned'` + mật khẩu đúng → 403
  `account_banned`; `/api/session` của user bị ban → 401. (Dùng đúng harness gọi
  handler như các test hiện có — xem `worker/send.test.ts` / `worker/auth.test.ts`
  làm mẫu trước khi viết.)
- Cập nhật test route nếu có (theo mẫu test hiện có). Không sửa test cũ trừ khi test cũ
  sai theo spec mới — nếu phải sửa, ghi rõ lý do trong báo cáo.

## 3. Verify (bắt buộc, chạy lại độc lập sau mỗi vòng)

```bash
npx tsc --noEmit          # phải 0 lỗi
npx vitest run --isolate=false --exclude worker/smoke.e2e.test.ts   # pass hết: 200 baseline + test mới (trừ smoke.e2e.test.ts, cần dev server live)
```

Đếm route `/api/*` trong `worker/index.ts` trước/sau bằng
`grep -E "path === ['\"]/api" worker/index.ts` (repo dùng cả nháy đơn lẫn nháy kép);
sau = trước + 13 (34 → 47). Kiểm tra `git status` kiểu thủ công: liệt kê file tạo/sửa
+ sha256 từng file. Kiểm tra D1 local: migration 0014 apply được (test chạy qua là đủ
— không chạy migration lên D1 thật).

Lưu ý: `tsc -p tsconfig.worker.json` có 7 lỗi từ trước trên code live (worker/index.ts
dòng ~1417-1460, có sẵn từ trước R4 — chưa sửa). Lệnh verify chuẩn của vòng này là
`npx tsc --noEmit` ở trên; nếu `tsc -p tsconfig.worker.json` vẫn đúng 7 lỗi cũ đó thì
ghi nhận là "không đổi", KHÔNG sửa trong vòng này, KHÔNG báo FAIL vì đó.

## 4. Ràng buộc nhắc lại

- KHÔNG viết lại `worker/index.ts`; KHÔNG đổi chữ ký hàm cũ trong `src/api.ts`.
- KHÔNG viết lại `src/App.tsx` — chỉ phẫu thuật đúng 7 điểm ở §1.7 (thêm icon `tool`
  vào `src/shared-mail-views.tsx`, thêm route vào union + parseRoute + import +
  dispatch, thêm 2 link nav). KHÔNG thêm Admin vào mảng folder hay `NavSection`.
  KHÔNG đụng `MailShell`, `currentSection`, `sectionHash`.
- KHÔNG commit/push/deploy. KHÔNG `rm` file nào (kể cả file test hay file tạm).
- KHÔNG đưa key/secret/token vào prompt, log, file hay chat. Không thêm secret mới
  nào ở vòng này (không cần secret mới).
- D1 trigger: KHÔNG dùng (giữ code hiển, audit ghi bằng hàm `logAdminAction`).
- Không thêm dependency mới vào `package.json`. Không thêm binding mới vào
  `wrangler.jsonc` (không Queue, không Workflow, không cron ở vòng này).
- Mọi con số trong báo cáo phải có bằng chứng (lệnh/log/D1) — không bịa.
