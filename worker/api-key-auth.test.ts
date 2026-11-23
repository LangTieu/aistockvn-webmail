import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./mail";

const API_KEY = "a-test-api-key-that-is-never-a-production-secret";

function makeEnv(apiKey?: string): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(..._values: unknown[]) {
          return {
            async all() {
              if (sql.includes("SELECT address FROM mailboxes")) return { results: [{ address: "owner@example.com" }] };
              if (sql.includes("SELECT email FROM external_accounts")) return { results: [] };
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return {
    DB: db,
    RAW: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    MAILBOX_ADDRESS: "owner@example.com",
    FROM_NAME: "Owner",
    ALLOWED_EMAILS: "owner@example.com",
    GOOGLE_CLIENT_ID: "",
    FORWARD_TO: "",
    SESSION_SECRET: "test-secret",
    MAIL_API_KEY: apiKey,
  } as Env;
}

function request(path: string, key?: string) {
  const headers = new Headers();
  if (key !== undefined) headers.set("X-Api-Key", key);
  return worker.fetch(new Request(`https://mail.example${path}`, { headers }), makeEnv(API_KEY), {} as ExecutionContext);
}

describe("mail API key authentication", () => {
  it("accepts the configured key for messages", async () => {
    const response = await request("/api/messages", API_KEY);
    expect(response.status).toBe(200);
  });

  it("rejects an incorrect key", async () => {
    const response = await request("/api/messages", "wrong-key");
    expect(response.status).toBe(401);
  });

  it("rejects a request without a key or session", async () => {
    const response = await request("/api/messages");
    expect(response.status).toBe(401);
  });

  it("does not accept the API key for admin routes", async () => {
    const response = await request("/api/admin/stats", API_KEY);
    expect(response.status).toBe(401);
  });
});
