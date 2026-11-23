import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { ingestInbound } from "./mail";

type RecordedRun = {
  sql: string;
  args: unknown[];
};

function makeMockDb() {
  const runs: RecordedRun[] = [];

  const createStatement = (sql: string, boundArgs: unknown[] = []) => ({
    bind(...args: unknown[]) {
      return createStatement(sql, args);
    },
    async first<T = unknown>(): Promise<T | null> {
      return null;
    },
    async all<T = unknown>(): Promise<{ results: T[] }> {
      return { results: [] };
    },
    async run(): Promise<Record<string, unknown>> {
      if (sql.includes("INSERT OR IGNORE INTO messages")) {
        throw new Error("D1_ERROR: transient database write failure");
      }
      runs.push({ sql, args: boundArgs });
      return {};
    },
  });

  return {
    db: {
      prepare(sql: string) {
        return createStatement(sql);
      },
    },
    runs,
  };
}

function makeStrictPlaceholderMockDb() {
  const countPlaceholders = (sql: string) => (sql.match(/\?/g) || []).length;

  const assertPlaceholderMatch = (sql: string, boundArgs: unknown[]) => {
    const expected = countPlaceholders(sql);
    if (expected !== boundArgs.length) {
      throw new Error(
        `SQLITE_ERROR: placeholder count ${expected} !== bind count ${boundArgs.length} in SQL: ${sql}`,
      );
    }
  };

  const createStatement = (sql: string, boundArgs: unknown[] = []) => ({
    bind(...args: unknown[]) {
      return createStatement(sql, args);
    },
    async first<T = unknown>(): Promise<T | null> {
      assertPlaceholderMatch(sql, boundArgs);
      return null;
    },
    async all<T = unknown>(): Promise<{ results: T[] }> {
      assertPlaceholderMatch(sql, boundArgs);
      return { results: [] };
    },
    async run(): Promise<Record<string, unknown>> {
      assertPlaceholderMatch(sql, boundArgs);
      return {};
    },
  });

  return {
    prepare(sql: string) {
      return createStatement(sql);
    },
  };
}

describe("ingest failure is durable and forward still runs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a durable ingest_failures row and still forwards when the D1 messages INSERT fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { db, runs } = makeMockDb();
    const putKeys: string[] = [];
    const rawBucket = {
      put: vi.fn(async (key: string) => {
        putKeys.push(key);
        return {};
      }),
    };

    const messageId =
      "<1795167245143.df207d33-a29b-4e92-94da-98bb2b8609f2@2832298t.backblaze.com>";
    const rawEml = [
      "From: getstarted@backblaze.com",
      "To: backblaze01-4z4b@aistockvn.com",
      `Message-ID: ${messageId}`,
      "Subject: [Verify email] Complete your Backblaze account setup",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Verify your Backblaze account.",
    ].join("\r\n");

    const message = {
      to: "backblaze01-4z4b@aistockvn.com",
      from: "getstarted@backblaze.com",
      raw: rawEml,
      forward: vi.fn().mockResolvedValue(undefined),
    };

    const env = {
      DB: db,
      RAW: rawBucket,
      MAILBOX_ADDRESS: "admin@aistockvn.com",
      ALLOWED_EMAILS: "admin@aistockvn.com",
      FORWARD_TO: "skillshare01br@mail.com",
      ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=",
    } as any;

    await expect((worker as any).email(message, env)).resolves.toBeUndefined();

    expect(message.forward).toHaveBeenCalledWith("skillshare01br@mail.com");

    const failedPutKey = putKeys.find(
      (k) => k.startsWith("raw/failed/") && k.endsWith(".eml"),
    );
    expect(failedPutKey).toBeDefined();
    expect(rawBucket.put).toHaveBeenCalledWith(
      expect.stringMatching(/^raw\/failed\/.+\.eml$/),
      expect.anything(),
      expect.anything(),
    );

    const failureInsert = runs.find((r) =>
      r.sql.includes("INSERT INTO ingest_failures"),
    );
    expect(failureInsert).toBeDefined();

    const args = failureInsert!.args;
    expect(args).toContain("backblaze01-4z4b@aistockvn.com");
    expect(args).toContain(messageId);

    const recordedRawKey = args.find(
      (a): a is string =>
        typeof a === "string" &&
        a.startsWith("raw/failed/") &&
        a.endsWith(".eml"),
    );
    expect(recordedRawKey).toBe(failedPutKey);

    const recordedError = args.find(
      (a): a is string =>
        typeof a === "string" && a.includes("transient database write failure"),
    );
    expect(recordedError).toBeDefined();
    expect(recordedError!.length).toBeGreaterThan(0);
  });

  it("ingestInbound INSERT placeholder count matches bind count (regression for the missing ?)", async () => {
    const db = makeStrictPlaceholderMockDb();
    const rawBucket = {
      put: vi.fn().mockResolvedValue({}),
    };

    const messageId =
      "<1795167245143.df207d33-a29b-4e92-94da-98bb2b8609f2@2832298t.backblaze.com>";
    const rawEml = [
      "From: getstarted@backblaze.com",
      "To: backblaze01-4z4b@aistockvn.com",
      `Message-ID: ${messageId}`,
      "Subject: [Verify email] Complete your Backblaze account setup",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Verify your Backblaze account.",
    ].join("\r\n");

    const rawBuffer = new TextEncoder().encode(rawEml).buffer;

    const env = {
      DB: db,
      RAW: rawBucket,
      MAILBOX_ADDRESS: "admin@aistockvn.com",
      ALLOWED_EMAILS: "admin@aistockvn.com",
      FORWARD_TO: "",
      ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=",
    } as any;

    const result = await ingestInbound(
      env,
      rawBuffer,
      { from: "getstarted@backblaze.com", to: "backblaze01-4z4b@aistockvn.com" },
    );

    expect(result).toMatchObject({
      duplicate: false,
      folder: "inbox",
    });
  });
});
