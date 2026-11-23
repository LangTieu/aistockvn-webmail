export const MAX_DRAFTS_PER_MAILBOX = 5;

export interface DraftRecord {
  id: string;
  mailbox_address: string;
  to_addr: string;
  cc_addr: string;
  subject: string;
  text: string;
  reply_to_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface DraftDto {
  id: string;
  mailboxAddress: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  replyToId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DraftUpsertInput {
  id?: string;
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  replyToId?: string | null;
}

export class DraftError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function toDraftDto(row: DraftRecord): DraftDto {
  return {
    id: row.id,
    mailboxAddress: row.mailbox_address,
    to: row.to_addr ?? '',
    cc: row.cc_addr ?? '',
    subject: row.subject ?? '',
    text: row.text ?? '',
    replyToId: row.reply_to_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildInClause(values: string[]): { placeholders: string; params: string[] } {
  const normalized = Array.from(
    new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))
  );
  if (normalized.length === 0) {
    return { placeholders: 'NULL', params: [] };
  }
  return {
    placeholders: normalized.map(() => '?').join(', '),
    params: normalized,
  };
}

export function hasDraftContent(input: DraftUpsertInput): boolean {
  const to = (input.to ?? '').trim();
  const subject = (input.subject ?? '').trim();
  const text = (input.text ?? '').trim();
  return to.length > 0 || subject.length > 0 || text.length > 0;
}

export async function listDrafts(
  db: D1Database,
  mailboxAddresses: string[]
): Promise<DraftDto[]> {
  const { placeholders, params } = buildInClause(mailboxAddresses);
  if (params.length === 0) return [];

  const result = await db
    .prepare(
      `SELECT id, mailbox_address, to_addr, cc_addr, subject, text, reply_to_id, created_at, updated_at
       FROM mail_drafts
       WHERE LOWER(mailbox_address) IN (${placeholders})
       ORDER BY updated_at DESC`
    )
    .bind(...params)
    .all<DraftRecord>();

  return (result.results ?? []).map(toDraftDto);
}

export async function getDraft(
  db: D1Database,
  id: string,
  mailboxAddresses: string[]
): Promise<DraftDto | null> {
  const { placeholders, params } = buildInClause(mailboxAddresses);
  if (params.length === 0) return null;

  const row = await db
    .prepare(
      `SELECT id, mailbox_address, to_addr, cc_addr, subject, text, reply_to_id, created_at, updated_at
       FROM mail_drafts
       WHERE id = ? AND LOWER(mailbox_address) IN (${placeholders})
       LIMIT 1`
    )
    .bind(id, ...params)
    .first<DraftRecord>();

  return row ? toDraftDto(row) : null;
}

export async function upsertDraft(
  db: D1Database,
  primaryMailbox: string,
  mailboxAddresses: string[],
  input: DraftUpsertInput,
  nowMs: number = Date.now()
): Promise<DraftDto> {
  if (!hasDraftContent(input)) {
    throw new DraftError(400, 'Draft must contain at least one of: to, subject, or text');
  }

  const normalizedPrimary = primaryMailbox.trim().toLowerCase();
  const { placeholders, params } = buildInClause(mailboxAddresses);
  if (params.length === 0 || !normalizedPrimary) {
    throw new DraftError(403, 'No accessible mailbox');
  }

  const toAddr = (input.to ?? '').trim();
  const ccAddr = (input.cc ?? '').trim();
  const subject = (input.subject ?? '').trim();
  const text = input.text ?? '';
  const replyToId = input.replyToId ? input.replyToId.trim() : null;

  if (input.id && input.id.trim().length > 0) {
    const id = input.id.trim();
    const existing = await db
      .prepare(
        `SELECT id, mailbox_address, created_at
         FROM mail_drafts
         WHERE id = ?
         LIMIT 1`
      )
      .bind(id)
      .first<{ id: string; mailbox_address: string; created_at: number }>();

    if (existing) {
      if (!params.includes(existing.mailbox_address.toLowerCase())) {
        throw new DraftError(404, 'Draft not found');
      }

      await db
        .prepare(
          `UPDATE mail_drafts
           SET to_addr = ?, cc_addr = ?, subject = ?, text = ?, reply_to_id = ?, updated_at = ?
           WHERE id = ? AND LOWER(mailbox_address) IN (${placeholders})`
        )
        .bind(toAddr, ccAddr, subject, text, replyToId, nowMs, id, ...params)
        .run();

      const updated = await getDraft(db, id, mailboxAddresses);
      if (!updated) {
        throw new DraftError(404, 'Draft not found');
      }
      return updated;
    }

    await db
      .prepare(
        `INSERT INTO mail_drafts
         (id, mailbox_address, to_addr, cc_addr, subject, text, reply_to_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, normalizedPrimary, toAddr, ccAddr, subject, text, replyToId, nowMs, nowMs)
      .run();

    await pruneOldDrafts(db, normalizedPrimary);

    const created = await getDraft(db, id, mailboxAddresses);
    if (!created) {
      throw new DraftError(500, 'Failed to load created draft');
    }
    return created;
  }

  const newId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO mail_drafts
       (id, mailbox_address, to_addr, cc_addr, subject, text, reply_to_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(newId, normalizedPrimary, toAddr, ccAddr, subject, text, replyToId, nowMs, nowMs)
    .run();

  await pruneOldDrafts(db, normalizedPrimary);

  const created = await getDraft(db, newId, mailboxAddresses);
  if (!created) {
    throw new DraftError(500, 'Failed to load created draft');
  }
  return created;
}

export async function pruneOldDrafts(
  db: D1Database,
  mailboxAddress: string,
  maxDrafts: number = MAX_DRAFTS_PER_MAILBOX
): Promise<void> {
  const normalized = mailboxAddress.trim().toLowerCase();
  await db
    .prepare(
      `DELETE FROM mail_drafts
       WHERE LOWER(mailbox_address) = ?
         AND id NOT IN (
           SELECT id FROM mail_drafts
           WHERE LOWER(mailbox_address) = ?
           ORDER BY updated_at DESC, rowid DESC
           LIMIT ?
         )`
    )
    .bind(normalized, normalized, maxDrafts)
    .run();
}

export async function deleteDraft(
  db: D1Database,
  id: string,
  mailboxAddresses: string[]
): Promise<boolean> {
  const { placeholders, params } = buildInClause(mailboxAddresses);
  if (params.length === 0) return false;

  const result = await db
    .prepare(
      `DELETE FROM mail_drafts
       WHERE id = ? AND LOWER(mailbox_address) IN (${placeholders})`
    )
    .bind(id, ...params)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}
