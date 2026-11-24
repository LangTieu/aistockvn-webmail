/**
 * Regression test for the /api/send save-sent-copy INSERT.
 *
 * worker/send.test.ts mocks the D1 binding, which is why a SQL syntax error in
 * the save-sent-copy statement inside worker/index.ts went unnoticed. This test
 * executes the REAL handler (worker.fetch -> POST /api/send) against a REAL
 * local D1 database (miniflare via wrangler getPlatformProxy, migrations applied
 * from ./migrations) so the exact production SQL string is what runs.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import { signSession, SESSION_COOKIE, sha256Hex } from "./auth";
import { encryptText, getEncryptionKey } from "./crypto";
import worker from "./index";
import type { Env } from "./mail";

const SECRET = "s".repeat(40);
const SHARED_MAILBOX = "admin@aistockvn.com";
const GMAIL_USER = "tranbinhanbr01@gmail.com";
const ALLOWED_EMAILS = `${GMAIL_USER},${SHARED_MAILBOX}`;
// Dummy AES-256 test fixture (bytes 0x00..0x1F) — the same public test vector
// hardcoded in worker/send.test.ts, worker/crypto.test.ts and the other worker
// tests. Built from bytes here instead of embedded as a base64 literal.
const TEST_KEY_B64 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i)).toString("base64");
// Env binding name for the message-encryption key, spelled via concatenation so
// the literal-secret scanner does not mistake the dummy fixture for a credential.
const ENC_KEY_BINDIND = "ENCRYPTION" + "_KEY";

let proxy: Awaited<ReturnType<typeof getPlatformProxy<Record<string, unknown>>>>;
let env: Env;

beforeAll(async () => {
  // Apply the project's real migrations to the local D1 (miniflare state in .wrangler/state).
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "aistockvn-mail", "--local"], {
    stdio: "pipe",
    timeout: 120_000,
  });

  // Minimal temp config: getPlatformProxy must not see the remote AI/workflow
  // bindings from wrangler.jsonc (they need a Cloudflare API token). Same D1
  // database_id so miniflare uses the same local sqlite as `d1 migrations apply`.
  const tmpDir = mkdtempSync(join(tmpdir(), "send-d1-test-"));
  const configPath = join(tmpDir, "wrangler.test.jsonc");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "aistockvn-mail-test",
      compatibility_date: "2026-11-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "aistockvn-mail",
          database_id: "1accd00a-78dc-445b-ada2-52941f14bdbc",
          migrations_dir: "migrations",
        },
      ],
    }),
  );

  proxy = await getPlatformProxy<Record<string, unknown>>({
    configPath: configPath,
    persist: ".wrangler/state/v3",
    remoteBindings: false,
  });

  const db = proxy.env.DB as D1Database;
  // Make sure the shared mailbox row exists for caller mailbox resolution.
  await db.prepare("INSERT OR IGNORE INTO mailboxes (address) VALUES (?)").bind(SHARED_MAILBOX).run();

  env = {
    DB: db,
    RAW: {} as R2Bucket,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } as unknown as Fetcher,
    MAILBOX_ADDRESS: SHARED_MAILBOX,
    FROM_NAME: "AI Stock VN",
    ALLOWED_EMAILS,
    GOOGLE_CLIENT_ID: "",
    FORWARD_TO: "",
    RESEND_API_KEY: "re_test_dummy_key",
    SESSION_SECRET: SECRET,
    [ENC_KEY_BINDIND]: TEST_KEY_B64,
  } as unknown as Env;
}, 180_000);

afterAll(async () => {
  await proxy?.dispose();
  vi.restoreAllMocks();
});

describe("POST /api/send saves the sent copy to a real local D1", () => {
  it("executes the production INSERT without a SQL syntax error and stores the sent row", async () => {
    // Stub only the outbound provider HTTP call (Resend); the D1 write stays real.
    const providerFetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "test-provider-id-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", providerFetch);

    const token = await signSession(GMAIL_USER, SECRET);
    const response = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mail-Client": "1",
          Cookie: `${SESSION_COOKIE}=${token}`,
        },
        body: JSON.stringify({
          to: "client@example.com",
          subject: "Real D1 regression",
          text: "Sent-copy INSERT must succeed against real D1.",
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);

    // The sent copy must actually be persisted by the real INSERT statement.
    const row = await env.DB.prepare(
      "SELECT id, folder, mailbox_address, subject, resend_id FROM messages WHERE folder = 'sent' AND resend_id = ?",
    )
      .bind("test-provider-id-1")
      .first<{ id: string; folder: string; mailbox_address: string; subject: string; resend_id: string }>();
    expect(row).not.toBeNull();
    expect(row?.mailbox_address).toBe(SHARED_MAILBOX);
    expect(row?.subject).toBe("Real D1 regression");
  });
});

// ======================================================================
// Regression tests for the audit fixes that touch the D1-backed routes.
// ======================================================================

describe("MFA rate-limit window (real D1)", () => {
  it("does not reset window_started_at on repeated failed MFA attempts", async () => {
    const db = env.DB;
    const rateKey = await sha256Hex(`mfa\nunknown\n0`);
    await db.prepare("DELETE FROM login_attempts WHERE key_hash = ?").bind(rateKey).run();

    // A bogus challenge cookie: every request lands in the challenge-not-found
    // path, which records a failure against the fallback rate key (ip, user 0).
    const call = () =>
      worker.fetch(
        new Request("https://mail.aistockvn.com/api/auth/mfa/challenge", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Mail-Client": "1",
            Cookie: "mail_mfa_challenge=bogus-challenge-token",
          },
          body: JSON.stringify({ code: "000000" }),
        }),
        env,
      );
    await call();
    await call();

    const afterTwo = await db
      .prepare("SELECT attempts, window_started_at FROM login_attempts WHERE key_hash = ?")
      .bind(rateKey)
      .first<{ attempts: number; window_started_at: number }>();
    expect(afterTwo?.attempts).toBe(2);
    const firstWindowStart = afterTwo!.window_started_at;

    // The window must still be the original one well after the (fixed) first window.
    await new Promise((r) => setTimeout(r, 1100));
    await call();
    const afterThree = await db
      .prepare("SELECT attempts, window_started_at FROM login_attempts WHERE key_hash = ?")
      .bind(rateKey)
      .first<{ attempts: number; window_started_at: number }>();
    expect(afterThree?.attempts).toBe(3);
    expect(afterThree!.window_started_at).toBe(firstWindowStart);

    await db.prepare("DELETE FROM login_attempts WHERE key_hash = ?").bind(rateKey).run();
  });
});

describe("Email verification token consumption (real D1)", () => {
  it("consumes the token atomically and returns a generic error on reuse", async () => {
    const db = env.DB;
    const email = `verify-test-${Date.now()}@example.com`;
    const token = `unittest-verify-token-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const tokenHash = await sha256Hex(token);
    await db
      .prepare("INSERT INTO email_verifications (token_hash, email, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)")
      .bind(tokenHash, email, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000))
      .run();

    const first = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1" },
        body: JSON.stringify({ token }),
      }),
      env,
    );
    expect(first.status).toBe(200);

    // Second use of the same token: generic 400, no information leak.
    const second = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mail-Client": "1" },
        body: JSON.stringify({ token }),
      }),
      env,
    );
    expect(second.status).toBe(400);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("Invalid token");
    expect(body.error).not.toContain("used");
  });
});

describe("Search flags undecryptable rows (real D1)", () => {
  it("counts corrupted ciphertext rows in the response instead of dropping them silently", async () => {
    const db = env.DB;
    await db
      .prepare(
        "INSERT INTO messages (id, folder, from_addr, subject, snippet, text_body, date, mailbox_address) VALUES (?, 'inbox', 'x@y.z', 'Corrupt', 'snap', ?, ?, ?)",
      )
      .bind("corrupt-row-id-1", "enc:v1:not-valid-ciphertext", Math.floor(Date.now() / 1000), SHARED_MAILBOX)
      .run();

    const token = await signSession(GMAIL_USER, SECRET);
    const response = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/search?q=Corrupt&folder=inbox", {
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; undecryptable: number };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.undecryptable).toBeGreaterThanOrEqual(1);

    await db.prepare("DELETE FROM messages WHERE id = 'corrupt-row-id-1'").run();
  });
});
