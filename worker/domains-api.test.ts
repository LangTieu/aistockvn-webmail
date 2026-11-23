import { describe, expect, it } from "vitest";
import worker from "./index";
import { signSession, SESSION_COOKIE } from "./auth";

const SHARED_MAILBOX = "admin@aistockvn.com";
const GMAIL_USER = "tranbinhanbr01@gmail.com";
const ALLOWED_EMAILS = `${GMAIL_USER},other@example.com,${SHARED_MAILBOX}`;

function createMockDb(userMailboxes: Record<string, string[]> = {}) {
  const domainStore: Record<string, { domain: string; enabled: number }> = {};
  return {
    prepare(sql: string) {
      const isOrderSelect = sql.includes("SELECT domain, enabled FROM domains ORDER BY");
      const isWhereSelect = sql.includes("SELECT domain, enabled FROM domains WHERE domain = ?");
      const isInsert = sql.includes("INSERT OR IGNORE INTO domains");
      const isUpdate = sql.includes("UPDATE domains SET enabled");
      const isMailboxesSelect = sql.includes("SELECT address FROM mailboxes");
      return {
        bind(...binds: unknown[]) {
          const domain = String(binds[0] || "").toLowerCase();
          return {
            async first<R = { domain: string; enabled: number }>() {
              if (isMailboxesSelect) {
                const email = String(binds[0] || "").toLowerCase();
                const addrs = userMailboxes[email] ?? [];
                return { results: addrs.map((address) => ({ address })) as R[] };
              }
              if (isWhereSelect) return (domainStore[domain] as R) || null;
              if (isOrderSelect) return { results: Object.values(domainStore).map((d) => ({ domain: d.domain, enabled: d.enabled === 1 })) as R[] };
              return null as R | null;
            },
            async all<R = { domain: string; enabled: number }>() {
              if (isMailboxesSelect) {
                const email = String(binds[0] || "").toLowerCase();
                const addrs = userMailboxes[email] ?? [];
                return { results: addrs.map((address) => ({ address })) as R[] };
              }
              if (isOrderSelect) return { results: Object.values(domainStore).map((d) => ({ domain: d.domain, enabled: d.enabled === 1 })) as R[] };
              return { results: [] as R[] };
            },
            meta: { changes: 0 },
            run() {
              if (isInsert) { if (!domainStore[domain]) domainStore[domain] = { domain, enabled: 1 }; }
              if (isUpdate) {
                const updateDomain = String(binds[1] || "").toLowerCase();
                const updateEnabled = binds[0] as number;
                let updateRow = domainStore[updateDomain] || null;
                if (!updateRow) {
                  const updateDomainWithoutTld = updateDomain.replace(/\.[^.]+$/, "");
                  updateRow = domainStore[updateDomainWithoutTld] || null;
                }
                if (!updateRow) {
                  updateRow = domainStore[updateDomain + ".com"] || null;
                }
                if (updateRow) {
                  updateRow.domain = updateDomain;
                  updateRow.enabled = updateEnabled;
                }
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
}

function makeEnv(initialDomains: any = {}) {
  const db = createMockDb();
  if (initialDomains) {
    Object.entries(initialDomains).forEach(([d, e]) => {
      db.prepare("INSERT OR IGNORE INTO domains (domain, enabled, created_at) VALUES (?, 1, ?)").bind(d, Date.now()).run();
    });
  }
  const env: any = {
    DB: db,
    RAW: { put: async () => new Response("ok") } as any,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    MAILBOX_ADDRESS: SHARED_MAILBOX,
    FROM_NAME: "AI Stock VN",
    ALLOWED_EMAILS,
    GOOGLE_CLIENT_ID: "",
    FORWARD_TO: "",
    RESEND_API_KEY: "re_test_dummy_key",
    SESSION_SECRET: "s".repeat(40),
  };
  return { env, db };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/domains", () => {
  it("adds a valid domain and returns 200 with the domain row", async () => {
    const { env } = makeEnv();
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ domain: "example.com" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: { domain: string; enabled: boolean } };
    expect(body.domain.domain).toBe("example.com");
    expect(body.domain.enabled).toBe(true);
  });

  it("duplicate add returns the existing row without error", async () => {
    const { env } = makeEnv({ example: { enabled: 1 } });
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    let res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ domain: "example.com" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ domain: "example.com" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid domain: missing dot", async () => {
    const { env } = makeEnv();
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ domain: "localhost" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid domain: leading dot", async () => {
    const { env } = makeEnv();
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ domain: ".example.com" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid domain: trailing dot", async () => {
    const { env } = makeEnv();
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ domain: "example.com." }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid domain: spaces", async () => {
    const { env } = makeEnv();
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ domain: "example .com" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty domain", async () => {
    const { env } = makeEnv();
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ domain: "" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated request", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1" },
        body: JSON.stringify({ domain: "test.com" }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
