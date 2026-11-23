import { describe, it, expect, beforeEach } from 'vitest';
import {
  upsertDraft,
  listDrafts,
  getDraft,
  deleteDraft,
  DraftError,
  MAX_DRAFTS_PER_MAILBOX,
} from './drafts';

interface Row {
  rowid: number;
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

function createMockD1(): D1Database {
  let rows: Row[] = [];
  let seq = 1;

  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async all<T = unknown>() {
        if (sql.includes('SELECT id, mailbox_address, to_addr')) {
          const mailboxes = bound.map((b) => String(b).toLowerCase());
          const results = rows
            .filter((r) => mailboxes.includes(r.mailbox_address.toLowerCase()))
            .sort((a, b) => b.updated_at - a.updated_at || b.rowid - a.rowid);
          return { results: results as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      async first<T = unknown>() {
        if (sql.includes('WHERE id = ? AND LOWER(mailbox_address) IN')) {
          const id = String(bound[0]);
          const mailboxes = bound.slice(1).map((b) => String(b).toLowerCase());
          const found = rows.find(
            (r) => r.id === id && mailboxes.includes(r.mailbox_address.toLowerCase())
          );
          return (found ?? null) as unknown as T;
        }
        if (sql.includes('SELECT id, mailbox_address, created_at')) {
          const id = String(bound[0]);
          const found = rows.find((r) => r.id === id);
          return (found ?? null) as unknown as T;
        }
        return null as unknown as T;
      },
      async run() {
        if (sql.includes('INSERT INTO mail_drafts')) {
          const [
            id,
            mailbox_address,
            to_addr,
            cc_addr,
            subject,
            text,
            reply_to_id,
            created_at,
            updated_at,
          ] = bound;
          rows.push({
            rowid: seq++,
            id: String(id),
            mailbox_address: String(mailbox_address),
            to_addr: String(to_addr),
            cc_addr: String(cc_addr),
            subject: String(subject),
            text: String(text),
            reply_to_id: reply_to_id === null ? null : String(reply_to_id),
            created_at: Number(created_at),
            updated_at: Number(updated_at),
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE mail_drafts')) {
          const [to_addr, cc_addr, subject, text, reply_to_id, updated_at, id, ...rest] = bound;
          const mailboxes = rest.map((b) => String(b).toLowerCase());
          let changes = 0;
          rows = rows.map((r) => {
            if (r.id === String(id) && mailboxes.includes(r.mailbox_address.toLowerCase())) {
              changes++;
              return {
                ...r,
                to_addr: String(to_addr),
                cc_addr: String(cc_addr),
                subject: String(subject),
                text: String(text),
                reply_to_id: reply_to_id === null ? null : String(reply_to_id),
                updated_at: Number(updated_at),
              };
            }
            return r;
          });
          return { meta: { changes } };
        }
        if (sql.includes('AND id NOT IN')) {
          const mailbox = String(bound[0]).toLowerCase();
          const limit = Number(bound[2]);
          const keptIds = new Set(
            rows
              .filter((r) => r.mailbox_address.toLowerCase() === mailbox)
              .sort((a, b) => b.updated_at - a.updated_at || b.rowid - a.rowid)
              .slice(0, limit)
              .map((r) => r.id)
          );
          const before = rows.length;
          rows = rows.filter(
            (r) => r.mailbox_address.toLowerCase() !== mailbox || keptIds.has(r.id)
          );
          return { meta: { changes: before - rows.length } };
        }
        if (sql.includes('DELETE FROM mail_drafts')) {
          const id = String(bound[0]);
          const mailboxes = bound.slice(1).map((b) => String(b).toLowerCase());
          const before = rows.length;
          rows = rows.filter(
            (r) => !(r.id === id && mailboxes.includes(r.mailbox_address.toLowerCase()))
          );
          return { meta: { changes: before - rows.length } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };

  return { prepare } as unknown as D1Database;
}

describe('mail drafts', () => {
  let db: D1Database;
  const alice = 'alice@aistockvn.com';
  const bob = 'bob@aistockvn.com';

  beforeEach(() => {
    db = createMockD1();
  });

  it('creates, fetches, updates, lists, and deletes a draft', async () => {
    const created = await upsertDraft(
      db,
      alice,
      [alice],
      { to: 'dest@example.com', subject: 'Hello', text: 'Draft body' },
      1000
    );

    expect(created.id).toBeTruthy();
    expect(created.subject).toBe('Hello');

    const fetched = await getDraft(db, created.id, [alice]);
    expect(fetched?.text).toBe('Draft body');

    const updated = await upsertDraft(
      db,
      alice,
      [alice],
      { id: created.id, to: 'dest@example.com', subject: 'Hello v2', text: 'Updated body' },
      2000
    );
    expect(updated.id).toBe(created.id);
    expect(updated.subject).toBe('Hello v2');
    expect(updated.updatedAt).toBe(2000);

    const list = await listDrafts(db, [alice]);
    expect(list).toHaveLength(1);

    const deleted = await deleteDraft(db, created.id, [alice]);
    expect(deleted).toBe(true);
    expect(await listDrafts(db, [alice])).toHaveLength(0);
  });

  it('rejects empty drafts with 400', async () => {
    await expect(
      upsertDraft(db, alice, [alice], { to: '   ', subject: '', text: '  ' }, 1000)
    ).rejects.toThrow(DraftError);

    try {
      await upsertDraft(db, alice, [alice], { cc: 'cc@example.com' }, 1000);
    } catch (err) {
      expect(err).toBeInstanceOf(DraftError);
      expect((err as DraftError).status).toBe(400);
    }
  });

  it('enforces max 5 drafts per mailbox by evicting the oldest updated_at', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= MAX_DRAFTS_PER_MAILBOX + 1; i++) {
      const d = await upsertDraft(
        db,
        alice,
        [alice],
        { subject: `Draft ${i}`, text: `Body ${i}` },
        i * 1000
      );
      ids.push(d.id);
    }

    const list = await listDrafts(db, [alice]);
    expect(list).toHaveLength(MAX_DRAFTS_PER_MAILBOX);
    expect(list.map((d) => d.subject)).toEqual([
      'Draft 6',
      'Draft 5',
      'Draft 4',
      'Draft 3',
      'Draft 2',
    ]);
    expect(await getDraft(db, ids[0], [alice])).toBeNull();
  });

  it('isolates drafts across mailboxes (other mailbox cannot read, update, or delete)', async () => {
    const aliceDraft = await upsertDraft(
      db,
      alice,
      [alice],
      { subject: 'Secret', text: 'Private' },
      1000
    );

    expect(await getDraft(db, aliceDraft.id, [bob])).toBeNull();
    expect(await listDrafts(db, [bob])).toHaveLength(0);
    expect(await deleteDraft(db, aliceDraft.id, [bob])).toBe(false);

    await expect(
      upsertDraft(
        db,
        bob,
        [bob],
        { id: aliceDraft.id, subject: 'Hijack', text: 'Nope' },
        2000
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  it('removes a draft when deleted by draftId after send', async () => {
    const draft = await upsertDraft(
      db,
      alice,
      [alice],
      { to: 'dest@example.com', subject: 'Ready', text: 'Send me' },
      1000
    );

    const removed = await deleteDraft(db, draft.id, [alice]);
    expect(removed).toBe(true);
    expect(await getDraft(db, draft.id, [alice])).toBeNull();
  });
});
