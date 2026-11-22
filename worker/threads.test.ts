import { describe, it, expect, beforeEach } from 'vitest';
import {
  listThreads,
  getThread,
  applyBatch,
  validateBatchIds,
  resolveThreadRoot,
  parentCandidatesOf,
  threadKeyOf,
  ThreadsError,
  BatchError,
  MAX_BATCH_IDS,
  type ThreadMessageRow,
} from './threads';

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
      async all<T = unknown>(): Promise<{ results: T[] }> {
        if (sql.includes('folder = ? AND date < ?')) {
          const folder = String(bound[0]);
          const before = Number(bound[1]);
          const mailboxes = bound.slice(2).map((b) => String(b).toLowerCase());
          const results = rows
            .filter(
              (r) =>
                r.folder === folder &&
                r.date < before &&
                mailboxes.includes(r.mailbox_address.toLowerCase())
            )
            .sort((a, b) => b.date - a.date);
          return { results: results as unknown as T[] };
        }
        if (sql.includes('ORDER BY date ASC')) {
          const mailboxes = bound.map((b) => String(b).toLowerCase());
          const results = rows
            .filter((r) => mailboxes.includes(r.mailbox_address.toLowerCase()))
            .sort((a, b) => a.date - b.date);
          return { results: results as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      async run(): Promise<{ meta: { changes: number } }> {
        if (sql.includes('UPDATE messages SET')) {
          const idMatch = sql.match(/id IN \(([^)]*)\)/);
          const idCount = idMatch ? (idMatch[1].match(/\?/g) ?? []).length : 0;
          const ids = bound.slice(0, idCount).map((v) => String(v));
          const mailboxes = bound.slice(idCount).map((b) => String(b).toLowerCase());
          let changes = 0;
          rows = rows.map((r) => {
            if (!ids.includes(r.id) || !mailboxes.includes(r.mailbox_address.toLowerCase())) {
              return r;
            }
            changes++;
            if (sql.includes('is_read = 1')) return { ...r, is_read: 1 };
            if (sql.includes('is_read = 0')) return { ...r, is_read: 0 };
            if (sql.includes('is_starred = 1')) return { ...r, is_starred: 1 };
            if (sql.includes('is_starred = 0')) return { ...r, is_starred: 0 };
            if (sql.includes("folder = 'spam'")) return { ...r, folder: 'spam' };
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

describe('thread view', () => {
  const alice = 'alice@aistockvn.com';
  const bob = 'bob@aistockvn.com';
  let store: ReturnType<typeof createMockD1>;

  beforeEach(() => {
    store = createMockD1();
  });

  it('groups a parent/child/grandchild chain via in_reply_to under the root message_id', async () => {
    store = createMockD1([
      makeRow({ id: 'root', message_id: 'root-1', subject: 'Thread', date: 1000 }),
      makeRow({
        id: 'child',
        message_id: 'child-1',
        in_reply_to: 'root-1',
        subject: 'Re: Thread',
        date: 2000,
        is_read: 0,
        from_addr: bob,
      }),
      makeRow({
        id: 'grand',
        message_id: 'grand-1',
        in_reply_to: 'child-1',
        subject: 'Re: Thread',
        date: 3000,
        is_read: 0,
      }),
    ]);

    const threads = await listThreads(store.db, [alice], 'inbox');
    expect(threads).toHaveLength(1);
    const thread = threads[0];
    expect(thread.threadKey).toBe('root-1');
    expect(thread.count).toBe(3);
    expect(thread.unreadCount).toBe(2);
    expect(thread.latestDate).toBe(3000);
    expect(thread.latestId).toBe('grand');
    expect(thread.ids).toEqual(expect.arrayContaining(['root', 'child', 'grand']));
    expect(thread.participants).toEqual(expect.arrayContaining([alice, bob]));
  });

  it('groups a reply that only carries references_hdr', async () => {
    store = createMockD1([
      makeRow({ id: 'root2', message_id: 'root-2', subject: 'Refs thread', date: 1000 }),
      makeRow({
        id: 'reply2',
        message_id: 'reply2-1',
        references_hdr: 'root-2',
        subject: 'Re: Refs thread',
        date: 2000,
      }),
      makeRow({
        id: 'reply3',
        message_id: 'reply3-1',
        references_hdr: '<other@example.com> <root-2>',
        subject: 'Re: Refs thread',
        date: 3000,
      }),
    ]);

    const threads = await listThreads(store.db, [alice], 'inbox');
    expect(threads).toHaveLength(1);
    expect(threads[0].threadKey).toBe('root-2');
    expect(threads[0].count).toBe(3);
  });

  it('keeps unrelated roots in separate threads and sorts by latest activity', async () => {
    store = createMockD1([
      makeRow({ id: 'a1', message_id: 'a-root', subject: 'A', date: 1000 }),
      makeRow({ id: 'a2', message_id: 'a-child', in_reply_to: 'a-root', subject: 'A', date: 5000 }),
      makeRow({ id: 'b1', message_id: 'b-root', subject: 'B', date: 2000 }),
      makeRow({ id: 'b2', message_id: 'b-child', in_reply_to: 'b-root', subject: 'B', date: 4000 }),
    ]);

    const threads = await listThreads(store.db, [alice], 'inbox');
    expect(threads).toHaveLength(2);
    expect(threads[0].threadKey).toBe('a-root');
    expect(threads[0].latestDate).toBe(5000);
    expect(threads[1].threadKey).toBe('b-root');
    expect(threads[1].latestDate).toBe(4000);
  });

  it('scopes threads to the caller mailbox and folder', async () => {
    store = createMockD1([
      makeRow({ id: 'mine', message_id: 'mine-1', subject: 'Mine', date: 1000 }),
      makeRow({
        id: 'theirs',
        message_id: 'theirs-1',
        subject: 'Theirs',
        date: 2000,
        mailbox_address: bob,
        from_addr: bob,
      }),
      makeRow({
        id: 'sent',
        message_id: 'sent-1',
        subject: 'Sent',
        folder: 'sent',
        date: 3000,
      }),
    ]);

    const inboxThreads = await listThreads(store.db, [alice], 'inbox');
    expect(inboxThreads.map((t) => t.threadKey)).toEqual(['mine-1']);

    const sentThreads = await listThreads(store.db, [alice], 'sent');
    expect(sentThreads.map((t) => t.threadKey)).toEqual(['sent-1']);

    const bobThreads = await listThreads(store.db, [bob], 'inbox');
    expect(bobThreads.map((t) => t.threadKey)).toEqual(['theirs-1']);
  });

  it('returns the whole thread oldest-first and 400 on an empty key', async () => {
    store = createMockD1([
      makeRow({ id: 'root', message_id: 'root-1', subject: 'Thread', date: 1000 }),
      makeRow({ id: 'child', message_id: 'child-1', in_reply_to: 'root-1', date: 2000 }),
      makeRow({ id: 'other', message_id: 'other-1', subject: 'Other', date: 1500 }),
    ]);

    const messages = await getThread(store.db, [alice], 'root-1');
    expect(messages.map((m) => m.id)).toEqual(['root', 'child']);

    await expect(getThread(store.db, [alice], '')).rejects.toMatchObject({
      name: 'ThreadsError',
      status: 400,
    });
    try {
      await getThread(store.db, [alice], '');
    } catch (err) {
      expect(err).toBeInstanceOf(ThreadsError);
    }
  });

  it('resolveThreadRoot walks in_reply_to then references_hdr', () => {
    const rows: ThreadMessageRow[] = [
      makeRow({ id: 'root', message_id: 'root-1' }),
      makeRow({ id: 'mid', message_id: 'mid-1', in_reply_to: 'root-1' }),
      makeRow({ id: 'leaf', message_id: 'leaf-1', references_hdr: 'root-1 mid-1' }),
    ];
    const byId = new Map<string, ThreadMessageRow>();
    for (const row of rows) {
      byId.set(row.message_id as string, row);
      byId.set(row.id, row);
    }

    expect(threadKeyOf(resolveThreadRoot(rows[2], byId))).toBe('root-1');
    expect(parentCandidatesOf(rows[2])).toEqual(['mid-1', 'root-1']);
  });
});

describe('batch operations', () => {
  const alice = 'alice@aistockvn.com';
  const bob = 'bob@aistockvn.com';
  let store: ReturnType<typeof createMockD1>;

  beforeEach(() => {
    store = createMockD1([
      makeRow({ id: 'm1', subject: 'One', date: 1000 }),
      makeRow({ id: 'm2', subject: 'Two', date: 2000 }),
      makeRow({
        id: 'b1',
        subject: 'Bob',
        date: 3000,
        mailbox_address: bob,
        from_addr: bob,
        is_read: 0,
      }),
    ]);
  });

  it('rejects more than 50 ids with 400', async () => {
    const ids = Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => `id-${i}`);
    await expect(applyBatch(store.db, [alice], ids, 'read')).rejects.toMatchObject({
      name: 'BatchError',
      status: 400,
    });
    expect(() => validateBatchIds(ids)).toThrow(BatchError);
    expect(validateBatchIds(ids.slice(0, MAX_BATCH_IDS))).toHaveLength(MAX_BATCH_IDS);
  });

  it('rejects empty id lists and unknown actions with 400', async () => {
    await expect(applyBatch(store.db, [alice], [], 'read')).rejects.toMatchObject({ status: 400 });
    await expect(applyBatch(store.db, [alice], ['m1'], 'nope' as never)).rejects.toMatchObject({
      status: 400,
    });
    await expect(applyBatch(store.db, [alice], 'm1' as never, 'read')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('spam action moves the caller messages to the spam folder', async () => {
    const result = await applyBatch(store.db, [alice], ['m1', 'm2'], 'spam');
    expect(result).toEqual({ updated: 2 });
    expect(store.rows().find((r) => r.id === 'm1')?.folder).toBe('spam');
    expect(store.rows().find((r) => r.id === 'm2')?.folder).toBe('spam');
  });

  it('star/unstar and read/unread update the expected flags', async () => {
    await applyBatch(store.db, [alice], ['m1'], 'star');
    expect(store.rows().find((r) => r.id === 'm1')?.is_starred).toBe(1);

    await applyBatch(store.db, [alice], ['m1'], 'unstar');
    expect(store.rows().find((r) => r.id === 'm1')?.is_starred).toBe(0);

    await applyBatch(store.db, [alice], ['m1'], 'unread');
    expect(store.rows().find((r) => r.id === 'm1')?.is_read).toBe(0);

    await applyBatch(store.db, [alice], ['m1'], 'read');
    expect(store.rows().find((r) => r.id === 'm1')?.is_read).toBe(1);
  });

  it('skips ids of another mailbox and unknown ids without failing the batch', async () => {
    const result = await applyBatch(store.db, [alice], ['m1', 'b1', 'ghost'], 'read');
    expect(result).toEqual({ updated: 1 });
    expect(store.rows().find((r) => r.id === 'm1')?.is_read).toBe(1);
    expect(store.rows().find((r) => r.id === 'b1')?.is_read).toBe(0);
  });
});
