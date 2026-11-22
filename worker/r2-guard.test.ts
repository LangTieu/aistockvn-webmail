import { describe, it, expect, vi, afterEach } from "vitest";
import {
  R2_STORAGE_HARD_CAP_BYTES,
  R2_CLASS_A_HARD_CAP_MONTH,
  isR2WriteBlocked,
  recordR2Write,
  getR2Usage,
  type R2Usage,
} from "./r2-guard";
import { ingestInbound } from "./mail";

const TEST_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Mock D1 that holds one r2_usage row (or none). prepare() exposes first/all/run directly (as real D1 does). */
function makeR2MockDb(initial: R2Usage | null) {
  let row: R2Usage | null = initial ? { ...initial } : null;
  const makeStatement = (sql: string, boundBinds: unknown[] = []) => {
    const stmt = {
      bind(...binds: unknown[]) {
        return makeStatement(sql, binds);
      },
      async first<T = Record<string, unknown>>() {
        if (sql.includes("FROM r2_usage")) return (row ? { ...row } : null) as unknown as T | null;
        return null as T | null;
      },
      async all<T = Record<string, unknown>>() {
        return { results: [] as T[] };
      },
      async run() {
        if (sql.includes("INSERT INTO r2_usage")) {
          row = {
            bytes_total: Number(boundBinds[0]),
            objects_total: 1,
            class_a_month: String(boundBinds[1]),
            class_a_count: 1,
            blocked: Number(boundBinds[2]),
          };
          return { success: true } as any;
        }
        if (sql.includes("UPDATE r2_usage SET")) {
          if (row) {
            row = {
              bytes_total: Number(boundBinds[0]),
              objects_total: Number(boundBinds[1]),
              class_a_month: String(boundBinds[2]),
              class_a_count: Number(boundBinds[3]),
              blocked: Number(boundBinds[4]),
            };
          }
          return { success: true } as any;
        }
        return { success: true } as any;
      },
    };
    return stmt;
  };
  const db = {
    prepare(sql: string) {
      return makeStatement(sql);
    },
  };
  return { db: db as unknown as D1Database, getRow: () => row };
}

function underCapRow(): R2Usage {
  return { bytes_total: 571746, objects_total: 27, class_a_month: currentMonth(), class_a_count: 27, blocked: 0 };
}

describe("R2 billing hard guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows writes and counts them when under the cap", async () => {
    const { db, getRow } = makeR2MockDb(underCapRow());
    expect(await isR2WriteBlocked(db)).toBe(false);
    await recordR2Write(db, 30_000);
    const row = getRow()!;
    expect(row.bytes_total).toBe(571746 + 30_000);
    expect(row.objects_total).toBe(28);
    expect(row.class_a_count).toBe(28);
    expect(row.blocked).toBe(0);
    expect(await isR2WriteBlocked(db)).toBe(false);
  });

  it("sets blocked=1 when a write crosses the 8 GB storage cap", async () => {
    const { db, getRow } = makeR2MockDb({
      bytes_total: R2_STORAGE_HARD_CAP_BYTES - 1000,
      objects_total: 100,
      class_a_month: currentMonth(),
      class_a_count: 100,
      blocked: 0,
    });
    expect(await isR2WriteBlocked(db)).toBe(false);
    await recordR2Write(db, 2000);
    expect(getRow()!.blocked).toBe(1);
    expect(await isR2WriteBlocked(db)).toBe(true);
  });

  it("blocks when the blocked flag is already set", async () => {
    const { db } = makeR2MockDb({ ...underCapRow(), blocked: 1 });
    expect(await isR2WriteBlocked(db)).toBe(true);
  });

  it("blocks when the Class A monthly count is already at the cap", async () => {
    const { db } = makeR2MockDb({
      ...underCapRow(),
      class_a_count: R2_CLASS_A_HARD_CAP_MONTH,
    });
    expect(await isR2WriteBlocked(db)).toBe(true);
  });

  it("resets the Class A count when the month rolls over", async () => {
    const { db, getRow } = makeR2MockDb({
      ...underCapRow(),
      class_a_month: "2000-01",
      class_a_count: R2_CLASS_A_HARD_CAP_MONTH,
    });
    expect(await isR2WriteBlocked(db)).toBe(false);
    await recordR2Write(db, 1000);
    expect(getRow()!.class_a_month).toBe(currentMonth());
    expect(getRow()!.class_a_count).toBe(1);
    expect(getRow()!.blocked).toBe(0);
  });

  it("fails open when the DB throws (guard never breaks mail)", async () => {
    const throwingDb = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                throw new Error("D1 down");
              },
              async run() {
                throw new Error("D1 down");
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    expect(await isR2WriteBlocked(throwingDb)).toBe(false);
    expect(await getR2Usage(throwingDb)).toBeNull();
    await expect(recordR2Write(throwingDb, 1000)).resolves.toBeUndefined();
  });

  it("treats a missing r2_usage row as not blocked (migration not yet applied)", async () => {
    const { db } = makeR2MockDb(null);
    expect(await isR2WriteBlocked(db)).toBe(false);
    await recordR2Write(db, 5000);
    const row = await getR2Usage(db);
    expect(row?.bytes_total).toBe(5000);
    expect(row?.blocked).toBe(0);
  });
});

describe("ingestInbound respects the R2 hard guard", () => {
  const rawEml = [
    "From: getstarted@backblaze.com",
    "To: admin@aistockvn.com",
    "Message-ID: <r2guard-test-001@example.com>",
    "Subject: R2 guard test",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Body for R2 guard test.",
  ].join("\r\n");

  function makeIngestMockDb(blocked: boolean) {
    const r2Row: R2Usage = { ...underCapRow(), blocked: blocked ? 1 : 0 };
    const messageInserts: unknown[][] = [];
    const makeStatement = (sql: string, boundBinds: unknown[] = []) => {
      const stmt = {
        bind(...binds: unknown[]) {
          return makeStatement(sql, binds);
        },
        async first<T = Record<string, unknown>>() {
          if (sql.includes("FROM r2_usage")) return { ...r2Row } as unknown as T | null;
          return null as T | null;
        },
        async all<T = Record<string, unknown>>() {
          return { results: [] as T[] };
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO messages")) {
            messageInserts.push([...boundBinds]);
          }
          if (sql.includes("UPDATE r2_usage SET")) {
            r2Row.bytes_total = Number(boundBinds[0]);
            r2Row.objects_total = Number(boundBinds[1]);
            r2Row.class_a_month = String(boundBinds[2]);
            r2Row.class_a_count = Number(boundBinds[3]);
            r2Row.blocked = Number(boundBinds[4]);
          }
          return { success: true } as any;
        },
      };
      return stmt;
    };
    const db = {
      prepare(sql: string) {
        return makeStatement(sql);
      },
    };
    return { db: db as unknown as D1Database, messageInserts };
  }

  it("skips the R2 PUT but still stores the D1 row (raw_key=null) when blocked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, messageInserts } = makeIngestMockDb(true);
    const rawBucket = { put: vi.fn(async () => ({})) };
    const env = {
      DB: db,
      RAW: rawBucket,
      MAILBOX_ADDRESS: "admin@aistockvn.com",
      ALLOWED_EMAILS: "admin@aistockvn.com",
      ENCRYPTION_KEY: TEST_KEY_B64,
    } as any;

    const result = await ingestInbound(env, new TextEncoder().encode(rawEml).buffer as ArrayBuffer, {
      from: "getstarted@backblaze.com",
      to: "admin@aistockvn.com",
    });
    expect(result.duplicate).toBe(false);
    expect(rawBucket.put).not.toHaveBeenCalled();
    expect(messageInserts).toHaveLength(1);
    // raw_key is the 18th bind (index 17) in the messages INSERT.
    expect(messageInserts[0][17]).toBeNull();
  });

  it("writes R2 and records usage when not blocked", async () => {
    const { db, messageInserts } = makeIngestMockDb(false);
    const rawBucket = { put: vi.fn(async () => ({})) };
    const env = {
      DB: db,
      RAW: rawBucket,
      MAILBOX_ADDRESS: "admin@aistockvn.com",
      ALLOWED_EMAILS: "admin@aistockvn.com",
      ENCRYPTION_KEY: TEST_KEY_B64,
    } as any;

    const result = await ingestInbound(env, new TextEncoder().encode(rawEml).buffer as ArrayBuffer, {
      from: "getstarted@backblaze.com",
      to: "admin@aistockvn.com",
    });
    expect(result.duplicate).toBe(false);
    expect(rawBucket.put).toHaveBeenCalledTimes(1);
    expect(messageInserts).toHaveLength(1);
    expect(typeof messageInserts[0][17]).toBe("string");
    expect(String(messageInserts[0][17])).toMatch(/^raw\/\d{4}\/\d{2}\/.+\.eml$/);
  });
});
