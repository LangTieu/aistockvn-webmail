import { describe, expect, it, vi, afterEach } from "vitest";
import { signSession, SESSION_COOKIE } from "./auth";
import worker from "./index";
import type { Env } from "./mail";
import {
  BackupError,
  getBackupSettings,
  updateBackupSettings,
  listBackupRuns,
  runBackup,
  listBackupObjects,
  downloadBackupObject,
} from "./backup";

vi.mock("./backup", () => {
  class MockBackupError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message?: string) {
      super(message ?? code);
      this.name = "BackupError";
      this.status = status;
      this.code = code;
    }
  }
  return {
    BackupError: MockBackupError,
    BackupWorkflow: class {},
    getBackupSettings: vi.fn(),
    updateBackupSettings: vi.fn(),
    listBackupRuns: vi.fn(),
    runBackup: vi.fn(),
    listBackupObjects: vi.fn(),
    downloadBackupObject: vi.fn(),
  };
});

interface MockUserRow {
  id: string;
  email: string;
  role: string;
  status: string;
  verified: number;
}

export interface ClientErrorRow {
  id: string;
  crash_id: string;
  mailbox_hash: string;
  message: string;
  stack: string;
  url: string;
  user_agent: string;
  created_at: number;
}

interface AuditLogEntry {
  sql: string;
  args: unknown[];
}

function createMockDb() {
  const users: MockUserRow[] = [
    { id: "u1", email: "admin@aistockvn.com", role: "super_admin", status: "active", verified: 1 },
    { id: "u2", email: "mod@aistockvn.com", role: "admin", status: "active", verified: 1 },
    { id: "u3", email: "user@aistockvn.com", role: "user", status: "active", verified: 1 },
  ];
  const adminSettings = new Map<string, string>();
  const clientErrors: ClientErrorRow[] = [];
  const auditLogs: AuditLogEntry[] = [];

  const db = {
    prepare(sql: string) {
      const norm = sql.replace(/\s+/g, " ").trim();
      const upper = norm.toUpperCase();

      const makeStmt = (binds: unknown[]) => ({
        bind(...args: unknown[]) {
          return makeStmt(args);
        },
        async first<T = unknown>(): Promise<T | null> {
          if (upper.includes("FROM USERS") && upper.includes("WHERE EMAIL")) {
            const target = String(binds[0] ?? "").toLowerCase();
            const found = users.find((u) => u.email.toLowerCase() === target);
            return (found ? { ...found } : null) as T | null;
          }
          if (upper.includes("FROM ADMIN_SETTINGS")) {
            const key = String(binds[0] ?? "");
            if (adminSettings.has(key)) {
              return { key, value: adminSettings.get(key)!, updated_at: 0 } as unknown as T;
            }
            return null;
          }
          return null;
        },
        async all<T = unknown>(): Promise<{ results: T[] }> {
          if (upper.includes("FROM MAILBOXES")) {
            return { results: [] };
          }
          if (upper.includes("FROM EXTERNAL_ACCOUNTS")) {
            return { results: [] };
          }
          if (upper.includes("FROM ADMIN_SETTINGS")) {
            const rows = Array.from(adminSettings.entries()).map(([key, value]) => ({
              key,
              value,
              updated_at: 0,
            }));
            return { results: rows as unknown as T[] };
          }
          if (upper.includes("FROM USERS")) {
            return { results: users.map((u) => ({ ...u })) as unknown as T[] };
          }
          if (upper.includes("FROM CLIENT_ERRORS")) {
            const rows = [...clientErrors].sort((a, b) => b.created_at - a.created_at);
            return { results: rows as unknown as T[] };
          }
          return { results: [] };
        },
        async run() {
          if (upper.includes("INSERT INTO CLIENT_ERRORS")) {
            clientErrors.push({
              id: String(binds[0] ?? ""),
              crash_id: String(binds[1] ?? ""),
              mailbox_hash: String(binds[2] ?? ""),
              message: String(binds[3] ?? ""),
              stack: String(binds[4] ?? ""),
              url: String(binds[5] ?? ""),
              user_agent: String(binds[6] ?? ""),
              created_at: Number(binds[7] ?? 0),
            });
          } else if (upper.includes("INSERT") && upper.includes("ADMIN_SETTINGS")) {
            adminSettings.set(String(binds[0] ?? ""), String(binds[1] ?? ""));
          } else if (upper.includes("INSERT")) {
            auditLogs.push({ sql: norm, args: [...binds] });
          }
          return { success: true, meta: { changes: 1 } };
        },
      });

      return makeStmt([]);
    },
  } as unknown as D1Database;

  return {
    db,
    state: {
      users,
      adminSettings,
      clientErrors,
      auditLogs,
    },
  };
}

const SECRET = "s".repeat(40);
const SUPER_ADMIN_EMAIL = "admin@aistockvn.com";
const ADMIN_EMAIL = "mod@aistockvn.com";
const NORMAL_USER_EMAIL = "user@aistockvn.com";
const ALLOWED_EMAILS = [SUPER_ADMIN_EMAIL, ADMIN_EMAIL, NORMAL_USER_EMAIL].join(",");
const TEST_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";

async function makeEnv(overrides: Partial<Env> = {}) {
  const { db, state } = createMockDb();
  const env: Env = {
    DB: db,
    RAW: { get: async () => null, list: async () => ({ objects: [] }), put: async () => {}, delete: async () => {} } as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } as unknown as Fetcher,
    MAILBOX_ADDRESS: SUPER_ADMIN_EMAIL,
    FROM_NAME: "AI Stock VN",
    ALLOWED_EMAILS,
    GOOGLE_CLIENT_ID: "",
    FORWARD_TO: "",
    RESEND_API_KEY: "re_test_dummy_key",
    ENCRYPTION_KEY: TEST_KEY_B64,
    SESSION_SECRET: SECRET,
    ...overrides,
  };
  return { env, state };
}

async function authedRequest(email: string, path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<Request> {
  const token = await signSession(email, SECRET);
  const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${token}` };
  if (method !== "GET") {
    headers["X-Mail-Client"] = "1";
    headers["Content-Type"] = "application/json";
  }
  return new Request(`https://mail.aistockvn.com${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const CANNED_RUNS = [
  { id: "run-1", trigger: "cron", status: "succeeded", startedAt: 1700000001000, finishedAt: 1700000002000, d1ObjectKey: "d1/2026-11-20/run-1.sqlite", d1Size: 12345, r2Copied: 3, r2Errors: 0, error: "" },
  { id: "run-2", trigger: "manual", status: "failed", startedAt: 1700000003000, finishedAt: 1700000004000, d1ObjectKey: "", d1Size: 0, r2Copied: 0, r2Errors: 1, error: "boom" },
];
const CANNED_SETTINGS = { backupEnabled: false, backupRetentionDays: 30, backupSchedule: "0 20 * * *", backupBucketConfigured: false, lastBackup: CANNED_RUNS[1] };

afterEach(() => { vi.restoreAllMocks(); });

describe("GET /api/admin/backups (R8 routes)", () => {
  it("admin GET returns runs newest first", async () => {
    const { env } = await makeEnv();
    vi.mocked(listBackupRuns).mockResolvedValue([CANNED_RUNS[1], CANNED_RUNS[0]]);
    const res = await worker.fetch(await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/backups"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("run-2");
    expect(body[1].id).toBe("run-1");
    expect(body[0]).toMatchObject({
      trigger: "manual",
      status: "failed",
      startedAt: 1700000003000,
      d1ObjectKey: "",
      d1Size: 0,
      r2Copied: 0,
      r2Errors: 1,
      error: "boom",
    });
  });

  it("admin GET ?limit=1 returns one run and passes limit", async () => {
    const { env } = await makeEnv();
    vi.mocked(listBackupRuns).mockResolvedValue([CANNED_RUNS[1]]);
    const res = await worker.fetch(await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/backups?limit=1"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveLength(1);
    expect(vi.mocked(listBackupRuns)).toHaveBeenCalledWith(expect.anything(), { limit: 1 });
  });

  it("normal user GET returns 403 admin_forbidden", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(await authedRequest(NORMAL_USER_EMAIL, "/api/admin/backups"), env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("admin_forbidden");
  });

  it("no session returns 401", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(new Request("https://mail.aistockvn.com/api/admin/backups"), env);
    expect(res.status).toBe(401);
  });

  it("admin GET /api/admin/settings returns backup fields", async () => {
    const { env, state } = await makeEnv();
    state.adminSettings.set("send_daily_cap", "100");
    vi.mocked(getBackupSettings).mockResolvedValue(CANNED_SETTINGS);
    const res = await worker.fetch(await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/settings"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.backupEnabled).toBe(false);
    expect(body.backupRetentionDays).toBe(30);
    expect(body.backupSchedule).toBe("0 20 * * *");
    expect(body.backupBucketConfigured).toBe(false);
    expect(body.lastBackupAt).toBe(1700000003000);
    expect(body.lastBackupStatus).toBe("failed");
  });
});

describe("POST /api/admin/backups/run (R8 routes)", () => {
  it("super admin POST starts a manual run and returns it", async () => {
    const { env } = await makeEnv();
    vi.mocked(runBackup).mockResolvedValue({ ...CANNED_RUNS[0], trigger: "manual" });
    const res = await worker.fetch(await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/backups/run", "POST", {}), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; trigger: string };
    expect(body.id).toBe("run-1");
    expect(body.trigger).toBe("manual");
    expect(vi.mocked(runBackup)).toHaveBeenCalledWith(expect.anything(), "manual", expect.any(Number));
  });

  it("admin (non-super) POST returns 403 admin_forbidden", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(await authedRequest(ADMIN_EMAIL, "/api/admin/backups/run", "POST", {}), env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("admin_forbidden");
  });

  it("runBackup BackupError surfaces as its status and code", async () => {
    const { env } = await makeEnv();
    vi.mocked(runBackup).mockRejectedValue(new BackupError(409, "backup_disabled"));
    const res = await worker.fetch(await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/backups/run", "POST", {}), env);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("backup_disabled");
    expect(body.code).toBe("backup_disabled");
  });
});

describe("GET /api/admin/backups/objects (R8 routes)", () => {
  const CANNED_OBJECTS = {
    objects: [{ key: "d1/2026-11-20/run-1.sqlite", size: 12345, uploaded: "2026-11-20T00:00:00Z" }],
    cursor: undefined,
  };

  it("admin GET returns objects for the run", async () => {
    const { env } = await makeEnv();
    vi.mocked(listBackupObjects).mockResolvedValue(CANNED_OBJECTS);
    const res = await worker.fetch(await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/backups/objects?runId=run-1"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { objects: Array<{ key: string; size: number; uploaded: string }>; cursor?: string };
    expect(body.objects).toHaveLength(1);
    expect(body.objects[0].key).toBe("d1/2026-11-20/run-1.sqlite");
    expect(vi.mocked(listBackupObjects)).toHaveBeenCalledWith(expect.anything(), "run-1", undefined);
  });

  it("GET without runId returns 400", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/backups/objects"), env);
    expect(res.status).toBe(400);
  });

  it("normal user GET returns 403 admin_forbidden", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(await authedRequest(NORMAL_USER_EMAIL, "/api/admin/backups/objects?runId=run-1"), env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("admin_forbidden");
  });
});

describe("GET /api/admin/backups/download (R8 routes)", () => {
  it("admin GET downloads the object with attachment headers", async () => {
    const { env } = await makeEnv();
    vi.mocked(downloadBackupObject).mockResolvedValue({ body: "fake-sqlite-bytes", contentType: "application/octet-stream" });
    const res = await worker.fetch(await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/backups/download?runId=run-1&key=d1/2026-11-20/run-1.sqlite"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="run-1.sqlite"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("fake-sqlite-bytes");
    expect(vi.mocked(downloadBackupObject)).toHaveBeenCalledWith(expect.anything(), "run-1", "d1/2026-11-20/run-1.sqlite");
  });

  it("GET without key returns 400", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/backups/download?runId=run-1"), env);
    expect(res.status).toBe(400);
  });

  it("normal user GET returns 403 admin_forbidden", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(await authedRequest(NORMAL_USER_EMAIL, "/api/admin/backups/download?runId=run-1&key=d1/2026-11-20/run-1.sqlite"), env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("admin_forbidden");
  });
});

describe("POST /api/client-errors (R8 routes)", () => {
  it("authed user POST records the error and returns ok", async () => {
    const { env, state } = await makeEnv();
    const res = await worker.fetch(await authedRequest(NORMAL_USER_EMAIL, "/api/client-errors", "POST", { crashId: "abc-123", message: "boom", url: "/inbox", userAgent: "test" }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; crashId?: string };
    expect(body.ok).toBe(true);
    expect(body.crashId).toBe("abc-123");
    expect(state.clientErrors).toHaveLength(1);
  });

  it("POST without crashId returns 400", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(await authedRequest(NORMAL_USER_EMAIL, "/api/client-errors", "POST", { message: "boom" }), env);
    expect(res.status).toBe(400);
  });

  it("POST with body over 16KB returns 413 client_error_too_large", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(await authedRequest(NORMAL_USER_EMAIL, "/api/client-errors", "POST", { crashId: "big-1", message: "x".repeat(17000) }), env);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("client_error_too_large");
  });

  it("POST with invalid JSON returns 400", async () => {
    const { env } = await makeEnv();
    const token = await signSession(NORMAL_USER_EMAIL, SECRET);
    const req = new Request("https://mail.aistockvn.com/api/client-errors", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${token}`, "X-Mail-Client": "1", "Content-Type": "application/json" },
      body: "not-json{",
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/admin/client-errors (R8 routes)", () => {
  it("admin GET returns recorded client errors", async () => {
    const { env } = await makeEnv();
    await worker.fetch(await authedRequest(NORMAL_USER_EMAIL, "/api/client-errors", "POST", { crashId: "err-1", message: "first", url: "/inbox", userAgent: "test" }), env);
    await worker.fetch(await authedRequest(NORMAL_USER_EMAIL, "/api/client-errors", "POST", { crashId: "err-2", message: "second", url: "/sent", userAgent: "test" }), env);
    const res = await worker.fetch(await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/client-errors"), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body.map((b: any) => b.crashId).sort()).toEqual(["err-1", "err-2"]);
    const second = body.find((b: any) => b.crashId === "err-2");
    expect(second).toMatchObject({ message: "second", url: "/sent" });
    expect(typeof second.mailboxHash).toBe("string");
    expect(second.mailboxHash.length).toBe(43);
  });

  it("normal user GET returns 403 admin_forbidden", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(await authedRequest(NORMAL_USER_EMAIL, "/api/admin/client-errors"), env);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("admin_forbidden");
  });
});
