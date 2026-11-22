import { describe, it, expect, vi } from "vitest";
import { summarizeText, draftReply } from "./ai";
import type { Env } from "./mail";
import worker from "./index";
import { signSession, SESSION_COOKIE } from "./auth";

const TEST_SUMMARY_CANNED = "Summary: The email discusses market trends and Q4 performance.";
const TEST_DRAFT_CANNED = "Dear sender, Thank you for your email. I will review the details and get back to you shortly.";
const TEST_SUBJECT = "Q4 Market Analysis";
const TEST_FROM = "client@example.com";
const TEST_TEXT = "The Q4 market showed strong growth across all sectors.";
const SHARED_MAILBOX = "admin@aistockvn.com";
const GMAIL_USER = "tranbinhanbr01@gmail.com";
const ALLOWED_EMAILS = `${GMAIL_USER},${SHARED_MAILBOX}`;
const SECRET = "s".repeat(40);
const TEST_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";

function createMockDb(
  userMailboxes: Record<string, string[]>,
  initialMessages: any[] = [],
) {
  const messages: any[] = [...initialMessages];
  // ai_rate_limits table state: day -> calls (global scope only in tests).
  const aiRateLimits: Record<string, number> = {};

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
                return { results: addrs.map((address: string) => ({ address })) as T[] };
              }
              if (sql.includes("FROM messages WHERE")) {
                const folder = String(boundBinds[0]);
                const before = Number(boundBinds[1]);
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
              if (sql.includes("FROM ai_rate_limits")) {
                const day = String(boundBinds[1] || "");
                const calls = aiRateLimits[day];
                return (calls === undefined ? null : { calls }) as unknown as T | null;
              }
              if (sql.includes("SELECT * FROM messages WHERE id = ?")) {
                const id = String(boundBinds[0]);
                const found = messages.find((m) => m.id === id) ?? null;
                return found as unknown as T | null;
              }
              return null as T | null;
            },
            async run() {
              if (sql.includes("INSERT INTO ai_rate_limits")) {
                const day = String(boundBinds[1] || "");
                aiRateLimits[day] = 1;
                return { success: true } as any;
              }
              if (sql.includes("UPDATE ai_rate_limits SET calls = calls + 1")) {
                const day = String(boundBinds[1] || "");
                aiRateLimits[day] = (aiRateLimits[day] ?? 0) + 1;
                return { success: true } as any;
              }
              return { success: true } as any;
            },
          };
        },
      };
    },
  };

  return { db: db as unknown as D1Database, messages, aiRateLimits };
}

function makeEnv(
  overrides: Partial<Env> = {},
  userMailboxes: Record<string, string[]> = {
    [GMAIL_USER]: [],
    [SHARED_MAILBOX]: [SHARED_MAILBOX],
  },
  initialMessages: any[] = [],
): { env: Env; inserts: any; messages: any[]; aiRateLimits: Record<string, number> } {
  const { db, inserts, messages, aiRateLimits } = createMockDb(userMailboxes, initialMessages);
  const env: Env = {
    DB: db,
    RAW: {} as any,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } as any,
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
  return { env, inserts, messages, aiRateLimits };
}

afterEach(() => {
  vi.restoreAllMocks();
});

let token: string;

beforeAll(async () => {
  token = await signSession(GMAIL_USER, SECRET);
});

describe("worker/ai.ts - summarizeText and draftReply", () => {
  const makeAiEnv = (mockReturn: string) => {
    const mockRun = vi.fn().mockResolvedValue(mockReturn);
    const { env: baseEnv } = makeEnv();
    const env: Env = { ...baseEnv, AI: { run: mockRun } as any };
    return { env, mockRun };
  };

  describe("summarizeText", () => {
    it("returns the model text (trimmed)", async () => {
      const { env, mockRun } = makeAiEnv(TEST_SUMMARY_CANNED);
      const result = await summarizeText(env, "Hello world this is a test email body.");
      expect(result).toBe(TEST_SUMMARY_CANNED);
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it("handles empty text returns empty string", async () => {
      const { env } = makeAiEnv(TEST_SUMMARY_CANNED);
      const result = await summarizeText(env, "");
      expect(result).toBe("");
    });

it("throws when env.AI is missing", async () => {
      const { env: baseEnv } = makeEnv();
      const env: Partial<Env> = { ...baseEnv } as Partial<Env>;
      delete (env as any).AI;
      await expect(summarizeText(env as Env, "test text")).rejects.toThrow(
        "AI is not configured on the server",
      );
    });

    it("trims response text from object shape", async () => {
      const mockRun = vi.fn().mockResolvedValue({ response: "  hello world " });
      const { env: baseEnv } = makeEnv();
      const env: Env = { ...baseEnv, AI: { run: mockRun } as any };
      const result = await summarizeText(env, "Hello world this is a test email body.");
      expect(result).toBe("hello world");
      expect(mockRun).toHaveBeenCalledTimes(1);
    });
  });


  describe("draftReply", () => {
    it("returns the draft text; the prompt includes the original subject/from/text", async () => {
      const { env } = makeAiEnv(TEST_DRAFT_CANNED);
      const result = await draftReply(env, {
        subject: TEST_SUBJECT,
        from: TEST_FROM,
        text: TEST_TEXT,
      });
      expect(result).toBe(TEST_DRAFT_CANNED);
    });

    it("throws when env.AI is missing", async () => {
      const { env: baseEnv } = makeEnv();
      const env: Partial<Env> = { ...baseEnv } as Partial<Env>;
      delete (env as any).AI;
      await expect(draftReply(env as Env, { subject: "test", from: "a", text: "b" })).rejects.toThrow(
        "AI is not configured on the server",
      );
    });

    it("trims response text from object shape", async () => {
      const mockRun = vi.fn().mockResolvedValue({ response: "  hello draft " });
      const { env: baseEnv } = makeEnv();
      const env: Env = { ...baseEnv, AI: { run: mockRun } as any };
      const result = await draftReply(env, {
        subject: TEST_SUBJECT,
        from: TEST_FROM,
        text: TEST_TEXT,
      });
      expect(result).toBe("hello draft");
      expect(mockRun).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry rule", () => {
    it("retries once on 429 then succeeds", async () => {
      const mockRun = vi.fn()
        .mockRejectedValueOnce({ message: "429", status: 429 })
        .mockResolvedValueOnce(TEST_SUMMARY_CANNED);
      const { env, mockRun: run } = (() => {
        const r = { run: mockRun } as any;
        return { env: { AI: r } as unknown as Env, mockRun: mockRun };
      })();

      const result = await summarizeText(env, "test text");
      expect(result).toBe(TEST_SUMMARY_CANNED);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("throws 'temporarily unavailable' after two 429 failures", async () => {
      const mockRun = vi.fn()
        .mockRejectedValueOnce({ message: "429", status: 429 })
        .mockRejectedValueOnce({ message: "429", status: 429 });
      const { env } = (() => {
        const r = { run: mockRun } as any;
        return { env: { AI: r } as unknown as Env };
      })();

      await expect(summarizeText(env, "test text")).rejects.toThrow(
        "AI is temporarily unavailable, please try again later",
      );
    });

    it("throws 'temporarily unavailable' after 503 then 503", async () => {
      const mockRun = vi.fn()
        .mockRejectedValueOnce({ message: "503", status: 503 })
        .mockRejectedValueOnce({ message: "503", status: 503 });
      const { env } = (() => {
        const r = { run: mockRun } as any;
        return { env: { AI: r } as unknown as Env };
      })();

      await expect(summarizeText(env, "test text")).rejects.toThrow(
        "AI is temporarily unavailable, please try again later",
      );
    });
  });

  describe("AI daily rate-limit guardrail", () => {
    const today = () => new Date().toISOString().slice(0, 10);

    function makeCappedEnv(mockReturn: string) {
      const mockRun = vi.fn().mockResolvedValue(mockReturn);
      const { env: baseEnv, aiRateLimits } = makeEnv();
      const env: Env = { ...baseEnv, AI: { run: mockRun } as any };
      return { env, mockRun, aiRateLimits };
    }

    it("allows calls under the 60/day cap and counts them", async () => {
      const { env, mockRun, aiRateLimits } = makeCappedEnv(TEST_SUMMARY_CANNED);
      const result = await summarizeText(env, "Hello world.");
      expect(result).toBe(TEST_SUMMARY_CANNED);
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(aiRateLimits[today()]).toBe(1);
    });

    it("blocks the 61st call with a clear daily-limit error", async () => {
      const { env, mockRun, aiRateLimits } = makeCappedEnv(TEST_SUMMARY_CANNED);
      aiRateLimits[today()] = 60;
      await expect(summarizeText(env, "Hello world.")).rejects.toThrow("AI daily limit reached");
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("truncates input longer than 8000 chars before calling the model", async () => {
      const { env, mockRun } = makeCappedEnv(TEST_SUMMARY_CANNED);
      const longText = "x".repeat(9000);
      await summarizeText(env, longText);
      expect(mockRun).toHaveBeenCalledTimes(1);
      const msgs = mockRun.mock.calls[0][1].messages;
      const userMsg = msgs.find((m: any) => m.role === "user");
      expect(userMsg.content.length).toBeLessThanOrEqual(8000);
    });

    it("fails open when the rate-limit table is unavailable", async () => {
      const mockRun = vi.fn().mockResolvedValue(TEST_SUMMARY_CANNED);
      const brokenDb = {
        prepare() {
          throw new Error("no such table: ai_rate_limits");
        },
      } as unknown as D1Database;
      const { env: baseEnv } = makeEnv();
      const env: Env = { ...baseEnv, DB: brokenDb, AI: { run: mockRun } as any };
      const result = await summarizeText(env, "Hello world.");
      expect(result).toBe(TEST_SUMMARY_CANNED);
      expect(mockRun).toHaveBeenCalledTimes(1);
    });
  });
});

describe("worker/ai endpoints", () => {
  function makeSearchEnv(
    userMailboxes: Record<string, string[]> = {
      [GMAIL_USER]: [],
      [SHARED_MAILBOX]: [SHARED_MAILBOX],
    },
    initialMessages: any[] = [],
  ) {
    return makeEnv({}, userMailboxes, initialMessages);
  }

  it("POST /api/messages/:id/summary unknown id → 404", async () => {
    const { env: baseEnv } = makeEnv();
    const env: Env = {
      ...baseEnv,
      AI: undefined as any,
      ALLOWED_EMAILS: `${GMAIL_USER},${SHARED_MAILBOX}`,
    } as Env;
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/messages/nonexistent/summary", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${token}`, "X-Mail-Client": "1" },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/messages/:id/summary happy path returns mocked model text", async () => {
    const { env: baseEnv } = makeEnv(undefined, undefined, [{ id: "msg-001", folder: "inbox", mailbox_address: SHARED_MAILBOX, from_addr: TEST_FROM, text_body: TEST_TEXT, subject: TEST_SUBJECT }]);
    const env: Env = {
      ...baseEnv,
      AI: { run: vi.fn().mockResolvedValue(TEST_SUMMARY_CANNED) } as any,
      ALLOWED_EMAILS: `${GMAIL_USER},${SHARED_MAILBOX}`,
    } as Env;
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/messages/msg-001/summary", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${token}`, "X-Mail-Client": "1" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: string };
    expect(body.summary).toBe(TEST_SUMMARY_CANNED);
  });

  it("POST /api/messages/:id/draft-reply unknown id → 404", async () => {
    const { env: baseEnv } = makeEnv();
    const env: Env = {
      ...baseEnv,
      AI: undefined as any,
      ALLOWED_EMAILS: `${GMAIL_USER},${SHARED_MAILBOX}`,
    } as Env;
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/messages/nonexistent/draft-reply", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${token}`, "X-Mail-Client": "1" },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/messages/:id/draft-reply happy path returns mocked draft text", async () => {
    const { env: baseEnv } = makeEnv(undefined, undefined, [{ id: "msg-001", folder: "inbox", mailbox_address: SHARED_MAILBOX, from_addr: TEST_FROM, text_body: TEST_TEXT, subject: TEST_SUBJECT }]);
    const env: Env = {
      ...baseEnv,
      AI: { run: vi.fn().mockResolvedValue(TEST_DRAFT_CANNED) } as any,
      ALLOWED_EMAILS: `${GMAIL_USER},${SHARED_MAILBOX}`,
    } as Env;
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/messages/msg-001/draft-reply", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${token}`, "X-Mail-Client": "1" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft: string };
    expect(body.draft).toBe(TEST_DRAFT_CANNED);
  });

  it("missing env.AI throws 'not configured' error in endpoint", async () => {
    const { env: baseEnv } = makeEnv(undefined, undefined, [{ id: "msg-001", folder: "inbox", mailbox_address: SHARED_MAILBOX, from_addr: TEST_FROM, text_body: TEST_TEXT, subject: TEST_SUBJECT }]);
    const env: Env = {
      ...baseEnv,
      AI: undefined as any,
      ALLOWED_EMAILS: `${GMAIL_USER},${SHARED_MAILBOX}`,
    } as Env;
    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/messages/msg-001/summary", {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE}=${token}`, "X-Mail-Client": "1" },
      }),
      env,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("AI is not configured");
  });
});