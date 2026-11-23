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

interface CapturedInsert {
  sql: string;
  binds: unknown[];
}

interface StoredMessage {
  id: string;
  folder: "inbox" | "sent";
  mailbox_address: string;
  in_reply_to: string | null;
  references_hdr: string | null;
  message_id: string | null;
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
  attachments: string;
  raw_key: string | null;
  resend_id: string | null;
}

function createMockDb(
  userMailboxes: Record<string, string[]>,
  initialMessages: StoredMessage[] = [],
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
                return { results: addrs.map((address) => ({ address })) as T[] };
              }
              if (sql.includes("FROM messages WHERE")) {
                const folder = String(binds[0]);
                const before = Number(binds[1]);
                if (sql.includes("AND 1=0")) {
                  return { results: [] as T[] };
                }
                const allowedMailboxes = binds.slice(2).map((b) => String(b).toLowerCase());
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
              if (sql.includes("FROM aliases WHERE local_part = ? AND domain = ?")) {
                const [localPart, domain] = binds.map(String);
                return (localPart === "admin" && ["istockvn.eu.cc", "icalendar.eu.cc", "inotion.eu.cc", "other.example"].includes(domain)
                  ? { id: `alias-${domain}`, local_part: localPart, domain, label: "Admin", enabled: 1, created_by: GMAIL_USER, created_at: 1 }
                  : null) as T | null;
              }
              if (sql.includes("FROM domains WHERE domain = ?")) {
                const domain = String(binds[0]);
                return (["istockvn.eu.cc", "icalendar.eu.cc", "inotion.eu.cc", "other.example"].includes(domain)
                  ? { domain, enabled: 1 }
                  : null) as T | null;
              }
              if (sql.includes("SELECT COUNT(*) AS n FROM messages")) {
                if (sql.includes("1=0 AND")) {
                  return { n: 0 } as T;
                }
                const allowedMailboxes = binds.map((b) => String(b).toLowerCase());
                const count = messages.filter(
                  (m) =>
                    m.folder === "inbox" &&
                    m.is_read === 0 &&
                    allowedMailboxes.includes(m.mailbox_address.toLowerCase()),
                ).length;
                return { n: count } as T;
              }
              if (sql.includes("SELECT * FROM messages WHERE id = ?")) {
                const id = String(binds[0]);
                const found = messages.find((m) => m.id === id) ?? null;
                return found as unknown as T | null;
              }
              if (sql.includes("SELECT message_id, references_hdr FROM messages")) {
                if (sql.includes("AND 1=0")) {
                  return null;
                }
                const id = String(binds[0]);
                const allowedMailboxes = binds.slice(1).map((b) => String(b).toLowerCase());
                const found = messages.find(
                  (m) => m.id === id && allowedMailboxes.includes(m.mailbox_address.toLowerCase()),
                );
                return (found
                  ? { message_id: found.message_id, references_hdr: found.references_hdr }
                  : null) as T | null;
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
                  attachments: String(binds[14] ?? "[]"),
                  raw_key: null,
                  resend_id: (resendId as string | null) ?? null,
                });
              }
              if (sql.includes("UPDATE messages SET is_read = 1 WHERE id = ?")) {
                const id = String(binds[0]);
                const target = messages.find((m) => m.id === id);
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
    // Migration 0004: Gmail users have NO row in mailboxes table
    [GMAIL_USER]: [],
    [OTHER_GMAIL_USER]: [],
    [SHARED_MAILBOX]: [SHARED_MAILBOX],
  },
  initialMessages: StoredMessage[] = [],
): { env: Env; inserts: CapturedInsert[]; messages: StoredMessage[] } {
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

describe("POST /api/send shared mailbox sender", () => {
  it("downloads sent attachment bytes from B2 metadata", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([65, 66, 67]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const sent: StoredMessage = {
      id: "4ae84351-4e3a-4890-8cd5-ec187dd7f57b", folder: "sent", mailbox_address: SHARED_MAILBOX,
      in_reply_to: null, references_hdr: null, message_id: null, from_addr: SHARED_MAILBOX, from_name: "",
      to_addrs: "[]", cc_addrs: "[]", reply_to: null, subject: "file", snippet: "", text_body: "",
      html_body: null, date: 1, is_read: 1,
      attachments: JSON.stringify([{ index: 0, filename: "report.txt", mimeType: "text/plain", size: 3, inline: false, key: "123e4567-e89b-12d3-a456-426614174000/report.txt" }]),
      raw_key: null, resend_id: null,
    };
    const { env } = makeEnv({ B2_KEY_ID: "test-id", B2_APPLICATION_KEY: "test-secret", B2_BUCKET_NAME: "private", B2_S3_ENDPOINT: "https://s3.eu-central-003.backblazeb2.com" }, undefined, [sent]);
    const token = await signSession(GMAIL_USER, SECRET);
    const response = await worker.fetch(new Request(`https://mail.aistockvn.com/api/messages/${sent.id}/attachments/0`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } }), env);
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([65, 66, 67]);
    expect(response.headers.get("Content-Disposition")).toContain("report.txt");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads received attachments from the R2 raw message", async () => {
    const received: StoredMessage = {
      id: "5ae84351-4e3a-4890-8cd5-ec187dd7f57b", folder: "inbox", mailbox_address: SHARED_MAILBOX,
      in_reply_to: null, references_hdr: null, message_id: null, from_addr: "sender@example.com", from_name: "",
      to_addrs: "[]", cc_addrs: "[]", reply_to: null, subject: "file", snippet: "", text_body: "",
      html_body: null, date: 1, is_read: 0, attachments: "[]", raw_key: "raw/mail.eml", resend_id: null,
    };
    const raw = ["From: sender@example.com", "To: admin@aistockvn.com", "Subject: file", "MIME-Version: 1.0", "Content-Type: multipart/mixed; boundary=abc", "", "--abc", "Content-Type: text/plain", "", "body", "--abc", "Content-Type: text/plain; name=note.txt", "Content-Disposition: attachment; filename=note.txt", "Content-Transfer-Encoding: base64", "", "SEk=", "--abc--"].join("\r\n");
    const { env } = makeEnv({ RAW: { get: async () => ({ arrayBuffer: async () => new TextEncoder().encode(raw).buffer }) } as unknown as R2Bucket }, undefined, [received]);
    const token = await signSession(GMAIL_USER, SECRET);
    const response = await worker.fetch(new Request(`https://mail.aistockvn.com/api/messages/${received.id}/attachments/0`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } }), env);
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("HI");
  });

  it("fetches a private B2 object and sends its base64 content through Resend", async () => {
    let resendPayload: any;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.resend.com")) {
        resendPayload = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "resend_with_attachment" }), { status: 200 });
      }
      return new Response(new Uint8Array([65, 66, 67]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { env } = makeEnv({ B2_KEY_ID: "test-id", B2_APPLICATION_KEY: "test-secret", B2_BUCKET_NAME: "private", B2_S3_ENDPOINT: "https://s3.eu-central-003.backblazeb2.com" });
    const token = await signSession(GMAIL_USER, SECRET);
    const req = new Request("https://mail.aistockvn.com/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ to: "customer@example.com", subject: "With file", text: "Body", attachments: [{ key: "123e4567-e89b-12d3-a456-426614174000/report.txt", filename: "report.txt", size: 3, mimeType: "text/plain" }] }),
    });
    const response = await worker.fetch(req, env);
    expect(response.status).toBe(200);
    expect(resendPayload.attachments).toEqual([{ filename: "report.txt", content: "QUJD", content_type: "text/plain" }]);
  });

  it("sends from env.MAILBOX_ADDRESS and saves sent row under admin@ when signed in as gmail user", async () => {
    const capturedCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedCalls.push({ url: String(input), init });
        return new Response(JSON.stringify({ id: "resend_msg_gmail_001" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const { env, inserts } = makeEnv();
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
        subject: "Hello from Gmail user",
        text: "Body text",
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { id: string; resendId: string };
    expect(resBody.resendId).toBe("resend_msg_gmail_001");
    expect(typeof resBody.id).toBe("string");

    // Verify Resend API call used shared admin@ sender address
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].url).toBe("https://api.resend.com/emails");
    const sentPayload = JSON.parse(String(capturedCalls[0].init?.body));
    expect(sentPayload.from).toBe("AI Stock VN <admin@aistockvn.com>");
    expect(sentPayload.to).toEqual(["customer@example.com"]);
    expect(sentPayload.subject).toBe("Hello from Gmail user");

    // Verify D1 INSERT saved mailbox_address = admin@aistockvn.com and from_addr = admin@aistockvn.com
    expect(inserts).toHaveLength(1);
    const [, mailboxAddress, , , fromAddr, fromName] = inserts[0].binds;
    expect(mailboxAddress).toBe("admin@aistockvn.com");
    expect(fromAddr).toBe("admin@aistockvn.com");
    expect(fromName).toBe("AI Stock VN");
  });

  it("sends from env.MAILBOX_ADDRESS when signed in as admin@aistockvn.com", async () => {
    const capturedCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedCalls.push({ url: String(input), init });
        return new Response(JSON.stringify({ id: "resend_msg_admin_002" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const { env, inserts } = makeEnv();
    const token = await signSession(SHARED_MAILBOX, SECRET);
    const req = new Request("https://mail.aistockvn.com/api/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mail-Client": "1",
        Cookie: `${SESSION_COOKIE}=${token}`,
      },
      body: JSON.stringify({
        to: "partner@example.com",
        subject: "Hello from Admin",
        text: "Admin message body",
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const resBody = (await res.json()) as { id: string; resendId: string };
    expect(resBody.resendId).toBe("resend_msg_admin_002");

    expect(capturedCalls).toHaveLength(1);
    const sentPayload = JSON.parse(String(capturedCalls[0].init?.body));
    expect(sentPayload.from).toBe("AI Stock VN <admin@aistockvn.com>");

    expect(inserts).toHaveLength(1);
    const [, mailboxAddress, , , fromAddr] = inserts[0].binds;
    expect(mailboxAddress).toBe("admin@aistockvn.com");
    expect(fromAddr).toBe("admin@aistockvn.com");
  });

  it("returns 503 if env.MAILBOX_ADDRESS is empty", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { env, inserts } = makeEnv({ MAILBOX_ADDRESS: "" });
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
    expect(inserts).toHaveLength(0);
  });

  async function sendAs(from: string, overrides: Partial<Env> = {}, extra: Record<string, unknown> = {}) {
    const { env, inserts } = makeEnv(overrides);
    const token = await signSession(GMAIL_USER, SECRET);
    const response = await worker.fetch(new Request("https://mail.aistockvn.com/api/send", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ from, to: "customer@example.com", subject: "Routed", text: "hello", ...extra }),
    }), env);
    return { response, inserts };
  }

  it("routes istockvn.eu.cc through send.dev with attachments and reply headers", async () => {
    let payload: any;
    let headers: HeadersInit | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input).includes("s3.eu-central-003")) return new Response(new Uint8Array([65, 66, 67]));
      headers = init?.headers;
      payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "istock-msg" }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const original: StoredMessage = { id: "reply-id", folder: "inbox", mailbox_address: SHARED_MAILBOX, in_reply_to: null, references_hdr: null, message_id: "<orig@example.com>", from_addr: "client@example.com", from_name: "", to_addrs: "[]", cc_addrs: "[]", reply_to: null, subject: "old", snippet: "", text_body: "", html_body: null, date: 1, is_read: 0, attachments: "[]", raw_key: null, resend_id: null };
    const { env, inserts } = makeEnv({ SENDDEV_API_KEY: "senddev_test_dummy_key", B2_KEY_ID: "test-id", B2_APPLICATION_KEY: "test-secret", B2_BUCKET_NAME: "private", B2_S3_ENDPOINT: "https://s3.eu-central-003.backblazeb2.com" }, undefined, [original]);
    const token = await signSession(GMAIL_USER, SECRET);
    const response = await worker.fetch(new Request("https://mail.aistockvn.com/api/send", { method: "POST", headers: { "Content-Type": "application/json", "X-Mail-Client": "1", Cookie: `${SESSION_COOKIE}=${token}` }, body: JSON.stringify({ from: "admin@istockvn.eu.cc", to: "customer@example.com", subject: "Reply", text: "hello", replyToId: "reply-id", attachments: [{ key: "123e4567-e89b-12d3-a456-426614174000/report.txt", filename: "report.txt", size: 3, mimeType: "text/plain" }] }) }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resendId: "istock-msg" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://api.do.dev/v1/send/emails/send");
    expect(new Headers(headers).get("Authorization")).toBe("Bearer senddev_test_dummy_key");
    expect(payload).toMatchObject({ to: ["customer@example.com"], from: { email: "admin@istockvn.eu.cc", name: "AI Stock VN" }, subject: "Reply", attachments: [{ contentType: "text/plain", filename: "report.txt", content: "QUJD" }] });
    expect(payload).not.toHaveProperty("headers");
    expect(inserts[0].binds[2]).toBe("<orig@example.com>");
    expect(inserts[0].binds[3]).toBe("<orig@example.com>");
    expect(inserts[0].binds[13]).toBe("istock-msg");
  });

  it.each(["icalendar.eu.cc", "inotion.eu.cc"]) ("routes %s through send.dev", async (domain) => {
    let payload: any;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer senddev_test_dummy_key");
      return new Response(JSON.stringify({ id: "msg_xxx", status: "queued" }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { response, inserts } = await sendAs(`admin@${domain}`, { SENDDEV_API_KEY: "senddev_test_dummy_key" });
    expect(response.status).toBe(200);
    expect((await response.json()).resendId).toBe("msg_xxx");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.do.dev/v1/send/emails/send");
    expect(payload.from).toEqual({ email: `admin@${domain}`, name: "AI Stock VN" });
    expect(payload.to).toEqual(["customer@example.com"]);
    expect(payload).not.toHaveProperty("headers");
    expect(inserts[0].binds[13]).toBe("msg_xxx");
  });

  it("enforces send.dev size, recipient, and key requirements before fetch", async () => {
    let providerCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("s3.eu-central-003")) return new Response(new Uint8Array(190000), { status: 200 });
      providerCalls++;
      return new Response(JSON.stringify({ id: "unexpected" }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const missing = await sendAs("admin@icalendar.eu.cc", {});
    expect(missing.response.status).toBe(503);
    const tooMany = await sendAs("admin@icalendar.eu.cc", { SENDDEV_API_KEY: "senddev_test_dummy_key" }, { to: "a@x.com,b@x.com,c@x.com,d@x.com,e@x.com,f@x.com" });
    expect(tooMany.response.status).toBe(400);
    const large = await sendAs("admin@icalendar.eu.cc", { SENDDEV_API_KEY: "senddev_test_dummy_key", B2_KEY_ID: "test-id", B2_APPLICATION_KEY: "test-secret", B2_BUCKET_NAME: "private", B2_S3_ENDPOINT: "https://s3.eu-central-003.backblazeb2.com" }, { attachments: [{ key: "123e4567-e89b-12d3-a456-426614174000/big.bin", filename: "big.bin", size: 190000, mimeType: "application/octet-stream" }] });
    expect(large.response.status).toBe(400);
    expect(providerCalls).toBe(0);
  });

  it("routes enabled aliases on other domains to Resend", async () => {
    let url = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { url = String(input); return new Response(JSON.stringify({ id: "fallback-id" }), { status: 200 }); }));
    const { response } = await sendAs("admin@other.example");
    expect(response.status).toBe(200);
    expect(url).toBe("https://api.resend.com/emails");
  });
});

describe("shared mailbox access for Gmail users without personal mailbox row", () => {
  const inboundId = "11111111-1111-4111-8111-111111111111";

  function seedInboundMessage(): StoredMessage {
    return {
      id: inboundId,
      folder: "inbox",
      mailbox_address: SHARED_MAILBOX,
      in_reply_to: null,
      references_hdr: null,
      message_id: "<inbound-info-001@example.com>",
      from_addr: "client@example.com",
      from_name: "Client",
      to_addrs: JSON.stringify([{ address: "info@aistockvn.com", name: "" }]),
      cc_addrs: "[]",
      reply_to: null,
      subject: "Inquiry to info@aistockvn.com",
      snippet: "Hello team",
      text_body: "Hello team",
      html_body: null,
      date: Date.now() - 1000,
      is_read: 0,
      attachments: "[]",
      raw_key: null,
      resend_id: null,
    };
  }

  it("allows Gmail user with no mailbox row to list Sent after sending from admin@", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "resend_sent_gmail_003" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { env } = makeEnv();
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
          to: "customer@example.com",
          subject: "Sent by Gmail user",
          text: "Shared sent item",
        }),
      }),
      env,
    );
    expect(sendRes.status).toBe(200);

    const sentRes = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/messages?folder=sent", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(sentRes.status).toBe(200);
    const sentBody = (await sentRes.json()) as { items: Array<{ subject: string; from: { address: string } }> };
    expect(sentBody.items).toHaveLength(1);
    expect(sentBody.items[0].subject).toBe("Sent by Gmail user");
    expect(sentBody.items[0].from.address).toBe(SHARED_MAILBOX);
  });

  it("allows Gmail user with no mailbox row to list Inbox, see unread counts, read shared message (not 404), and reply with In-Reply-To", async () => {
    const capturedCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedCalls.push({ url: String(input), init });
        return new Response(JSON.stringify({ id: "resend_reply_gmail_004" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const { env } = makeEnv({}, undefined, [seedInboundMessage()]);
    const token = await signSession(GMAIL_USER, SECRET);

    const countsRes = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/counts", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(countsRes.status).toBe(200);
    expect(await countsRes.json()).toEqual({ unread: 1 });

    const inboxRes = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/messages?folder=inbox", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(inboxRes.status).toBe(200);
    const inboxBody = (await inboxRes.json()) as { items: Array<{ id: string; subject: string }> };
    expect(inboxBody.items).toHaveLength(1);
    expect(inboxBody.items[0].id).toBe(inboundId);
    expect(inboxBody.items[0].subject).toBe("Inquiry to info@aistockvn.com");

    const readRes = await worker.fetch(
      new Request(`https://mail.aistockvn.com/api/messages/${inboundId}`, {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as { id: string; subject: string };
    expect(readBody.id).toBe(inboundId);

    const replyRes = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mail-Client": "1",
          Cookie: `${SESSION_COOKIE}=${token}`,
        },
        body: JSON.stringify({
          to: "client@example.com",
          subject: "Re: Inquiry to info@aistockvn.com",
          text: "Reply text",
          replyToId: inboundId,
        }),
      }),
      env,
    );
    expect(replyRes.status).toBe(200);
    const replyPayload = JSON.parse(String(capturedCalls[0].init?.body));
    expect(replyPayload.headers["In-Reply-To"]).toBe("<inbound-info-001@example.com>");
  });

  it("mailbox scoping A/B: user A cannot read user B's private mailbox while shared mailbox remains accessible", async () => {
    // Shared mailbox (admin@aistockvn.com) is shared across all allowed users, while private
    // mailboxes remain strictly isolated between user A and user B.
    const privateMsgId = "22222222-2222-4222-8222-222222222222";
    const privateMsgB: StoredMessage = {
      id: privateMsgId,
      folder: "inbox",
      mailbox_address: OTHER_GMAIL_USER,
      in_reply_to: null,
      references_hdr: null,
      message_id: "<private-b@example.com>",
      from_addr: "secret@example.com",
      from_name: "Secret",
      to_addrs: JSON.stringify([{ address: OTHER_GMAIL_USER, name: "" }]),
      cc_addrs: "[]",
      reply_to: null,
      subject: "Private B Only",
      snippet: "Secret body",
      text_body: "Secret body",
      html_body: null,
      date: Date.now() - 500,
      is_read: 0,
      attachments: "[]",
      raw_key: null,
      resend_id: null,
    };

    const { env } = makeEnv(
      {},
      {
        [GMAIL_USER]: [GMAIL_USER],
        [OTHER_GMAIL_USER]: [OTHER_GMAIL_USER],
        [SHARED_MAILBOX]: [SHARED_MAILBOX],
      },
      [seedInboundMessage(), privateMsgB],
    );

    const tokenA = await signSession(GMAIL_USER, SECRET);
    const tokenB = await signSession(OTHER_GMAIL_USER, SECRET);

    // User A cannot see User B's private message in list and gets 404 when reading it directly
    const listARes = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/messages?folder=inbox", {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${tokenA}` },
      }),
      env,
    );
    expect(listARes.status).toBe(200);
    const listABody = (await listARes.json()) as { items: Array<{ id: string }> };
    expect(listABody.items.map((i) => i.id)).toContain(inboundId);
    expect(listABody.items.map((i) => i.id)).not.toContain(privateMsgId);

    const readPrivateAsA = await worker.fetch(
      new Request(`https://mail.aistockvn.com/api/messages/${privateMsgId}`, {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${tokenA}` },
      }),
      env,
    );
    expect(readPrivateAsA.status).toBe(404);

    // User B can read their own private message as well as the shared mailbox message
    const readPrivateAsB = await worker.fetch(
      new Request(`https://mail.aistockvn.com/api/messages/${privateMsgId}`, {
        method: "GET",
        headers: { Cookie: `${SESSION_COOKIE}=${tokenB}` },
      }),
      env,
    );
    expect(readPrivateAsB.status).toBe(200);
  });
});
