import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword, SESSION_COOKIE, signSession } from "./auth";
import worker from "./index";
import type { Env } from "./mail";

const SECRET = "s".repeat(40);
const SUPER_ADMIN_EMAIL = "admin@aistockvn.com";
const ADMIN_EMAIL = "mod@aistockvn.com";
const NORMAL_USER_EMAIL = "user@aistockvn.com";
const BANNED_USER_EMAIL = "banned@aistockvn.com";
const ALLOWED_EMAILS = [
  SUPER_ADMIN_EMAIL,
  ADMIN_EMAIL,
  NORMAL_USER_EMAIL,
  BANNED_USER_EMAIL,
].join(",");
const TEST_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: "super_admin" | "admin" | "user";
  status: "active" | "banned";
  verified: number;
  created_at: number;
}

interface MailboxRow {
  id: string;
  user_id: string;
  address: string;
}

interface DomainRow {
  domain: string;
  enabled: number;
  created_at: number;
}

interface AliasRow {
  id: string;
  local_part: string;
  domain: string;
  label: string;
  enabled: number;
  created_by: string;
  created_at: number;
}

interface MessageRow {
  id: string;
  folder: string;
  mailbox_address: string;
  date: number;
  is_read: number;
  raw_key: string | null;
}

interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  created_at: number;
}

interface AdminSettingRow {
  key: string;
  value: string;
  updated_at: number;
}

interface MockState {
  users: UserRow[];
  mailboxes: MailboxRow[];
  domains: DomainRow[];
  aliases: AliasRow[];
  messages: MessageRow[];
  auditLogs: AuditLogRow[];
  settings: Map<string, AdminSettingRow>;
  deletedR2Keys: string[];
  messageInserts: number;
}

function createMockDb(initial?: Partial<MockState>) {
  const state: MockState = {
    users: initial?.users ? [...initial.users] : [],
    mailboxes: initial?.mailboxes ? [...initial.mailboxes] : [],
    domains: initial?.domains
      ? [...initial.domains]
      : [{ domain: "aistockvn.com", enabled: 1, created_at: 1_700_000_000_000 }],
    aliases: initial?.aliases
      ? [...initial.aliases]
      : [
          {
            id: "alias-1",
            local_part: "info",
            domain: "aistockvn.com",
            label: "Info",
            enabled: 1,
            created_by: SUPER_ADMIN_EMAIL,
            created_at: 1_700_000_000_000,
          },
        ],
    messages: initial?.messages ? [...initial.messages] : [],
    auditLogs: initial?.auditLogs ? [...initial.auditLogs] : [],
    settings: initial?.settings ? new Map(initial.settings) : new Map(),
    deletedR2Keys: [],
    messageInserts: 0,
  };

  function makeStatement(sql: string, binds: unknown[]) {
    const norm = sql.replace(/\s+/g, " ").trim();
    const upper = norm.toUpperCase();

    return {
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        // Users single-row lookups
        if (upper.includes("FROM USERS") && upper.includes("COUNT(*)")) {
          if (upper.includes("SUM(CASE WHEN")) {
            const total = state.users.length;
            const active = state.users.filter((u) => u.status === "active").length;
            const banned = state.users.filter((u) => u.status === "banned").length;
            const admins = state.users.filter(
              (u) => u.role === "super_admin" || u.role === "admin",
            ).length;
            const superAdmins = state.users.filter((u) => u.role === "super_admin").length;
            const normalUsers = state.users.filter((u) => u.role === "user").length;
            return {
              total,
              active,
              banned,
              admins,
              super_admins: superAdmins,
              users: normalUsers,
            } as unknown as T;
          }
          if (upper.includes("ROLE = 'SUPER_ADMIN'")) {
            const count = state.users.filter(
              (u) =>
                u.role === "super_admin" &&
                (!upper.includes("STATUS = 'ACTIVE'") || u.status === "active"),
            ).length;
            return { count, n: count, total: count } as unknown as T;
          }
          return { count: state.users.length, total: state.users.length } as unknown as T;
        }

        if (upper.includes("FROM USERS") && upper.includes("WHERE") && upper.includes("EMAIL")) {
          const email = String(binds[0] ?? "").trim().toLowerCase();
          const u = state.users.find((row) => row.email.toLowerCase() === email);
          if (!u) return null;
          return {
            id: u.id,
            email: u.email,
            display_name: u.display_name,
            password_hash: u.password_hash,
            role: u.role,
            status: u.status,
            verified: u.verified,
            created_at: u.created_at,
          } as unknown as T;
        }

        // Mailboxes stats
        if (upper.includes("FROM MAILBOXES") && upper.includes("COUNT(*)")) {
          return { total: state.mailboxes.length, count: state.mailboxes.length } as unknown as T;
        }

        // Messages stats / counts / cleanup preview / sent today
        if (upper.includes("FROM MESSAGES") && upper.includes("COUNT(*)")) {
          if (upper.includes("SUM(CASE WHEN")) {
            const total = state.messages.length;
            const unread = state.messages.filter((m) => m.is_read === 0).length;
            const inbox = state.messages.filter((m) => m.folder === "inbox").length;
            const sent = state.messages.filter((m) => m.folder === "sent").length;
            const spam = state.messages.filter((m) => m.folder === "spam").length;
            const trash = state.messages.filter((m) => m.folder === "trash").length;
            return { total, unread, inbox, sent, spam, trash } as unknown as T;
          }

          if (upper.includes("FOLDER = 'SENT'") && upper.includes("DATE >=")) {
            const mailbox = String(binds[0] ?? "").toLowerCase();
            const dayStartMs = Number(binds[1] ?? 0);
            const count = state.messages.filter(
              (m) =>
                m.folder === "sent" &&
                m.mailbox_address.toLowerCase() === mailbox &&
                m.date >= dayStartMs,
            ).length;
            return { count, n: count } as unknown as T;
          }

          if (upper.includes("FOLDER = ?") && upper.includes("DATE < ?")) {
            const folder = String(binds[0] ?? "").toLowerCase();
            const cutoffMs = Number(binds[1] ?? 0);
            const mailbox = binds.length >= 3 ? String(binds[2] ?? "").toLowerCase() : null;
            const count = state.messages.filter(
              (m) =>
                m.folder === folder &&
                m.date < cutoffMs &&
                (!mailbox || m.mailbox_address.toLowerCase() === mailbox),
            ).length;
            return { count } as unknown as T;
          }

          return { count: 0, n: 0, total: 0 } as unknown as T;
        }

        // Domains stats
        if (upper.includes("FROM DOMAINS") && upper.includes("COUNT(*)")) {
          const total = state.domains.length;
          const enabled = state.domains.filter((d) => d.enabled === 1).length;
          return { total, enabled } as unknown as T;
        }

        // Aliases stats
        if (upper.includes("FROM ALIASES") && upper.includes("COUNT(*)")) {
          const total = state.aliases.length;
          const enabled = state.aliases.filter((a) => a.enabled === 1).length;
          return { total, enabled } as unknown as T;
        }

        // Notification settings & push subscriptions stats
        if (upper.includes("FROM NOTIFICATION_SETTINGS")) {
          return { push_enabled: 0, telegram_enabled: 0 } as unknown as T;
        }
        if (upper.includes("FROM PUSH_SUBSCRIPTIONS")) {
          return { total: 0, count: 0 } as unknown as T;
        }

        // Admin settings lookup
        if (upper.includes("FROM ADMIN_SETTINGS")) {
          const key = binds.length > 0 ? String(binds[0]) : "send_daily_cap";
          const row = state.settings.get(key) ?? null;
          return row as unknown as T | null;
        }

        // Auth rate limits / MFA tables — return null/0 so password login proceeds cleanly
        if (
          upper.includes("LOGIN_ATTEMPTS") ||
          upper.includes("RATE_LIMIT") ||
          upper.includes("AUTH_ATTEMPTS")
        ) {
          return { count: 0, n: 0, attempts: 0 } as unknown as T;
        }

        return null;
      },

      async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
        if (upper.includes("FROM USERS")) {
          const rows = [...state.users]
            .sort((a, b) => a.created_at - b.created_at || a.email.localeCompare(b.email))
            .map((u) => {
              const mb = state.mailboxes.find((m) => m.user_id === u.id);
              return {
                id: u.id,
                email: u.email,
                display_name: u.display_name,
                role: u.role,
                status: u.status,
                verified: u.verified,
                created_at: u.created_at,
                mailbox: mb?.address ?? null,
              };
            });
          return { results: rows as unknown as T[] };
        }

        if (upper.includes("FROM MAILBOXES")) {
          const email = String(binds[0] ?? "").toLowerCase();
          const u = state.users.find((row) => row.email.toLowerCase() === email);
          const rows = u
            ? state.mailboxes.filter((m) => m.user_id === u.id).map((m) => ({ address: m.address }))
            : [];
          return { results: rows as unknown as T[] };
        }

        if (upper.includes("FROM DOMAINS")) {
          const rows = [...state.domains]
            .sort((a, b) => a.domain.localeCompare(b.domain))
            .map((d) => ({
              domain: d.domain,
              enabled: d.enabled,
              created_at: d.created_at,
              alias_count: state.aliases.filter((a) => a.domain === d.domain).length,
            }));
          return { results: rows as unknown as T[] };
        }

        if (upper.includes("FROM ALIASES")) {
          const rows = [...state.aliases]
            .sort((a, b) => b.created_at - a.created_at)
            .map((a) => ({
              id: a.id,
              local_part: a.local_part,
              domain: a.domain,
              label: a.label,
              enabled: a.enabled,
              created_by: a.created_by,
              created_at: a.created_at,
            }));
          return { results: rows as unknown as T[] };
        }

        if (upper.includes("FROM MESSAGES") && upper.includes("FOLDER = ?") && upper.includes("DATE < ?")) {
          const folder = String(binds[0] ?? "").toLowerCase();
          const cutoffMs = Number(binds[1] ?? 0);
          const mailbox = binds.length >= 3 ? String(binds[2] ?? "").toLowerCase() : null;
          const rows = state.messages
            .filter(
              (m) =>
                m.folder === folder &&
                m.date < cutoffMs &&
                (!mailbox || m.mailbox_address.toLowerCase() === mailbox),
            )
            .map((m) => ({ id: m.id, raw_key: m.raw_key }));
          return { results: rows as unknown as T[] };
        }

        if (upper.includes("FROM AUDIT_LOGS")) {
          let rows = [...state.auditLogs];
          let idx = 0;
          if (upper.includes("ACTION = ?")) {
            const action = String(binds[idx++] ?? "");
            rows = rows.filter((r) => r.action === action);
          }
          if (upper.includes("CREATED_AT < ?")) {
            const before = Number(binds[idx++] ?? Number.MAX_SAFE_INTEGER);
            rows = rows.filter((r) => r.created_at < before);
          }
          const limit = idx < binds.length ? Number(binds[idx]) : 50;
          rows.sort((a, b) => b.created_at - a.created_at);
          return { results: rows.slice(0, limit) as unknown as T[] };
        }

        return { results: [] };
      },

      async run(): Promise<{ success: boolean; meta: { changes: number } }> {
        if (upper.startsWith("UPDATE USERS SET ROLE = ?")) {
          const role = String(binds[0]) as UserRow["role"];
          const email = String(binds[1]).toLowerCase();
          const target = state.users.find((u) => u.email.toLowerCase() === email);
          if (!target) return { success: true, meta: { changes: 0 } };
          target.role = role;
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("UPDATE USERS SET STATUS = ?")) {
          const status = String(binds[0]) as UserRow["status"];
          const email = String(binds[1]).toLowerCase();
          const target = state.users.find((u) => u.email.toLowerCase() === email);
          if (!target) return { success: true, meta: { changes: 0 } };
          target.status = status;
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("UPDATE DOMAINS SET ENABLED = ?")) {
          const enabled = Number(binds[0]);
          const domain = String(binds[1]).toLowerCase();
          const target = state.domains.find((d) => d.domain.toLowerCase() === domain);
          if (!target) return { success: true, meta: { changes: 0 } };
          target.enabled = enabled;
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("UPDATE ALIASES SET ENABLED = ?")) {
          const enabled = Number(binds[0]);
          const id = String(binds[1]);
          const target = state.aliases.find((a) => a.id === id);
          if (!target) return { success: true, meta: { changes: 0 } };
          target.enabled = enabled;
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("DELETE FROM MESSAGES")) {
          const folder = String(binds[0] ?? "").toLowerCase();
          const cutoffMs = Number(binds[1] ?? 0);
          const mailbox = binds.length >= 3 ? String(binds[2] ?? "").toLowerCase() : null;
          const beforeLen = state.messages.length;
          state.messages = state.messages.filter(
            (m) =>
              !(
                m.folder === folder &&
                m.date < cutoffMs &&
                (!mailbox || m.mailbox_address.toLowerCase() === mailbox)
              ),
          );
          return { success: true, meta: { changes: beforeLen - state.messages.length } };
        }

        if (upper.startsWith("INSERT INTO AUDIT_LOGS")) {
          const [id, actor, action, target, detail, createdAt] = binds;
          state.auditLogs.push({
            id: String(id),
            actor: String(actor),
            action: String(action),
            target: String(target),
            detail: String(detail),
            created_at: Number(createdAt),
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("INSERT INTO ADMIN_SETTINGS")) {
          const value = String(binds[0]);
          const updatedAt = Number(binds[1] ?? Date.now());
          state.settings.set("send_daily_cap", {
            key: "send_daily_cap",
            value,
            updated_at: updatedAt,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("INSERT INTO MESSAGES")) {
          state.messageInserts += 1;
          const [id, mailboxAddress, , , , , , , , , , , date] = binds;
          state.messages.push({
            id: String(id),
            folder: "sent",
            mailbox_address: String(mailboxAddress),
            date: Number(date ?? Date.now()),
            is_read: 1,
            raw_key: null,
          });
          return { success: true, meta: { changes: 1 } };
        }

        return { success: true, meta: { changes: 0 } };
      },
    };
  }

  const db = {
    prepare(sql: string) {
      const base = makeStatement(sql, []);
      return {
        ...base,
        bind(...binds: unknown[]) {
          return makeStatement(sql, binds);
        },
      };
    },
  };

  return { db: db as unknown as D1Database, state };
}

async function seedDefaultUsers(passwordPlain = "Matkhau123"): Promise<UserRow[]> {
  const pwHash = await hashPassword(passwordPlain);
  return [
    {
      id: "00000000-0000-0000-0000-000000000001",
      email: SUPER_ADMIN_EMAIL,
      display_name: "Super Admin",
      password_hash: pwHash,
      role: "super_admin",
      status: "active",
      verified: 1,
      created_at: 1_700_000_000_000,
    },
    {
      id: "00000000-0000-0000-0000-000000000002",
      email: ADMIN_EMAIL,
      display_name: "Moderator",
      password_hash: pwHash,
      role: "admin",
      status: "active",
      verified: 1,
      created_at: 1_700_000_001_000,
    },
    {
      id: "00000000-0000-0000-0000-000000000003",
      email: NORMAL_USER_EMAIL,
      display_name: "Regular User",
      password_hash: pwHash,
      role: "user",
      status: "active",
      verified: 1,
      created_at: 1_700_000_002_000,
    },
    {
      id: "00000000-0000-0000-0000-000000000004",
      email: BANNED_USER_EMAIL,
      display_name: "Banned User",
      password_hash: pwHash,
      role: "user",
      status: "banned",
      verified: 1,
      created_at: 1_700_000_003_000,
    },
  ];
}

async function makeEnv(initial?: Partial<MockState>, overrides: Partial<Env> = {}) {
  const users = initial?.users ?? (await seedDefaultUsers());
  const { db, state } = createMockDb({ ...initial, users });
  const r2Bucket = {
    async delete(keys: string | string[]) {
      if (Array.isArray(keys)) {
        state.deletedR2Keys.push(...keys);
      } else {
        state.deletedR2Keys.push(keys);
      }
    },
  };

  const env: Env = {
    DB: db,
    RAW: r2Bucket as unknown as R2Bucket,
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

async function authedRequest(
  email: string,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<Request> {
  const token = await signSession(email, SECRET);
  const headers: Record<string, string> = {
    Cookie: `${SESSION_COOKIE}=${token}`,
  };
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Ban enforcement via worker handler", () => {
  it("POST /api/auth/password with banned user and correct password returns 403 account_banned without session cookie", async () => {
    const { env } = await makeEnv();
    const req = new Request("https://mail.aistockvn.com/api/auth/password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mail-Client": "1",
      },
      body: JSON.stringify({
        email: BANNED_USER_EMAIL,
        password: "Matkhau123",
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error ?? body.code).toBe("account_banned");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("POST /api/auth/password with banned user and wrong password still returns 401", async () => {
    const { env } = await makeEnv();
    const req = new Request("https://mail.aistockvn.com/api/auth/password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mail-Client": "1",
      },
      body: JSON.stringify({
        email: BANNED_USER_EMAIL,
        password: "WrongPassword999",
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("GET /api/session of a banned user returns 401", async () => {
    const { env } = await makeEnv();
    const req = await authedRequest(BANNED_USER_EMAIL, "/api/session", "GET");

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("GET /api/session of an active user returns 200 with email, mailbox, and role", async () => {
    const { env } = await makeEnv();
    const req = await authedRequest(SUPER_ADMIN_EMAIL, "/api/session", "GET");

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; mailbox: string; role: string };
    expect(body.email).toBe(SUPER_ADMIN_EMAIL);
    expect(body.role).toBe("super_admin");
  });
});

describe("Send daily rate limit and Resend failure audit", () => {
  it("POST /api/send returns 429 send_rate_limited when today's sent count >= cap without calling Resend or writing row", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const now = Date.now();
    const { env, state } = await makeEnv({
      settings: new Map([
        ["send_daily_cap", { key: "send_daily_cap", value: "2", updated_at: now }],
      ]),
      messages: [
        {
          id: "sent-1",
          folder: "sent",
          mailbox_address: SUPER_ADMIN_EMAIL,
          date: now,
          is_read: 1,
          raw_key: null,
        },
        {
          id: "sent-2",
          folder: "sent",
          mailbox_address: SUPER_ADMIN_EMAIL,
          date: now,
          is_read: 1,
          raw_key: null,
        },
      ],
    });

    const req = await authedRequest(SUPER_ADMIN_EMAIL, "/api/send", "POST", {
      to: "customer@example.com",
      subject: "Over cap",
      text: "Should be blocked",
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error ?? body.code).toBe("send_rate_limited");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.messageInserts).toBe(0);
  });

  it("POST /api/send logs a send_failed audit row when Resend returns an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("sensitive upstream body", { status: 500 })),
    );

    const { env, state } = await makeEnv();
    const req = await authedRequest(SUPER_ADMIN_EMAIL, "/api/send", "POST", {
      to: "failing@example.com",
      subject: "Upstream failure",
      text: "Hello",
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(502);

    const failedLogs = state.auditLogs.filter((l) => l.action === "send_failed");
    expect(failedLogs).toHaveLength(1);
    expect(failedLogs[0].target).toBe("failing@example.com");
    expect(failedLogs[0].detail).not.toContain("sensitive upstream body");
  });
});

describe("13 /api/admin/* routes authorization, validation, and behavior", () => {
  it("returns 403 for non-admin user on all 13 admin routes", async () => {
    const { env } = await makeEnv();
    const requests: Array<[string, "GET" | "POST", unknown?]> = [
      ["/api/admin/stats", "GET"],
      ["/api/admin/users", "GET"],
      ["/api/admin/users/role", "POST", { email: NORMAL_USER_EMAIL, role: "admin" }],
      ["/api/admin/users/status", "POST", { email: BANNED_USER_EMAIL, status: "active" }],
      ["/api/admin/domains", "GET"],
      ["/api/admin/domains/toggle", "POST", { domain: "aistockvn.com", enabled: false }],
      ["/api/admin/aliases", "GET"],
      ["/api/admin/aliases/toggle", "POST", { id: "alias-1", enabled: false }],
      ["/api/admin/mail-cleanup/preview?folder=spam&olderThanDays=30", "GET"],
      ["/api/admin/mail-cleanup", "POST", { folder: "spam", olderThanDays: 30 }],
      ["/api/admin/audit-logs", "GET"],
      ["/api/admin/settings", "GET"],
      ["/api/admin/settings", "POST", { sendDailyCap: 300 }],
    ];

    for (const [path, method, body] of requests) {
      const req = await authedRequest(NORMAL_USER_EMAIL, path, method, body);
      const res = await worker.fetch(req, env);
      expect(res.status, `Expected 403 on ${method} ${path}`).toBe(403);
    }
  });

  it("GET /api/admin/stats returns 401 when unauthenticated and 200 for admin", async () => {
    const { env } = await makeEnv();

    const unauthRes = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/admin/stats"),
      env,
    );
    expect(unauthRes.status).toBe(401);

    const adminRes = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/stats", "GET"),
      env,
    );
    expect(adminRes.status).toBe(200);
    const stats = (await adminRes.json()) as { users: { total: number } };
    expect(stats.users.total).toBe(4);
  });

  it("GET /api/admin/users lists users without exposing password_hash", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/users", "GET"),
      env,
    );
    expect(res.status).toBe(200);
    const raw = (await res.json()) as unknown;
    const users = Array.isArray(raw) ? raw : (raw as { users: unknown[] }).users;
    expect(users).toHaveLength(4);
    for (const u of users as Array<Record<string, unknown>>) {
      expect(u).not.toHaveProperty("password_hash");
      expect(u).not.toHaveProperty("passwordHash");
    }
  });

  it("POST /api/admin/users/role enforces super_admin, rejects bad role / self-change, and updates valid role", async () => {
    const { env, state } = await makeEnv();

    // Regular admin cannot change roles -> 403
    const byAdmin = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/users/role", "POST", {
        email: NORMAL_USER_EMAIL,
        role: "admin",
      }),
      env,
    );
    expect(byAdmin.status).toBe(403);

    // Invalid role -> 400
    const badRole = await worker.fetch(
      await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/users/role", "POST", {
        email: NORMAL_USER_EMAIL,
        role: "owner",
      }),
      env,
    );
    expect(badRole.status).toBe(400);

    // Self role change -> 400
    const selfChange = await worker.fetch(
      await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/users/role", "POST", {
        email: SUPER_ADMIN_EMAIL,
        role: "admin",
      }),
      env,
    );
    expect(selfChange.status).toBe(400);

    // Valid role change by super_admin -> 200
    const okRes = await worker.fetch(
      await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/users/role", "POST", {
        email: NORMAL_USER_EMAIL,
        role: "admin",
      }),
      env,
    );
    expect(okRes.status).toBe(200);
    expect(state.users.find((u) => u.email === NORMAL_USER_EMAIL)?.role).toBe("admin");
  });

  it("POST /api/admin/users/status rejects bad status / self-ban and updates valid status", async () => {
    const { env, state } = await makeEnv();

    const badStatus = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/users/status", "POST", {
        email: NORMAL_USER_EMAIL,
        status: "suspended",
      }),
      env,
    );
    expect(badStatus.status).toBe(400);

    const selfBan = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/users/status", "POST", {
        email: ADMIN_EMAIL,
        status: "banned",
      }),
      env,
    );
    expect(selfBan.status).toBe(400);

    const okRes = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/users/status", "POST", {
        email: NORMAL_USER_EMAIL,
        status: "banned",
      }),
      env,
    );
    expect(okRes.status).toBe(200);
    expect(state.users.find((u) => u.email === NORMAL_USER_EMAIL)?.status).toBe("banned");
  });

  it("GET /api/admin/domains and POST /api/admin/domains/toggle handle 404 and valid toggle", async () => {
    const { env, state } = await makeEnv();

    const listRes = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/domains", "GET"),
      env,
    );
    expect(listRes.status).toBe(200);

    const notFound = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/domains/toggle", "POST", {
        domain: "unknown.example.com",
        enabled: false,
      }),
      env,
    );
    expect(notFound.status).toBe(404);

    const okRes = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/domains/toggle", "POST", {
        domain: "aistockvn.com",
        enabled: false,
      }),
      env,
    );
    expect(okRes.status).toBe(200);
    expect(state.domains.find((d) => d.domain === "aistockvn.com")?.enabled).toBe(0);
  });

  it("GET /api/admin/aliases and POST /api/admin/aliases/toggle handle 404 and valid toggle", async () => {
    const { env, state } = await makeEnv();

    const listRes = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/aliases", "GET"),
      env,
    );
    expect(listRes.status).toBe(200);

    const notFound = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/aliases/toggle", "POST", {
        id: "nonexistent-alias-id",
        enabled: false,
      }),
      env,
    );
    expect(notFound.status).toBe(404);

    const okRes = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/aliases/toggle", "POST", {
        id: "alias-1",
        enabled: false,
      }),
      env,
    );
    expect(okRes.status).toBe(200);
    expect(state.aliases.find((a) => a.id === "alias-1")?.enabled).toBe(0);
  });

  it("GET /api/admin/mail-cleanup/preview and POST /api/admin/mail-cleanup validate inputs, preview without deleting, and execute cleanup", async () => {
    const now = Date.now();
    const oldDate = now - 60 * 86_400_000;
    const recentDate = now - 2 * 86_400_000;

    const { env, state } = await makeEnv({
      messages: [
        {
          id: "spam-old",
          folder: "spam",
          mailbox_address: SUPER_ADMIN_EMAIL,
          date: oldDate,
          is_read: 0,
          raw_key: "raw/spam-old.eml",
        },
        {
          id: "spam-new",
          folder: "spam",
          mailbox_address: SUPER_ADMIN_EMAIL,
          date: recentDate,
          is_read: 0,
          raw_key: "raw/spam-new.eml",
        },
      ],
    });

    const badPreview = await worker.fetch(
      await authedRequest(
        ADMIN_EMAIL,
        "/api/admin/mail-cleanup/preview?folder=bogus&olderThanDays=30",
        "GET",
      ),
      env,
    );
    expect(badPreview.status).toBe(400);

    const previewRes = await worker.fetch(
      await authedRequest(
        ADMIN_EMAIL,
        "/api/admin/mail-cleanup/preview?folder=spam&olderThanDays=30",
        "GET",
      ),
      env,
    );
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as { count: number };
    expect(previewBody.count).toBe(1);
    expect(state.messages).toHaveLength(2);

    const badRun = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/mail-cleanup", "POST", {
        folder: "spam",
        olderThanDays: -5,
      }),
      env,
    );
    expect(badRun.status).toBe(400);

    const runRes = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/mail-cleanup", "POST", {
        folder: "spam",
        olderThanDays: 30,
      }),
      env,
    );
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { deleted: number };
    expect(runBody.deleted).toBe(1);
    expect(state.messages.map((m) => m.id)).toEqual(["spam-new"]);
  });

  it("GET /api/admin/audit-logs lists and filters by action", async () => {
    const { env } = await makeEnv({
      auditLogs: [
        {
          id: "log-1",
          actor: SUPER_ADMIN_EMAIL,
          action: "send_failed",
          target: "a@example.com",
          detail: "500",
          created_at: 1_700_000_002_000,
        },
        {
          id: "log-2",
          actor: SUPER_ADMIN_EMAIL,
          action: "domain_toggled",
          target: "aistockvn.com",
          detail: '{"enabled":false}',
          created_at: 1_700_000_001_000,
        },
      ],
    });

    const filteredRes = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/audit-logs?action=send_failed", "GET"),
      env,
    );
    expect(filteredRes.status).toBe(200);
    const raw = (await filteredRes.json()) as unknown;
    const logs = Array.isArray(raw)
      ? raw
      : ((raw as { logs?: unknown[]; auditLogs?: unknown[] }).logs ??
        (raw as { auditLogs?: unknown[] }).auditLogs ??
        []);
    expect(logs).toHaveLength(1);
    expect((logs[0] as { action: string }).action).toBe("send_failed");
  });

  it("GET /api/admin/settings and POST /api/admin/settings validate cap and persist updates", async () => {
    const { env, state } = await makeEnv();

    const getRes = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/admin/settings", "GET"),
      env,
    );
    expect(getRes.status).toBe(200);
    const settings = (await getRes.json()) as { sendDailyCap: number; allowedEmails: string[] };
    expect(settings.sendDailyCap).toBe(200);
    expect(settings.allowedEmails).toContain(SUPER_ADMIN_EMAIL);

    for (const badCap of [0, -1, 10001, "abc"]) {
      const badRes = await worker.fetch(
        await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/settings", "POST", {
          sendDailyCap: badCap,
        }),
        env,
      );
      expect(badRes.status, `Expected 400 for sendDailyCap=${String(badCap)}`).toBe(400);
    }

    const okRes = await worker.fetch(
      await authedRequest(SUPER_ADMIN_EMAIL, "/api/admin/settings", "POST", {
        sendDailyCap: 500,
      }),
      env,
    );
    expect(okRes.status).toBe(200);
    expect(state.settings.get("send_daily_cap")?.value).toBe("500");
  });
});
