import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { signSession, SESSION_COOKIE } from "./auth";
import { encryptText, decryptText, isEncrypted, getEncryptionKey } from "./crypto";
import type { Env } from "./mail";

const SECRET = "s".repeat(40);
const SHARED_MAILBOX = "admin@aistockvn.com";
const GMAIL_USER = "tranbinhanbr01@gmail.com";
const OTHER_GMAIL_USER = "lethanhdongus@gmail.com";
const ALLOWED_EMAILS = `${GMAIL_USER},${OTHER_GMAIL_USER},${SHARED_MAILBOX}`;
const TEST_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";

interface CapturedInsert {
  sql: string;
  binds: unknown[];
}

interface StoredMessage {
  id: string;
  folder: "inbox" | "sent";
  mailbox_address: string;
  from_addr: string;
  from_name: string;
  to_addrs: string;
  cc_addrs: string;
  subject: string;
  snippet: string;
  text_body: string;
  html_body: string | null;
  date: number;
  is_read: number;
  attachments: string;
  raw_key: string | null;
  resend_id: string | null;
  reply_to: string | null;
  message_id: string | null;
  references_hdr: string | null;
  in_reply_to?: string | null;
}

interface MockAliasRow {
  local_part: string;
  domain: string;
  enabled: number;
}

interface MockDomainRow {
  domain: string;
  enabled: number;
}

const INBOUND_ID = "11111111-1111-4111-8111-111111111111";

function createMockDb(
  userMailboxes: Record<string, string[]> = {
    [GMAIL_USER]: [],
    [OTHER_GMAIL_USER]: [],
    [SHARED_MAILBOX]: [SHARED_MAILBOX],
  },
  initialMessages: StoredMessage[] = [],
  aliases: MockAliasRow[] = [],
  domains: MockDomainRow[] = [],
) {
  const inserts: CapturedInsert[] = [];
  const messages: StoredMessage[] = [...initialMessages];

  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all<T = Record<string, unknown>>() {
              if (sql.includes("SELECT address FROM mailboxes")) {
                const email = String(binds[0] || "").toLowerCase();
                const addrs = userMailboxes[email] ?? [];
                return { results: addrs.map((address: string) => ({ address })) as T[] };
              }
              if (sql.toLowerCase().includes("messages_fts") && sql.toUpperCase().includes("MATCH")) {
                const matchQuery = String(binds[0] || "");
                const terms: string[] = [];
                const matches = matchQuery.match(/"([^"]+)"/g) || [];
                for (const m of matches) {
                  terms.push(m.replace(/"/g, "").trim());
                }
                const folder = String(binds[1] || "");
                const mailboxAddrs = (binds.slice(2) || []).map((b: unknown) => String(b).toLowerCase());
                const scored = messages
                  .filter((m: StoredMessage) => {
                    const subjectLower = (m.subject || "").toLowerCase();
                    const bodyLower = (m.text_body || "").toLowerCase();
                    const fromAddrLower = (m.from_addr || "").toLowerCase();
                    const fromNameLower = (m.from_name || "").toLowerCase();
                    if (m.folder !== folder) return false;
                    if (!mailboxAddrs.some((a) => a === m.mailbox_address.toLowerCase()) && mailboxAddrs.length > 0) return false;
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
                    const aCount = (a as any)._matchedCount ?? 0;
                    const bCount = (b as any)._matchedCount ?? 0;
                    if (aCount !== bCount) return bCount - aCount;
                    return b.date - a.date;
                  })
                  .map((m: StoredMessage) => {
                    const { _matchedCount, ...rest } = m as any;
                    return rest as unknown as T[];
                  });
                return { results: scored };
              }
              if (sql.toLowerCase().includes("text_body like 'enc:v1:%'")) {
                const folder = String(binds[0]);
                const hasDate = sql.includes("date < ?");
                const before = hasDate ? Number(binds[1]) : undefined;
                const allowedMailboxes = hasDate ? binds.slice(2) : binds.slice(1);
                const filtered = messages.filter(
                  (m: StoredMessage) =>
                    m.folder === folder &&
                    (hasDate ? m.date < before! : true) &&
                    allowedMailboxes.includes(m.mailbox_address.toLowerCase()),
                );
                return { results: filtered as unknown as T[] };
              }
              if (sql.toLowerCase().includes("from messages where")) {
                const folder = String(binds[0]);
                const before = Number(binds[1]);
                if (sql.includes("AND 1=0")) {
                  return { results: [] as T[] };
                }
                const allowedMailboxes = binds.slice(2).map((b: unknown) => String(b).toLowerCase());
                const filtered = messages.filter(
                  (m: StoredMessage) =>
                    m.folder === folder &&
                    m.date < before &&
                    allowedMailboxes.includes(m.mailbox_address.toLowerCase()),
                ).sort((a: StoredMessage, b: StoredMessage) => b.date - a.date);
                return { results: filtered as unknown as T[] };
              }
              if (sql.includes("SELECT * FROM messages WHERE id = ?")) {
                const id = String(binds[0]);
                const found = messages.find((m: StoredMessage) => m.id === id) ?? null;
                return found as unknown as T | null;
              }
              if (sql.includes("SELECT message_id, references_hdr FROM messages")) {
                if (sql.includes("AND 1=0")) {
                  return null;
                }
                const id = String(binds[0]);
                const allowedMailboxes = binds.slice(1).map((b: unknown) => String(b).toLowerCase());
                const found = messages.find(
                  (m: StoredMessage) => m.id === id && allowedMailboxes.includes(m.mailbox_address.toLowerCase()),
                );
                return (found
                  ? { message_id: found.message_id, references_hdr: found.references_hdr }
                  : null) as T | null;
              }
              if (sql.toLowerCase().includes("join messages_fts")) {
                const ftsQuery = String(binds[0] || "").toLowerCase().replace(/"/g, "").trim();
                const folder = String(binds[1] || "").toLowerCase();
                const allowedMailboxes = binds.slice(2).map((b: unknown) => String(b).toLowerCase());
                if (sql.toLowerCase().includes("count(*)")) {
                  const count = messages.filter(
                    (m: StoredMessage) =>
                      m.folder === folder &&
                      allowedMailboxes.includes(m.mailbox_address.toLowerCase()) &&
                      ((ftsQuery && (m.subject || "").toLowerCase().includes(ftsQuery)) || !ftsQuery),
                  ).length;
                  return { total: count } as T;
                }
                const matched = messages.filter(
                  (m: StoredMessage) =>
                    m.folder === folder &&
                    allowedMailboxes.includes(m.mailbox_address.toLowerCase()) &&
                    ((ftsQuery && (m.subject || "").toLowerCase().includes(ftsQuery)) || !ftsQuery),
                );
                return { results: matched.slice(0, 31) as unknown as T[] };
              }
              if (sql.toLowerCase().includes("select count(*) as n from messages")) {
                if (sql.includes("1=0 AND")) {
                  return { n: 0 } as T;
                }
                const allowedMailboxes = binds.map((b: unknown) => String(b).toLowerCase());
                const count = messages.filter(
                  (m: StoredMessage) =>
                    m.folder === "inbox" &&
                    m.is_read === 0 &&
                    allowedMailboxes.includes(m.mailbox_address.toLowerCase()),
                ).length;
                return { n: count } as T;
              }
              return { results: [] as T[] };
            },
            async first<T = Record<string, unknown>>() {
              if (sql.toLowerCase().includes("from aliases")) {
                const localPart = String(binds[0] || "").toLowerCase();
                const domain = String(binds[1] || "").toLowerCase();
                const found = aliases.find(
                  (a) => a.local_part.toLowerCase() === localPart && a.domain.toLowerCase() === domain,
                );
                return (found ?? null) as unknown as T | null;
              }
              if (sql.toLowerCase().includes("from domains")) {
                const domain = String(binds[0] || "").toLowerCase();
                const found = domains.find((d) => d.domain.toLowerCase() === domain);
                return (found ?? null) as unknown as T | null;
              }
              if (sql.toLowerCase().includes("count(*)")) {
                if (sql.toLowerCase().includes("1=0 and")) {
                  return { n: 0 } as T;
                }
                if (sql.toLowerCase().includes("join messages_fts")) {
                  const allowedMailboxes = binds.slice(2).map((b: unknown) => String(b).toLowerCase());
                  const ftsQuery = String(binds[0] || "").toLowerCase().replace(/"/g, "").trim();
                  const folder = String(binds[1] || "").toLowerCase();
                  const count = messages.filter(
                    (m: StoredMessage) =>
                      m.folder === folder &&
                      allowedMailboxes.includes(m.mailbox_address.toLowerCase()) &&
                      ((ftsQuery && (m.subject || "").toLowerCase().includes(ftsQuery)) || !ftsQuery),
                  ).length;
                  return { total: count } as T;
                }
                const allowedMailboxes = binds.map((b: unknown) => String(b).toLowerCase());
                const count = messages.filter(
                  (m: StoredMessage) =>
                    m.folder === "inbox" &&
                    m.is_read === 0 &&
                    allowedMailboxes.includes(m.mailbox_address.toLowerCase()),
                ).length;
                return { n: count } as T;
              }
              if (sql.toLowerCase().includes("select count(*) as n from messages")) {
                if (sql.includes("1=0 AND")) {
                  return { n: 0 } as T;
                }
                const allowedMailboxes = binds.map((b: unknown) => String(b).toLowerCase());
                const count = messages.filter(
                  (m: StoredMessage) =>
                    m.folder === "inbox" &&
                    m.is_read === 0 &&
                    allowedMailboxes.includes(m.mailbox_address.toLowerCase()),
                ).length;
                return { n: count } as T;
              }
              if (sql.includes("SELECT * FROM messages WHERE id = ?")) {
                const id = String(binds[0]);
                const found = messages.find((m: StoredMessage) => m.id === id) ?? null;
                return found as unknown as T | null;
              }
              return null as T | null;
            },
            async run() {
              if (sql.includes("INSERT INTO messages")) {
                inserts.push({ sql, binds });
                const [
                  id,
                  mailboxAddress,
                  inReplyTo,
                  referencesHdr,
                  fromAddr,
                  fromName,
                  toAddrs,
                  ccAddrs,
                  subject,
                  snippet,
                  textBody,
                  htmlBody,
                  date,
                  resendId,
                ] = binds;
                messages.push({
                  id: String(id),
                  folder: "sent",
                  mailbox_address: String(mailboxAddress),
                  in_reply_to: (inReplyTo as string | null) ?? null,
                  references_hdr: (referencesHdr as string | null) ?? null,
                  message_id: null,
                  from_addr: String(fromAddr),
                  from_name: String(fromName),
                  to_addrs: String(toAddrs),
                  cc_addrs: String(ccAddrs),
                  reply_to: null,
                  subject: String(subject),
                  snippet: String(snippet),
                  text_body: String(textBody),
                  html_body: (htmlBody as string | null) ?? null,
                  date: Number(date),
                  is_read: 1,
                  attachments: "[]",
                  raw_key: null,
                  resend_id: String(resendId),
                });
              }
              if (sql.includes("UPDATE messages SET is_read = 1 WHERE id = ?")) {
                const id = String(binds[0]);
                const target = messages.find((m: StoredMessage) => m.id === id);
                if (target) target.is_read = 1;
              }
              return { success: true };
            },
          };
        },
      };
    },
  };

  return { db: db as unknown as D1Database, inserts, messages };
}

function makeEnv(
  overrides: Partial<Env> = {},
  userMailboxes: Record<string, string[]> = {
    [GMAIL_USER]: [],
    [OTHER_GMAIL_USER]: [],
    [SHARED_MAILBOX]: [SHARED_MAILBOX],
  },
  initialMessages: StoredMessage[] = [],
  aliases: MockAliasRow[] = [],
  domains: MockDomainRow[] = [],
): { env: Env; inserts: CapturedInsert[]; messages: StoredMessage[] } {
  const { db, inserts, messages } = createMockDb(userMailboxes, initialMessages, aliases, domains);
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Decrypt-read coverage", () => {
  it(
    "1. Send encrypts POST api send with ENCRYPTION_KEY 200 captured INSERT binds text_body starting with enc:v1 decryptText returns original plaintext",
    async () => {
    const capturedCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedCalls.push({ url: String(input), init });
        return new Response(JSON.stringify({ id: "resend_msg_001" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const { env, inserts } = makeEnv();
    const token = await signSession(GMAIL_USER, SECRET);
    const plaintext = "hello world this is a test body";
    const req = new Request("https://mail.aistockvn.com/api/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mail-Client": "1",
        Cookie: `${SESSION_COOKIE}=${token}`,
      },
      body: JSON.stringify({
        to: "customer@example.com",
        subject: "Test subject",
        text: plaintext,
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { id: string; resendId: string };
    expect(typeof resBody.id).toBe("string");
    expect(typeof resBody.resendId).toBe("string");

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].url).toBe("https://api.resend.com/emails");

    expect(inserts).toHaveLength(1);
    const [, , , , , , , , , , textBody] = inserts[0].binds;
    expect(textBody).toMatch(/^enc:v1:/);

    const key = await getEncryptionKey(env);
    const decrypted = await decryptText(String(textBody), key);
    expect(decrypted).toBe(plaintext);
  });

  it(
    "2. Send without key POST api send env lacking ENCRYPTION_KEY 503 Resend fetch mock NOT called",
    async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { env } = makeEnv({ ENCRYPTION_KEY: undefined });
    const token = await signSession(GMAIL_USER, SECRET);
    const req = new Request("https://mail.aistockvn.com/api/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mail-Client": "1",
        Cookie: `${SESSION_COOKIE}=${token}`,
      },
      body: JSON.stringify({
        to: "customer@example.com",
        subject: "Should fail",
        text: "Body",
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it(
    "3. Detail GET decrypts seeded encrypted row valid UUID GET api messages id 200 returned text equals plaintext",
    async () => {
    const encId = "11111111-1111-4111-8111-111111111111";
    const { env } = makeEnv({}, undefined, [
      {
        id: encId,
        folder: "inbox",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "sender@example.com",
        from_name: "Sender",
        to_addrs: "[]",
        cc_addrs: "[]",
        subject: "Secret",
        snippet: "hello secret world",
        text_body: await encryptText("hello secret world", await getEncryptionKey({ ENCRYPTION_KEY: TEST_KEY_B64 } as any)),
        html_body: null,
        date: Date.now() - 1000,
        is_read: 0,
        attachments: "[]",
        raw_key: null,
        resend_id: null,
        reply_to: null,
        message_id: null,
        references_hdr: null,
      },
    ]);
    const token = await signSession(GMAIL_USER, SECRET);

    const res = await worker.fetch(
      new Request(`https://mail.aistockvn.com/api/messages/${encId}`, {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; subject: string; text: string };
    expect(body.id).toBe(encId);
    expect(body.subject).toBe("Secret");
    expect(body.text).toBe("hello secret world");
  });

  it(
    "4. Detail GET legacy plaintext seeded plain row GET returns it unchanged env has a key",
    async () => {
    const encId = "22222222-2222-4222-8222-222222222222";
    const { env } = makeEnv({}, undefined, [
      {
        id: encId,
        folder: "inbox",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "sender@example.com",
        from_name: "Sender",
        to_addrs: "[]",
        cc_addrs: "[]",
        subject: "Legacy",
        snippet: "hello legacy world",
        text_body: "hello legacy world",
        html_body: null,
        date: Date.now() - 1000,
        is_read: 0,
        attachments: "[]",
        raw_key: null,
        resend_id: null,
        reply_to: null,
        message_id: null,
        references_hdr: null,
      },
    ]);
    const token = await signSession(GMAIL_USER, SECRET);

    const res = await worker.fetch(
      new Request(`https://mail.aistockvn.com/api/messages/${encId}`, {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; subject: string; text: string };
    expect(body.id).toBe(encId);
    expect(body.subject).toBe("Legacy");
    expect(body.text).toBe("hello legacy world");
  });

  it(
    "5. List q= decrypt-match seeded encrypted row plaintext contains invoice in inbox plus one plain row in sent items include encrypted row once",
    async () => {
    const encId = "33333333-3333-4333-8333-333333333333";
    const { env } = makeEnv({}, undefined, [
      {
        id: encId,
        folder: "inbox",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "vendor@example.com",
        from_name: "Vendor",
        to_addrs: "[]",
        cc_addrs: "[]",
        subject: "Invoice",
        snippet: "invoice payment $500",
        text_body: await encryptText("invoice payment $500", await getEncryptionKey({ ENCRYPTION_KEY: TEST_KEY_B64 } as any)),
        html_body: null,
        date: Date.now() - 1000,
        is_read: 0,
        attachments: "[]",
        raw_key: null,
        resend_id: null,
        reply_to: null,
        message_id: null,
        references_hdr: null,
      },
      {
        id: "msg-plain-invoice-001",
        folder: "sent",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "client@example.com",
        from_name: "Client",
        to_addrs: "[]",
        cc_addrs: "[]",
        subject: "Invoice payment",
        snippet: "Invoice payment",
        text_body: "Invoice due $500",
        html_body: null,
        date: Date.now() - 2000,
        is_read: 1,
        attachments: "[]",
        raw_key: null,
        resend_id: null,
        reply_to: null,
        message_id: null,
        references_hdr: null,
      },
    ]);
    const token = await signSession(GMAIL_USER, SECRET);

    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/messages?q=invoice&folder=inbox", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; subject: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(encId);
    expect(body.items[0].subject).toBe("Invoice");
  });

  it(
    "6. Search decrypt-match seeded encrypted row plaintext contains invoice plus one plain row matching invoice via FTS total 2 items length 2 ids distinct",
    async () => {
    const encId = "44444444-4444-4444-8444-444444444444";
    const { env } = makeEnv({}, undefined, [
      {
        id: encId,
        folder: "inbox",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "vendor@example.com",
        from_name: "Vendor",
        to_addrs: "[]",
        cc_addrs: "[]",
        subject: "Invoice",
        snippet: "invoice payment $500",
        text_body: await encryptText("invoice payment $500", await getEncryptionKey({ ENCRYPTION_KEY: TEST_KEY_B64 } as any)),
        html_body: null,
        date: Date.now() - 1000,
        is_read: 0,
        attachments: "[]",
        raw_key: null,
        resend_id: null,
        reply_to: null,
        message_id: null,
        references_hdr: null,
      },
      {
        id: "msg-plain-invoice-001",
        folder: "inbox",
        mailbox_address: SHARED_MAILBOX,
        from_addr: "client@example.com",
        from_name: "Client",
        to_addrs: "[]",
        cc_addrs: "[]",
        subject: "Invoice payment",
        snippet: "Invoice payment",
        text_body: "Invoice due $500",
        html_body: null,
        date: Date.now() - 2000,
        is_read: 0,
        attachments: "[]",
        raw_key: null,
        resend_id: null,
        reply_to: null,
        message_id: null,
        references_hdr: null,
      },
    ]);
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
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    const ids = new Set(body.items.map((r: any) => r.id));
    expect(ids.size).toBe(2);
  });

  it(
    "7. Regression: sending from an alias stores mailbox_address as sharedMailbox, keeps from_addr as alias, and is visible in Sent list, search, and detail",
    async () => {
    const aliasAddr = "contextdev-yp9x@aistockvn.com";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "resend_alias_001" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { env, inserts } = makeEnv(
      {},
      undefined,
      [],
      [{ local_part: "contextdev-yp9x", domain: "aistockvn.com", enabled: 1 }],
      [{ domain: "aistockvn.com", enabled: 1 }],
    );
    const token = await signSession(GMAIL_USER, SECRET);

    const sendRes = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mail-Client": "1",
          Cookie: `${SESSION_COOKIE}=${token}`,
        },
        body: JSON.stringify({
          from: aliasAddr,
          to: "yahia@context.dev",
          subject: "Re: Context.dev onboarding",
          text: "Reply sent from alias",
        }),
      }),
      env,
    );
    expect(sendRes.status).toBe(200);
    const sendBody = (await sendRes.json()) as { id: string; resendId: string };
    expect(inserts).toHaveLength(1);

    const [, mailboxAddress, , , fromAddr] = inserts[0].binds;
    expect(mailboxAddress).toBe(SHARED_MAILBOX);
    expect(fromAddr).toBe(aliasAddr);

    // Appears in Sent list
    const listRes = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/messages?folder=sent", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { items: Array<{ id: string; from_addr?: string }> };
    expect(listBody.items.some((m) => m.id === sendBody.id)).toBe(true);

    // Found by search in Sent
    const searchRes = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=onboarding&folder=sent", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as { items: Array<{ id: string }> };
    expect(searchBody.items.some((m) => m.id === sendBody.id)).toBe(true);

    // Opens by id
    const detailRes = await worker.fetch(
      new Request(`https://mail.aistockvn.com/api/messages/${sendBody.id}`, {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as { id: string; text: string };
    expect(detailBody.id).toBe(sendBody.id);
    expect(detailBody.text).toBe("Reply sent from alias");
  });

  it(
    "8. Regression: sending from admin@ remains unchanged (mailbox_address = admin@, from_addr = admin@)",
    async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "resend_admin_001" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { env, inserts } = makeEnv();
    const token = await signSession(GMAIL_USER, SECRET);

    const sendRes = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mail-Client": "1",
          Cookie: `${SESSION_COOKIE}=${token}`,
        },
        body: JSON.stringify({
          from: SHARED_MAILBOX,
          to: "customer@example.com",
          subject: "Direct from admin",
          text: "Hello from shared mailbox",
        }),
      }),
      env,
    );
    expect(sendRes.status).toBe(200);
    expect(inserts).toHaveLength(1);

    const [, mailboxAddress, , , fromAddr] = inserts[0].binds;
    expect(mailboxAddress).toBe(SHARED_MAILBOX);
    expect(fromAddr).toBe(SHARED_MAILBOX);
  });
});
