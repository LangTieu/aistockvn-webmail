import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SESSION_COOKIE, signSession } from "./auth";
import worker from "./index";
import { __setImapConnectForTests, type ImapConnectFn } from "./gmail";
import { encryptText, getEncryptionKey } from "./crypto";
import type { Env } from "./mail";

const SECRET = "s".repeat(40);
const TEST_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";
const FAKE_APP_PASSWORD = "abcd efgh ijkl mnop";

const ALICE_EMAIL = "alice@aistockvn.com";
const BOB_EMAIL = "bob@aistockvn.com";
const ADMIN_EMAIL = "admin@aistockvn.com";
const ALICE_ID = "u-a";
const BOB_ID = "u-b";
const ADMIN_ID = "u-admin";

const ALICE_GMAIL = "alice.test@gmail.com";
const ALLOWED_EMAILS = [ALICE_EMAIL, BOB_EMAIL, ADMIN_EMAIL].join(",");

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: "super_admin" | "admin" | "user";
  status: "active" | "banned";
  created_at: number;
}

interface MailboxRow {
  id: string;
  user_id: string;
  address: string;
}

interface ExternalAccountRow {
  id: string;
  user_id: string;
  provider: string;
  email: string;
  credential_enc: string;
  status: string;
  last_seen_uid: number;
  uid_validity: number | null;
  last_synced_at: number | null;
  lease_until: number;
  last_error: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  folder: string;
  mailbox_address: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references_hdr: string | null;
  envelope_from: string;
  envelope_to: string;
  from_addr: string;
  from_name: string;
  to_addrs: string;
  cc_addrs: string;
  reply_to: string | null;
  subject: string;
  snippet: string;
  text_body: string;
  date: number;
  is_read: number;
  raw_key: string;
  size: number;
  attachments: string;
  spam_score: number;
  spam_reasons: string;
  is_focused: number;
  focused_reasons: string;
  source: string;
  external_account_id: string | null;
}

interface NotificationSettingsRow {
  mailbox_address: string;
  push_enabled: number;
  telegram_enabled: number;
  telegram_chat_id: string;
  detail_level: string;
  updated_at: number;
}

interface NotificationOutboxRow {
  id: string;
  mailbox_address: string;
  message_id: string;
  channel: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  sent_at: number | null;
  last_error_code: string;
}

function seedUsers(): UserRow[] {
  return [
    {
      id: ALICE_ID,
      email: ALICE_EMAIL,
      display_name: "Alice",
      password_hash: "hash",
      role: "user",
      status: "active",
      created_at: 1_700_000_000_000,
    },
    {
      id: BOB_ID,
      email: BOB_EMAIL,
      display_name: "Bob",
      password_hash: "hash",
      role: "user",
      status: "active",
      created_at: 1_700_000_001_000,
    },
    {
      id: ADMIN_ID,
      email: ADMIN_EMAIL,
      display_name: "Admin",
      password_hash: "hash",
      role: "super_admin",
      status: "active",
      created_at: 1_700_000_002_000,
    },
  ];
}

function seedMailboxes(): MailboxRow[] {
  return [
    { id: "mb-a", user_id: ALICE_ID, address: ALICE_EMAIL },
    { id: "mb-b", user_id: BOB_ID, address: BOB_EMAIL },
    { id: "mb-admin", user_id: ADMIN_ID, address: ADMIN_EMAIL },
  ];
}

function createMockD1() {
  const state = {
    users: seedUsers(),
    mailboxes: seedMailboxes(),
    externalAccounts: [] as ExternalAccountRow[],
    messages: [] as MessageRow[],
    notificationSettings: new Map<string, NotificationSettingsRow>(),
    notificationOutbox: [] as NotificationOutboxRow[],
    rawKeys: [] as string[],
  };

  const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const userByEmail = (email: unknown) =>
    state.users.find((u) => u.email.toLowerCase() === lower(email)) ?? null;
  const accountById = (id: unknown) =>
    state.externalAccounts.find((a) => a.id === String(id)) ?? null;

  function makeStatement(sql: string, binds: unknown[]) {
    const upper = sql
      .replace(/\s+/g, " ")
      .replace(/\s*(<=|>=|<>|!=|=|<|>)\s*/g, "$1")
      .trim()
      .toUpperCase();

    const mailboxBinds = (start: number) => {
      const end = upper.includes("SUBJECT LIKE ?") ? binds.length - 1 : binds.length;
      return binds.slice(start, end).map(lower).filter(Boolean);
    };

    return {
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        // NOTE: external_accounts must be matched first: the ownership query embeds
        // "(SELECT id FROM users WHERE email = ?)" and would otherwise hit the users branch.
        if (upper.includes("FROM EXTERNAL_ACCOUNTS")) {
          if (upper.includes("USER_ID=(SELECT")) {
            const u = userByEmail(binds[1]);
            const row = accountById(binds[0]);
            if (!row || !u || row.user_id !== u.id) return null;
            return { id: row.id } as unknown as T;
          }
          if (upper.includes("USER_ID=?") && upper.includes("EMAIL=?") && !upper.includes("(SELECT")) {
            const userId = String(binds[0]);
            const email = lower(binds[1]);
            const row = state.externalAccounts.find(
              (a) => a.user_id === userId && a.provider === "gmail" && a.email === email,
            );
            return (row ? { id: row.id } : null) as unknown as T;
          }
          if (upper.includes("AND USER_ID=?")) {
            const row = accountById(binds[0]);
            if (!row || row.user_id !== String(binds[1])) return null;
            return row as unknown as T;
          }
          return (accountById(binds[0]) ?? null) as unknown as T;
        }

        if (upper.includes("FROM USERS") && upper.includes("EMAIL=?")) {
          const u = userByEmail(binds[0]);
          if (!u) return null;
          return {
            id: u.id,
            email: u.email,
            display_name: u.display_name,
            role: u.role,
            status: u.status,
          } as unknown as T;
        }

        if (upper.includes("FROM MESSAGES")) {
          if (upper.includes("JOIN MESSAGES_FTS")) {
            return { total: 0 } as unknown as T;
          }
          if (upper.includes("COUNT(*)")) {
            const mailboxes = binds.length > 0 ? binds.map(lower) : null;
            const n = state.messages.filter(
              (m) =>
                (!mailboxes || mailboxes.includes(lower(m.mailbox_address))) &&
                m.folder === "inbox" &&
                m.is_read === 0,
            ).length;
            return { n, count: n } as unknown as T;
          }
          if (upper.includes("MESSAGE_ID=?")) {
            const mailbox = lower(binds[0]);
            const messageId = String(binds[1] ?? "");
            const row = state.messages.find(
              (m) =>
                m.message_id === messageId &&
                lower(m.mailbox_address) === mailbox &&
                m.folder === "inbox",
            );
            return (row ? { id: row.id } : null) as unknown as T;
          }
          return null;
        }

        if (upper.includes("FROM SPAM_BLOCKLIST")) return null;

        if (upper.includes("FROM NOTIFICATION_SETTINGS")) {
          return (state.notificationSettings.get(lower(binds[0])) ?? null) as unknown as T;
        }

        return null;
      },

      async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
        if (upper.includes("FROM EXTERNAL_ACCOUNTS")) {
          let rows: ExternalAccountRow[] = [];
          if (upper.includes("USER_ID=(SELECT")) {
            const u = userByEmail(binds[0]);
            rows = u
              ? state.externalAccounts.filter(
                  (a) =>
                    a.user_id === u.id &&
                    a.provider === "gmail" &&
                    (a.status === "active" || a.status === "error"),
                )
              : [];
          } else {
            const userId = String(binds[0]);
            rows = state.externalAccounts
              .filter((a) => a.user_id === userId)
              .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
          }
          return { results: rows as unknown as T[] };
        }

        if (upper.includes("FROM MAILBOXES")) {
          const u = userByEmail(binds[0]);
          const rows = u
            ? state.mailboxes.filter((m) => m.user_id === u.id).map((m) => ({ address: m.address }))
            : [];
          return { results: rows as unknown as T[] };
        }

        if (upper.includes("FROM USERS")) {
          return {
            results: state.users
              .filter((u) => !!u.display_name)
              .map((u) => ({ display_name: u.display_name })) as unknown as T[],
          };
        }

        if (upper.includes("FROM MESSAGES")) {
          if (upper.includes("JOIN MESSAGES_FTS")) return { results: [] as T[] };
          if (upper.includes("FOLDER='SENT'")) {
            return {
              results: state.messages
                .filter((m) => m.folder === "sent" && !!m.message_id)
                .map((m) => ({ message_id: m.message_id })) as unknown as T[],
            };
          }
          if (upper.includes("TEXT_BODY LIKE 'ENC:V1:%'")) {
            const folder = lower(binds[0]);
            const mailboxes = binds.slice(1).map(lower);
            const rows = state.messages.filter(
              (m) =>
                m.folder === folder &&
                mailboxes.includes(lower(m.mailbox_address)) &&
                m.text_body.startsWith("enc:v1:"),
            );
            return { results: rows as unknown as T[] };
          }
          if (upper.includes("FOLDER=?") && upper.includes("DATE<?")) {
            const folder = lower(binds[0]);
            const before = Number(binds[1]);
            const mailboxes = mailboxBinds(2);
            const rows = state.messages
              .filter(
                (m) =>
                  m.folder === folder &&
                  m.date < before &&
                  mailboxes.includes(lower(m.mailbox_address)),
              )
              .sort((a, b) => b.date - a.date);
            return { results: rows as unknown as T[] };
          }
          return { results: [] as T[] };
        }

        return { results: [] as T[] };
      },

      async run(): Promise<{ success: boolean; meta: { changes: number } }> {
        if (upper.startsWith("INSERT INTO EXTERNAL_ACCOUNTS")) {
          const [id, userId, email, credentialEnc, createdAt, updatedAt] = binds;
          const normalizedEmail = lower(email);
          const dup = state.externalAccounts.some(
            (a) =>
              a.user_id === String(userId) && a.provider === "gmail" && a.email === normalizedEmail,
          );
          if (dup) return { success: true, meta: { changes: 0 } };
          state.externalAccounts.push({
            id: String(id),
            user_id: String(userId),
            provider: "gmail",
            email: normalizedEmail,
            credential_enc: String(credentialEnc),
            status: "active",
            last_seen_uid: 0,
            uid_validity: null,
            last_synced_at: null,
            lease_until: 0,
            last_error: "",
            created_at: Number(createdAt),
            updated_at: Number(updatedAt),
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("UPDATE EXTERNAL_ACCOUNTS SET STATUS='SYNCING'")) {
          const [leaseUntil, now, accountId, claimNow] = binds;
          const row = accountById(accountId);
          if (!row || row.status !== "active" || row.lease_until > Number(claimNow)) {
            return { success: true, meta: { changes: 0 } };
          }
          row.status = "syncing";
          row.lease_until = Number(leaseUntil);
          row.updated_at = Number(now);
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("UPDATE EXTERNAL_ACCOUNTS SET LAST_SEEN_UID=?")) {
          const [uid, now, accountId] = binds;
          const row = accountById(accountId);
          if (!row) return { success: true, meta: { changes: 0 } };
          row.last_seen_uid = Number(uid);
          row.updated_at = Number(now);
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("UPDATE EXTERNAL_ACCOUNTS SET STATUS='ACTIVE'")) {
          const [uidValidity, lastSeenUid, now, lastError, updatedAt, accountId] = binds;
          const row = accountById(accountId);
          if (!row) return { success: true, meta: { changes: 0 } };
          row.status = "active";
          row.uid_validity = uidValidity === null ? null : Number(uidValidity);
          row.last_seen_uid = Number(lastSeenUid);
          row.last_synced_at = Number(now);
          row.lease_until = 0;
          row.last_error = String(lastError ?? "");
          row.updated_at = Number(updatedAt);
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("UPDATE EXTERNAL_ACCOUNTS SET STATUS='ERROR'")) {
          const [lastError, now, accountId] = binds;
          const row = accountById(accountId);
          if (!row) return { success: true, meta: { changes: 0 } };
          row.status = "error";
          row.lease_until = 0;
          row.last_error = String(lastError ?? "");
          row.updated_at = Number(now);
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("UPDATE EXTERNAL_ACCOUNTS SET STATUS='DISABLED'")) {
          const [now, accountId, userId] = binds;
          const row = accountById(accountId);
          if (!row || row.user_id !== String(userId)) {
            return { success: true, meta: { changes: 0 } };
          }
          row.status = "disabled";
          row.updated_at = Number(now);
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("INSERT OR IGNORE INTO MESSAGES")) {
          const [id, folder, mailbox, messageId] = binds;
          const message_id = messageId === null || messageId === undefined ? null : String(messageId);
          if (message_id !== null) {
            const dup = state.messages.some(
              (m) =>
                m.message_id === message_id &&
                m.folder === String(folder) &&
                lower(m.mailbox_address) === lower(mailbox),
            );
            if (dup) return { success: true, meta: { changes: 0 } };
          }
          state.messages.push({
            id: String(id),
            folder: String(folder),
            mailbox_address: mailbox === null || mailbox === undefined ? null : String(mailbox),
            message_id,
            in_reply_to: binds[4] === null || binds[4] === undefined ? null : String(binds[4]),
            references_hdr: binds[5] === null || binds[5] === undefined ? null : String(binds[5]),
            envelope_from: String(binds[6] ?? ""),
            envelope_to: String(binds[7] ?? ""),
            from_addr: String(binds[8] ?? ""),
            from_name: String(binds[9] ?? ""),
            to_addrs: String(binds[10] ?? "[]"),
            cc_addrs: String(binds[11] ?? "[]"),
            reply_to: binds[12] === null || binds[12] === undefined ? null : String(binds[12]),
            subject: String(binds[13] ?? ""),
            snippet: String(binds[14] ?? ""),
            text_body: String(binds[15] ?? ""),
            date: Number(binds[16] ?? 0),
            is_read: 0,
            raw_key: String(binds[17] ?? ""),
            size: Number(binds[18] ?? 0),
            attachments: String(binds[19] ?? "[]"),
            spam_score: Number(binds[20] ?? 0),
            spam_reasons: String(binds[21] ?? "[]"),
            is_focused: Number(binds[22] ?? 0),
            focused_reasons: String(binds[23] ?? "[]"),
            source: String(binds[24] ?? "omnimail"),
            external_account_id:
              binds[25] === null || binds[25] === undefined ? null : String(binds[25]),
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (upper.startsWith("INSERT OR IGNORE INTO NOTIFICATION_OUTBOX")) {
          const [id, mailbox, messageId, channel, nextAttemptAt, createdAt] = binds;
          const normalizedMailbox = lower(mailbox);
          const normalizedMessageId = String(messageId);
          const normalizedChannel = String(channel);
          const dup = state.notificationOutbox.some(
            (r) =>
              r.mailbox_address === normalizedMailbox &&
              r.message_id === normalizedMessageId &&
              r.channel === normalizedChannel,
          );
          if (dup) return { success: true, meta: { changes: 0 } };
          state.notificationOutbox.push({
            id: String(id),
            mailbox_address: normalizedMailbox,
            message_id: normalizedMessageId,
            channel: normalizedChannel,
            status: "pending",
            attempts: 0,
            next_attempt_at: Number(nextAttemptAt),
            created_at: Number(createdAt),
            sent_at: null,
            last_error_code: "",
          });
          return { success: true, meta: { changes: 1 } };
        }

        return { success: true, meta: { changes: 0 } };
      },
    };
  }

  const db = {
    prepare(sql: string) {
      const base = makeStatement(sql, []);
      return {
        ...base,
        bind(...binds: unknown[]) {
          return makeStatement(sql, binds);
        },
      };
    },
  };

  return { db: db as unknown as D1Database, state };
}

function makeEnv(db: D1Database, rawKeys: string[]): Env {
  return {
    DB: db,
    RAW: {
      async put(key: string) {
        rawKeys.push(key);
      },
      async delete() {},
      async head() {
        return null;
      },
    } as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } as unknown as Fetcher,
    MAILBOX_ADDRESS: ADMIN_EMAIL,
    FROM_NAME: "AI Stock VN",
    ALLOWED_EMAILS,
    GOOGLE_CLIENT_ID: "",
    FORWARD_TO: "",
    RESEND_API_KEY: "re_test_dummy_key",
    ENCRYPTION_KEY: TEST_KEY_B64,
    SESSION_SECRET: SECRET,
  };
}

async function authedRequest(
  email: string,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<Request> {
  const token = await signSession(email, SECRET);
  const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${token}` };
  if (method !== "GET") {
    headers["X-Mail-Client"] = "1";
    headers["Content-Type"] = "application/json";
  }
  return new Request(`https://mail.aistockvn.com${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

interface ImapScript {
  loginOk?: boolean;
  uidsByMailbox?: Record<string, number[]>;
  rawByUid?: Record<number, string>;
  failUids?: number[];
}

function installFakeImap(script: ImapScript): { calls: { count: number } } {
  const calls = { count: 0 };
  const encoder = new TextEncoder();

  const factory: ImapConnectFn = () => {
    calls.count += 1;
    const decoder = new TextDecoder();
    let loggedInAs = "";
    let buffer = "";
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

    const emit = (text: string) => {
      controllerRef?.enqueue(encoder.encode(text));
    };

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(encoder.encode("* OK Gimap ready\r\n"));
      },
    });

    const handleLine = (line: string) => {
      const tagMatch = line.match(/^(\S+) (.*)$/);
      if (!tagMatch) return;
      const tag = tagMatch[1];
      const rest = tagMatch[2];

      if (rest === "SELECT INBOX") {
        emit(
          `* 3 EXISTS\r\n* OK [UIDVALIDITY 12345]\r\n* OK [UIDNEXT 200]\r\n${tag} OK SELECT completed\r\n`,
        );
        return;
      }

      const loginMatch = rest.match(/^LOGIN "([^"]*)" "(.*)"$/);
      if (loginMatch) {
        if (script.loginOk === false) {
          emit(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        } else {
          loggedInAs = loginMatch[1].toLowerCase();
          emit(`${tag} OK LOGIN completed\r\n`);
        }
        return;
      }

      const searchMatch = rest.match(/^UID SEARCH UID (\d+):\*/);
      if (searchMatch) {
        const from = Number(searchMatch[1]);
        const uids = (script.uidsByMailbox?.[loggedInAs] ?? [])
          .filter((uid) => uid >= from)
          .sort((a, b) => a - b);
        const list = uids.length > 0 ? ` ${uids.join(" ")}` : "";
        emit(`* SEARCH${list}\r\n${tag} OK SEARCH completed\r\n`);
        return;
      }

      const fetchMatch = rest.match(/^UID FETCH (\d+) \(UID BODY\.PEEK\[\]\)$/);
      if (fetchMatch) {
        const uid = Number(fetchMatch[1]);
        const raw = script.rawByUid?.[uid];
        if ((script.failUids ?? []).includes(uid) || raw === undefined) {
          emit(`${tag} NO FETCH failed\r\n`);
          return;
        }
        const bytes = encoder.encode(raw);
        emit(`* ${uid} FETCH (UID ${uid} BODY[] {${bytes.length}}\r\n`);
        controllerRef?.enqueue(bytes);
        emit("\r\n");
        emit(`${tag} OK FETCH completed\r\n`);
        return;
      }

      if (rest === "LOGOUT") {
        emit(`* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`);
        return;
      }

      emit(`${tag} BAD Unknown command\r\n`);
    };

    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx = buffer.indexOf("\r\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleLine(line);
          idx = buffer.indexOf("\r\n");
        }
      },
    });

    return { opened: Promise.resolve(), readable, writable, close: async () => {} };
  };

  __setImapConnectForTests(factory);
  return { calls };
}

function makeRaw(opts: {
  messageId: string;
  subject: string;
  body: string;
  to?: string;
  from?: string;
}): string {
  const to = opts.to ?? ALICE_GMAIL;
  const from = opts.from ?? "sender@example.com";
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${opts.subject}`,
    `Message-ID: <${opts.messageId}>`,
    "Date: Fri, 20 Nov 2026 01:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body,
    "",
  ].join("\n");
}

async function seedAccount(
  env: Env,
  state: ReturnType<typeof createMockD1>["state"],
  opts: { userId?: string; email?: string; password?: string; createdAt?: number } = {},
): Promise<ExternalAccountRow> {
  const key = await getEncryptionKey(env);
  const credential_enc = await encryptText(opts.password ?? FAKE_APP_PASSWORD, key);
  const createdAt = opts.createdAt ?? 1_700_000_000_000;
  const row: ExternalAccountRow = {
    id: `acc-${state.externalAccounts.length + 1}`,
    user_id: opts.userId ?? ALICE_ID,
    provider: "gmail",
    email: opts.email ?? ALICE_GMAIL,
    credential_enc,
    status: "active",
    last_seen_uid: 0,
    uid_validity: 12345,
    last_synced_at: null,
    lease_until: 0,
    last_error: "",
    created_at: createdAt,
    updated_at: createdAt,
  };
  state.externalAccounts.push(row);
  return row;
}

afterEach(() => {
  vi.restoreAllMocks();
  __setImapConnectForTests(null);
});

describe("external Gmail routes", () => {
  it("scopes GET /api/external/accounts to the calling user only", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    installFakeImap({ loginOk: true });

    const aliceConnect = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/external/gmail/connect", "POST", {
        email: ALICE_GMAIL,
        appPassword: FAKE_APP_PASSWORD,
      }),
      env,
    );
    expect(aliceConnect.status).toBe(200);
    const aliceBody = (await aliceConnect.json()) as { account: { id: string } };
    expect(state.externalAccounts).toHaveLength(1);

    const aliceList = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/external/accounts"),
      env,
    );
    expect(aliceList.status).toBe(200);
    const aliceAccounts = ((await aliceList.json()) as { accounts: Array<{ email: string }> })
      .accounts;
    expect(aliceAccounts).toHaveLength(1);
    expect(aliceAccounts[0].email).toBe(ALICE_GMAIL);

    const bobList = await worker.fetch(await authedRequest(BOB_EMAIL, "/api/external/accounts"), env);
    expect(bobList.status).toBe(200);
    expect(((await bobList.json()) as { accounts: unknown[] }).accounts).toHaveLength(0);

    const adminList = await worker.fetch(
      await authedRequest(ADMIN_EMAIL, "/api/external/accounts"),
      env,
    );
    expect(adminList.status).toBe(200);
    expect(((await adminList.json()) as { accounts: unknown[] }).accounts).toHaveLength(0);
    expect(aliceBody.account.id).toBeTruthy();
  });

  it("connect returns the account without any credential material and rejects a bad password with 401", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    installFakeImap({ loginOk: true });

    const okRes = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/external/gmail/connect", "POST", {
        email: ALICE_GMAIL,
        appPassword: FAKE_APP_PASSWORD,
      }),
      env,
    );
    expect(okRes.status).toBe(200);
    const rawBody = await okRes.text();
    expect(rawBody).not.toContain(FAKE_APP_PASSWORD);
    expect(rawBody).not.toContain("credential_enc");
    const body = JSON.parse(rawBody) as { account: { email: string; status: string } };
    expect(body.account.email).toBe(ALICE_GMAIL);
    expect(body.account.status).toBe("active");
    expect(state.externalAccounts[0].credential_enc.startsWith("enc:v1:")).toBe(true);

    installFakeImap({ loginOk: false });
    const badRes = await worker.fetch(
      await authedRequest(BOB_EMAIL, "/api/external/gmail/connect", "POST", {
        email: BOB_EMAIL.replace("@aistockvn.com", ".test@gmail.com"),
        appPassword: FAKE_APP_PASSWORD,
      }),
      env,
    );
    expect(badRes.status).toBe(401);
    expect(((await badRes.json()) as { error?: string }).error).toBe("gmail_auth_failed");
    expect(state.externalAccounts).toHaveLength(1);
  });

  it("returns the App Password guidance message for a bad-length password", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    const response = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/external/gmail/connect", "POST", {
        email: ALICE_GMAIL,
        appPassword: "too-short",
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_input",
      code: "invalid_input",
      message:
        "Enter the 16-character App Password Google generated (Google Account > Security > 2-Step Verification > App passwords), not your regular Gmail password.",
    });
    expect(state.externalAccounts).toHaveLength(0);
  });

  it("disconnect returns 404 for another user's account and 200 with status disabled for the owner", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    const bobAccount = await seedAccount(env, state, {
      userId: BOB_ID,
      email: "bob.test@gmail.com",
      createdAt: 1_700_000_001_000,
    });

    const foreign = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/external/gmail/disconnect", "POST", {
        accountId: bobAccount.id,
      }),
      env,
    );
    expect(foreign.status).toBe(404);
    expect(state.externalAccounts.find((a) => a.id === bobAccount.id)?.status).toBe("active");

    const own = await worker.fetch(
      await authedRequest(BOB_EMAIL, "/api/external/gmail/disconnect", "POST", {
        accountId: bobAccount.id,
      }),
      env,
    );
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as { account: { status: string } };
    expect(ownBody.account.status).toBe("disabled");
    expect(state.externalAccounts.find((a) => a.id === bobAccount.id)?.status).toBe("disabled");
  });

  it("sync returns 404 for another user's account without running IMAP, and 200 for the owner", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    const bobAccount = await seedAccount(env, state, {
      userId: BOB_ID,
      email: "bob.test@gmail.com",
      createdAt: 1_700_000_001_000,
    });
    const imap = installFakeImap({
      loginOk: true,
      uidsByMailbox: {
        "bob.test@gmail.com": [301],
        [ALICE_GMAIL]: [101],
      },
      rawByUid: {
        301: makeRaw({
          messageId: "bob-1@example.com",
          subject: "Bob mail",
          body: "Bob body",
          to: "bob.test@gmail.com",
        }),
        101: makeRaw({
          messageId: "alice-1@example.com",
          subject: "Alice mail",
          body: "Alice body",
        }),
      },
    });

    const foreign = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/external/gmail/sync", "POST", {
        accountId: bobAccount.id,
      }),
      env,
    );
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error?: string }).error).toBe("account_not_found");
    expect(imap.calls.count).toBe(0);
    expect(state.messages).toHaveLength(0);

    const aliceAccount = await seedAccount(env, state, { createdAt: 1_700_000_000_000 });
    const own = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/external/gmail/sync", "POST", {
        accountId: aliceAccount.id,
      }),
      env,
    );
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ fetched: 1, inserted: 1, duplicates: 0, errors: 0 });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].mailbox_address).toBe(ALICE_GMAIL);
  });

  it("shows an external message only to its owner across messages, search, and counts", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    installFakeImap({
      loginOk: true,
      uidsByMailbox: { [ALICE_GMAIL]: [101] },
      rawByUid: {
        101: makeRaw({
          messageId: "zebra-1@example.com",
          subject: "External zebra",
          body: "A zebra crossed the road",
        }),
      },
    });
    const account = await seedAccount(env, state);

    const syncRes = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/external/gmail/sync", "POST", {
        accountId: account.id,
      }),
      env,
    );
    expect(syncRes.status).toBe(200);
    const stored = state.messages[0];
    expect(stored.subject).toBe("External zebra");
    expect(stored.source).toBe("gmail");
    expect(stored.mailbox_address).toBe(ALICE_GMAIL);

    const aliceMessages = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/messages?folder=inbox"),
      env,
    );
    expect(aliceMessages.status).toBe(200);
    const aliceItems = ((await aliceMessages.json()) as { items: Array<{ id: string }> }).items;
    expect(aliceItems.map((i) => i.id)).toContain(stored.id);

    const bobMessages = await worker.fetch(
      await authedRequest(BOB_EMAIL, "/api/messages?folder=inbox"),
      env,
    );
    expect(bobMessages.status).toBe(200);
    const bobItems = ((await bobMessages.json()) as { items: Array<{ id: string }> }).items;
    expect(bobItems.map((i) => i.id)).not.toContain(stored.id);
    expect(bobItems).toHaveLength(0);

    const aliceSearch = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/search?q=zebra"),
      env,
    );
    expect(aliceSearch.status).toBe(200);
    const aliceSearchBody = (await aliceSearch.json()) as {
      items: Array<{ id: string }>;
      total: number;
    };
    expect(aliceSearchBody.total).toBe(1);
    expect(aliceSearchBody.items.map((i) => i.id)).toContain(stored.id);

    const bobSearch = await worker.fetch(await authedRequest(BOB_EMAIL, "/api/search?q=zebra"), env);
    expect(bobSearch.status).toBe(200);
    const bobSearchBody = (await bobSearch.json()) as { items: unknown[]; total: number };
    expect(bobSearchBody.total).toBe(0);
    expect(bobSearchBody.items).toHaveLength(0);

    const aliceCounts = await worker.fetch(await authedRequest(ALICE_EMAIL, "/api/counts"), env);
    expect(aliceCounts.status).toBe(200);
    const aliceUnread = (await aliceCounts.json()) as { unread: number };
    expect(aliceUnread.unread).toBeGreaterThanOrEqual(1);

    const bobCounts = await worker.fetch(await authedRequest(BOB_EMAIL, "/api/counts"), env);
    expect(bobCounts.status).toBe(200);
    expect(((await bobCounts.json()) as { unread: number }).unread).toBe(0);
  });

  it("listItem exposes mailboxAddress and source for an external message", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    installFakeImap({
      loginOk: true,
      uidsByMailbox: { [ALICE_GMAIL]: [101] },
      rawByUid: {
        101: makeRaw({
          messageId: "source-1@example.com",
          subject: "Source check",
          body: "Source check body",
        }),
      },
    });
    const account = await seedAccount(env, state);
    const syncRes = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/external/gmail/sync", "POST", {
        accountId: account.id,
      }),
      env,
    );
    expect(syncRes.status).toBe(200);

    const listRes = await worker.fetch(
      await authedRequest(ALICE_EMAIL, "/api/messages?folder=inbox"),
      env,
    );
    const items = ((await listRes.json()) as { items: Array<Record<string, unknown>> }).items;
    const external = items.find((i) => i.subject === "Source check");
    expect(external).toBeTruthy();
    expect(external!.mailboxAddress).toBe(ALICE_GMAIL);
    expect(external!.source).toBe("gmail");
  });

  it("migration 0015 declares the external_accounts table, new columns, and mailbox-scoped unique index", () => {
    const sql = readFileSync(new URL("../migrations/0015_external.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS external_accounts");
    expect(sql).toContain("UNIQUE (user_id, provider, email)");
    expect(sql).toContain("ADD COLUMN source");
    expect(sql).toContain("ADD COLUMN external_account_id");
    expect(sql).toContain("idx_messages_mailbox_folder_msgid");
  });

  it("rejects an unauthenticated GET /api/external/accounts with 401", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);

    const res = await worker.fetch(
      new Request("https://mail.aistockvn.com/api/external/accounts"),
      env,
    );
    expect(res.status).toBe(401);
  });
});
