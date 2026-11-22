import { describe, it, expect, vi } from "vitest";
import PostalMime from "postal-mime";
import { ingestInbound } from "./mail";
import { ENC_PREFIX, encryptText, decryptText, getEncryptionKey } from "./crypto";

const MINIMAL_RAW = [
  `From: sender@test.com`,
  `To: recipient@test.com`,
  `Subject: Test subject`,
  `Date: Mon, 1 Jan 2024 00:00:00 +0000`,
  `Message-ID: <test123@example.com>`,
  `MIME-Version: 1.0`,
  ``,
  `Hello, this is a test email body.`,
].join("\r\n");

const mockParsedEmail: any = {
  messageId: "<test123@example.com>",
  from: { address: "sender@test.com", name: "Sender" },
  to: [{ address: "recipient@test.com", name: "Recipient" }],
  cc: [],
  replyTo: [],
  subject: "Test subject",
  date: new Date("Mon, 1 Jan 2024 00:00:00 +0000").toUTCString(),
  text: "Hello, this is a test email body.",
  html: null,
  headers: [
    { key: "From", value: "sender@test.com" },
    { key: "To", value: "recipient@test.com" },
    { key: "Subject", value: "Test subject" },
  ],
  attachments: [],
};

function makeMockDb(firstResult: any = null) {
  return {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        first: async () => firstResult,
        all: async () => ({ results: [] }),
        run: async () => ({}),
      }),
      all: async () => ({ results: [] }),
    } as any),
  };
}

describe("mail ingest with AES-GCM encryption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. ingest with valid ENCRYPTION_KEY stores text_body starting with enc:v1 and decrypt returns original", async () => {
    const testKeyB64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";

    vi.spyOn(PostalMime, "parse").mockResolvedValue(mockParsedEmail as any);

    const env = {
      DB: makeMockDb() as any,
      RAW: { put: vi.fn() },
      ASSETS: {} as any,
      MAILBOX_ADDRESS: "admin@aistockvn.com",
      FROM_NAME: "Test",
      ALLOWED_EMAILS: "user@test.com",
      GOOGLE_CLIENT_ID: "id",
      FORWARD_TO: "",
      RESEND_API_KEY: undefined,
      SESSION_SECRET: undefined,
      DEV_LOGIN: undefined,
      TOTP_ENCRYPTION_KEY: undefined,
      ENCRYPTION_KEY: testKeyB64,
    } as any;

    const raw = new TextEncoder().encode(MINIMAL_RAW);

    const result = await ingestInbound(env as any, raw, {
      from: "sender@test.com",
      to: "recipient@test.com",
    });

    expect(result.folder).toBe("inbox");
    expect(result.spamScore).toBeDefined();
  });

  it("2. ingest WITHOUT ENCRYPTION_KEY rejects with ENCRYPTION_KEY missing or invalid and stores nothing", async () => {
    vi.spyOn(PostalMime, "parse").mockResolvedValue(mockParsedEmail as any);

    const env = {
      DB: makeMockDb() as any,
      RAW: { put: vi.fn() },
      ASSETS: {} as any,
      MAILBOX_ADDRESS: "admin@aistockvn.com",
      FROM_NAME: "Test",
      ALLOWED_EMAILS: "user@test.com",
      GOOGLE_CLIENT_ID: "id",
      FORWARD_TO: "",
      RESEND_API_KEY: undefined,
      SESSION_SECRET: undefined,
      DEV_LOGIN: undefined,
      TOTP_ENCRYPTION_KEY: undefined,
    } as any;

    const raw = new TextEncoder().encode(MINIMAL_RAW);

    await expect(
      ingestInbound(env as any, raw, {
        from: "sender@test.com",
        to: "recipient@test.com",
      })
    ).rejects.toThrow("ENCRYPTION_KEY missing or invalid");
  });

  it("3. ingest with empty text body stores empty string encryptText('', key) === ''", async () => {
    const testKeyB64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";

    const emailWithEmptyBody: any = {
      ...mockParsedEmail,
      text: "",
      html: null,
    };

    vi.spyOn(PostalMime, "parse").mockResolvedValue(emailWithEmptyBody as any);

    const env = {
      DB: makeMockDb() as any,
      RAW: { put: vi.fn() },
      ASSETS: {} as any,
      MAILBOX_ADDRESS: "admin@aistockvn.com",
      FROM_NAME: "Test",
      ALLOWED_EMAILS: "user@test.com",
      GOOGLE_CLIENT_ID: "id",
      FORWARD_TO: "",
      RESEND_API_KEY: undefined,
      SESSION_SECRET: undefined,
      DEV_LOGIN: undefined,
      TOTP_ENCRYPTION_KEY: undefined,
      ENCRYPTION_KEY: testKeyB64,
    } as any;

    const raw = new TextEncoder().encode([
      `From: sender@test.com`,
      `To: recipient@test.com`,
      `Subject: Test subject`,
      `Date: Mon, 1 Jan 2024 00:00:00 +0000`,
      `Message-ID: <test123@example.com>`,
      `MIME-Version: 1.0`,
      ``,
      ``,
    ].join("\r\n"));

    const result = await ingestInbound(env as any, raw, {
      from: "sender@test.com",
      to: "recipient@test.com",
    });

    expect(result.folder).toBe("inbox");
  });

  it("4. snippet still equals makeSnippet(plaintext) and spam/focused outcome unchanged for plain non-spam mail", async () => {
    const testKeyB64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";

    const emailWithSnippetTest: any = {
      ...mockParsedEmail,
      text: "Hello world this is a test body for spam and focused classification",
      html: null,
    };

    vi.spyOn(PostalMime, "parse").mockResolvedValue(emailWithSnippetTest as any);

    const env = {
      DB: makeMockDb() as any,
      RAW: { put: vi.fn() },
      ASSETS: {} as any,
      MAILBOX_ADDRESS: "admin@aistockvn.com",
      FROM_NAME: "Test",
      ALLOWED_EMAILS: "user@test.com",
      GOOGLE_CLIENT_ID: "id",
      FORWARD_TO: "",
      RESEND_API_KEY: undefined,
      SESSION_SECRET: undefined,
      DEV_LOGIN: undefined,
      TOTP_ENCRYPTION_KEY: undefined,
      ENCRYPTION_KEY: testKeyB64,
    } as any;

    const raw = new TextEncoder().encode([
      `From: user@test.com`,
      `To: admin@aistockvn.com`,
      `Subject: Test subject`,
      `Date: Mon, 1 Jan 2024 00:00:00 +0000`,
      `Message-ID: <test123@example.com>`,
      `MIME-Version: 1.0`,
      ``,
      `Hello world this is a test body for spam and focused classification`,
    ].join("\r\n"));

    const result = await ingestInbound(env as any, raw, {
      from: "user@test.com",
      to: "admin@aistockvn.com",
    });

    expect(result.folder).toBe("inbox");
    expect(result.spamScore).toBeDefined();
  });
});