import { afterEach, describe, expect, it, vi } from "vitest";
import { signSession, SESSION_COOKIE } from "./auth";
import worker from "./index";
import type { Env } from "./mail";

const SECRET = "s".repeat(40);
const SHARED_MAILBOX = "admin@aistockvn.com";
const GMAIL_USER = "tranbinhanbr01@gmail.com";
const OTHER_GMAIL_USER = "lethanhdongus@gmail.com";
const ALLOWED_EMAILS = `${GMAIL_USER},${OTHER_GMAIL_USER},${SHARED_MAILBOX}`;
const TEST_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";

interface StoredMessage {
  id: string;
  folder: "inbox" | "sent";
  mailbox_address: string;
  from_addr: string;
  from_name: string;
  to_addrs: string;
  subject: string;
  text_body: string;
  date: number;
}

function createMockDb(
  userMailboxes: Record<string, string[]>,
  initialMessages: StoredMessage[] = [],
) {
  const messages: StoredMessage[] = [...initialMessages];

  const db = {
    prepare(sql: string) {
      let boundBinds: unknown[] = [];
      return {
        bind(...binds: unknown[]) {
          boundBinds = binds;
          return {
            async all<T = Record<string, unknown>>() {
              if (sql.includes("SELECT address FROM mailboxes")) {
                const email = String(boundBinds[0] || "").toLowerCase();
                const addrs = userMailboxes[email] ?? [];
                return { results: addrs.map((address) => ({ address })) as T[] };
              }
              if (sql.toLowerCase().includes("messages_fts") && sql.toUpperCase().includes("MATCH")) {
                const matchQuery = String(boundBinds[0] || "");
                // Extract double-quoted phrases as terms (strip quotes)
                const terms: string[] = [];
                const matches = matchQuery.match(/"([^"]+)"/g) || [];
                for (const m of matches) {
                  terms.push(m.replace(/"/g, "").trim());
                }
                const folder = String(boundBinds[1] || "");
                const mailboxAddrs = (boundBinds.slice(2) || []).map((b) => String(b).toLowerCase());
                const scored = messages
                  .filter((m) => {
                    // Pre-compute lowercase fields
                    const subjectLower = (m.subject || "").toLowerCase();
                    const bodyLower = (m.text_body || "").toLowerCase();
                    const fromAddrLower = (m.from_addr || "").toLowerCase();
                    const fromNameLower = (m.from_name || "").toLowerCase();
                    
                    // Filter by folder
                    if (m.folder !== folder) return false;
                    // Filter by mailbox_address
                    if (!mailboxAddrs.some((a) => a === m.mailbox_address.toLowerCase()) && mailboxAddrs.length > 0) return false;
                    // Must match ALL terms (AND)
                    if (terms.length === 0) return false;
                    const termMatches = terms.every((term) => {
                      const termLower = term.toLowerCase();
                      return (
                        subjectLower.includes(termLower) ||
                        bodyLower.includes(termLower) ||
                        fromAddrLower.includes(termLower) ||
                        fromNameLower.includes(termLower)
                      );
                    });
                    if (!termMatches) return false;
                    // Count how many terms match for relevance ordering
                    let matchedCount = 0;
                    for (const term of terms) {
                      const termLower = term.toLowerCase();
                      if (
                        subjectLower.includes(termLower) ||
                        bodyLower.includes(termLower) ||
                        fromAddrLower.includes(termLower) ||
                        fromNameLower.includes(termLower)
                      ) {
                        matchedCount++;
                      }
                    }
                    return { ...m, _matchedCount: matchedCount };
                  })
                  .sort((a, b) => {
                    const aCount = a._matchedCount ?? 0;
                    const bCount = b._matchedCount ?? 0;
                    if (aCount !== bCount) return bCount - aCount;
                    return b.date - a.date;
                  })
                  .map((m) => {
                    const { _matchedCount, ...rest } = m;
                    return rest as unknown as T[];
                  });
                return { results: scored };
              }
              if (sql.includes("FROM messages WHERE")) {
                const folder = String(boundBinds[0]);
                const before = Number(boundBinds[1]);
                if (sql.includes("AND 1=0")) {
                  return { results: [] as T[] };
                }
                const allowedMailboxes = boundBinds.slice(2).map((b) => String(b).toLowerCase());
                const filtered = messages
                  .filter(
                    (m) =>
                      m.folder === folder &&
                      m.date < before &&
                      allowedMailboxes.includes(m.mailbox_address.toLowerCase()),
                  )
                  .sort((a, b) => b.date - a.date);
                return { results: filtered as unknown as T[] };
              }
              return { results: [] as T[] };
            },
            async first<T = Record<string, unknown>>() {
              if (sql.includes("SELECT COUNT(*) AS n FROM messages")) {
                if (sql.includes("1=0 AND")) {
                  return { n: 0 } as T;
                }
                const allowedMailboxes = boundBinds.map((b) => String(b).toLowerCase());
                const count = messages.filter(
                  (m) =>
                    m.folder === "inbox" &&
                    m.is_read === 0 &&
                    allowedMailboxes.includes(m.mailbox_address.toLowerCase()),
                ).length;
                return { n: count } as T;
              }
              if (sql.includes("SELECT COUNT(*) AS total") && sql.includes("messages_fts")) {
                if (sql.includes("1=0 AND")) {
                  return { total: 0 } as T;
                }
                const ftsQuery = String(boundBinds[0] || "");
                const folder = String(boundBinds[1] || "");
                const mailboxAddrs = (boundBinds.slice(2) || []).map((b) => String(b).toLowerCase());
                // Extract double-quoted terms from the FTS query
                const terms: string[] = [];
                const matches = ftsQuery.match(/"([^"]+)"/g) || [];
                for (const m of matches) {
                  terms.push(m.replace(/"/g, "").trim());
                }
                const count = messages.filter((m) => {
                  const subjectLower = (m.subject || "").toLowerCase();
                  const bodyLower = (m.text_body || "").toLowerCase();
                  const fromAddrLower = (m.from_addr || "").toLowerCase();
                  const fromNameLower = (m.from_name || "").toLowerCase();
                  // Must match ALL terms (AND)
                  if (terms.length === 0) return false;
                  const termMatches = terms.every((term) => {
                    const termLower = term.toLowerCase();
                    return (
                      subjectLower.includes(termLower) ||
                      bodyLower.includes(termLower) ||
                      fromAddrLower.includes(termLower) ||
                      fromNameLower.includes(termLower)
                    );
                  });
                  if (!termMatches) return false;
                  // Filter by folder
                  if (m.folder !== folder) return false;
                  // Filter by mailbox_address
                  if (!mailboxAddrs.includes(m.mailbox_address.toLowerCase())) return false;
                  return true;
                }).length;
                return { total: count } as T;
              }
              if (sql.includes("SELECT * FROM messages WHERE id = ?")) {
                const id = String(boundBinds[0]);
                const found = messages.find((m) => m.id === id) ?? null;
                return found as unknown as T | null;
              }
              return null as T | null;
            },
          };
        },
      };
    },
  };

  return { db: db as unknown as D1Database, inserts: [] as any, messages };
}

function makeEnv(
  overrides: Partial<Env> = {},
  userMailboxes: Record<string, string[]> = {
    [GMAIL_USER]: [],
    [OTHER_GMAIL_USER]: [],
    [SHARED_MAILBOX]: [SHARED_MAILBOX],
  },
  initialMessages: StoredMessage[] = [],
): { env: Env; inserts: any; messages: StoredMessage[] } {
  const { db, inserts, messages } = createMockDb(userMailboxes, initialMessages);
  const env: Env = {
    DB: db,
    RAW: {} as R2Bucket,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } as unknown as Fetcher,
    MAILBOX_ADDRESS: SHARED_MAILBOX,
    FROM_NAME: "AI Stock VN",
    ALLOWED_EMAILS,
    GOOGLE_CLIENT_ID: "",
    FORWARD_TO: "",
    RESEND_API_KEY: "re_test_dummy_key",
    ENCRYPTION_KEY: TEST_KEY_B64,
    SESSION_SECRET: SECRET,
    ...overrides,
  };
  return { env, inserts, messages };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/search FTS endpoint", () => {
  function makeSearchEnv(
    userMailboxes: Record<string, string[]> = {
      [GMAIL_USER]: [],
      [OTHER_GMAIL_USER]: [],
      [SHARED_MAILBOX]: [SHARED_MAILBOX],
    },
    initialMessages: StoredMessage[] = [],
  ) {
    return makeEnv({}, userMailboxes, initialMessages);
  }

  it("returns 400 when q is missing", async () => {
    const { env } = makeSearchEnv();
    const token = await signSession(GMAIL_USER, SECRET);
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when q is empty after trim", async () => {
    const { env } = makeSearchEnv();
    const token = await signSession(GMAIL_USER, SECRET);
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=&folder=inbox", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 200 with empty items for operator-only query", async () => {
    const { env } = makeSearchEnv();
    const token = await signSession(GMAIL_USER, SECRET);
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=*^( )&folder=inbox", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: any[]; total: number };
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("returns matching messages ordered by relevance; non-matching excluded", async () => {
    const inboundId = "msg-001";
    const messages: StoredMessage[] = [
      {
        id: inboundId,
        folder: "inbox",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "client@example.com",
        from_name: "Client",
        to_addrs: "[]",
        subject: "Invoice payment",
        text_body: "Payment of $500 is due",
        date: Date.now() - 1000,
      },
      {
        id: "msg-002",
        folder: "inbox",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "boss@example.com",
        from_name: "Boss",
        to_addrs: "[]",
        subject: "Meeting agenda",
        text_body: "Discuss Q4 plans",
        date: Date.now() - 2000,
      },
    ];
    const { env } = makeSearchEnv({}, messages);
    const token = await signSession(GMAIL_USER, SECRET);
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=invoice&folder=inbox", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: any[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].subject).toBe("Invoice payment");
    expect(body.total).toBe(1);
  });

  it("finds full-text content and returns no items for an absent term", async () => {
    const messages: StoredMessage[] = [
      {
        id: "msg-hello-r3",
        folder: "inbox",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "sender@example.com",
        from_name: "Sender",
        to_addrs: "[]",
        subject: "A welcome note",
        text_body: "hello R3 from the full text body",
        date: Date.now(),
      },
    ];
    const { env } = makeSearchEnv({}, messages);
    const token = await signSession(GMAIL_USER, SECRET);
    const headers = { Cookie: `${SESSION_COOKIE}=${token}` };

    const found = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=hello%20R3&folder=inbox", { headers }),
      env,
    );
    expect(found.status).toBe(200);
    const foundBody = (await found.json()) as { items: any[]; total: number };
    expect(foundBody.items.map((item) => item.id)).toContain("msg-hello-r3");
    expect(foundBody.total).toBe(1);

    const absent = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=missingterm&folder=inbox", { headers }),
      env,
    );
    expect(absent.status).toBe(200);
    const absentBody = (await absent.json()) as { items: any[]; total: number };
    expect(absentBody.items).toHaveLength(0);
    expect(absentBody.total).toBe(0);
  });

  it("keeps FTS search results mapped to MessageItem addresses", async () => {
    const { env } = makeSearchEnv({}, [{
      id: "msg-backblaze",
      folder: "inbox",
      mailbox_address: SHARED_MAILBOX,
      from_addr: "alerts@backblaze.com",
      from_name: "Backblaze",
      to_addrs: "[]",
      subject: "Backblaze restore complete",
      text_body: "Your restore is ready",
      date: Date.now(),
    }]);
    const token = await signSession(GMAIL_USER, SECRET);
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=Backblaze&folder=inbox", {
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ from?: { address?: unknown } }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].from?.address).toBe("alerts@backblaze.com");
    expect(typeof body.items[0].from?.address).toBe("string");
  });

  it("mailbox scoping: message in another mailbox is NOT returned; user with no mailbox rows still sees shared mailbox results", async () => {
    const privateMsgId = "msg-private";
    const messages: StoredMessage[] = [
      {
        id: privateMsgId,
        folder: "inbox",
        mailbox_address: OTHER_GMAIL_USER,
        from_addr: "secret@example.com",
        from_name: "Secret",
        to_addrs: "[]",
        subject: "Private Only",
        text_body: "Secret body",
        date: Date.now() - 500,
      },
      {
        id: "msg-shared",
        folder: "inbox",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "admin@example.com",
        from_name: "Admin",
        to_addrs: "[]",
        subject: "Shared message",
        text_body: "Shared body",
        date: Date.now() - 1000,
      },
    ];
    const { env } = makeSearchEnv(
      {
        [GMAIL_USER]: [GMAIL_USER],
        [OTHER_GMAIL_USER]: [OTHER_GMAIL_USER],
        [SHARED_MAILBOX]: [SHARED_MAILBOX],
      },
      messages,
    );
    const token = await signSession(GMAIL_USER, SECRET);
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=shared&folder=inbox", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: any[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].subject).toBe("Shared message");
    expect(body.total).toBe(1);
  });

  it("folder filter: folder=sent returns only sent", async () => {
    const sentId = "msg-sent-001";
    const messages: StoredMessage[] = [
      {
        id: sentId,
        folder: "sent",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "admin@example.com",
        from_name: "Admin",
        to_addrs: "[]",
        subject: "Sent email",
        text_body: "Sent body",
        date: Date.now() - 1000,
      },
    ];
    const { env } = makeSearchEnv({}, messages);
    const token = await signSession(GMAIL_USER, SECRET);
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=sent&folder=sent", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: any[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].subject).toBe("Sent email");
    expect(body.total).toBe(1);
  });

  it("FTS injection attempt (subject:urgent* OR 1=1) returns 200 with safe sanitized matching", async () => {
    const injectId = "msg-inject";
    const messages: StoredMessage[] = [
      {
        id: injectId,
        folder: "inbox",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "test@example.com",
        from_name: "Test",
        to_addrs: "[]",
        subject: "Urgent meeting",
        text_body: "Meeting at 3pm",
        date: Date.now() - 1000,
      },
    ];
    const { env } = makeSearchEnv({}, messages);
    const token = await signSession(GMAIL_USER, SECRET);
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=subject:urgent*%20OR%201=1&folder=inbox", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: any[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("Vietnamese diacritics query matches (e.g. Hóa đơn)", async () => {
    const vietnamId = "msg-vietnam";
    const messages: StoredMessage[] = [
      {
        id: vietnamId,
        folder: "inbox",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "test@example.com",
        from_name: "Test",
        to_addrs: "[]",
        subject: "Hóa đơn tháng 11",
        text_body: "Thông báo hóa đơn",
        date: Date.now() - 1000,
      },
    ];
    const { env } = makeSearchEnv({}, messages);
    const token = await signSession(GMAIL_USER, SECRET);
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=Hóa%20đơn&folder=inbox", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: any[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});
