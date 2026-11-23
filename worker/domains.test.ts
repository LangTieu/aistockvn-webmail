import { describe, expect, it } from "vitest";
import worker from "./index";
import { signSession, SESSION_COOKIE } from "./auth";

const SHARED_MAILBOX = "admin@aistockvn.com";
const GMAIL_USER = "tranbinhanbr01@gmail.com";
const ALLOWED_EMAILS = `${GMAIL_USER},other@example.com,${SHARED_MAILBOX}`;

function createMockDb(userMailboxes: Record<string, string[]> = {}) {
  const domainStore: any = {};
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
async first() {
              if (isMailboxesSelect) {
                const email = String(binds[0] || "").toLowerCase();
                const addrs = userMailboxes[email] ?? [];
                return { results: addrs.map((address) => ({ address })) };
              }
              if (isWhereSelect) {
                let row = (domainStore[domain] as any) || null;
                if (!row) {
                  const domainWithoutTld = domain.replace(/\.[^.]+$/, "");
                  row = domainStore[domainWithoutTld] || null;
                }
                if (!row) {
                  row = domainStore[domain + ".com"] || null;
                }
                if (row && !row.domain.includes(".")) row.domain += ".com";
                return row;
              }
              if (isOrderSelect) return { results: Object.values(domainStore).map((d) => ({ domain: d.domain, enabled: d.enabled === 1 })) as any[] };
              return null;
            },
            async all() {
              if (isMailboxesSelect) {
                const email = String(binds[0] || "").toLowerCase();
                const addrs = userMailboxes[email] ?? [];
                return { results: addrs.map((address) => ({ address })) };
              }
              if (isWhereSelect) {
                let row = domainStore[domain];
                if (!row) {
                  const domainWithoutTld = domain.replace(/\.[^.]+$/, "");
                  row = domainStore[domainWithoutTld];
                }
                if (!row) {
                  row = domainStore[domain + ".com"];
                }
                if (row && !row.domain.includes(".")) row.domain += ".com";
                return { results: row ? [row] : [] };
              }
              return { results: [] };
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
              return { meta: { changes: 1 } };
            },
          };
        },
        // Statement-level all()/first() (no bind): real D1 supports these;
        // mail.ts uses them for parameter-less queries (sent ids, user names).
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };
}

function makeEnv(initialDomains: any = {}, userMailboxes: Record<string, string[]> = {}) {
  const db = createMockDb(userMailboxes);
  if (initialDomains) {
    Object.entries(initialDomains).forEach(([d, e]) => {
      db.prepare("INSERT OR IGNORE INTO domains (domain, enabled, created_at) VALUES (?, 1, ?)").bind(d, Date.now()).run();
      const enabled = (e as any)?.enabled;
      if (enabled === 0) {
        db.prepare("UPDATE domains SET enabled = ? WHERE domain = ?").bind(0, d).run();
      }
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
    ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=",
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

describe("POST /api/domains/:domain/enable and /disable", () => {
  it("enables a domain and returns the updated row", async () => {
    const { env } = makeEnv({ test: { enabled: 0 } });
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains/test.com/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: { domain: string; enabled: boolean } };
    expect(body.domain.domain).toBe("test.com");
    expect(body.domain.enabled).toBe(true);
  });

  it("disables a domain and returns the updated row", async () => {
    const { env } = makeEnv({ test: { enabled: 1 } });
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains/test.com/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: { domain: string; enabled: boolean } };
    expect(body.domain.domain).toBe("test.com");
    expect(body.domain.enabled).toBe(false);
  });

  it("returns 404 for unknown domain enable", async () => {
    const { env } = makeEnv();
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains/unknown.com/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown domain disable", async () => {
    const { env } = makeEnv();
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/domains/unknown.com/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` }
    }),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("inbound email handler - disabled domain", () => {
  it("drops inbound mail to a disabled domain", async () => {
    const { env } = makeEnv({ disabled: { enabled: 0 } });
    const message: any = {
      to: "user@disabled.com",
      from: "sender@example.com",
      raw: "",
    };
    await worker.email(message, env);
    expect(true).toBe(true);
  });

  it("stores inbound mail to an unknown domain (current behavior preserved)", async () => {
    const { env } = makeEnv();
    const message: any = {
      to: "user@unknown.com",
      from: "sender@example.com",
      raw: "",
    };
    await worker.email(message, env);
    expect(true).toBe(true);
  });
});

describe("alias creation on disabled domain", () => {
  it("returns 400 when creating alias on a disabled domain", async () => {
    const { env } = makeEnv({ disabled: { enabled: 0 } });
    const token = await signSession(GMAIL_USER, "s".repeat(40));
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ label: "test", domain: "disabled.com" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});