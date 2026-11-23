// worker/observability.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminError, type AdminEnv } from './admin';
import type { Env } from './mail';
import {
  BACKUP_EVENTS,
  logEvent,
  reportClientError,
  safeLogText,
} from './observability';

interface StoredClientErrorRow {
  id: string;
  crash_id: string;
  mailbox_hash: string;
  message: string;
  stack: string;
  url: string;
  user_agent: string;
  created_at: number;
}

function createMockObservabilityD1() {
  const clientErrors: StoredClientErrorRow[] = [];

  const db = {
    prepare(sql: string) {
      let boundArgs: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          boundArgs = args;
          return stmt;
        },
        async first<T = unknown>(): Promise<T | null> {
          if (sql.includes('FROM client_errors')) {
            return (clientErrors[0] as unknown as T) ?? null;
          }
          return null;
        },
        async all<T = unknown>(): Promise<{ results: T[] }> {
          if (sql.includes('FROM client_errors')) {
            return { results: clientErrors as unknown as T[] };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT INTO client_errors')) {
            const [
              id,
              crash_id,
              mailbox_hash,
              message,
              stack,
              url,
              user_agent,
              created_at,
            ] = boundArgs;
            clientErrors.push({
              id: String(id),
              crash_id: String(crash_id),
              mailbox_hash: String(mailbox_hash),
              message: String(message),
              stack: String(stack),
              url: String(url),
              user_agent: String(user_agent),
              created_at: Number(created_at),
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };

  return {
    db: db as unknown as D1Database,
    clientErrors,
  };
}

describe('observability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('safeLogText', () => {
    it('cuts long strings to maxLen (default 200)', () => {
      const input = 'x'.repeat(350);
      const out = safeLogText(input);
      expect(out.length).toBe(200);
      expect(out).toBe('x'.repeat(200));

      expect(safeLogText('abcdef', 4)).toBe('abcd');
    });

    it('replaces newlines, tabs, and control chars < 0x20 with single spaces', () => {
      const input = 'hello\nworld\rfoo\tbar\x00baz\x1fend';
      expect(safeLogText(input)).toBe('hello world foo bar baz end');
    });

    it('never throws for undefined, null, numbers, objects, or circular values', () => {
      expect(() => safeLogText(undefined)).not.toThrow();
      expect(safeLogText(undefined)).toBe('undefined');
      expect(safeLogText(null)).toBe('null');
      expect(safeLogText(12345)).toBe('12345');
      expect(safeLogText({ a: 1, b: 'two' })).toBe('{"a":1,"b":"two"}');

      const circular: Record<string, unknown> = { name: 'loop' };
      circular.self = circular;
      expect(() => safeLogText(circular)).not.toThrow();
      expect(typeof safeLogText(circular)).toBe('string');
    });
  });

  describe('logEvent', () => {
    const fakeEnv = {} as unknown as Env;

    it('writes exactly one single-line JSON string with event and ts', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logEvent(fakeEnv, BACKUP_EVENTS.BACKUP_STARTED, { trigger: 'manual', count: 3 });

      expect(spy).toHaveBeenCalledTimes(1);
      const rawLine = String(spy.mock.calls[0][0]);
      expect(rawLine.includes('\n')).toBe(false);

      const parsed = JSON.parse(rawLine) as Record<string, unknown>;
      expect(parsed.event).toBe('backup_started');
      expect(typeof parsed.ts).toBe('number');
      expect(parsed.trigger).toBe('manual');
      expect(parsed.count).toBe(3);
    });

    it('drops forbidden keys both top-level and nested, and drops raw mailbox while keeping mailboxHash', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logEvent(fakeEnv, BACKUP_EVENTS.INGEST_FAILED, {
        password: 'pw',
        appPassword: 'apw',
        app_password: 'apw2',
        token: 'tok',
        secret: 'sec',
        authorization: 'Bearer xyz',
        cookie: 'sid=123',
        subject: 'Private subject',
        body: 'Private body',
        text_body: 'txt',
        html_body: '<p>html</p>',
        attachment: 'file.pdf',
        snippet: 'preview',
        raw_key: 'r2/key',
        resend_id: 're_123',
        mailbox: 'alice@example.com',
        mailboxHash: 'a'.repeat(64),
        nested: {
          token: 'nested-secret',
          subject: 'nested-subject',
          safeField: 'ok',
        },
      });

      expect(spy).toHaveBeenCalledTimes(1);
      const rawLine = String(spy.mock.calls[0][0]);
      const parsed = JSON.parse(rawLine) as Record<string, unknown>;

      expect(parsed.password).toBeUndefined();
      expect(parsed.appPassword).toBeUndefined();
      expect(parsed.app_password).toBeUndefined();
      expect(parsed.token).toBeUndefined();
      expect(parsed.secret).toBeUndefined();
      expect(parsed.authorization).toBeUndefined();
      expect(parsed.cookie).toBeUndefined();
      expect(parsed.subject).toBeUndefined();
      expect(parsed.body).toBeUndefined();
      expect(parsed.text_body).toBeUndefined();
      expect(parsed.html_body).toBeUndefined();
      expect(parsed.attachment).toBeUndefined();
      expect(parsed.snippet).toBeUndefined();
      expect(parsed.raw_key).toBeUndefined();
      expect(parsed.resend_id).toBeUndefined();
      expect(parsed.mailbox).toBeUndefined();
      expect(parsed.mailboxHash).toBe('a'.repeat(64));

      const nested = parsed.nested as Record<string, unknown>;
      expect(nested.token).toBeUndefined();
      expect(nested.subject).toBeUndefined();
      expect(nested.safeField).toBe('ok');
      expect(rawLine).not.toContain('alice@example.com');
      expect(rawLine).not.toContain('Private subject');
    });

    it('truncates string values longer than 200 chars via safeLogText', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logEvent(fakeEnv, BACKUP_EVENTS.BACKUP_FAILED, {
        reason: 'e'.repeat(300) + '\ntrailing',
      });

      const parsed = JSON.parse(String(spy.mock.calls[0][0])) as Record<string, unknown>;
      expect(typeof parsed.reason).toBe('string');
      expect((parsed.reason as string).length).toBeLessThanOrEqual(200);
    });

    it('never throws even when console.log throws or fields contain circular references', () => {
      vi.spyOn(console, 'log').mockImplementationOnce(() => {
        throw new Error('stdout broken');
      });

      expect(() =>
        logEvent(fakeEnv, BACKUP_EVENTS.API_UNHANDLED_ERROR, { status: 500 }),
      ).not.toThrow();

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      spy.mockClear();
      const circular: Record<string, unknown> = { label: 'node' };
      circular.self = circular;

      expect(() =>
        logEvent(fakeEnv, BACKUP_EVENTS.API_UNHANDLED_ERROR, { circular }),
      ).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('reportClientError', () => {
    it('throws AdminError 400 when crashId is missing, empty, or non-object body', async () => {
      const { db } = createMockObservabilityD1();
      const env: AdminEnv = { DB: db };

      await expect(
        reportClientError(env, 'user@example.com', {}),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_crash_id' });

      await expect(
        reportClientError(env, 'user@example.com', { crashId: '   ' }),
      ).rejects.toBeInstanceOf(AdminError);

      await expect(
        reportClientError(env, 'user@example.com', null),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_crash_id' });
    });

    it('throws AdminError 400 when crashId exceeds 64 chars', async () => {
      const { db } = createMockObservabilityD1();
      const env: AdminEnv = { DB: db };

      await expect(
        reportClientError(env, 'user@example.com', { crashId: 'c'.repeat(65) }),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_crash_id' });
    });

    it('drops unknown fields, hashes mailbox to 64-char hex, truncates long fields, stores row, and logs client_error_received', async () => {
      const { db, clientErrors } = createMockObservabilityD1();
      const env: AdminEnv = { DB: db };
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const rawMailbox = 'henrry@aistockvn.com';
      const result = await reportClientError(env, rawMailbox, {
        crashId: 'crash-001',
        message: 'm'.repeat(650),
        stack: 's'.repeat(4500),
        url: 'https://example.com' + 'u'.repeat(600),
        userAgent: 'Mozilla/5.0 ' + 'a'.repeat(600),
        subject: 'Secret email subject',
        token: 'secret-session-token',
        body: 'Secret email body',
      });

      expect(result).toEqual({ ok: true, crashId: 'crash-001' });
      expect(clientErrors).toHaveLength(1);

      const stored = clientErrors[0];
      expect(stored.id.length).toBeGreaterThan(0);
      expect(stored.crash_id).toBe('crash-001');
      expect(stored.mailbox_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(stored.mailbox_hash).not.toBe(rawMailbox);
      expect(stored.message.length).toBe(500);
      expect(stored.stack.length).toBe(4000);
      expect(stored.url.length).toBe(500);
      expect(stored.user_agent.length).toBe(500);
      expect(typeof stored.created_at).toBe('number');

      const serializedRow = JSON.stringify(stored);
      expect(serializedRow).not.toContain('Secret email subject');
      expect(serializedRow).not.toContain('secret-session-token');
      expect(serializedRow).not.toContain('Secret email body');
      expect(serializedRow).not.toContain(rawMailbox);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(String(logSpy.mock.calls[0][0])) as Record<string, unknown>;
      expect(logged.event).toBe('client_error_received');
      expect(logged.crashId).toBe('crash-001');
    });
  });
});
