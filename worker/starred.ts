/**
 * worker/starred.ts — starred flag helpers (Phase 4 round 2).
 *
 * Pure-ish module in the style of worker/drafts.ts: every function takes the
 * D1 binding plus the caller's mailbox list, so a message that belongs to
 * another mailbox is treated exactly like a missing message (404).
 */

export const MAX_STARRED_LIMIT = 100;
export const DEFAULT_STARRED_LIMIT = 30;

export interface StarredMessageRow {
  id: string;
  folder: string;
  from_addr: string;
  from_name: string;
  to_addrs: string;
  subject: string;
  snippet: string;
  date: number;
  is_read: number;
  is_focused: number;
  is_starred: number;
  attachments: string;
}

export class StarredError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'StarredError';
    this.status = status;
  }
}

function normalizeMailboxList(mailboxList: string[]): string[] {
  return Array.from(
    new Set(
      (mailboxList || [])
        .map((value) => String(value).trim().toLowerCase())
        .filter((value) => value.length > 0)
    )
  );
}

export function normalizeStarredLimit(limit: number): number {
  const parsed = Math.trunc(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STARRED_LIMIT;
  return Math.min(parsed, MAX_STARRED_LIMIT);
}

/**
 * Set (or clear) the starred flag of one message.
 * Throws StarredError(404) when the id does not exist or belongs to another mailbox.
 */
export async function setStarred(
  db: D1Database,
  mailboxList: string[],
  id: string,
  starred: boolean
): Promise<{ id: string; is_starred: boolean }> {
  const messageId = String(id ?? '').trim();
  if (!messageId) throw new StarredError(404, 'Message not found');

  const mailboxes = normalizeMailboxList(mailboxList);
  const row = await db
    .prepare(`SELECT id, mailbox_address FROM messages WHERE id = ? LIMIT 1`)
    .bind(messageId)
    .first<{ id: string; mailbox_address: string | null }>();

  if (!row) throw new StarredError(404, 'Message not found');

  const rowMailbox =
    typeof row.mailbox_address === 'string' ? row.mailbox_address.trim().toLowerCase() : '';
  if (mailboxes.length === 0 || !rowMailbox || !mailboxes.includes(rowMailbox)) {
    throw new StarredError(404, 'Message not found');
  }

  const placeholders = mailboxes.map(() => '?').join(', ');
  await db
    .prepare(
      `UPDATE messages SET is_starred = ? WHERE id = ? AND LOWER(mailbox_address) IN (${placeholders})`
    )
    .bind(starred ? 1 : 0, messageId, ...mailboxes)
    .run();

  return { id: row.id, is_starred: starred };
}

/**
 * Rows for GET /api/messages?starred=1 — starred mail of the caller across
 * every folder (inbox / sent / spam), newest first, `before`/`limit` paged.
 */
export async function listStarred(
  db: D1Database,
  mailboxList: string[],
  before: number = Number.MAX_SAFE_INTEGER,
  limit: number = DEFAULT_STARRED_LIMIT
): Promise<StarredMessageRow[]> {
  const mailboxes = normalizeMailboxList(mailboxList);
  const safeLimit = normalizeStarredLimit(limit);
  const cursor = Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER;

  const where =
    mailboxes.length > 0
      ? `is_starred = 1 AND date < ? AND LOWER(mailbox_address) IN (${mailboxes.map(() => '?').join(', ')})`
      : `is_starred = 1 AND date < ? AND 1=0`;
  const binds: unknown[] = mailboxes.length > 0 ? [cursor, ...mailboxes] : [cursor];

  const { results } = await db
    .prepare(
      `SELECT id, folder, from_addr, from_name, to_addrs, subject, snippet, date, is_read, is_focused, is_starred, attachments
       FROM messages WHERE ${where} ORDER BY date DESC LIMIT ${safeLimit + 1}`
    )
    .bind(...binds)
    .all<StarredMessageRow>();

  return (results ?? []) as StarredMessageRow[];
}