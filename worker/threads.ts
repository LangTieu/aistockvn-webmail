/**
 * worker/threads.ts — thread view helpers + batch operations (Phase 4 round 2).
 *
 * Thread model
 * ------------
 * Every message belongs to the thread of its oldest ancestor. Ancestors are
 * followed through `in_reply_to` first, then through the tokens of
 * `references_hdr` (last token = immediate parent). A message with no known
 * parent is its own root.
 *
 * `threadKey` is the root's `message_id`; when the root has no `message_id`
 * the root's `id` is used instead.
 *
 * Batch ops live here too (the spec allows either this file or worker/batch.ts):
 *   applyBatch(db, mailboxList, ids, action) — max 50 ids per call.
 */

export const THREAD_SCAN_LIMIT = 200;
export const THREAD_DETAIL_LIMIT = 1000;
export const THREAD_DEFAULT_LIMIT = 30;
export const THREAD_MAX_LIMIT = 100;

export const MAX_BATCH_IDS = 50;

export const BATCH_ACTIONS = ['read', 'unread', 'star', 'unstar', 'spam'] as const;
export type BatchAction = (typeof BATCH_ACTIONS)[number];

export interface ThreadMessageRow {
  id: string;
  message_id: string | null;
  in_reply_to: string | null;
  references_hdr: string | null;
  folder: string;
  mailbox_address: string | null;
  from_addr: string;
  from_name: string;
  to_addrs: string;
  cc_addrs: string;
  reply_to: string | null;
  subject: string;
  snippet: string;
  text_body: string;
  html_body: string | null;
  date: number;
  is_read: number;
  is_starred: number;
  attachments: string;
}

export interface ThreadSummary {
  threadKey: string;
  subject: string;
  participants: string[];
  count: number;
  unreadCount: number;
  latestDate: number;
  latestId: string;
  starred: boolean;
  snippet: string;
  /** ids of every message in the thread (used by the frontend to batch a whole thread) */
  ids: string[];
}

export class ThreadsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ThreadsError';
    this.status = status;
  }
}

export class BatchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'BatchError';
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

function normalizeThreadLimit(limit: number): number {
  const parsed = Math.trunc(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return THREAD_DEFAULT_LIMIT;
  return Math.min(parsed, THREAD_MAX_LIMIT);
}

/** Strip angle brackets / whitespace and lowercase: message ids compare case-insensitively. */
export function normalizeMessageId(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[<>\s]/g, '').toLowerCase();
}

/** The thread key of a single row: root message_id when present, otherwise the row id. */
export function threadKeyOf(row: Pick<ThreadMessageRow, 'id' | 'message_id'>): string {
  const messageId = typeof row.message_id === 'string' ? row.message_id.trim() : '';
  return messageId.length > 0 ? messageId : row.id;
}

/** Parent candidates for a row: in_reply_to first, then references_hdr from newest to oldest. */
export function parentCandidatesOf(row: Pick<ThreadMessageRow, 'in_reply_to' | 'references_hdr'>): string[] {
  const out: string[] = [];
  const inReplyTo = normalizeMessageId(row.in_reply_to);
  if (inReplyTo) out.push(inReplyTo);

  if (row.references_hdr) {
    // References is a whitespace-separated list of msg-ids, each usually wrapped
    // in angle brackets ("<a@x> <b@y>"). Split on whitespace FIRST, then
    // normalize each token, otherwise stripping whitespace would merge tokens.
    const tokens = String(row.references_hdr)
      .split(/\s+/)
      .map((token) => normalizeMessageId(token))
      .filter((token) => token.length > 0);
    for (let i = tokens.length - 1; i >= 0; i--) out.push(tokens[i]);
  }
  return out;
}

function buildMessageIdMap(rows: ThreadMessageRow[]): Map<string, ThreadMessageRow> {
  const map = new Map<string, ThreadMessageRow>();
  for (const row of rows) {
    const keys = [normalizeMessageId(row.message_id), normalizeMessageId(row.id)].filter(
      (key) => key.length > 0
    );
    for (const key of keys) {
      if (!map.has(key)) map.set(key, row);
    }
  }
  return map;
}

/**
 * Walk up the reply chain to the oldest known ancestor.
 * Cycles and unknown parents stop the walk (that message is then the root).
 */
export function resolveThreadRoot(
  row: ThreadMessageRow,
  byMessageId: Map<string, ThreadMessageRow>
): ThreadMessageRow {
  let current = row;
  const visited = new Set<string>([row.id]);

  for (let depth = 0; depth < 64; depth++) {
    let parent: ThreadMessageRow | undefined;
    for (const candidate of parentCandidatesOf(current)) {
      const found = byMessageId.get(candidate);
      if (found && !visited.has(found.id)) {
        parent = found;
        break;
      }
    }
    if (!parent) return current;
    visited.add(parent.id);
    current = parent;
  }
  return current;
}

const THREAD_SELECT = `id, message_id, in_reply_to, references_hdr, folder, mailbox_address,
    from_addr, from_name, to_addrs, cc_addrs, reply_to, subject, snippet, text_body, html_body,
    date, is_read, is_starred, attachments`;

/**
 * One row per thread, newest activity first.
 *
 * LIMIT: only the 200 newest messages of the folder are loaded and grouped on
 * the server (THREAD_SCAN_LIMIT). A parent older than that window is treated as
 * unknown, so the newest visible message becomes the root of its own thread.
 */
export async function listThreads(
  db: D1Database,
  mailboxList: string[],
  folder: string = 'inbox',
  before: number = Number.MAX_SAFE_INTEGER,
  limit: number = THREAD_DEFAULT_LIMIT
): Promise<ThreadSummary[]> {
  const mailboxes = normalizeMailboxList(mailboxList);
  if (mailboxes.length === 0) return [];

  const safeFolder = ['inbox', 'sent', 'spam'].includes(folder) ? folder : 'inbox';
  const safeLimit = normalizeThreadLimit(limit);
  const cursor = Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER;
  const placeholders = mailboxes.map(() => '?').join(', ');

  const { results } = await db
    .prepare(
      `SELECT ${THREAD_SELECT}
       FROM messages
       WHERE folder = ? AND date < ? AND LOWER(mailbox_address) IN (${placeholders})
       ORDER BY date DESC
       LIMIT ${THREAD_SCAN_LIMIT}`
    )
    .bind(safeFolder, cursor, ...mailboxes)
    .all<ThreadMessageRow>();

  const rows = (results ?? []) as ThreadMessageRow[];
  const byMessageId = buildMessageIdMap(rows);

  const groups = new Map<
    string,
    {
      summary: ThreadSummary;
      participants: Set<string>;
    }
  >();

  for (const row of rows) {
    const root = resolveThreadRoot(row, byMessageId);
    const key = threadKeyOf(root);

    let group = groups.get(key);
    if (!group) {
      group = {
        summary: {
          threadKey: key,
          subject: row.subject,
          participants: [],
          count: 0,
          unreadCount: 0,
          latestDate: 0,
          latestId: row.id,
          starred: false,
          snippet: row.snippet,
          ids: [],
        },
        participants: new Set<string>(),
      };
      groups.set(key, group);
    }

    const summary = group.summary;
    summary.count += 1;
    summary.ids.push(row.id);
    if (!row.is_read) summary.unreadCount += 1;
    if (row.is_starred) summary.starred = true;
    if (row.from_addr) group.participants.add(row.from_addr);

    if (row.date >= summary.latestDate) {
      summary.latestDate = row.date;
      summary.latestId = row.id;
      summary.snippet = row.snippet;
      summary.subject = row.subject;
    }
  }

  const summaries = Array.from(groups.values()).map((group) => ({
    ...group.summary,
    participants: Array.from(group.participants),
  }));

  summaries.sort((a, b) => b.latestDate - a.latestDate);
  return summaries.slice(0, safeLimit);
}

/**
 * Every message of one thread, oldest first (reading order).
 * Throws ThreadsError(400) when no key is given.
 */
export async function getThread(
  db: D1Database,
  mailboxList: string[],
  threadKey: string
): Promise<ThreadMessageRow[]> {
  const key = String(threadKey ?? '').trim();
  if (!key) throw new ThreadsError(400, 'Thread key is required');

  const mailboxes = normalizeMailboxList(mailboxList);
  if (mailboxes.length === 0) return [];

  const placeholders = mailboxes.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT ${THREAD_SELECT}
       FROM messages
       WHERE LOWER(mailbox_address) IN (${placeholders})
       ORDER BY date ASC
       LIMIT ${THREAD_DETAIL_LIMIT}`
    )
    .bind(...mailboxes)
    .all<ThreadMessageRow>();

  const rows = (results ?? []) as ThreadMessageRow[];
  const byMessageId = buildMessageIdMap(rows);
  const wanted = normalizeMessageId(key);

  return rows.filter((row) => {
    const rowKey = threadKeyOf(resolveThreadRoot(row, byMessageId));
    return rowKey === key || normalizeMessageId(rowKey) === wanted;
  });
}

export function isBatchAction(value: unknown): value is BatchAction {
  return typeof value === 'string' && (BATCH_ACTIONS as readonly string[]).includes(value);
}

/**
 * Validate the id list of a batch call.
 * Empty (or non-array) lists and lists longer than 50 ids are rejected with 400.
 */
export function validateBatchIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) throw new BatchError(400, 'ids must be an array');

  const normalized = ids
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const unique = Array.from(new Set(normalized));

  if (unique.length === 0) throw new BatchError(400, 'ids must not be empty');
  if (unique.length > MAX_BATCH_IDS) {
    throw new BatchError(400, `Too many ids (max ${MAX_BATCH_IDS})`);
  }
  return unique;
}

/**
 * Apply one action to many messages of the caller's mailboxes.
 * Unknown / foreign ids are skipped silently; `updated` counts real changes.
 */
export async function applyBatch(
  db: D1Database,
  mailboxList: string[],
  ids: unknown,
  action: unknown
): Promise<{ updated: number }> {
  const messageIds = validateBatchIds(ids);
  if (!isBatchAction(action)) throw new BatchError(400, 'Unknown action');

  const setClause =
    action === 'read'
      ? 'is_read = 1'
      : action === 'unread'
        ? 'is_read = 0'
        : action === 'star'
          ? 'is_starred = 1'
          : action === 'unstar'
            ? 'is_starred = 0'
            : "folder = 'spam'";

  const mailboxes = normalizeMailboxList(mailboxList);
  const idPlaceholders = messageIds.map(() => '?').join(', ');
  const mailboxClause =
    mailboxes.length > 0
      ? ` AND LOWER(mailbox_address) IN (${mailboxes.map(() => '?').join(', ')})`
      : ' AND 1=0';
  const binds: unknown[] = mailboxes.length > 0 ? [...messageIds, ...mailboxes] : [...messageIds];

  const result = await db
    .prepare(
      `UPDATE messages SET ${setClause} WHERE id IN (${idPlaceholders})${mailboxClause}`
    )
    .bind(...binds)
    .run();

  return { updated: result.meta?.changes ?? 0 };
}