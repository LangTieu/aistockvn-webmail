import { describe, it, expect, beforeEach } from 'vitest';
import {
  setStarred,
  listStarred,
  normalizeStarredLimit,
  StarredError,
  MAX_STARRED_LIMIT,
} from './starred';

interface MsgRow {
  id: string;
  message_id: string | null;
  in_reply_to: string | null;
  references_hdr: string | null;
  folder: string;
  mailbox_address: string;
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
  is_focused: number;
  is_starred: number;
  attachments: string;
}

function makeRow(partial: Partial<MsgRow> & { id: string }): MsgRow {
  return {
    message_id: null,
    in_reply_to: null,
    references_hdr: null,
    folder: 'inbox',
    mailbox_address: 'alice@aistockvn.com',
    from_addr: 'alice@aistockvn.com',
    from_name: 'Alice',
    to_addrs: '[]',
    cc_addrs: '[]',
    reply_to: null,
    subject: '(No subject)',
    snippet: '',
    text_body: '',
    html_body: null,
    date: 0,
    is_read: 1,
    is_focused: 1,
    is_starred: 0,
    attachments: '[]',
    ...partial,
  };
}

function createMockD1(initial: MsgRow[] = []) {
  let rows: MsgRow[] = initial.map((r) => ({ ...r }));

  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async first<T = unknown>(): Promise<T> {
        if (sql.includes('SELECT id, mailbox_address FROM messages WHERE id = ?')) {
          const id = String(bound[0]);
          return (rows.find((r) => r.id === id) ?? null) as unknown as T;
        }
        return null as unknown as T;
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        if (sql.includes('is_starred = 1 AND date < ?')) {
          const before = Number(bound[0]);
          const mailboxes = bound.slice(1).map((b) => String(b).toLowerCase());
          const limitMatch = sql.match(/LIMIT (\d+)/);
          const limit = limitMatch ? Number(limitMatch[1]) : undefined;
          const results = rows
            .filter(
              (r) =>
                r.is_starred === 1 &&
                r.date < before &&
                mailboxes.includes(r.mailbox_address.toLowerCase())
            )
            .sort((a, b) => b.date - a.date)
            .slice(0, limit);
          return { results: results as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      async run(): Promise<{ meta: { changes: number } }> {
        if (sql.includes('UPDATE messages SET is_starred = ?')) {
          const starred = bound[0];
          const id = String(bound[1]);
          const mailboxes = bound.slice(2).map((b) => String(b).toLowerCase());
          let changes = 0;
          rows = rows.map((r) => {
            if (r.id === id && mailboxes.includes(r.mailbox_address.toLowerCase())) {
              changes++;
              return { ...r, is_starred: Number(starred) };
            }
            return r;
          });
          return { meta: { changes } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };

  return { db: { prepare } as unknown as D1Database, rows: () => rows };
}

describe('starred messages', () => {
  const alice = 'alice@aistockvn.com';
  const bob = 'bob@aistockvn.com';
  let store: ReturnType<typeof createMockD1>;

  beforeEach(() => {
    store = createMockD1([
      makeRow({ id: 'm1', subject: 'Starred inbox', date: 3000 }),
      makeRow({ id: 'm2', subject: 'Plain inbox', date: 2000 }),
      makeRow({
        id: 'm3',
        subject: 'Starred sent',
        folder: 'sent',
        date: 1000,
        is_starred: 1,
      }),
      makeRow({
        id: 'm4',
        subject: 'Bob starred',
        mailbox_address: bob,
        from_addr: bob,
        date: 500,
        is_starred: 1,
      }),
    ]);
  });

  it('stars and unstars a message owned by the caller', async () => {
    const starred = await setStarred(store.db, [alice], 'm1', true);
    expect(starred).toEqual({ id: 'm1', is_starred: true });
    expect(store.rows().find((r) => r.id === 'm1')?.is_starred).toBe(1);

    const unstarred = await setStarred(store.db, [alice], 'm1', false);
    expect(unstarred).toEqual({ id: 'm1', is_starred: false });
    expect(store.rows().find((r) => r.id === 'm1')?.is_starred).toBe(0);
  });

  it('returns 404 when starring a message of another mailbox', async () => {
    await expect(setStarred(store.db, [alice], 'm4', true)).rejects.toMatchObject({
      name: 'StarredError',
      status: 404,
    });

    try {
      await setStarred(store.db, [alice], 'm4', true);
    } catch (err) {
      expect(err).toBeInstanceOf(StarredError);
      expect((err as StarredError).status).toBe(404);
    }

    expect(store.rows().find((r) => r.id === 'm4')?.is_starred).toBe(1);
  });

  it('returns 404 for an unknown message id', async () => {
    await expect(setStarred(store.db, [alice], 'nope', true)).rejects.toMatchObject({
      status: 404,
    });
    await expect(setStarred(store.db, [alice], '', true)).rejects.toMatchObject({ status: 404 });
  });

  it('GET /api/messages?starred=1 returns only the caller starred messages across folders', async () => {
    await setStarred(store.db, [alice], 'm1', true);

    const rows = await listStarred(store.db, [alice]);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('m1');
    expect(ids).toContain('m3');
    expect(ids).not.toContain('m2');
    expect(ids).not.toContain('m4');
    expect(rows.every((r) => r.is_starred === 1)).toBe(true);
  });

  it('lists starred messages newest first and scopes by mailbox', async () => {
    await setStarred(store.db, [alice], 'm1', true);
    const rows = await listStarred(store.db, [alice]);
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm3']);

    const bobRows = await listStarred(store.db, [bob]);
    expect(bobRows.map((r) => r.id)).toEqual(['m4']);
  });

  it('paginates starred messages with before/limit', async () => {
    await setStarred(store.db, [alice], 'm1', true);
    // The module asks the DB for limit + 1 rows so the route can detect a next page.
    const firstPage = await listStarred(store.db, [alice], Number.MAX_SAFE_INTEGER, 1);
    expect(firstPage.map((r) => r.id)).toEqual(['m1', 'm3']);

    const secondPage = await listStarred(store.db, [alice], firstPage[0].date, 1);
    expect(secondPage.map((r) => r.id)).toEqual(['m3']);
  });

  it('normalizes the starred limit to the allowed range', () => {
    expect(normalizeStarredLimit(0)).toBe(30);
    expect(normalizeStarredLimit(-5)).toBe(30);
    expect(normalizeStarredLimit(Number.NaN)).toBe(30);
    expect(normalizeStarredLimit(5)).toBe(5);
    expect(normalizeStarredLimit(10_000)).toBe(MAX_STARRED_LIMIT);
  });
});
