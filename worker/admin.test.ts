import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AdminError,
  requireAdmin,
  requireSuperAdmin,
  getAdminStats,
  listUsers,
  setUserRole,
  setUserStatus,
  listDomains,
  toggleDomain,
  listAliases,
  toggleAlias,
  previewCleanup,
  runCleanup,
  logAdminAction,
  listAuditLogs,
  getAdminSettings,
  updateAdminSettings,
  countSentToday,
  type AdminEnv,
  type R2BucketLike,
} from './admin';

interface MockUserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  role: string;
  status: string;
  verified: number;
  created_at: number;
}

interface MockMailboxRow {
  address: string;
  user_id: string;
}

interface MockMessageRow {
  id: string;
  mailbox_address: string;
  folder: string;
  date: number;
  is_read: number;
  raw_key: string | null;
  size?: number;
  attachments?: string | null;
}

interface MockDomainRow {
  domain: string;
  enabled: number;
  created_at: number;
}

interface MockAliasRow {
  id: string;
  local_part: string;
  domain: string;
  label: string;
  enabled: number;
  created_by: string;
  created_at: number;
}

interface MockNotificationSettingRow {
  mailbox_address: string;
  push_enabled: number;
  telegram_enabled: number;
}

interface MockPushSubRow {
  id: string;
  mailbox_address: string;
}

interface MockAuditLogRow {
  id: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  created_at: number;
}

interface MockAdminSettingRow {
  key: string;
  value: string;
  updated_at: number;
}

function createMockAdminD1() {
  const users: MockUserRow[] = [];
  const mailboxes: MockMailboxRow[] = [];
  const messages: MockMessageRow[] = [];
  const domains: MockDomainRow[] = [];
  const aliases: MockAliasRow[] = [];
  const notificationSettings: MockNotificationSettingRow[] = [];
  const pushSubscriptions: MockPushSubRow[] = [];
  const auditLogs: MockAuditLogRow[] = [];
  const adminSettings = new Map<string, MockAdminSettingRow>();

  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async first<T = unknown>() {
        if (sql.includes('FROM users') && sql.includes('COUNT(*) AS count') && sql.includes("role = 'super_admin'")) {
          const count = users.filter((u) => u.role === 'super_admin' && u.status === 'active').length;
          return { count } as unknown as T;
        }
        if (sql.includes('FROM users') && sql.includes('SUM(CASE WHEN status')) {
          return {
            total: users.length,
            active: users.filter((u) => u.status === 'active').length,
            banned: users.filter((u) => u.status === 'banned').length,
            admins: users.filter((u) => u.role === 'super_admin' || u.role === 'admin').length,
          } as unknown as T;
        }
        if (sql.includes('FROM users') && sql.includes('WHERE email = ?')) {
          const email = String(bound[0]).toLowerCase();
          const found = users.find((u) => u.email.toLowerCase() === email);
          return (found ? { ...found } : null) as unknown as T;
        }
        if (sql.includes('FROM mailboxes')) {
          return { total: mailboxes.length } as unknown as T;
        }
        if (sql.includes('FROM messages') && sql.includes("folder = 'sent'") && sql.includes('date >= ?')) {
          const mailbox = String(bound[0]).toLowerCase();
          const dayStartMs = Number(bound[1]);
          const count = messages.filter(
            (m) =>
              m.mailbox_address.toLowerCase() === mailbox &&
              m.folder === 'sent' &&
              m.date >= dayStartMs
          ).length;
          return { count } as unknown as T;
        }
        if (sql.includes('FROM messages') && sql.includes('WHERE folder = ? AND date < ?')) {
          const folder = String(bound[0]);
          const cutoffMs = Number(bound[1]);
          const mailbox = sql.includes('mailbox_address = ?') ? String(bound[2]).toLowerCase() : null;
          const count = messages.filter(
            (m) =>
              m.folder === folder &&
              m.date < cutoffMs &&
              (mailbox === null || m.mailbox_address.toLowerCase() === mailbox)
          ).length;
          return { count } as unknown as T;
        }
        if (sql.includes('FROM messages') && sql.includes('SUM(CASE WHEN is_read')) {
          return {
            total: messages.length,
            unread: messages.filter((m) => m.is_read === 0).length,
            spam: messages.filter((m) => m.folder === 'spam').length,
            trash: messages.filter((m) => m.folder === 'trash').length,
          } as unknown as T;
        }
        if (sql.includes('FROM domains') && sql.includes('COUNT(*) AS total')) {
          return {
            total: domains.length,
            enabled: domains.filter((d) => d.enabled === 1).length,
          } as unknown as T;
        }
        if (sql.includes('FROM aliases') && sql.includes('COUNT(*) AS total')) {
          return {
            total: aliases.length,
            enabled: aliases.filter((a) => a.enabled === 1).length,
          } as unknown as T;
        }
        if (sql.includes('FROM notification_settings')) {
          return {
            push_enabled: notificationSettings.filter((n) => n.push_enabled === 1).length,
            telegram_enabled: notificationSettings.filter((n) => n.telegram_enabled === 1).length,
          } as unknown as T;
        }
        if (sql.includes('FROM push_subscriptions')) {
          return { total: pushSubscriptions.length } as unknown as T;
        }
        if (sql.includes('FROM admin_settings')) {
          const key = sql.includes("'storage_quota_mb'") ? 'storage_quota_mb' : 'send_daily_cap';
          return (adminSettings.get(key) ?? null) as unknown as T;
        }
        return null as unknown as T;
      },
      async all<T = unknown>() {
        if (sql.includes('GROUP BY mailbox_address')) {
          const groups = new Map<string, MockMessageRow[]>();
          for (const message of messages) {
            const mailbox = message.mailbox_address ?? '';
            groups.set(mailbox, [...(groups.get(mailbox) ?? []), message]);
          }
          const results = [...groups.entries()].map(([mailbox, rows]) => ({
            mailbox, messages: rows.length,
            bytes: rows.reduce((sum, row) => sum + (row.size ?? 0), 0),
            attachments: rows.map((row) => row.attachments ?? '[]').join(String.fromCharCode(31)),
          })).sort((a, b) => b.bytes - a.bytes);
          return { results: results as unknown as T[] };
        }
        if (sql.includes("strftime('%Y-%m-%d'") && sql.includes('FROM messages')) {
          const since = Number(bound[0]);
          const groups = new Map<string, {date:string;received:number;sent:number}>();
          for (const row of messages.filter((m) => m.date >= since)) {
            const date = new Date(row.date).toISOString().slice(0, 10);
            const item = groups.get(date) ?? { date, received: 0, sent: 0 };
            if (row.folder === 'inbox') item.received += 1;
            if (row.folder === 'sent') item.sent += 1;
            groups.set(date, item);
          }
          return { results: [...groups.values()] as unknown as T[] };
        }
        if (sql.includes('FROM users')) {
          const sorted = [...users].sort(
            (a, b) => a.created_at - b.created_at || a.email.localeCompare(b.email)
          );
          return { results: sorted.map((u) => ({ ...u })) as unknown as T[] };
        }
        if (sql.includes('FROM domains')) {
          const sorted = [...domains].sort((a, b) => a.domain.localeCompare(b.domain));
          return { results: sorted.map((d) => ({ ...d })) as unknown as T[] };
        }
        if (sql.includes('FROM aliases')) {
          const sorted = [...aliases].sort((a, b) => b.created_at - a.created_at);
          return { results: sorted.map((a) => ({ ...a })) as unknown as T[] };
        }
        if (sql.includes('FROM messages') && sql.includes('WHERE folder = ? AND date < ?')) {
          const folder = String(bound[0]);
          const cutoffMs = Number(bound[1]);
          const mailbox = sql.includes('mailbox_address = ?') ? String(bound[2]).toLowerCase() : null;
          const matched = messages
            .filter(
              (m) =>
                m.folder === folder &&
                m.date < cutoffMs &&
                (mailbox === null || m.mailbox_address.toLowerCase() === mailbox)
            )
            .map((m) => ({ id: m.id, raw_key: m.raw_key }));
          return { results: matched as unknown as T[] };
        }
        if (sql.includes('FROM audit_logs')) {
          let idx = 0;
          let filtered = [...auditLogs];
          if (sql.includes('action = ?')) {
            const action = String(bound[idx++]);
            filtered = filtered.filter((r) => r.action === action);
          }
          if (sql.includes('created_at < ?')) {
            const before = Number(bound[idx++]);
            filtered = filtered.filter((r) => r.created_at < before);
          }
          const limit = Number(bound[idx]);
          filtered.sort((a, b) => b.created_at - a.created_at);
          return { results: filtered.slice(0, limit) as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (sql.includes('INSERT INTO audit_logs')) {
          const [id, actor, action, target, detail, created_at] = bound;
          auditLogs.push({
            id: String(id),
            actor: String(actor),
            action: String(action),
            target: String(target),
            detail: String(detail),
            created_at: Number(created_at),
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE users SET role = ? WHERE email = ?')) {
          const [role, email] = bound;
          const user = users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
          if (!user) return { meta: { changes: 0 } };
          user.role = String(role);
          return { meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE users SET status = ? WHERE email = ?')) {
          const [status, email] = bound;
          const user = users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
          if (!user) return { meta: { changes: 0 } };
          user.status = String(status);
          return { meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE domains SET enabled = ? WHERE domain = ?')) {
          const [enabled, domain] = bound;
          const row = domains.find((d) => d.domain.toLowerCase() === String(domain).toLowerCase());
          if (!row) return { meta: { changes: 0 } };
          row.enabled = Number(enabled);
          return { meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE aliases SET enabled = ? WHERE id = ?')) {
          const [enabled, id] = bound;
          const row = aliases.find((a) => a.id === String(id));
          if (!row) return { meta: { changes: 0 } };
          row.enabled = Number(enabled);
          return { meta: { changes: 1 } };
        }
        if (sql.includes('DELETE FROM messages')) {
          const folder = String(bound[0]);
          const cutoffMs = Number(bound[1]);
          const mailbox = sql.includes('mailbox_address = ?') ? String(bound[2]).toLowerCase() : null;
          const beforeLen = messages.length;
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const m = messages[i];
            if (
              m.folder === folder &&
              m.date < cutoffMs &&
              (mailbox === null || m.mailbox_address.toLowerCase() === mailbox)
            ) {
              messages.splice(i, 1);
            }
          }
          return { meta: { changes: beforeLen - messages.length } };
        }
        if (sql.includes('INSERT INTO admin_settings')) {
          const [value, updated_at] = bound;
          const key = sql.includes("'storage_quota_mb'") ? 'storage_quota_mb' : 'send_daily_cap';
          adminSettings.set(key, {
            key,
            value: String(value),
            updated_at: Number(updated_at),
          });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };

  return {
    db: { prepare } as unknown as D1Database,
    users,
    mailboxes,
    messages,
    domains,
    aliases,
    notificationSettings,
    pushSubscriptions,
    auditLogs,
    adminSettings,
  };
}

describe('worker/admin', () => {
  let mock: ReturnType<typeof createMockAdminD1>;
  let r2Delete: ReturnType<typeof vi.fn>;
  let env: AdminEnv;

  beforeEach(() => {
    mock = createMockAdminD1();
    r2Delete = vi.fn().mockResolvedValue(undefined);
    const mockR2: R2BucketLike = {
      delete: r2Delete as unknown as R2BucketLike['delete'],
    };

    mock.users.push(
      {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@aistockvn.com',
        display_name: 'Super Admin',
        password_hash: 'hash-super-secret',
        role: 'super_admin',
        status: 'active',
        verified: 1,
        created_at: 1000,
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        email: 'mod@aistockvn.com',
        display_name: 'Moderator',
        password_hash: 'hash-mod-secret',
        role: 'admin',
        status: 'active',
        verified: 1,
        created_at: 2000,
      },
      {
        id: '00000000-0000-0000-0000-000000000003',
        email: 'user@aistockvn.com',
        display_name: 'Normal User',
        password_hash: 'hash-user-secret',
        role: 'user',
        status: 'active',
        verified: 1,
        created_at: 3000,
      }
    );

    env = {
      DB: mock.db,
      MAIL_BUCKET: mockR2,
      ALLOWED_EMAILS: 'admin@aistockvn.com, user@aistockvn.com',
    };
  });

  describe('requireAdmin & requireSuperAdmin', () => {
    it('allows super_admin and admin, rejects regular user and unknown email with 403', async () => {
      await expect(requireAdmin(env, 'admin@aistockvn.com')).resolves.toBe('super_admin');
      await expect(requireAdmin(env, { email: 'mod@aistockvn.com' })).resolves.toBe('admin');

      await expect(requireAdmin(env, 'user@aistockvn.com')).rejects.toMatchObject({
        status: 403,
        code: 'admin_forbidden',
      });
      await expect(requireAdmin(env, 'nobody@aistockvn.com')).rejects.toMatchObject({
        status: 403,
        code: 'admin_forbidden',
      });
    });

    it('requireSuperAdmin allows only super_admin and rejects admin with 403', async () => {
      await expect(requireSuperAdmin(env, 'admin@aistockvn.com')).resolves.toBe('super_admin');
      await expect(requireSuperAdmin(env, 'mod@aistockvn.com')).rejects.toMatchObject({
        status: 403,
        code: 'admin_forbidden',
      });
    });
  });

  describe('setUserRole', () => {
    it('rejects invalid role with 400 and non-super_admin caller with 403', async () => {
      await expect(
        setUserRole(env, 'admin@aistockvn.com', 'user@aistockvn.com', 'owner')
      ).rejects.toMatchObject({ status: 400, code: 'invalid_role' });

      await expect(
        setUserRole(env, 'mod@aistockvn.com', 'user@aistockvn.com', 'admin')
      ).rejects.toMatchObject({ status: 403, code: 'admin_forbidden' });
    });

    it('rejects self role change with 400 cannot_change_self', async () => {
      await expect(
        setUserRole(env, 'admin@aistockvn.com', 'admin@aistockvn.com', 'admin')
      ).rejects.toMatchObject({ status: 400, code: 'cannot_change_self' });
    });

    it('rejects demoting the last active super_admin with 400 last_super_admin', async () => {
      mock.users.push({
        id: '00000000-0000-0000-0000-000000000004',
        email: 'inactive-sa@aistockvn.com',
        display_name: 'Inactive SA',
        password_hash: 'hash-4',
        role: 'super_admin',
        status: 'banned',
        verified: 1,
        created_at: 4000,
      });

      await expect(
        setUserRole(env, 'inactive-sa@aistockvn.com', 'admin@aistockvn.com', 'admin')
      ).rejects.toMatchObject({ status: 400, code: 'last_super_admin' });
    });

    it('updates role and records an audit log entry', async () => {
      const res = await setUserRole(env, 'admin@aistockvn.com', 'user@aistockvn.com', 'admin');
      expect(res).toEqual({ email: 'user@aistockvn.com', role: 'admin' });
      expect(mock.users.find((u) => u.email === 'user@aistockvn.com')?.role).toBe('admin');
      expect(mock.auditLogs).toHaveLength(1);
      expect(mock.auditLogs[0]).toMatchObject({
        actor: 'admin@aistockvn.com',
        action: 'user_role_changed',
        target: 'user@aistockvn.com',
      });
    });
  });

  describe('setUserStatus', () => {
    it('rejects invalid status and self ban with 400', async () => {
      await expect(
        setUserStatus(env, 'admin@aistockvn.com', 'user@aistockvn.com', 'suspended')
      ).rejects.toMatchObject({ status: 400, code: 'invalid_status' });

      await expect(
        setUserStatus(env, 'admin@aistockvn.com', 'admin@aistockvn.com', 'banned')
      ).rejects.toMatchObject({ status: 400, code: 'cannot_ban_self' });
    });

    it('bans a user and logs the admin action', async () => {
      const res = await setUserStatus(env, 'mod@aistockvn.com', 'user@aistockvn.com', 'banned');
      expect(res).toEqual({ email: 'user@aistockvn.com', status: 'banned' });
      expect(mock.users.find((u) => u.email === 'user@aistockvn.com')?.status).toBe('banned');
      expect(mock.auditLogs).toHaveLength(1);
      expect(mock.auditLogs[0].action).toBe('user_status_changed');
    });
  });

  describe('listUsers', () => {
    it('returns safe user fields and never exposes password_hash', async () => {
      const users = await listUsers(env);
      expect(users).toHaveLength(3);
      for (const u of users) {
        expect(u).not.toHaveProperty('password_hash');
        expect(u).not.toHaveProperty('passwordHash');
        expect(Object.keys(u).sort()).toEqual([
          'createdAt',
          'displayName',
          'email',
          'id',
          'role',
          'status',
          'verified',
        ]);
      }
    });
  });

  describe('domains & aliases', () => {
    it('lists and toggles domains and aliases with audit logging', async () => {
      mock.domains.push(
        { domain: 'aistockvn.com', enabled: 1, created_at: 1000 },
        { domain: 'istockvn.com', enabled: 0, created_at: 2000 }
      );
      mock.aliases.push({
        id: 'alias-1',
        local_part: 'sales',
        domain: 'aistockvn.com',
        label: 'Sales',
        enabled: 1,
        created_by: 'admin@aistockvn.com',
        created_at: 1500,
      });

      const domains = await listDomains(env);
      expect(domains).toHaveLength(2);
      expect(domains[0]).toMatchObject({ domain: 'aistockvn.com', enabled: true });

      const toggledDomain = await toggleDomain(env, 'admin@aistockvn.com', 'istockvn.com', true);
      expect(toggledDomain).toEqual({ domain: 'istockvn.com', enabled: true });

      const aliases = await listAliases(env);
      expect(aliases).toHaveLength(1);
      expect(aliases[0].address).toBe('sales@aistockvn.com');

      const toggledAlias = await toggleAlias(env, 'mod@aistockvn.com', 'alias-1', false);
      expect(toggledAlias).toEqual({ id: 'alias-1', enabled: false });

      expect(mock.auditLogs.map((l) => l.action)).toEqual(['domain_toggled', 'alias_toggled']);
    });
  });

  describe('getAdminStats', () => {
    it('counts system-wide users, mailboxes, messages, domains, aliases, and notifications', async () => {
      mock.users[2].status = 'banned';
      mock.mailboxes.push(
        { address: 'admin@aistockvn.com', user_id: '00000000-0000-0000-0000-000000000001' },
        { address: 'mod@aistockvn.com', user_id: '00000000-0000-0000-0000-000000000002' }
      );
      mock.messages.push(
        { id: 'm1', mailbox_address: 'admin@aistockvn.com', folder: 'inbox', date: 1000, is_read: 0, raw_key: null, size: 100 },
        { id: 'm2', mailbox_address: 'admin@aistockvn.com', folder: 'spam', date: 1000, is_read: 1, raw_key: null, size: 200 },
        { id: 'm3', mailbox_address: 'mod@aistockvn.com', folder: 'trash', date: 1000, is_read: 0, raw_key: null, size: 300 }
      );
      mock.domains.push(
        { domain: 'aistockvn.com', enabled: 1, created_at: 1000 },
        { domain: 'istockvn.com', enabled: 0, created_at: 1000 }
      );
      mock.aliases.push(
        { id: 'a1', local_part: 'info', domain: 'aistockvn.com', label: '', enabled: 1, created_by: '', created_at: 1000 },
        { id: 'a2', local_part: 'old', domain: 'aistockvn.com', label: '', enabled: 0, created_by: '', created_at: 1000 }
      );
      mock.notificationSettings.push(
        { mailbox_address: 'admin@aistockvn.com', push_enabled: 1, telegram_enabled: 1 },
        { mailbox_address: 'mod@aistockvn.com', push_enabled: 0, telegram_enabled: 1 }
      );
      mock.pushSubscriptions.push({ id: 'ps1', mailbox_address: 'admin@aistockvn.com' });

      const stats = await getAdminStats(env);
      expect(stats).toEqual({
        users: { total: 3, active: 2, banned: 1, admins: 2 },
        mailboxes: { total: 2 },
        messages: { total: 3, unread: 2, spam: 1, trash: 1 },
        domains: { total: 2, enabled: 1 },
        aliases: { total: 2, enabled: 1 },
        notifications: { pushEnabled: 1, telegramEnabled: 2, pushSubscriptions: 1 },
        storage: {
          totalBytes: 600, totalMessages: 3, attachmentBytes: 0, quotaMb: 0, quotaBytes: 0,
          byMailbox: [
            { mailbox: 'admin@aistockvn.com', messages: 2, bytes: 300, percentOfQuota: null, overQuota: false },
            { mailbox: 'mod@aistockvn.com', messages: 1, bytes: 300, percentOfQuota: null, overQuota: false },
          ],
          daily: Array.from({ length: 30 }, (_, i) => {
            const today = new Date();
            const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 29 + i));
            return { date: d.toISOString().slice(0, 10), received: 0, sent: 0 };
          }),
        },
      });
    });

    it('aggregates storage and returns all 30 UTC days with quota percentages', async () => {
      const today = new Date();
      const todayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      const inboxDate = new Date(todayStart + 1000).toISOString().slice(0, 10);
      const sentDate = new Date(todayStart + 2000).toISOString().slice(0, 10);
      mock.messages.push(
        { id: 'large', mailbox_address: 'large@example.com', folder: 'inbox', date: todayStart + 1000, is_read: 0, raw_key: null, size: 1_572_864, attachments: '[{"size":2048}]' },
        { id: 'sent', mailbox_address: 'large@example.com', folder: 'sent', date: todayStart + 2000, is_read: 1, raw_key: null, size: 524_288, attachments: '[]' },
        { id: 'other', mailbox_address: 'small@example.com', folder: 'inbox', date: todayStart - 2 * 86_400_000, is_read: 0, raw_key: null, size: 1, attachments: 'invalid' },
        { id: 'unknown', mailbox_address: '', folder: 'archive', date: todayStart - 86_400_000, is_read: 1, raw_key: null, size: 5, attachments: '[]' },
      );
      await updateAdminSettings(env, 'admin@aistockvn.com', { storageQuotaMb: 1 }, 1234);

      const stats = await getAdminStats(env);
      expect(stats.storage).toEqual({
        totalBytes: 2_097_158, totalMessages: 4, attachmentBytes: 2048,
        quotaMb: 1, quotaBytes: 1_048_576,
        byMailbox: [
          { mailbox: 'large@example.com', messages: 2, bytes: 2_097_152, percentOfQuota: 200, overQuota: true },
          { mailbox: '(unknown)', messages: 1, bytes: 5, percentOfQuota: 0, overQuota: false },
          { mailbox: 'small@example.com', messages: 1, bytes: 1, percentOfQuota: 0, overQuota: false },
        ],
        daily: stats.storage.daily,
      });
      expect(stats.storage.daily).toHaveLength(30);
      expect(stats.storage.daily.at(-1)?.date).toBe(new Date().toISOString().slice(0, 10));
      expect(stats.storage.daily.map((day) => day.date)).toEqual(Array.from({ length: 30 }, (_, i) => {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 29 + i));
        return d.toISOString().slice(0, 10);
      }));
      expect(stats.storage.daily.find((day) => day.date === inboxDate)?.received).toBe(1);
      expect(stats.storage.daily.find((day) => day.date === sentDate)?.sent).toBe(1);
      expect(stats.storage.daily.some((day) => day.received === 0 && day.sent === 0)).toBe(true);
    });

    it('returns null quota percentages and no over-quota flags when quota is zero', async () => {
      mock.messages.push({ id: 'm', mailbox_address: 'a@example.com', folder: 'inbox', date: Date.now(), is_read: 0, raw_key: null, size: 1 });
      const { storage } = await getAdminStats(env);
      expect(storage.quotaMb).toBe(0);
      expect(storage.byMailbox[0]).toMatchObject({ percentOfQuota: null, overQuota: false });
    });
  });

  describe('previewCleanup & runCleanup', () => {
    const nowMs = 100 * 86_400_000;

    beforeEach(() => {
      mock.messages.push(
        {
          id: 'old-trash-1',
          mailbox_address: 'admin@aistockvn.com',
          folder: 'trash',
          date: nowMs - 40 * 86_400_000,
          is_read: 1,
          raw_key: 'raw/old-trash-1.eml',
        },
        {
          id: 'old-trash-2',
          mailbox_address: 'user@aistockvn.com',
          folder: 'trash',
          date: nowMs - 35 * 86_400_000,
          is_read: 1,
          raw_key: 'raw/old-trash-2.eml',
        },
        {
          id: 'new-trash',
          mailbox_address: 'admin@aistockvn.com',
          folder: 'trash',
          date: nowMs - 5 * 86_400_000,
          is_read: 1,
          raw_key: 'raw/new-trash.eml',
        },
        {
          id: 'old-inbox',
          mailbox_address: 'admin@aistockvn.com',
          folder: 'inbox',
          date: nowMs - 60 * 86_400_000,
          is_read: 1,
          raw_key: null,
        }
      );
    });

    it('previewCleanup counts matching rows without deleting anything', async () => {
      const preview = await previewCleanup(env, { folder: 'trash', olderThanDays: 30 }, nowMs);
      expect(preview.count).toBe(2);
      expect(mock.messages).toHaveLength(4);
      expect(r2Delete).not.toHaveBeenCalled();
    });

    it('runCleanup deletes matching rows, deletes R2 raw_keys best-effort, and logs audit', async () => {
      r2Delete
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('R2 temporary failure'));

      const result = await runCleanup(
        env,
        'admin@aistockvn.com',
        { folder: 'trash', olderThanDays: 30 },
        nowMs
      );

      expect(result).toEqual({ deleted: 2, r2Errors: 1 });
      expect(mock.messages.map((m) => m.id)).toEqual(['new-trash', 'old-inbox']);
      expect(r2Delete).toHaveBeenCalledTimes(2);
      expect(r2Delete).toHaveBeenCalledWith('raw/old-trash-1.eml');
      expect(r2Delete).toHaveBeenCalledWith('raw/old-trash-2.eml');
      expect(mock.auditLogs).toHaveLength(1);
      expect(mock.auditLogs[0].action).toBe('mail_cleanup');
    });
  });

  describe('listAuditLogs', () => {
    it('filters by action=send_failed and supports limit and before cursor', async () => {
      await logAdminAction(env, 'admin@aistockvn.com', 'send_failed', 'a@b.com', 'err1', 1000);
      await logAdminAction(env, 'admin@aistockvn.com', 'user_role_changed', 'u@b.com', 'ok', 2000);
      await logAdminAction(env, 'admin@aistockvn.com', 'send_failed', 'c@d.com', 'err2', 3000);

      const failedOnly = await listAuditLogs(env, { action: 'send_failed', limit: 10 });
      expect(failedOnly).toHaveLength(2);
      expect(failedOnly.map((l) => l.target)).toEqual(['c@d.com', 'a@b.com']);

      const paged = await listAuditLogs(env, { action: 'send_failed', before: 3000, limit: 10 });
      expect(paged).toHaveLength(1);
      expect(paged[0].target).toBe('a@b.com');
    });
  });

  describe('getAdminSettings & updateAdminSettings', () => {
    it('defaults quota to zero, persists it independently, and validates quota values', async () => {
      expect((await getAdminSettings(env)).storageQuotaMb).toBe(0);
      for (const bad of [-1, 102401, 1.5, '2' as unknown as number]) {
        await expect(updateAdminSettings(env, 'admin@aistockvn.com', { storageQuotaMb: bad }, 5000))
          .rejects.toMatchObject({ status: 400, code: 'invalid_storage_quota_mb' });
      }
      await updateAdminSettings(env, 'admin@aistockvn.com', { sendDailyCap: 321 }, 6000);
      const quotaUpdate = await updateAdminSettings(env, 'admin@aistockvn.com', { storageQuotaMb: 42 }, 7000);
      expect(quotaUpdate).toMatchObject({ sendDailyCap: 321, storageQuotaMb: 42 });
      const capUpdate = await updateAdminSettings(env, 'admin@aistockvn.com', { sendDailyCap: 123 }, 8000);
      expect(capUpdate).toMatchObject({ sendDailyCap: 123, storageQuotaMb: 42 });
    });

    it('validates sendDailyCap (0, -1, 10001, non-number -> 400; 200 -> ok)', async () => {
      const initial = await getAdminSettings(env);
      expect(initial.sendDailyCap).toBe(200);
      expect(initial.allowedEmails).toEqual(['admin@aistockvn.com', 'user@aistockvn.com']);

      for (const bad of [0, -1, 10001, 1.5, '200' as unknown as number, NaN]) {
        await expect(
          updateAdminSettings(env, 'admin@aistockvn.com', { sendDailyCap: bad }, 5000)
        ).rejects.toBeInstanceOf(AdminError);
        await expect(
          updateAdminSettings(env, 'admin@aistockvn.com', { sendDailyCap: bad }, 5000)
        ).rejects.toMatchObject({ status: 400, code: 'invalid_send_daily_cap' });
      }

      const updated = await updateAdminSettings(
        env,
        'admin@aistockvn.com',
        { sendDailyCap: 200 },
        6000
      );
      expect(updated.sendDailyCap).toBe(200);
      expect(updated.updatedAt).toBe(6000);
      expect(mock.auditLogs[mock.auditLogs.length - 1].action).toBe('settings_updated');
    });
  });

  describe('countSentToday', () => {
    it('counts only folder=sent rows for the mailbox since dayStartMs, excluding yesterday and other folders', async () => {
      const dayStartMs = Date.UTC(2026, 10, 19, 0, 0, 0);
      mock.messages.push(
        { id: 's1', mailbox_address: 'admin@aistockvn.com', folder: 'sent', date: dayStartMs + 1000, is_read: 1, raw_key: null },
        { id: 's2', mailbox_address: 'admin@aistockvn.com', folder: 'sent', date: dayStartMs + 5000, is_read: 1, raw_key: null },
        { id: 's-yesterday', mailbox_address: 'admin@aistockvn.com', folder: 'sent', date: dayStartMs - 1, is_read: 1, raw_key: null },
        { id: 'inbox-today', mailbox_address: 'admin@aistockvn.com', folder: 'inbox', date: dayStartMs + 2000, is_read: 0, raw_key: null },
        { id: 'other-mailbox', mailbox_address: 'user@aistockvn.com', folder: 'sent', date: dayStartMs + 3000, is_read: 1, raw_key: null }
      );

      const count = await countSentToday(env, 'admin@aistockvn.com', dayStartMs);
      expect(count).toBe(2);
    });
  });
});
