import type { Env } from './mail';
import {
  claimDueNotifications,
  disableTelegramForMailbox,
  getNotificationSettings,
  listPushSubscriptions,
  markNotification,
  type DetailLevel,
} from './notifications';
import { PushError, sendPush } from './push';
import { sendTelegramMessage, TelegramError } from './telegram';

export interface DeliverySummary {
  claimed: number;
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
}

interface MessagePreviewRow {
  from_name: string | null;
  from_addr: string | null;
  subject: string | null;
  snippet: string | null;
}

export function formatNotificationText(
  detailLevel: DetailLevel,
  msg: { fromName: string; fromAddr: string; subject: string; snippet: string },
  webmailUrl: string = 'https://mail.aistockvn.com'
): string {
  const sender = msg.fromName.trim() || msg.fromAddr.trim() || 'Người gửi không xác định';
  if (detailLevel === 'basic') {
    return `Bạn có thư mới từ ${sender}\n${webmailUrl}`;
  }
  const subject = msg.subject.trim() || '(Không có tiêu đề)';
  const snippet = msg.snippet.replace(/\s+/g, ' ').trim().slice(0, 160);
  const lines = [`Bạn có thư mới từ ${sender}`, `Tiêu đề: ${subject}`];
  if (snippet) {
    lines.push(snippet);
  }
  lines.push(webmailUrl);
  return lines.join('\n');
}

function backoffSeconds(attempts: number): number {
  return Math.min(3600, 30 * Math.pow(2, attempts));
}

export async function deliverPendingNotifications(
  env: Env,
  nowMs: number = Date.now(),
  fetchImpl: typeof fetch = fetch
): Promise<DeliverySummary> {
  const rows = await claimDueNotifications(env.DB, nowMs, 20);
  const summary: DeliverySummary = {
    claimed: rows.length,
    sent: 0,
    skipped: 0,
    retried: 0,
    failed: 0,
  };

  for (const row of rows) {
    const settings = await getNotificationSettings(env.DB, row.mailbox_address);

    if (row.channel === 'push') {
      if (!settings.pushEnabled) {
        await markNotification(env.DB, row.id, { status: 'skipped', lastErrorCode: 'push_disabled' });
        summary.skipped++;
        continue;
      }
      if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
        await markNotification(env.DB, row.id, { status: 'skipped', lastErrorCode: 'missing_vapid_secret' });
        summary.skipped++;
        continue;
      }

      const subs = await listPushSubscriptions(env.DB, row.mailbox_address);
      if (subs.length === 0) {
        await markNotification(env.DB, row.id, { status: 'skipped', lastErrorCode: 'no_push_subscription' });
        summary.skipped++;
        continue;
      }

      let anySent = false;
      let retryableErr: PushError | null = null;
      let fatalErr: PushError | null = null;

      for (const sub of subs) {
        try {
          const res = await sendPush(sub, null, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, {
            fetchImpl,
            db: env.DB,
          });
          if (res.ok) {
            anySent = true;
          }
        } catch (err) {
          if (err instanceof PushError) {
            if (err.retryable) retryableErr = err;
            else fatalErr = err;
          } else {
            retryableErr = new PushError(500, 'push_unknown', true, 'Unknown push error');
          }
        }
      }

      if (anySent) {
        await markNotification(env.DB, row.id, { status: 'sent', sentAt: nowMs, lastErrorCode: '' });
        summary.sent++;
      } else if (retryableErr && row.attempts < 3) {
        const nextAt = nowMs + backoffSeconds(row.attempts) * 1000;
        await markNotification(env.DB, row.id, {
          status: 'pending',
          nextAttemptAt: nextAt,
          lastErrorCode: retryableErr.code,
        });
        summary.retried++;
      } else if (retryableErr || fatalErr) {
        await markNotification(env.DB, row.id, {
          status: 'failed',
          lastErrorCode: (retryableErr ?? fatalErr)!.code,
        });
        summary.failed++;
      } else {
        await markNotification(env.DB, row.id, {
          status: 'skipped',
          lastErrorCode: 'push_subscription_gone',
        });
        summary.skipped++;
      }
      continue;
    }

    if (row.channel === 'telegram') {
      if (!settings.telegramEnabled) {
        await markNotification(env.DB, row.id, { status: 'skipped', lastErrorCode: 'telegram_disabled' });
        summary.skipped++;
        continue;
      }
      if (!env.TELEGRAM_BOT_TOKEN) {
        await markNotification(env.DB, row.id, { status: 'skipped', lastErrorCode: 'missing_telegram_token' });
        summary.skipped++;
        continue;
      }
      if (!settings.telegramChatId) {
        await markNotification(env.DB, row.id, { status: 'skipped', lastErrorCode: 'missing_telegram_chat_id' });
        summary.skipped++;
        continue;
      }

      const msgRow = await env.DB.prepare(
        `SELECT from_name, from_addr, subject, snippet FROM messages WHERE id = ? LIMIT 1`
      )
        .bind(row.message_id)
        .first<MessagePreviewRow>();

      const text = formatNotificationText(settings.detailLevel, {
        fromName: msgRow?.from_name ?? '',
        fromAddr: msgRow?.from_addr ?? '',
        subject: msgRow?.subject ?? '',
        snippet: msgRow?.snippet ?? '',
      });

      try {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, settings.telegramChatId, text, fetchImpl);
        await markNotification(env.DB, row.id, { status: 'sent', sentAt: nowMs, lastErrorCode: '' });
        summary.sent++;
      } catch (err) {
        if (err instanceof TelegramError) {
          if (err.code === 'telegram_forbidden') {
            await disableTelegramForMailbox(env.DB, row.mailbox_address, nowMs);
            await markNotification(env.DB, row.id, {
              status: 'failed',
              lastErrorCode: err.code,
            });
            summary.failed++;
          } else if (err.retryable && row.attempts < 3) {
            const delaySec =
              err.retryAfter !== undefined
                ? Math.min(3600, err.retryAfter)
                : backoffSeconds(row.attempts);
            await markNotification(env.DB, row.id, {
              status: 'pending',
              nextAttemptAt: nowMs + delaySec * 1000,
              lastErrorCode: err.code,
            });
            summary.retried++;
          } else {
            await markNotification(env.DB, row.id, {
              status: 'failed',
              lastErrorCode: err.code,
            });
            summary.failed++;
          }
        } else {
          await markNotification(env.DB, row.id, {
            status: 'failed',
            lastErrorCode: 'telegram_unknown',
          });
          summary.failed++;
        }
      }
    }
  }

  return summary;
}
