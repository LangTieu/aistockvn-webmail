export type DetailLevel = 'basic' | 'full';
export type NotificationChannel = 'push' | 'telegram';
export type NotificationStatus = 'pending' | 'sent' | 'skipped' | 'failed';

export const TELEGRAM_CHAT_ID_RE = /^-?\d{1,20}$/;

export interface NotificationSettingsRow {
  mailbox_address: string;
  push_enabled: number;
  telegram_enabled: number;
  telegram_chat_id: string;
  detail_level: string;
  updated_at: number;
}

export interface NotificationSettings {
  mailboxAddress: string;
  pushEnabled: boolean;
  telegramEnabled: boolean;
  telegramChatId: string;
  detailLevel: DetailLevel;
  updatedAt: number;
}

export interface NotificationSettingsUpdate {
  pushEnabled?: boolean;
  telegramEnabled?: boolean;
  telegramChatId?: string;
  detailLevel?: DetailLevel;
}

export interface NotificationOutboxRow {
  id: string;
  mailbox_address: string;
  message_id: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  sent_at: number | null;
  last_error_code: string;
}

export interface PushSubscriptionRow {
  id: string;
  mailbox_address: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
}

export class NotificationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'NotificationError';
    this.status = status;
  }
}

function normalizeMailbox(mailboxAddress: string): string {
  const normalized = mailboxAddress.trim().toLowerCase();
  if (!normalized) {
    throw new NotificationError(400, 'Mailbox address is required');
  }
  return normalized;
}

function toSettingsDto(mailboxAddress: string, row: NotificationSettingsRow | null): NotificationSettings {
  if (!row) {
    return {
      mailboxAddress,
      pushEnabled: false,
      telegramEnabled: false,
      telegramChatId: '',
      detailLevel: 'basic',
      updatedAt: 0,
    };
  }
  return {
    mailboxAddress: row.mailbox_address,
    pushEnabled: row.push_enabled === 1,
    telegramEnabled: row.telegram_enabled === 1,
    telegramChatId: row.telegram_chat_id ?? '',
    detailLevel: row.detail_level === 'full' ? 'full' : 'basic',
    updatedAt: row.updated_at,
  };
}

export function shouldNotify(
  folder: string,
  duplicate: boolean,
  settings: Pick<NotificationSettings, 'pushEnabled' | 'telegramEnabled'>
): boolean {
  if (folder !== 'inbox' || duplicate) {
    return false;
  }
  return Boolean(settings.pushEnabled || settings.telegramEnabled);
}

export async function getNotificationSettings(
  db: D1Database,
  mailboxAddress: string
): Promise<NotificationSettings> {
  const normalized = normalizeMailbox(mailboxAddress);
  const row = await db
    .prepare(
      `SELECT mailbox_address, push_enabled, telegram_enabled, telegram_chat_id, detail_level, updated_at
       FROM notification_settings
       WHERE mailbox_address = ?
       LIMIT 1`
    )
    .bind(normalized)
    .first<NotificationSettingsRow>();
  return toSettingsDto(normalized, row ?? null);
}

export async function updateNotificationSettings(
  db: D1Database,
  mailboxAddress: string,
  input: NotificationSettingsUpdate,
  nowMs: number = Date.now()
): Promise<NotificationSettings> {
  const normalized = normalizeMailbox(mailboxAddress);
  const current = await getNotificationSettings(db, normalized);

  const pushEnabled = input.pushEnabled !== undefined ? Boolean(input.pushEnabled) : current.pushEnabled;
  const telegramEnabled =
    input.telegramEnabled !== undefined ? Boolean(input.telegramEnabled) : current.telegramEnabled;

  let telegramChatId = current.telegramChatId;
  if (input.telegramChatId !== undefined) {
    const trimmed = String(input.telegramChatId).trim();
    if (trimmed !== '' && !TELEGRAM_CHAT_ID_RE.test(trimmed)) {
      throw new NotificationError(400, 'Invalid Telegram chat ID format');
    }
    telegramChatId = trimmed;
  }

  let detailLevel: DetailLevel = current.detailLevel;
  if (input.detailLevel !== undefined) {
    if (input.detailLevel !== 'basic' && input.detailLevel !== 'full') {
      throw new NotificationError(400, 'Invalid detail_level; must be "basic" or "full"');
    }
    detailLevel = input.detailLevel;
  }

  await db
    .prepare(
      `INSERT INTO notification_settings
       (mailbox_address, push_enabled, telegram_enabled, telegram_chat_id, detail_level, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(mailbox_address) DO UPDATE SET
         push_enabled = excluded.push_enabled,
         telegram_enabled = excluded.telegram_enabled,
         telegram_chat_id = excluded.telegram_chat_id,
         detail_level = excluded.detail_level,
         updated_at = excluded.updated_at`
    )
    .bind(
      normalized,
      pushEnabled ? 1 : 0,
      telegramEnabled ? 1 : 0,
      telegramChatId,
      detailLevel,
      nowMs
    )
    .run();

  return {
    mailboxAddress: normalized,
    pushEnabled,
    telegramEnabled,
    telegramChatId,
    detailLevel,
    updatedAt: nowMs,
  };
}

export async function disableTelegramForMailbox(
  db: D1Database,
  mailboxAddress: string,
  nowMs: number = Date.now()
): Promise<void> {
  const normalized = normalizeMailbox(mailboxAddress);
  await db
    .prepare(
      `UPDATE notification_settings
       SET telegram_enabled = 0, updated_at = ?
       WHERE mailbox_address = ?`
    )
    .bind(nowMs, normalized)
    .run();
}

export async function enqueueNotification(
  db: D1Database,
  mailboxAddress: string,
  messageId: string,
  channel: NotificationChannel,
  nowMs: number = Date.now()
): Promise<{ id: string; inserted: boolean }> {
  const normalized = normalizeMailbox(mailboxAddress);
  const msgId = messageId.trim();
  if (!msgId) {
    throw new NotificationError(400, 'Message ID is required');
  }
  if (channel !== 'push' && channel !== 'telegram') {
    throw new NotificationError(400, 'Invalid notification channel');
  }

  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO notification_outbox
       (id, mailbox_address, message_id, channel, status, attempts, next_attempt_at, created_at, sent_at, last_error_code)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, NULL, '')`
    )
    .bind(id, normalized, msgId, channel, nowMs, nowMs)
    .run();

  return { id, inserted: (result.meta?.changes ?? 0) > 0 };
}

export async function claimDueNotifications(
  db: D1Database,
  nowMs: number = Date.now(),
  limit: number = 20
): Promise<NotificationOutboxRow[]> {
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const due = await db
    .prepare(
      `SELECT id, mailbox_address, message_id, channel, status, attempts, next_attempt_at, created_at, sent_at, last_error_code
       FROM notification_outbox
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC, created_at ASC
       LIMIT ?`
    )
    .bind(nowMs, safeLimit)
    .all<NotificationOutboxRow>();

  const rows = due.results ?? [];
  const claimed: NotificationOutboxRow[] = [];
  const leaseUntil = nowMs + 60_000;

  for (const row of rows) {
    const nextAttempts = row.attempts + 1;
    const res = await db
      .prepare(
        `UPDATE notification_outbox
         SET attempts = ?, next_attempt_at = ?
         WHERE id = ? AND status = 'pending' AND attempts = ?`
      )
      .bind(nextAttempts, leaseUntil, row.id, row.attempts)
      .run();

    if ((res.meta?.changes ?? 0) > 0) {
      claimed.push({
        ...row,
        attempts: nextAttempts,
        next_attempt_at: leaseUntil,
      });
    }
  }

  return claimed;
}

export async function markNotification(
  db: D1Database,
  id: string,
  update: {
    status: NotificationStatus;
    nextAttemptAt?: number;
    sentAt?: number | null;
    lastErrorCode?: string;
  }
): Promise<void> {
  const lastErrorCode = update.lastErrorCode ?? '';
  if (update.nextAttemptAt !== undefined) {
    await db
      .prepare(
        `UPDATE notification_outbox
         SET status = ?, next_attempt_at = ?, sent_at = ?, last_error_code = ?
         WHERE id = ?`
      )
      .bind(update.status, update.nextAttemptAt, update.sentAt ?? null, lastErrorCode, id)
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE notification_outbox
       SET status = ?, sent_at = ?, last_error_code = ?
       WHERE id = ?`
    )
    .bind(update.status, update.sentAt ?? null, lastErrorCode, id)
    .run();
}

export async function listPushSubscriptions(
  db: D1Database,
  mailboxAddress: string
): Promise<PushSubscriptionRow[]> {
  const normalized = normalizeMailbox(mailboxAddress);
  const res = await db
    .prepare(
      `SELECT id, mailbox_address, endpoint, p256dh, auth, created_at
       FROM push_subscriptions
       WHERE mailbox_address = ?
       ORDER BY created_at DESC`
    )
    .bind(normalized)
    .all<PushSubscriptionRow>();
  return res.results ?? [];
}

export async function deletePushSubscriptionByEndpoint(
  db: D1Database,
  endpoint: string
): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`)
    .bind(endpoint)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
