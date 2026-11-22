import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Env } from './mail';
import {
  getNotificationSettings,
  updateNotificationSettings,
  enqueueNotification,
  shouldNotify,
  NotificationError,
  type NotificationSettingsRow,
  type NotificationOutboxRow,
} from './notifications';
import { deliverPendingNotifications } from './notify-delivery';

function createMockD1() {
  const settings = new Map<string, NotificationSettingsRow>();
  const outbox: NotificationOutboxRow[] = [];
  const messages = new Map<
    string,
    { from_name: string; from_addr: string; subject: string; snippet: string }
  >();

  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async first<T = unknown>() {
        if (sql.includes('FROM notification_settings')) {
          const mailbox = String(bound[0]);
          return (settings.get(mailbox) ?? null) as unknown as T;
        }
        if (sql.includes('FROM messages')) {
          const id = String(bound[0]);
          return (messages.get(id) ?? null) as unknown as T;
        }
        return null as unknown as T;
      },
      async all<T = unknown>() {
        if (sql.includes('FROM notification_outbox')) {
          const nowMs = Number(bound[0]);
          const limit = Number(bound[1]);
          const due = outbox
            .filter((r) => r.status === 'pending' && r.next_attempt_at <= nowMs)
            .sort((a, b) => a.next_attempt_at - b.next_attempt_at || a.created_at - b.created_at)
            .slice(0, limit);
          return { results: due as unknown as T[] };
        }
        if (sql.includes('FROM push_subscriptions')) {
          return { results: [] as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (sql.includes('INSERT INTO notification_settings')) {
          const [mailbox, push_enabled, telegram_enabled, telegram_chat_id, detail_level, updated_at] =
            bound;
          settings.set(String(mailbox), {
            mailbox_address: String(mailbox),
            push_enabled: Number(push_enabled),
            telegram_enabled: Number(telegram_enabled),
            telegram_chat_id: String(telegram_chat_id),
            detail_level: String(detail_level),
            updated_at: Number(updated_at),
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE notification_settings')) {
          const [updated_at, mailbox] = bound;
          const existing = settings.get(String(mailbox));
          if (existing) {
            existing.telegram_enabled = 0;
            existing.updated_at = Number(updated_at);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (sql.includes('INSERT OR IGNORE INTO notification_outbox')) {
          const [id, mailbox, messageId, channel, nextAttemptAt, createdAt] = bound;
          const dup = outbox.some(
            (r) =>
              r.mailbox_address === String(mailbox) &&
              r.message_id === String(messageId) &&
              r.channel === String(channel)
          );
          if (dup) {
            return { meta: { changes: 0 } };
          }
          outbox.push({
            id: String(id),
            mailbox_address: String(mailbox),
            message_id: String(messageId),
            channel: channel as 'push' | 'telegram',
            status: 'pending',
            attempts: 0,
            next_attempt_at: Number(nextAttemptAt),
            created_at: Number(createdAt),
            sent_at: null,
            last_error_code: '',
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE notification_outbox') && sql.includes('SET attempts = ?')) {
          const [nextAttempts, leaseUntil, id, expectedAttempts] = bound;
          const row = outbox.find(
            (r) => r.id === String(id) && r.status === 'pending' && r.attempts === Number(expectedAttempts)
          );
          if (!row) return { meta: { changes: 0 } };
          row.attempts = Number(nextAttempts);
          row.next_attempt_at = Number(leaseUntil);
          return { meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE notification_outbox') && sql.includes('SET status = ?')) {
          if (sql.includes('next_attempt_at = ?')) {
            const [status, nextAttemptAt, sentAt, lastErrorCode, id] = bound;
            const row = outbox.find((r) => r.id === String(id));
            if (!row) return { meta: { changes: 0 } };
            row.status = status as NotificationOutboxRow['status'];
            row.next_attempt_at = Number(nextAttemptAt);
            row.sent_at = sentAt === null ? null : Number(sentAt);
            row.last_error_code = String(lastErrorCode);
            return { meta: { changes: 1 } };
          } else {
            const [status, sentAt, lastErrorCode, id] = bound;
            const row = outbox.find((r) => r.id === String(id));
            if (!row) return { meta: { changes: 0 } };
            row.status = status as NotificationOutboxRow['status'];
            row.sent_at = sentAt === null ? null : Number(sentAt);
            row.last_error_code = String(lastErrorCode);
            return { meta: { changes: 1 } };
          }
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };

  return {
    db: { prepare } as unknown as D1Database,
    outbox,
    messages,
  };
}

describe('notifications', () => {
  const mailbox = 'admin@aistockvn.com';
  let mock: ReturnType<typeof createMockD1>;

  beforeEach(() => {
    mock = createMockD1();
  });

  it('shouldNotify returns true only for non-duplicate inbox when at least one channel is enabled', () => {
    expect(shouldNotify('inbox', false, { pushEnabled: true, telegramEnabled: false })).toBe(true);
    expect(shouldNotify('inbox', false, { pushEnabled: false, telegramEnabled: true })).toBe(true);
    expect(shouldNotify('inbox', false, { pushEnabled: false, telegramEnabled: false })).toBe(false);
    expect(shouldNotify('spam', false, { pushEnabled: true, telegramEnabled: true })).toBe(false);
    expect(shouldNotify('inbox', true, { pushEnabled: true, telegramEnabled: true })).toBe(false);
  });

  it('defaults notification settings to both channels off and basic detail level', async () => {
    const s = await getNotificationSettings(mock.db, mailbox);
    expect(s.pushEnabled).toBe(false);
    expect(s.telegramEnabled).toBe(false);
    expect(s.telegramChatId).toBe('');
    expect(s.detailLevel).toBe('basic');
  });

  it('validates detail_level and telegram_chat_id on update', async () => {
    await expect(
      updateNotificationSettings(mock.db, mailbox, { detailLevel: 'invalid' as 'basic' }, 1000)
    ).rejects.toThrow(NotificationError);

    await expect(
      updateNotificationSettings(mock.db, mailbox, { telegramChatId: 'not-a-number' }, 1000)
    ).rejects.toMatchObject({ status: 400 });

    const updated = await updateNotificationSettings(
      mock.db,
      mailbox,
      { pushEnabled: true, telegramEnabled: true, telegramChatId: '-100123456789', detailLevel: 'full' },
      2000
    );
    expect(updated.pushEnabled).toBe(true);
    expect(updated.telegramEnabled).toBe(true);
    expect(updated.telegramChatId).toBe('-100123456789');
    expect(updated.detailLevel).toBe('full');
  });

  it('deduplicates outbox rows via INSERT OR IGNORE on same mailbox, message, and channel', async () => {
    const first = await enqueueNotification(mock.db, mailbox, 'msg-1', 'telegram', 1000);
    const second = await enqueueNotification(mock.db, mailbox, 'msg-1', 'telegram', 1005);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(mock.outbox).toHaveLength(1);
  });

  it('deliverPendingNotifications skips without crashing when secrets are missing', async () => {
    await updateNotificationSettings(
      mock.db,
      mailbox,
      { pushEnabled: true, telegramEnabled: true, telegramChatId: '123456789' },
      1000
    );
    await enqueueNotification(mock.db, mailbox, 'msg-1', 'push', 1000);
    await enqueueNotification(mock.db, mailbox, 'msg-1', 'telegram', 1000);

    const fetchMock = vi.fn();
    const env = { DB: mock.db } as unknown as Env;
    const result = await deliverPendingNotifications(env, 2000, fetchMock as unknown as typeof fetch);

    expect(result.claimed).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mock.outbox.every((r) => r.status === 'skipped')).toBe(true);
  });
});
