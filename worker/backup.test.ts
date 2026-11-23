// worker/backup.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// backup.ts imports WorkflowEntrypoint from "cloudflare:workers", which does
// not resolve under the node test environment. Stub it: the tests exercise
// the module functions, never the Workflow class itself.
vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import {
  BackupError,
  exportD1SnapshotToBackup,
  getBackupSettings,
  isSkippedBackupTable,
  sqlLiteral,
  updateBackupSettings,
  runBackup,
  downloadBackupObject,
  getBackupStats,
} from "./backup";
import type { Env } from "./mail";
import worker, {
  isBackupWindow,
  vnDayStartMs,
  maybeTriggerScheduledBackup,
} from "./index";

interface AdminSettingRow {
  key: string;
  value: string;
  updated_at: number;
}

interface BackupRunRow {
  id: string;
  trigger: "manual" | "cron";
  status: "running" | "succeeded" | "failed";
  started_at: number;
  finished_at: number | null;
  d1_object_key: string;
  d1_size: number;
  r2_copied: number;
  r2_errors: number;
  error: string;
}

interface UserRow {
  id: string;
  email: string;
  role: string;
  status: string;
}

interface AuditLogEntry {
  sql: string;
  args: unknown[];
}

function createMockD1() {
  const adminSettings: AdminSettingRow[] = [];
  const backupRuns: BackupRunRow[] = [];
  const users: UserRow[] = [
    { id: "u-super", email: "super@aistockvn.com", role: "super_admin", status: "active" },
    { id: "u-admin", email: "admin@aistockvn.com", role: "admin", status: "active" },
  ];
  const auditLogs: AuditLogEntry[] = [];

  const sortNewestFirst = (rows: BackupRunRow[]) =>
    [...rows].sort((a, b) => {
      if (b.started_at !== a.started_at) return b.started_at - a.started_at;
      return b.id.localeCompare(a.id);
    });

  const sortOldestFirst = (rows: BackupRunRow[]) =>
    [...rows].sort((a, b) => a.started_at - b.started_at);

  const db = {
    prepare(sql: string) {
      let boundArgs: unknown[] = [];

      const runQuery = async () => {
        const norm = sql.replace(/\s+/g, " ").trim();

        if (norm.includes("INSERT INTO admin_settings") || norm.includes("REPLACE INTO admin_settings")) {
          const key = String(boundArgs[0] ?? "");
          const value = String(boundArgs[1] ?? "");
          const updatedAt = Number(boundArgs[2] ?? 0);
          const idx = adminSettings.findIndex((r) => r.key === key);
          if (idx >= 0) {
            adminSettings[idx] = { key, value, updated_at: updatedAt };
          } else {
            adminSettings.push({ key, value, updated_at: updatedAt });
          }
          return { success: true, meta: { changes: 1 } };
        }

        if (norm.includes("INSERT INTO backup_runs")) {
          const id = String(boundArgs[0]);
          const trigger = boundArgs[1] as "manual" | "cron";
          const hasExplicitStatus = boundArgs.length >= 4 && (boundArgs[2] === "running" || boundArgs[2] === "succeeded" || boundArgs[2] === "failed");
          const status = hasExplicitStatus ? (boundArgs[2] as "running" | "succeeded" | "failed") : "running";
          const startedAt = Number(hasExplicitStatus ? boundArgs[3] : boundArgs[2]);
          backupRuns.push({
            id,
            trigger,
            status,
            started_at: startedAt,
            finished_at: null,
            d1_object_key: "",
            d1_size: 0,
            r2_copied: 0,
            r2_errors: 0,
            error: "",
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (norm.includes("UPDATE backup_runs")) {
          const id = String(boundArgs[boundArgs.length - 1]);
          const row = backupRuns.find((r) => r.id === id);
          if (row) {
            if (norm.includes("status = 'succeeded'") || boundArgs[0] === "succeeded") {
              const offset = boundArgs[0] === "succeeded" ? 1 : 0;
              row.status = "succeeded";
              row.finished_at = Number(boundArgs[offset]);
              row.d1_object_key = String(boundArgs[offset + 1] ?? "");
              row.d1_size = Number(boundArgs[offset + 2] ?? 0);
              row.r2_copied = Number(boundArgs[offset + 3] ?? 0);
              row.r2_errors = Number(boundArgs[offset + 4] ?? 0);
              if (boundArgs.length - 1 > offset + 5) {
                row.error = String(boundArgs[offset + 5] ?? "");
              }
            } else if (norm.includes("status = 'failed'") || boundArgs[0] === "failed") {
              const offset = boundArgs[0] === "failed" ? 1 : 0;
              row.status = "failed";
              row.finished_at = Number(boundArgs[offset]);
              row.error = String(boundArgs[offset + 1] ?? "");
            }
          }
          return { success: true, meta: { changes: row ? 1 : 0 } };
        }

        if (norm.startsWith("INSERT")) {
          auditLogs.push({ sql: norm, args: [...boundArgs] });
          return { success: true, meta: { changes: 1 } };
        }

        return { success: true, meta: { changes: 0 } };
      };

      const allQuery = async <T = unknown>() => {
        const norm = sql.replace(/\s+/g, " ").trim();

        if (norm.includes("FROM admin_settings")) {
          return { results: adminSettings.map((r) => ({ ...r })) as unknown as T[] };
        }

        if (norm.includes("FROM backup_runs") && norm.includes("GROUP BY status")) {
          const cutoff = Number(boundArgs[0] ?? 0);
          const counts = new Map<string, number>();
          for (const r of backupRuns) {
            if (r.started_at >= cutoff) {
              counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
            }
          }
          const results = Array.from(counts.entries()).map(([status, count]) => ({
            status,
            count,
          }));
          return { results: results as unknown as T[] };
        }

        if (norm.includes("FROM backup_runs")) {
          let rows = norm.includes("ORDER BY started_at ASC")
            ? sortOldestFirst(backupRuns)
            : sortNewestFirst(backupRuns);

          if (norm.includes("WHERE started_at < ?")) {
            const before = Number(boundArgs[0]);
            const limit = Number(boundArgs[1] ?? 50);
            rows = rows.filter((r) => r.started_at < before).slice(0, limit);
          } else if (norm.includes("WHERE started_at >= ?")) {
            const cutoff = Number(boundArgs[0]);
            rows = rows.filter((r) => r.started_at >= cutoff);
          } else if (norm.includes("LIMIT ?")) {
            const limit = Number(boundArgs[boundArgs.length - 1] ?? 50);
            rows = rows.slice(0, limit);
          }

          return { results: rows.map((r) => ({ ...r })) as unknown as T[] };
        }

        if (norm.includes("FROM users")) {
          return { results: users.map((u) => ({ ...u })) as unknown as T[] };
        }

        return { results: [] as T[] };
      };

      const firstQuery = async <T = unknown>(colName?: string) => {
        const norm = sql.replace(/\s+/g, " ").trim();

        if (norm.includes("FROM users")) {
          const email = String(boundArgs[0] ?? "").toLowerCase();
          const found = users.find((u) => u.email.toLowerCase() === email) ?? null;
          if (!found) return null;
          if (colName) return (found as unknown as Record<string, unknown>)[colName] as T;
          return { ...found } as unknown as T;
        }

        if (norm.includes("FROM admin_settings")) {
          const key = String(boundArgs[0] ?? "");
          const found = adminSettings.find((r) => r.key === key) ?? null;
          if (!found) return null;
          if (colName) return (found as unknown as Record<string, unknown>)[colName] as T;
          return { ...found } as unknown as T;
        }

        if (norm.includes("FROM backup_runs")) {
          if (norm.includes("WHERE id = ?")) {
            const id = String(boundArgs[0] ?? "");
            const found = backupRuns.find((r) => r.id === id) ?? null;
            return found ? ({ ...found } as unknown as T) : null;
          }

          if (norm.includes("status = 'running'")) {
            const threshold = Number(boundArgs[0] ?? 0);
            const active = sortNewestFirst(backupRuns).find(
              (r) => r.status === "running" && r.started_at >= threshold && r.started_at > threshold - 1,
            );
            return active ? ({ ...active } as unknown as T) : null;
          }

          if (norm.includes("status = 'succeeded'")) {
            const lastOk = sortNewestFirst(backupRuns).find((r) => r.status === "succeeded") ?? null;
            return lastOk ? ({ ...lastOk } as unknown as T) : null;
          }

          if (norm.includes("COUNT(*)")) {
            const statusFilterMatch = norm.match(/status = '(succeeded|failed)'/);
            const cutoff = Number(boundArgs[0] ?? 0);
            const filtered = backupRuns.filter(
              (r) =>
                r.started_at >= cutoff &&
                (!statusFilterMatch || r.status === statusFilterMatch[1]),
            );
            const row = { count: filtered.length, total: filtered.length };
            if (colName) return (row as Record<string, unknown>)[colName] as T;
            return row as unknown as T;
          }

          const newest = sortNewestFirst(backupRuns)[0] ?? null;
          return newest ? ({ ...newest } as unknown as T) : null;
        }

        return null;
      };

      const stmt = {
        bind(...args: unknown[]) {
          boundArgs = args;
          return stmt;
        },
        run: runQuery,
        all: allQuery,
        first: firstQuery,
      };

      return stmt;
    },
  };

  return {
    db: db as unknown as D1Database,
    adminSettings,
    backupRuns,
    users,
    auditLogs,
  };
}

interface StoredR2Item {
  body: string | Uint8Array;
  uploaded: Date;
  size: number;
}

async function readBodyToBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (value && typeof value === "object" && "getReader" in value) {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (chunk) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged;
  }
  if (value && typeof value === "object" && "body" in value) {
    return readBodyToBytes((value as { body: unknown }).body);
  }
  return new TextEncoder().encode(String(value ?? ""));
}
function createMockR2() {
  const store = new Map<string, StoredR2Item>();
  const put = vi.fn(async (key: string, value: unknown, opts?: { uploaded?: Date }) => {
    const bytes = await readBodyToBytes(value);
    const item: StoredR2Item = {
      body: bytes,
        uploaded: opts?.uploaded ?? new Date(),
        size: bytes.byteLength,
    };
    store.set(key, item);
    return { key, size: item.size, uploaded: item.uploaded };
  });
  const get = vi.fn(async (key: string) => {
    const item = store.get(key);
    if (!item) return null;
    const bytes = typeof item.body === "string" ? new TextEncoder().encode(item.body) : item.body;
    const text = new TextDecoder().decode(bytes);
    return {
      key,
        size: item.size,
        uploaded: item.uploaded,
        body: text,
        text: async () => text,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  });
  const del = vi.fn(async (keys: string | string[]) => {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      store.delete(k);
    }
  });
  const list = vi.fn(async (opts?: { prefix?: string; limit?: number; cursor?: string }) => {
    const prefix = opts?.prefix ?? "";
    const limit = opts?.limit ?? 1000;
    const startIdx = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    const matchingKeys = Array.from(store.keys())
      .filter((k) => k.startsWith(prefix))
      .sort();
    const slice = matchingKeys.slice(startIdx, startIdx + limit);
    const objects = slice.map((k) => {
      const item = store.get(k)!;
      return {
        key: k,
          size: item.size,
          uploaded: item.uploaded,
      };
    });
    const nextIdx = startIdx + slice.length;
    const truncated = nextIdx < matchingKeys.length;
    return {
      objects,
        truncated,
        ...(truncated ? { cursor: String(nextIdx) } : {}),
        delimitedPrefixes: [],
    };
  });
  const seed = (key: string, content: string, uploaded: Date) => {
    const bytes = new TextEncoder().encode(content);
    store.set(key, { body: bytes, uploaded, size: bytes.byteLength });
  };
  return {
    bucket: {
      put,
        get,
        delete: del,
        list,
    } as unknown as R2Bucket,
      store,
      put,
      get,
      delete: del,
      list,
      seed,
  };
}
function makeEnv(
  db: D1Database,
  rawBucket: R2Bucket,
  backupBucket?: R2Bucket,
  overrides: Partial = {},
  ): Env {
  return {
    DB: db,
      RAW: rawBucket,
      ASSETS: {} as Fetcher,
      MAILBOX_ADDRESS: "contact@aistockvn.com",
      FROM_NAME: "AIStockVN",
      ALLOWED_EMAILS: "super@aistockvn.com,admin@aistockvn.com",
      GOOGLE_CLIENT_ID: "google-client-id",
      FORWARD_TO: "",
      ...(backupBucket ? { BACKUP: backupBucket } : {}),
      CLOUDFLARE_ACCOUNT_ID: "acc-123",
      D1_DATABASE_ID: "db-456",
      D1_REST_API_TOKEN: "SECRET-TOKEN-123",
      ...overrides,
  };
}
interface D1QueryCall {
  url: string;
  sql: string;
  params?: unknown[];
  authorization: string;
}

function installD1QueryFetchMock(options: { messageRowCount?: number } = {}) {
  const calls: D1QueryCall[] = [];
  const messageRowCount = options.messageRowCount ?? 3;
  // Rows the fake D1 holds for the dump. messages exercises sqlLiteral
  // (a quote and a NULL); users has a single row.
  const messageRows: Record<string, unknown>[] =
    messageRowCount <= 3
      ? [
          { id: "m1", subject: "Hello" },
          { id: "m2", subject: "O'Brien" },
          { id: "m3", subject: null },
        ].slice(0, messageRowCount)
      : Array.from({ length: messageRowCount }, (_, i) => ({
          id: `m${i}`,
          subject: `subject ${i}`,
        }));
  const userRows: Record<string, unknown>[] = [{ id: "u1", email: "a@b.c" }];
  const schemaRows: Record<string, unknown>[] = [
    {
      type: "table",
      name: "messages",
      sql: "CREATE TABLE messages (id TEXT PRIMARY KEY, subject TEXT)",
    },
    {
      type: "table",
      name: "messages_fts",
      sql: "CREATE VIRTUAL TABLE messages_fts USING fts5(subject, text_body, from_addr, from_name, content='messages', content_rowid='rowid', tokenize='unicode61')",
    },
    {
      type: "table",
      name: "users",
      sql: "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)",
    },
    {
      type: "index",
      name: "idx_messages_subject",
      sql: "CREATE INDEX idx_messages_subject ON messages (subject)",
    },
    {
      type: "trigger",
      name: "messages_ai",
      sql: "CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN SELECT 1; END",
    },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/query") && method === "POST") {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(rawBody) as { sql?: string; params?: unknown[] };
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        sql: parsed.sql ?? "",
        params: parsed.params,
        authorization: headers.Authorization ?? headers.authorization ?? "",
      });
      const sql = parsed.sql ?? "";
      const respond = (results: Record<string, unknown>[]) =>
        new Response(JSON.stringify({ success: true, result: [{ success: true, results }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (sql.includes("FROM sqlite_master")) {
        return respond(schemaRows);
      }
      if (sql.startsWith("SELECT COUNT(*)")) {
        const n = sql.includes('"messages"') ? messageRows.length : userRows.length;
        return respond([{ n }]);
      }
      if (sql.startsWith("SELECT * FROM")) {
        const m = sql.match(/LIMIT (\d+) OFFSET (\d+)/);
        const limit = m ? Number(m[1]) : 500;
        const offset = m ? Number(m[2]) : 0;
        const all = sql.includes('"messages"') ? messageRows : userRows;
        return respond(all.slice(offset, offset + limit));
      }
      return new Response("Not Found", { status: 404 });
    }
    return new Response("Not Found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

describe("worker/backup", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("returns default settings when admin_settings is empty", async () => {
    const { db } = createMockD1();
    const raw = createMockR2();
    const env = makeEnv(db, raw.bucket, undefined);
    const settings = await getBackupSettings(env);
    expect(settings.backupEnabled).toBe(false);
    expect(settings.backupRetentionDays).toBe(30);
    expect(settings.backupSchedule).toBe("0 20 * * *");
    expect(settings.backupBucketConfigured).toBe(false);
    expect(settings.lastBackup).toBeNull();
  });
  it("validates retention bounds and requires super_admin on updateBackupSettings", async () => {
    const { db, adminSettings } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    await expect(
      updateBackupSettings(env, "super@aistockvn.com", { backupRetentionDays: 0 }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    await expect(
      updateBackupSettings(env, "super@aistockvn.com", { backupRetentionDays: 366 }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    await expect(
      updateBackupSettings(env, "super@aistockvn.com", {
      backupRetentionDays: "abc" as unknown as number,
    }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    await expect(
      updateBackupSettings(env, "admin@aistockvn.com", { backupRetentionDays: 7 }),
      ).rejects.toMatchObject({ status: 403 });
    const updated = await updateBackupSettings(
      env,
      "super@aistockvn.com",
      { backupRetentionDays: 7 },
      1_700_000_000_000,
      );
    expect(updated.backupRetentionDays).toBe(7);
    const stored = adminSettings.find((s) => s.key === "backup_retention_days");
    expect(stored?.value).toBe("7");
  });
  it("completes runBackup successfully and copies D1 dump and RAW objects", async () => {
    const { db, adminSettings, backupRuns } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    adminSettings.push({ key: "backup_enabled", value: "1", updated_at: 1000 });
    const nowMs = Date.UTC(2026, 10, 20, 3, 0, 0);
    const todayStr = new Date(nowMs).toISOString().slice(0, 10);
    raw.seed("raw/msg-1.eml", "eml-1", new Date(nowMs - 5000));
    raw.seed("raw/msg-2.eml", "eml-2", new Date(nowMs - 2000));
    const { calls } = installD1QueryFetchMock();
    const res = await runBackup(env, "manual", nowMs);
    expect("skipped" in res).toBe(false);
    expect(backupRuns).toHaveLength(1);
    const row = backupRuns[0];
    expect(row.status).toBe("succeeded");
    expect(row.d1_object_key).toBe(`d1/${todayStr}/${row.id}.sql`);
    const dumpItem = backup.store.get(row.d1_object_key);
    expect(dumpItem).toBeDefined();
    expect(row.d1_size).toBe(dumpItem!.size);
    const dumpText = new TextDecoder().decode(dumpItem!.body as Uint8Array);
    expect(dumpText).toContain("CREATE TABLE messages");
    expect(dumpText).toContain('INSERT INTO "messages"');
    expect(dumpText).toContain("'O''Brien'");
    expect(dumpText).not.toContain('DROP TABLE IF EXISTS "messages_fts"');
    expect(dumpText).not.toContain('INSERT INTO "messages_fts"');
    expect(dumpText).toContain("COMMIT;");
    expect(dumpText).toContain("VALUES('rebuild')");
    expect(row.r2_copied).toBe(2);
    expect(backup.store.has(row.d1_object_key)).toBe(true);
    expect(backup.store.has("raw/msg-1.eml")).toBe(true);
    expect(backup.store.has("raw/msg-2.eml")).toBe(true);
    // The dump went through the D1 query API (not the export API).
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].sql).toContain("FROM sqlite_master");
    expect(calls[0].authorization).toBe("Bearer SECRET-TOKEN-123");
    expect(calls.every((c) => c.url.endsWith("/query"))).toBe(true);
  });
  it("marks run failed on D1 query HTTP 500 without leaking D1_REST_API_TOKEN", async () => {
    const { db, adminSettings, backupRuns } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket, {
      D1_REST_API_TOKEN: "SECRET-TOKEN-123",
    });
    adminSettings.push({ key: "backup_enabled", value: "1", updated_at: 1000 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream failure SECRET-TOKEN-123", { status: 500 })),
      );
    await expect(runBackup(env, "manual", 1_700_000_000_000)).rejects.toBeInstanceOf(BackupError);
    expect(backupRuns).toHaveLength(1);
    expect(backupRuns[0].status).toBe("failed");
    expect(backupRuns[0].error).not.toContain("SECRET-TOKEN-123");
  });
  it("skips runBackup when a running backup started within the last 6 hours", async () => {
    const { db, adminSettings, backupRuns } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    adminSettings.push({ key: "backup_enabled", value: "1", updated_at: 1000 });
    const nowMs = 1_700_000_000_000;
    backupRuns.push({
      id: "existing-running",
        trigger: "cron",
        status: "running",
        started_at: nowMs,
        finished_at: null,
        d1_object_key: "",
        d1_size: 0,
        r2_copied: 0,
        r2_errors: 0,
        error: "",
    });
    const result = await runBackup(env, "manual", nowMs);
    expect(result).toEqual({ skipped: true });
    expect(backupRuns).toHaveLength(1);
  });
  it("copies only RAW objects uploaded after the last succeeded finished_at", async () => {
    const { db, adminSettings, backupRuns } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    adminSettings.push({ key: "backup_enabled", value: "1", updated_at: 1000 });
    const lastFinishedAt = 1_700_000_000_000;
    backupRuns.push({
      id: "prev-ok",
        trigger: "cron",
        status: "succeeded",
        started_at: lastFinishedAt - 10_000,
        finished_at: lastFinishedAt,
        d1_object_key: "d1/2023-11-14/prev-ok.sqlite",
        d1_size: 8,
        r2_copied: 1,
        r2_errors: 0,
        error: "",
    });
    raw.seed("raw/older.eml", "old-body", new Date(lastFinishedAt - 5000));
    raw.seed("raw/newer.eml", "new-body", new Date(lastFinishedAt + 5000));
    installD1QueryFetchMock();
    const res = await runBackup(env, "manual", lastFinishedAt + 60_000);
    expect(res).toMatchObject({ status: "succeeded", r2Copied: 1 });
    expect(backup.store.has("raw/older.eml")).toBe(false);
    expect(backup.store.has("raw/newer.eml")).toBe(true);
  });
  it("records r2_errors and offending key while still succeeding when one RAW.get throws", async () => {
    const { db, adminSettings, backupRuns } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    adminSettings.push({ key: "backup_enabled", value: "1", updated_at: 1000 });
    const nowMs = 1_700_000_000_000;
    raw.seed("raw/good.eml", "ok", new Date(nowMs - 1000));
    raw.seed("raw/corrupt.eml", "bad", new Date(nowMs - 1000));
    const origGet = raw.get.getMockImplementation()!;
    raw.get.mockImplementation(async (key: string) => {
      if (key === "raw/corrupt.eml") {
        throw new Error("R2 read failure");
      }
      return origGet(key);
    });
    installD1QueryFetchMock();
    const res = await runBackup(env, "manual", nowMs);
    expect(res).toMatchObject({ status: "succeeded", r2Copied: 1, r2Errors: 1 });
    const latest = backupRuns[backupRuns.length - 1];
    expect(latest.status).toBe("succeeded");
    expect(latest.r2_errors).toBe(1);
    expect(latest.error).toContain("raw/corrupt.eml");
  });
  it("purges expired d1 and raw objects from BACKUP only and never deletes from RAW", async () => {
    const { db, adminSettings, backupRuns } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    adminSettings.push({ key: "backup_enabled", value: "1", updated_at: 1000 });
    adminSettings.push({ key: "backup_retention_days", value: "30", updated_at: 1000 });
    const dayMs = 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    const fortyDaysAgo = nowMs - 40 * dayMs;
    const oldD1Key = "d1/2026-10-10/old-run.sqlite";
    const oldRawKey = "raw/old-mail.eml";
    const freshRawKey = "raw/fresh-mail.eml";
    backupRuns.push({
      id: "old-run",
        trigger: "cron",
        status: "succeeded",
        started_at: fortyDaysAgo,
        finished_at: fortyDaysAgo + 5000,
        d1_object_key: oldD1Key,
        d1_size: 8,
        r2_copied: 1,
        r2_errors: 0,
        error: "",
    });
    backup.seed(oldD1Key, "OLD-SQL", new Date(fortyDaysAgo));
    backup.seed(oldRawKey, "OLD-EML", new Date(fortyDaysAgo));
    backup.seed(freshRawKey, "FRESH-EML", new Date(nowMs - dayMs));
    raw.seed(freshRawKey, "FRESH-EML", new Date(nowMs - dayMs));
    installD1QueryFetchMock();
    await runBackup(env, "manual", nowMs);
    expect(backup.delete).toHaveBeenCalled();
    const deletedKeys = backup.delete.mock.calls.flatMap((call) =>
      Array.isArray(call[0]) ? call[0] : [call[0]],
      );
    expect(deletedKeys).toContain(oldD1Key);
    expect(deletedKeys).toContain(oldRawKey);
    expect(deletedKeys).not.toContain(freshRawKey);
    expect(raw.delete).not.toHaveBeenCalled();
  });
  it("rejects unsafe keys and downloads the run d1_object_key in downloadBackupObject", async () => {
    const { db, backupRuns } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    const d1Key = "d1/2026-11-20/run-dl.sqlite";
    backupRuns.push({
      id: "run-dl",
        trigger: "manual",
        status: "succeeded",
        started_at: 1_700_000_000_000,
        finished_at: 1_700_000_001_000,
        d1_object_key: d1Key,
        d1_size: 11,
        r2_copied: 0,
        r2_errors: 0,
        error: "",
    });
    backup.seed(d1Key, "SQLITE-DATA", new Date(1_700_000_001_000));
    await expect(downloadBackupObject(env, "run-dl", "../secret")).rejects.toMatchObject({
      status: 400,
        code: "invalid_key",
    });
    await expect(downloadBackupObject(env, "run-dl", "evil/x")).rejects.toMatchObject({
      status: 400,
        code: "invalid_key",
    });
    const downloaded = await downloadBackupObject(env, "run-dl", d1Key);
    expect(downloaded.contentType).toBe("application/x-sqlite3");
    const bytes = await readBodyToBytes(downloaded.body);
    expect(new TextDecoder().decode(bytes)).toBe("SQLITE-DATA");
  });
  it("computes 30-day succeeded/failed counts and lastBackupAt in getBackupStats", async () => {
    const { db, backupRuns } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    const dayMs = 24 * 60 * 60 * 1000;
    const nowMs = 1_750_000_000_000;
    const newestStartedAt = nowMs - dayMs;
    backupRuns.push(
      {
      id: "r-old-40d",
        trigger: "cron",
        status: "succeeded",
        started_at: nowMs - 40 * dayMs,
        finished_at: nowMs - 40 * dayMs + 1000,
        d1_object_key: "d1/old/r0.sqlite",
        d1_size: 100,
        r2_copied: 1,
        r2_errors: 0,
        error: "",
    },
      {
      id: "r-ok-1",
        trigger: "cron",
        status: "succeeded",
        started_at: nowMs - 10 * dayMs,
        finished_at: nowMs - 10 * dayMs + 1000,
        d1_object_key: "d1/recent/r1.sqlite",
        d1_size: 200,
        r2_copied: 2,
        r2_errors: 0,
        error: "",
    },
      {
      id: "r-fail-1",
        trigger: "manual",
        status: "failed",
        started_at: nowMs - 5 * dayMs,
        finished_at: nowMs - 5 * dayMs + 1000,
        d1_object_key: "",
        d1_size: 0,
        r2_copied: 0,
        r2_errors: 0,
        error: "D1 query failed",
    },
      {
      id: "r-ok-2",
        trigger: "cron",
        status: "succeeded",
        started_at: newestStartedAt,
        finished_at: newestStartedAt + 1000,
        d1_object_key: "d1/recent/r2.sqlite",
        d1_size: 512,
        r2_copied: 3,
        r2_errors: 0,
        error: "",
    },
      );
    const stats = await getBackupStats(env, nowMs);
    expect(stats.succeededLast30d).toBe(2);
    expect(stats.failedLast30d).toBe(1);
    expect(stats.lastBackupAt).toBe(newestStartedAt);
    expect(stats.lastBackupSize).toBe(512);
  });
  it("skips FTS/shadow/system tables in isSkippedBackupTable", () => {
    expect(isSkippedBackupTable("messages")).toBe(false);
    expect(isSkippedBackupTable("users")).toBe(false);
    expect(isSkippedBackupTable("messages_fts")).toBe(true);
    expect(isSkippedBackupTable("messages_fts_data")).toBe(true);
    expect(isSkippedBackupTable("messages_fts_content")).toBe(true);
    expect(isSkippedBackupTable("_cf_KV")).toBe(true);
    expect(isSkippedBackupTable("sqlite_sequence")).toBe(true);
    expect(isSkippedBackupTable("other_fts", "CREATE VIRTUAL TABLE other_fts USING fts5(x)")).toBe(true);
    expect(isSkippedBackupTable("other_fts", "CREATE TABLE other_fts (x TEXT)")).toBe(false);
  });
  it("escapes values in sqlLiteral", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(undefined)).toBe("NULL");
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(Number.NaN)).toBe("NULL");
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(false)).toBe("0");
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral([0xde, 0xad])).toBe("X'DEAD'");
    expect(sqlLiteral({ a: 1 })).toBe("'{\"a\":1}'");
  });
  it("exports a query-based SQL dump via exportD1SnapshotToBackup, skipping FTS tables", async () => {
    const { db } = createMockD1();
    const backup = createMockR2();
    const raw = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    installD1QueryFetchMock();
    const res = await exportD1SnapshotToBackup(env, "run-1", Date.UTC(2026, 10, 20, 3, 0, 0));
    expect(backup.put).toHaveBeenCalledTimes(1);
    expect(backup.put).toHaveBeenCalledWith(res.d1ObjectKey, expect.any(String));
    expect(res.d1ObjectKey).toBe("d1/2026-11-20/run-1.sql");
    const item = backup.store.get(res.d1ObjectKey);
    expect(item).toBeDefined();
    expect(res.d1Size).toBe(item!.size);
    const text = new TextDecoder().decode(item!.body as Uint8Array);
    expect(text).toContain('DROP TABLE IF EXISTS "messages";');
    expect(text).toContain("CREATE TABLE messages");
    expect(text).toContain("CREATE TABLE users");
    expect(text).not.toContain('DROP TABLE IF EXISTS "messages_fts"');
    expect(text).not.toContain('INSERT INTO "messages_fts"');
    expect(text).toContain("CREATE INDEX idx_messages_subject");
    expect(text).toContain("VALUES('rebuild')");
  });
  it("pages through large tables with LIMIT/OFFSET", async () => {
    const { db } = createMockD1();
    const backup = createMockR2();
    const raw = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    const { calls } = installD1QueryFetchMock({ messageRowCount: 1200 });
    const res = await exportD1SnapshotToBackup(env, "run-big", Date.UTC(2026, 10, 20, 3, 0, 0));
    const item = backup.store.get(res.d1ObjectKey);
    expect(item).toBeDefined();
    const text = new TextDecoder().decode(item!.body as Uint8Array);
    const tuples = text.match(/\('m\d+',/g) ?? [];
    expect(tuples).toHaveLength(1200);
    const pageSql = calls.filter((c) => c.sql.startsWith("SELECT * FROM")).map((c) => c.sql);
    expect(pageSql).toContain('SELECT * FROM "messages" LIMIT 500 OFFSET 0');
    expect(pageSql).toContain('SELECT * FROM "messages" LIMIT 500 OFFSET 500');
    expect(pageSql).toContain('SELECT * FROM "messages" LIMIT 500 OFFSET 1000');
  });
  it("downloads the run .sql dump with application/sql content type", async () => {
    const { db, backupRuns } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    const d1Key = "d1/2026-11-20/run-sql.sql";
    backupRuns.push({
      id: "run-sql",
      trigger: "manual",
      status: "succeeded",
      started_at: 1_700_000_000_000,
      finished_at: 1_700_000_001_000,
      d1_object_key: d1Key,
      d1_size: 8,
      r2_copied: 0,
      r2_errors: 0,
      error: "",
    });
    backup.seed(d1Key, "SQL-DUMP", new Date(1_700_000_001_000));
    const downloaded = await downloadBackupObject(env, "run-sql", d1Key);
    expect(downloaded.contentType).toBe("application/sql");
    const bytes = await readBodyToBytes(downloaded.body);
    expect(new TextDecoder().decode(bytes)).toBe("SQL-DUMP");
  });

});

describe("scheduled backup trigger (R8)", () => {
  const makeCtx = () =>
    ({
      waitUntil: (p: Promise<unknown>) => {
        void p.catch(() => {});
      },
    }) as unknown as ExecutionContext;

  it("triggers BACKUP_WORKFLOW.create() once at 20:00 UTC when no run exists today (VN)", async () => {
    const { db } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const mockWorkflow = { create: vi.fn(async () => ({ id: "wf-1" })) };
    const env: Env = {
      ...makeEnv(db, raw.bucket, backup.bucket),
      ...({ BACKUP_WORKFLOW: mockWorkflow } as unknown as Partial<Env>),
    };
    const event = { scheduledTime: Date.UTC(2026, 10, 19, 20, 0, 0) } as ScheduledController;
    await worker.scheduled(event, env, makeCtx());
    expect(mockWorkflow.create).toHaveBeenCalledTimes(1);
  });

  it("does not trigger at 20:05 UTC (outside window)", async () => {
    const { db } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const mockWorkflow = { create: vi.fn(async () => ({ id: "wf-1" })) };
    const env: Env = {
      ...makeEnv(db, raw.bucket, backup.bucket),
      ...({ BACKUP_WORKFLOW: mockWorkflow } as unknown as Partial<Env>),
    };
    const event = { scheduledTime: Date.UTC(2026, 10, 19, 20, 5, 0) } as ScheduledController;
    await worker.scheduled(event, env, makeCtx());
    expect(mockWorkflow.create).not.toHaveBeenCalled();
  });

  it("does not trigger at 19:55 UTC (before window)", async () => {
    const { db } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const mockWorkflow = { create: vi.fn(async () => ({ id: "wf-1" })) };
    const env: Env = {
      ...makeEnv(db, raw.bucket, backup.bucket),
      ...({ BACKUP_WORKFLOW: mockWorkflow } as unknown as Partial<Env>),
    };
    const event = { scheduledTime: Date.UTC(2026, 10, 19, 19, 55, 0) } as ScheduledController;
    await worker.scheduled(event, env, makeCtx());
    expect(mockWorkflow.create).not.toHaveBeenCalled();
  });

  it("does not trigger at 20:00 UTC if a backup_runs row already exists for the current VN day", async () => {
    const { db, backupRuns } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const mockWorkflow = { create: vi.fn(async () => ({ id: "wf-1" })) };
    const env: Env = {
      ...makeEnv(db, raw.bucket, backup.bucket),
      ...({ BACKUP_WORKFLOW: mockWorkflow } as unknown as Partial<Env>),
    };
    backupRuns.push({
      id: "run-today",
      trigger: "cron",
      status: "succeeded",
      started_at: Date.UTC(2026, 10, 19, 18, 0, 0),
      finished_at: Date.UTC(2026, 10, 19, 18, 1, 0),
      d1_object_key: "d1/2026-11-20/run-today.sql",
      d1_size: 100,
      r2_copied: 0,
      r2_errors: 0,
      error: "",
    });
    const event = { scheduledTime: Date.UTC(2026, 10, 19, 20, 0, 0) } as ScheduledController;
    await worker.scheduled(event, env, makeCtx());
    expect(mockWorkflow.create).not.toHaveBeenCalled();
  });

  it("triggers at 20:00 UTC when only a previous VN day run exists", async () => {
    const { db, backupRuns } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const mockWorkflow = { create: vi.fn(async () => ({ id: "wf-1" })) };
    const env: Env = {
      ...makeEnv(db, raw.bucket, backup.bucket),
      ...({ BACKUP_WORKFLOW: mockWorkflow } as unknown as Partial<Env>),
    };
    backupRuns.push({
      id: "run-yesterday",
      trigger: "cron",
      status: "succeeded",
      started_at: Date.UTC(2026, 10, 19, 16, 59, 59),
      finished_at: Date.UTC(2026, 10, 19, 16, 59, 59),
      d1_object_key: "d1/2026-11-19/run-yesterday.sql",
      d1_size: 100,
      r2_copied: 0,
      r2_errors: 0,
      error: "",
    });
    const event = { scheduledTime: Date.UTC(2026, 10, 19, 20, 0, 0) } as ScheduledController;
    await worker.scheduled(event, env, makeCtx());
    expect(mockWorkflow.create).toHaveBeenCalledTimes(1);
  });

  it("does not throw at 20:00 UTC when BACKUP_WORKFLOW binding is missing", async () => {
    const { db } = createMockD1();
    const raw = createMockR2();
    const backup = createMockR2();
    const env = makeEnv(db, raw.bucket, backup.bucket);
    const event = { scheduledTime: Date.UTC(2026, 10, 19, 20, 0, 0) } as ScheduledController;
    await expect(worker.scheduled(event, env, makeCtx())).resolves.toBeUndefined();
    await expect(maybeTriggerScheduledBackup(env, event.scheduledTime)).resolves.toBe(false);
  });

  it("evaluates isBackupWindow and vnDayStartMs accurately", () => {
    expect(isBackupWindow(Date.UTC(2026, 10, 19, 20, 0, 0))).toBe(true);
    expect(isBackupWindow(Date.UTC(2026, 10, 19, 20, 4, 59))).toBe(true);
    expect(isBackupWindow(Date.UTC(2026, 10, 19, 20, 5, 0))).toBe(false);
    expect(vnDayStartMs(Date.UTC(2026, 10, 19, 20, 0, 0))).toBe(Date.UTC(2026, 10, 19, 17, 0, 0));
  });
});
