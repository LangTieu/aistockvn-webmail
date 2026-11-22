export type UserRole = 'super_admin' | 'admin' | 'user';
export type UserStatus = 'active' | 'banned';
export type AdminUserInput = string | { email?: string | null } | null | undefined;

export interface R2BucketLike {
  delete(keys: string | string[]): Promise<void>;
}

export interface AdminEnv {
  DB: D1Database;
  MAIL_BUCKET?: R2BucketLike;
  R2_BUCKET?: R2BucketLike;
  RAW_BUCKET?: R2BucketLike;
  RAW_MAIL?: R2BucketLike;
  R2?: R2BucketLike;
  BUCKET?: R2BucketLike;
  ALLOWED_EMAILS?: string;
  MAILBOX_ADDRESS?: string;
}

export interface AdminStats {
  users: {
    total: number;
    active: number;
    banned: number;
    admins: number;
  };
  mailboxes: {
    total: number;
  };
  messages: {
    total: number;
    unread: number;
    spam: number;
    trash: number;
  };
  domains: {
    total: number;
    enabled: number;
  };
  aliases: {
    total: number;
    enabled: number;
  };
  notifications: {
    pushEnabled: number;
    telegramEnabled: number;
    pushSubscriptions: number;
  };
  storage: { totalBytes:number; totalMessages:number; attachmentBytes:number; quotaMb:number; quotaBytes:number; byMailbox:Array<{mailbox:string;messages:number;bytes:number;percentOfQuota:number|null;overQuota:boolean}>; daily:Array<{date:string;received:number;sent:number}> };
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: string;
  verified: boolean;
  createdAt: number;
}

export interface AdminDomain {
  domain: string;
  enabled: boolean;
  createdAt: number;
}

export interface AdminAlias {
  id: string;
  localPart: string;
  domain: string;
  address: string;
  label: string;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
}

export interface CleanupOptions {
  mailbox?: string;
  folder: string;
  olderThanDays: number;
}

export interface CleanupPreview {
  count: number;
  folder: string;
  mailbox: string | null;
  olderThanDays: number;
  cutoffMs: number;
}

export interface CleanupResult {
  deleted: number;
  r2Errors: number;
}

export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  createdAt: number;
}

export interface ListAuditLogsOptions {
  action?: string;
  limit?: number;
  before?: number;
}

export interface AdminSettings {
  sendDailyCap: number;
  storageQuotaMb: number;
  updatedAt: number;
  allowedEmails: string[];
}

export interface UpdateAdminSettingsInput {
  sendDailyCap?: number;
  storageQuotaMb?: number;
}

interface UserRoleRow {
  role: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  status: string;
  verified: number;
  created_at: number;
}

interface DomainRow {
  domain: string;
  enabled: number;
  created_at: number;
}

interface AliasRow {
  id: string;
  local_part: string;
  domain: string;
  label: string;
  enabled: number;
  created_by: string;
  created_at: number;
}

interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  created_at: number;
}

interface AdminSettingRow {
  key: string;
  value: string;
  updated_at: number;
}

interface MessageCleanupRow {
  id: string;
  raw_key: string | null;
}

const VALID_ROLES: ReadonlySet<string> = new Set(['super_admin', 'admin', 'user']);
const VALID_STATUSES: ReadonlySet<string> = new Set(['active', 'banned']);
const ALLOWED_CLEANUP_FOLDERS: ReadonlySet<string> = new Set([
  'trash',
  'spam',
  'inbox',
  'sent',
  'archive',
]);

const DEFAULT_SEND_DAILY_CAP = 200;
const MIN_SEND_DAILY_CAP = 1;
const MAX_SEND_DAILY_CAP = 10_000;
const MS_PER_DAY = 86_400_000;

export class AdminError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = 'AdminError';
    this.status = status;
    this.code = code;
  }
}

function extractEmail(user: AdminUserInput): string {
  const raw = typeof user === 'string' ? user : user?.email ?? '';
  return raw.trim().toLowerCase();
}

function getR2Bucket(env: AdminEnv): R2BucketLike | undefined {
  return (
    env.MAIL_BUCKET ??
    env.R2_BUCKET ??
    env.RAW_BUCKET ??
    env.RAW_MAIL ??
    env.R2 ??
    env.BUCKET
  );
}

function parseAllowedEmails(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function validateCleanupOptions(
  opts: CleanupOptions,
  nowMs: number
): {
  folder: string;
  mailbox: string | null;
  olderThanDays: number;
  cutoffMs: number;
} {
  const folder = typeof opts?.folder === 'string' ? opts.folder.trim().toLowerCase() : '';
  if (!ALLOWED_CLEANUP_FOLDERS.has(folder)) {
    throw new AdminError(400, 'invalid_folder');
  }

  const olderThanDays = opts?.olderThanDays;
  if (
    typeof olderThanDays !== 'number' ||
    !Number.isFinite(olderThanDays) ||
    !Number.isInteger(olderThanDays) ||
    olderThanDays < 0 ||
    olderThanDays > 36_500
  ) {
    throw new AdminError(400, 'invalid_older_than_days');
  }

  const rawMailbox = typeof opts?.mailbox === 'string' ? opts.mailbox.trim().toLowerCase() : '';
  const mailbox = rawMailbox ? rawMailbox : null;
  const cutoffMs = nowMs - olderThanDays * MS_PER_DAY;

  return { folder, mailbox, olderThanDays, cutoffMs };
}

export function getUtcDayStartMs(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function requireAdmin(env: AdminEnv, user: AdminUserInput): Promise<UserRole> {
  const email = extractEmail(user);
  if (!email) {
    throw new AdminError(403, 'admin_forbidden');
  }

  const row = await env.DB.prepare(`SELECT role FROM users WHERE email = ? LIMIT 1`)
    .bind(email)
    .first<UserRoleRow>();

  if (!row || (row.role !== 'super_admin' && row.role !== 'admin')) {
    throw new AdminError(403, 'admin_forbidden');
  }

  return row.role;
}

export async function requireSuperAdmin(
  env: AdminEnv,
  user: AdminUserInput
): Promise<'super_admin'> {
  const email = extractEmail(user);
  if (!email) {
    throw new AdminError(403, 'admin_forbidden');
  }

  const row = await env.DB.prepare(`SELECT role FROM users WHERE email = ? LIMIT 1`)
    .bind(email)
    .first<UserRoleRow>();

  if (!row || row.role !== 'super_admin') {
    throw new AdminError(403, 'admin_forbidden');
  }

  return 'super_admin';
}

export async function logAdminAction(
  env: AdminEnv,
  actor: AdminUserInput,
  action: string,
  target: string = '',
  detail: string | Record<string, unknown> = '',
  nowMs: number = Date.now()
): Promise<AuditLogEntry> {
  const actorEmail = extractEmail(actor);
  const actionName = action.trim();
  if (!actionName) {
    throw new AdminError(400, 'invalid_action');
  }

  const id = crypto.randomUUID();
  const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor, action, target, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, actorEmail, actionName, target, detailStr, nowMs)
    .run();

  return {
    id,
    actor: actorEmail,
    action: actionName,
    target,
    detail: detailStr,
    createdAt: nowMs,
  };
}

export async function getAdminStats(env: AdminEnv): Promise<AdminStats> {
  const [usersRow, mailboxesRow, messagesRow, domainsRow, aliasesRow, notifRow, pushSubRow, mailboxRows, dailyRows, settings] =
    await Promise.all([
      env.DB.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) AS banned,
           SUM(CASE WHEN role IN ('super_admin', 'admin') THEN 1 ELSE 0 END) AS admins
         FROM users`
      ).first<{ total: number; active: number | null; banned: number | null; admins: number | null }>(),
      env.DB.prepare(`SELECT COUNT(*) AS total FROM mailboxes`).first<{ total: number }>(),
      env.DB.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
           SUM(CASE WHEN folder = 'spam' THEN 1 ELSE 0 END) AS spam,
           SUM(CASE WHEN folder = 'trash' THEN 1 ELSE 0 END) AS trash
         FROM messages`
      ).first<{ total: number; unread: number | null; spam: number | null; trash: number | null }>(),
      env.DB.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
         FROM domains`
      ).first<{ total: number; enabled: number | null }>(),
      env.DB.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
         FROM aliases`
      ).first<{ total: number; enabled: number | null }>(),
      env.DB.prepare(
        `SELECT
           SUM(CASE WHEN push_enabled = 1 THEN 1 ELSE 0 END) AS push_enabled,
           SUM(CASE WHEN telegram_enabled = 1 THEN 1 ELSE 0 END) AS telegram_enabled
         FROM notification_settings`
      ).first<{ push_enabled: number | null; telegram_enabled: number | null }>(),
      env.DB.prepare(`SELECT COUNT(*) AS total FROM push_subscriptions`).first<{ total: number }>(),
      env.DB.prepare(`SELECT COALESCE(mailbox_address, '') AS mailbox, COUNT(*) AS messages, COALESCE(SUM(size), 0) AS bytes, GROUP_CONCAT(attachments, char(31)) AS attachments FROM messages GROUP BY mailbox_address ORDER BY bytes DESC`).all<{mailbox:string;messages:number;bytes:number;attachments:string|null}>(),
      env.DB.prepare(`SELECT strftime('%Y-%m-%d', date/1000, 'unixepoch') AS date, SUM(CASE WHEN folder='inbox' THEN 1 ELSE 0 END) AS received, SUM(CASE WHEN folder='sent' THEN 1 ELSE 0 END) AS sent FROM messages WHERE date >= ? GROUP BY strftime('%Y-%m-%d', date/1000, 'unixepoch')`).bind(Date.now() - 30 * 86400000).all<{date:string;received:number;sent:number}>(),
      getAdminSettings(env),
    ]);

  const quotaBytes = settings.storageQuotaMb * 1024 * 1024;
  const byMailbox = (mailboxRows.results ?? []).map((row) => ({
    mailbox: row.mailbox || '(unknown)', messages: Number(row.messages), bytes: Number(row.bytes),
    attachmentBytes: (row.attachments ?? '').split(String.fromCharCode(31)).reduce((sum, raw) => {
      try { const parsed = JSON.parse(raw); return sum + (Array.isArray(parsed) ? parsed.reduce((s, a) => s + (Number(a?.size) || 0), 0) : 0); } catch { return sum; }
    }, 0),
    percentOfQuota: quotaBytes ? Math.round(Number(row.bytes) / quotaBytes * 1000) / 10 : null,
    overQuota: quotaBytes > 0 && Number(row.bytes) > quotaBytes,
  }));
  const totalBytes = byMailbox.reduce((sum, row) => sum + row.bytes, 0);
  const dailyMap = new Map((dailyRows.results ?? []).map((row) => [row.date, row]));
  const today = new Date();
  const daily = Array.from({length:30}, (_, i) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 29 + i));
    const date = d.toISOString().slice(0,10); const row = dailyMap.get(date);
    return {date, received:Number(row?.received ?? 0), sent:Number(row?.sent ?? 0)};
  });

  return {
    users: {
      total: Number(usersRow?.total ?? 0),
      active: Number(usersRow?.active ?? 0),
      banned: Number(usersRow?.banned ?? 0),
      admins: Number(usersRow?.admins ?? 0),
    },
    mailboxes: {
      total: Number(mailboxesRow?.total ?? 0),
    },
    messages: {
      total: Number(messagesRow?.total ?? 0),
      unread: Number(messagesRow?.unread ?? 0),
      spam: Number(messagesRow?.spam ?? 0),
      trash: Number(messagesRow?.trash ?? 0),
    },
    domains: {
      total: Number(domainsRow?.total ?? 0),
      enabled: Number(domainsRow?.enabled ?? 0),
    },
    aliases: {
      total: Number(aliasesRow?.total ?? 0),
      enabled: Number(aliasesRow?.enabled ?? 0),
    },
    notifications: {
      pushEnabled: Number(notifRow?.push_enabled ?? 0),
      telegramEnabled: Number(notifRow?.telegram_enabled ?? 0),
      pushSubscriptions: Number(pushSubRow?.total ?? 0),
    },
    storage: { totalBytes, totalMessages: byMailbox.reduce((sum, row) => sum + row.messages, 0), attachmentBytes: byMailbox.reduce((sum, row) => sum + row.attachmentBytes, 0), quotaMb: settings.storageQuotaMb, quotaBytes, byMailbox: byMailbox.map(({attachmentBytes: _a,...row}) => row), daily },
  };
}

export async function listUsers(env: AdminEnv): Promise<AdminUser[]> {
  const res = await env.DB.prepare(
    `SELECT id, email, display_name, role, status, verified, created_at
     FROM users
     ORDER BY created_at ASC, email ASC`
  ).all<UserRow>();

  return (res.results ?? []).map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? '',
    role: (VALID_ROLES.has(row.role) ? row.role : 'user') as UserRole,
    status: row.status,
    verified: row.verified === 1,
    createdAt: Number(row.created_at),
  }));
}

export async function setUserRole(
  env: AdminEnv,
  actor: AdminUserInput,
  email: string,
  role: string
): Promise<{ email: string; role: UserRole }> {
  if (!VALID_ROLES.has(role)) {
    throw new AdminError(400, 'invalid_role');
  }

  await requireSuperAdmin(env, actor);

  const actorEmail = extractEmail(actor);
  const targetEmail = email.trim().toLowerCase();
  if (!targetEmail) {
    throw new AdminError(400, 'invalid_email');
  }

  if (actorEmail === targetEmail) {
    throw new AdminError(400, 'cannot_change_self');
  }

  const targetRow = await env.DB.prepare(
    `SELECT id, email, role, status FROM users WHERE email = ? LIMIT 1`
  )
    .bind(targetEmail)
    .first<{ id: string; email: string; role: string; status: string }>();

  if (!targetRow) {
    throw new AdminError(404, 'user_not_found');
  }

  if (targetRow.role === 'super_admin' && role !== 'super_admin') {
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM users WHERE role = 'super_admin' AND status = 'active'`
    ).first<{ count: number }>();

    if (Number(countRow?.count ?? 0) <= 1 && targetRow.status === 'active') {
      throw new AdminError(400, 'last_super_admin');
    }
  }

  await env.DB.prepare(`UPDATE users SET role = ? WHERE email = ?`)
    .bind(role, targetEmail)
    .run();

  await logAdminAction(env, actorEmail, 'user_role_changed', targetEmail, {
    from: targetRow.role,
    to: role,
  });

  return { email: targetEmail, role: role as UserRole };
}

export async function setUserStatus(
  env: AdminEnv,
  actor: AdminUserInput,
  email: string,
  status: string
): Promise<{ email: string; status: UserStatus }> {
  if (!VALID_STATUSES.has(status)) {
    throw new AdminError(400, 'invalid_status');
  }

  const actorRole = await requireAdmin(env, actor);
  const actorEmail = extractEmail(actor);
  const targetEmail = email.trim().toLowerCase();
  if (!targetEmail) {
    throw new AdminError(400, 'invalid_email');
  }

  if (actorEmail === targetEmail && status === 'banned') {
    throw new AdminError(400, 'cannot_ban_self');
  }

  const targetRow = await env.DB.prepare(
    `SELECT id, email, role, status FROM users WHERE email = ? LIMIT 1`
  )
    .bind(targetEmail)
    .first<{ id: string; email: string; role: string; status: string }>();

  if (!targetRow) {
    throw new AdminError(404, 'user_not_found');
  }

  if (targetRow.role === 'super_admin' && actorRole !== 'super_admin') {
    throw new AdminError(403, 'admin_forbidden');
  }

  if (targetRow.role === 'super_admin' && status === 'banned') {
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM users WHERE role = 'super_admin' AND status = 'active'`
    ).first<{ count: number }>();

    if (Number(countRow?.count ?? 0) <= 1 && targetRow.status === 'active') {
      throw new AdminError(400, 'last_super_admin');
    }
  }

  await env.DB.prepare(`UPDATE users SET status = ? WHERE email = ?`)
    .bind(status, targetEmail)
    .run();

  await logAdminAction(env, actorEmail, 'user_status_changed', targetEmail, {
    from: targetRow.status,
    to: status,
  });

  return { email: targetEmail, status: status as UserStatus };
}

export async function listDomains(env: AdminEnv): Promise<AdminDomain[]> {
  const res = await env.DB.prepare(
    `SELECT domain, enabled, created_at
     FROM domains
     ORDER BY domain ASC`
  ).all<DomainRow>();

  return (res.results ?? []).map((row) => ({
    domain: row.domain,
    enabled: row.enabled === 1,
    createdAt: Number(row.created_at),
  }));
}

export async function toggleDomain(
  env: AdminEnv,
  actor: AdminUserInput,
  domain: string,
  enabled: boolean
): Promise<{ domain: string; enabled: boolean }> {
  await requireAdmin(env, actor);

  const normalizedDomain = domain.trim().toLowerCase();
  if (!normalizedDomain) {
    throw new AdminError(400, 'invalid_domain');
  }
  if (typeof enabled !== 'boolean') {
    throw new AdminError(400, 'invalid_enabled');
  }

  const res = await env.DB.prepare(`UPDATE domains SET enabled = ? WHERE domain = ?`)
    .bind(enabled ? 1 : 0, normalizedDomain)
    .run();

  if ((res.meta?.changes ?? 0) === 0) {
    throw new AdminError(404, 'domain_not_found');
  }

  await logAdminAction(env, actor, 'domain_toggled', normalizedDomain, { enabled });

  return { domain: normalizedDomain, enabled };
}

export async function listAliases(env: AdminEnv): Promise<AdminAlias[]> {
  const res = await env.DB.prepare(
    `SELECT id, local_part, domain, label, enabled, created_by, created_at
     FROM aliases
     ORDER BY created_at DESC`
  ).all<AliasRow>();

  return (res.results ?? []).map((row) => ({
    id: row.id,
    localPart: row.local_part,
    domain: row.domain,
    address: `${row.local_part}@${row.domain}`,
    label: row.label ?? '',
    enabled: row.enabled === 1,
    createdBy: row.created_by ?? '',
    createdAt: Number(row.created_at),
  }));
}

export async function toggleAlias(
  env: AdminEnv,
  actor: AdminUserInput,
  id: string,
  enabled: boolean
): Promise<{ id: string; enabled: boolean }> {
  await requireAdmin(env, actor);

  const aliasId = id.trim();
  if (!aliasId) {
    throw new AdminError(400, 'invalid_alias_id');
  }
  if (typeof enabled !== 'boolean') {
    throw new AdminError(400, 'invalid_enabled');
  }

  const res = await env.DB.prepare(`UPDATE aliases SET enabled = ? WHERE id = ?`)
    .bind(enabled ? 1 : 0, aliasId)
    .run();

  if ((res.meta?.changes ?? 0) === 0) {
    throw new AdminError(404, 'alias_not_found');
  }

  await logAdminAction(env, actor, 'alias_toggled', aliasId, { enabled });

  return { id: aliasId, enabled };
}

export async function previewCleanup(
  env: AdminEnv,
  opts: CleanupOptions,
  nowMs: number = Date.now()
): Promise<CleanupPreview> {
  const { folder, mailbox, olderThanDays, cutoffMs } = validateCleanupOptions(opts, nowMs);

  const row = mailbox
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE folder = ? AND date < ? AND mailbox_address = ?`
      )
        .bind(folder, cutoffMs, mailbox)
        .first<{ count: number }>()
    : await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE folder = ? AND date < ?`
      )
        .bind(folder, cutoffMs)
        .first<{ count: number }>();

  return {
    count: Number(row?.count ?? 0),
    folder,
    mailbox,
    olderThanDays,
    cutoffMs,
  };
}

export async function runCleanup(
  env: AdminEnv,
  actor: AdminUserInput,
  opts: CleanupOptions,
  nowMs: number = Date.now()
): Promise<CleanupResult> {
  await requireAdmin(env, actor);
  const { folder, mailbox, olderThanDays, cutoffMs } = validateCleanupOptions(opts, nowMs);

  const matched = mailbox
    ? await env.DB.prepare(
        `SELECT id, raw_key
         FROM messages
         WHERE folder = ? AND date < ? AND mailbox_address = ?`
      )
        .bind(folder, cutoffMs, mailbox)
        .all<MessageCleanupRow>()
    : await env.DB.prepare(
        `SELECT id, raw_key
         FROM messages
         WHERE folder = ? AND date < ?`
      )
        .bind(folder, cutoffMs)
        .all<MessageCleanupRow>();

  const rows = matched.results ?? [];
  let deleted = 0;
  let r2Errors = 0;

  if (rows.length > 0) {
    const deleteRes = mailbox
      ? await env.DB.prepare(
          `DELETE FROM messages
           WHERE folder = ? AND date < ? AND mailbox_address = ?`
        )
          .bind(folder, cutoffMs, mailbox)
          .run()
      : await env.DB.prepare(
          `DELETE FROM messages
           WHERE folder = ? AND date < ?`
        )
          .bind(folder, cutoffMs)
          .run();

    deleted = Number(deleteRes.meta?.changes ?? rows.length);

    const bucket = getR2Bucket(env);
    if (bucket) {
      for (const row of rows) {
        if (row.raw_key) {
          try {
            await bucket.delete(row.raw_key);
          } catch {
            r2Errors += 1;
          }
        }
      }
    }
  }

  await logAdminAction(
    env,
    actor,
    'mail_cleanup',
    mailbox ?? '*',
    { folder, olderThanDays, deleted, r2Errors },
    nowMs
  );

  return { deleted, r2Errors };
}

export async function listAuditLogs(
  env: AdminEnv,
  opts: ListAuditLogsOptions = {}
): Promise<AuditLogEntry[]> {
  const rawLimit = opts.limit ?? 50;
  const limit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(rawLimit) ? rawLimit : 50)));
  const action = typeof opts.action === 'string' ? opts.action.trim() : '';
  const hasBefore = typeof opts.before === 'number' && Number.isFinite(opts.before);

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (action) {
    clauses.push('action = ?');
    params.push(action);
  }
  if (hasBefore) {
    clauses.push('created_at < ?');
    params.push(opts.before);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);

  const res = await env.DB.prepare(
    `SELECT id, actor, action, target, detail, created_at
     FROM audit_logs
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(...params)
    .all<AuditLogRow>();

  return (res.results ?? []).map((row) => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    target: row.target,
    detail: row.detail,
    createdAt: Number(row.created_at),
  }));
}

export async function getAdminSettings(env: AdminEnv): Promise<AdminSettings> {
  const [row, quotaRow] = await Promise.all([
    env.DB.prepare(`SELECT key, value, updated_at FROM admin_settings WHERE key = 'send_daily_cap' LIMIT 1`).first<AdminSettingRow>(),
    env.DB.prepare(`SELECT key, value, updated_at FROM admin_settings WHERE key = 'storage_quota_mb' LIMIT 1`).first<AdminSettingRow>(),
  ]);

  const parsed = row ? Number.parseInt(row.value, 10) : NaN;
  const sendDailyCap =
    Number.isFinite(parsed) && parsed >= MIN_SEND_DAILY_CAP && parsed <= MAX_SEND_DAILY_CAP
      ? parsed
      : DEFAULT_SEND_DAILY_CAP;
  const quota = Number(quotaRow?.value);
  const storageQuotaMb = Number.isInteger(quota) && quota >= 0 && quota <= 102400 ? quota : 0;

  return {
    sendDailyCap,
    storageQuotaMb,
    updatedAt: Number(row?.updated_at ?? 0),
    allowedEmails: parseAllowedEmails(env.ALLOWED_EMAILS),
  };
}

export async function updateAdminSettings(
  env: AdminEnv,
  actor: AdminUserInput,
  input: UpdateAdminSettingsInput,
  nowMs: number = Date.now()
): Promise<AdminSettings> {
  await requireAdmin(env, actor);

  const rawCap = input?.sendDailyCap;
  const rawQuota = input?.storageQuotaMb;
  if (rawCap !== undefined && (
    typeof rawCap !== 'number' ||
    !Number.isFinite(rawCap) ||
    !Number.isInteger(rawCap) ||
    rawCap < MIN_SEND_DAILY_CAP ||
    rawCap > MAX_SEND_DAILY_CAP
  )) {
    throw new AdminError(400, 'invalid_send_daily_cap');
  }
  if (rawQuota !== undefined && (typeof rawQuota !== 'number' || !Number.isFinite(rawQuota) || !Number.isInteger(rawQuota) || rawQuota < 0 || rawQuota > 102400)) throw new AdminError(400, 'invalid_storage_quota_mb');
  if (rawCap === undefined && rawQuota === undefined) return getAdminSettings(env);
  if (rawCap !== undefined) {
  await env.DB.prepare(
    `INSERT INTO admin_settings (key, value, updated_at)
     VALUES ('send_daily_cap', ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  )
    .bind(String(rawCap), nowMs)
    .run();

  await logAdminAction(env, actor, 'settings_updated', 'send_daily_cap', { sendDailyCap: rawCap }, nowMs);
  }
  if (rawQuota !== undefined) {
    await env.DB.prepare(`INSERT INTO admin_settings (key, value, updated_at) VALUES ('storage_quota_mb', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(String(rawQuota), nowMs).run();
    await logAdminAction(env, actor, 'settings_updated', 'storage_quota_mb', { storageQuotaMb: rawQuota }, nowMs);
  }

  return getAdminSettings(env);
}

export async function countSentToday(
  env: AdminEnv,
  mailbox: string,
  dayStartMs: number = getUtcDayStartMs()
): Promise<number> {
  const normalized = mailbox.trim().toLowerCase();
  if (!normalized) {
    throw new AdminError(400, 'invalid_mailbox');
  }

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM messages
     WHERE mailbox_address = ? AND folder = 'sent' AND date >= ?`
  )
    .bind(normalized, dayStartMs)
    .first<{ count: number }>();

  return Number(row?.count ?? 0);
}
