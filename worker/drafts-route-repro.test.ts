// Regression test for Bug 2 (GET /api/drafts 500 on live).
// Root cause: the drafts route block in worker/index.ts used a bare
// `method` variable that does not exist (the file uses `req.method`),
// so every drafts route threw ReferenceError and the top-level fetch
// handler returned 500 {"error":"Server error"}.
// This test calls the REAL worker fetch handler with a hand-rolled
// mock D1 and asserts GET /api/drafts returns 200 with {drafts: []}.
// Control: GET /api/session also returns 200 (same session +
// callerMailboxList setup). No node:sqlite needed: the bug is a pure
// ReferenceError at the route condition, before any D1 call.
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signSession } from './auth';
import worker from './index';
import type { Env } from './mail';

const SECRET = 's'.repeat(40);
const TEST_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=';
const ADMIN_EMAIL = 'admin@aistockvn.com';
const ALLOWED_EMAILS = [ADMIN_EMAIL].join(',');

function createMockD1(): D1Database {
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async all<T = unknown>() {
        if (sql.includes('FROM mailboxes')) {
          return {
            results: [{ address: ADMIN_EMAIL }] as unknown as T[],
          };
        }
        if (sql.includes('FROM external_accounts')) {
          return { results: [] as T[] };
        }
        if (sql.includes('FROM mail_drafts')) {
          return { results: [] as T[] };
        }
        return { results: [] as T[] };
      },
      async first<T = unknown>() {
        if (sql.includes('FROM users')) {
          return {
            role: 'super_admin',
            status: 'active',
          } as unknown as T;
        }
        return null as unknown as T;
      },
      async run() {
        return { success: true, meta: { changes: 0 } };
      },
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    RAW: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
      async head() {
        return null;
      },
    } as unknown as R2Bucket,
    ASSETS: {
      fetch: async () => new Response('Not found', { status: 404 }),
    } as unknown as Fetcher,
    MAILBOX_ADDRESS: ADMIN_EMAIL,
    FROM_NAME: 'AI Stock VN',
    ALLOWED_EMAILS,
    GOOGLE_CLIENT_ID: '',
    FORWARD_TO: '',
    RESEND_API_KEY: 're_test_dummy_key',
    ENCRYPTION_KEY: TEST_KEY_B64,
    SESSION_SECRET: SECRET,
  };
}

async function authedGet(email: string, path: string): Promise<Request> {
  const token = await signSession(email, SECRET);
  return new Request(`https://mail.aistockvn.com${path}`, {
    method: 'GET',
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  });
}

describe('Bug 2 regression: GET /api/drafts via worker fetch', () => {
  it('returns 200 with an empty drafts list (control /api/session also 200)', async () => {
    const env = makeEnv(createMockD1());
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const sessionRes = await worker.fetch(
      await authedGet(ADMIN_EMAIL, '/api/session'),
      env,
    );
    expect(sessionRes.status).toBe(200);

    const res = await worker.fetch(
      await authedGet(ADMIN_EMAIL, '/api/drafts'),
      env,
    );
    const bodyText = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(bodyText)).toEqual({ drafts: [] });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
