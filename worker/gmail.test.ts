import { afterEach, describe, expect, it } from "vitest";
import {
  GmailError,
  __setImapConnectForTests,
  connectGmailAccount,
  syncGmailAccount,
  type ImapConnectFn,
} from "./gmail";
import { decryptText, encryptText, getEncryptionKey } from "./crypto";
import type { Env } from "./mail";

const TEST_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";
const FAKE_APP_PASSWORD = "abcd efgh ijkl mnop";
const GMAIL_ADDRESS = "alice.test@gmail.com";
const SECOND_GMAIL_ADDRESS = "alice2.test@gmail.com";
const USER_EMAIL = "alice@aistockvn.com";
const USER_ID = "u-a";
const SHARED_MAILBOX = "admin@aistockvn.com";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
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

function createMockD1() {
  const state = {
    users: [
      { id: USER_ID, email: USER_EMAIL, display_name: "Alice", role: "user", status: "active" },
    ] as UserRow[],
    mailboxes: [{ id: "mb-a", user_id: USER_ID, address: USER_EMAIL }] as MailboxRow[],
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
    // Normalize whitespace and spaces around '=' so both `folder='sent'` and `folder = ?` match.
    const upper = sql
      .replace(/\s+/g, " ")
      .replace(/\s*=\s*/g, "=")
      .trim()
      .toUpperCase();

    const mailboxBinds = (start: number) => {
      const end = upper.includes("SUBJECT LIKE ?") ? binds.length - 1 : binds.length;
      return binds.slice(start, end).map(lower).filter(Boolean);
    };

    return {
      async first<T = Record<string, unknown>>(): Promise<T | null> {
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

        if (upper.includes("FROM EXTERNAL_ACCOUNTS")) {
          // Route ownership check: WHERE id = ? AND user_id = (SELECT id FROM users WHERE email = ?)
          if (upper.includes("USER_ID=(SELECT")) {
            const u = userByEmail(binds[1]);
            const row = accountById(binds[0]);
            if (!row || !u || row.user_id !== u.id) return null;
            return { id: row.id } as unknown as T;
          }
          // Duplicate-email check: WHERE user_id = ? AND provider = 'gmail' AND email = ?
          if (upper.includes("USER_ID=?") && upper.includes("EMAIL=?") && !upper.includes("(SELECT")) {
            const userId = String(binds[0]);
            const email = lower(binds[1]);
            const row = state.externalAccounts.find(
              (a) => a.user_id === userId && a.provider === "gmail" && a.email === email,
            );
            return (row ? { id: row.id } : null) as unknown as T;
          }
          // Disconnect lookup: WHERE id = ? AND user_id = ?
          if (upper.includes("AND USER_ID=?")) {
            const row = accountById(binds[0]);
            if (!row || row.user_id !== String(binds[1])) return null;
            return row as unknown as T;
          }
          // Single row by id (sync path)
          return (accountById(binds[0]) ?? null) as unknown as T;
        }

        if (upper.includes("FROM MESSAGES")) {
          if (upper.includes("COUNT(*)")) {
            const mailboxes = binds.length > 0 ? binds.map(lower) : null;
            const n = state.messages.filter(
              (m) =>
                (!mailboxes || mailboxes.includes(lower(m.mailbox_address))) &&
                m.folder === "inbox" &&
                m.is_read === 0,
            ).length;
            return { n } as unknown as T;
          }
          if (upper.includes("JOIN MESSAGES_FTS")) {
            return { total: 0 } as unknown as T;
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
            (a) => a.user_id === String(userId) && a.provider === "gmail" && a.email === normalizedEmail,
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

        // Claim lease: ... WHERE id = ? AND status = 'active' AND lease_until <= ?
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

        // Cursor flush: UPDATE external_accounts SET last_seen_uid = ?, updated_at = ? WHERE id = ?
        if (upper.startsWith("UPDATE EXTERNAL_ACCOUNTS SET LAST_SEEN_UID=?")) {
          const [uid, now, accountId] = binds;
          const row = accountById(accountId);
          if (!row) return { success: true, meta: { changes: 0 } };
          row.last_seen_uid = Number(uid);
          row.updated_at = Number(now);
          return { success: true, meta: { changes: 1 } };
        }

        // Final success: SET status = 'active', uid_validity = ?, last_seen_uid = ?, last_synced_at = ?, lease_until = 0, last_error = ?, updated_at = ?
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

        // Final failure: SET status = 'error', lease_until = 0, last_error = ?, updated_at = ?
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

        // Disconnect: SET status = 'disabled', updated_at = ? WHERE id = ? AND user_id = ?
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
    MAILBOX_ADDRESS: SHARED_MAILBOX,
    FROM_NAME: "AI Stock VN",
    ALLOWED_EMAILS: `${USER_EMAIL},${SHARED_MAILBOX}`,
    GOOGLE_CLIENT_ID: "",
    FORWARD_TO: "",
    ENCRYPTION_KEY: TEST_KEY_B64,
  };
}

interface ImapScript {
  loginOk?: boolean;
  uidsByMailbox?: Record<string, number[]>;
  rawByUid?: Record<number, string>;
  failUids?: number[];
}

interface FakeImapHandle {
  calls: { count: number };
  loginPasswords: string[];
}

function installFakeImap(script: ImapScript): FakeImapHandle {
  const calls = { count: 0 };
  const loginPasswords: string[] = [];
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
        loginPasswords.push(loginMatch[2]);
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
        // Real IMAP framing: the literal marker closes the line, the ')' arrives after the bytes.
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

    return {
      opened: Promise.resolve(),
      readable,
      writable,
      close: async () => {},
    };
  };

  __setImapConnectForTests(factory);
  return { calls, loginPasswords };
}

function makeRaw(opts: {
  messageId: string;
  subject: string;
  body: string;
  to?: string;
  from?: string;
}): string {
  const to = opts.to ?? GMAIL_ADDRESS;
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
  opts: {
    email?: string;
    userId?: string;
    password?: string;
    status?: string;
    uidValidity?: number | null;
    lastSeenUid?: number;
    lastSyncedAt?: number | null;
    leaseUntil?: number;
    createdAt?: number;
  } = {},
): Promise<ExternalAccountRow> {
  const key = await getEncryptionKey(env);
  const credential_enc = await encryptText(opts.password ?? FAKE_APP_PASSWORD, key);
  const createdAt = opts.createdAt ?? 1_700_000_000_000;
  const row: ExternalAccountRow = {
    id: `acc-${state.externalAccounts.length + 1}`,
    user_id: opts.userId ?? USER_ID,
    provider: "gmail",
    email: opts.email ?? GMAIL_ADDRESS,
    credential_enc,
    status: opts.status ?? "active",
    last_seen_uid: opts.lastSeenUid ?? 0,
    uid_validity: opts.uidValidity === undefined ? 12345 : opts.uidValidity,
    last_synced_at: opts.lastSyncedAt === undefined ? null : opts.lastSyncedAt,
    lease_until: opts.leaseUntil ?? 0,
    last_error: "",
    created_at: createdAt,
    updated_at: createdAt,
  };
  state.externalAccounts.push(row);
  return row;
}

async function captureGmailError(fn: () => Promise<unknown>): Promise<GmailError> {
  try {
    await fn();
  } catch (e) {
    return e as GmailError;
  }
  throw new Error("expected the call to reject");
}

afterEach(() => {
  __setImapConnectForTests(null);
});

describe("gmail module", () => {
  it("stores an encrypted credential that decrypts back to the app password on connect", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    const imap = installFakeImap({ loginOk: true });

    const account = await connectGmailAccount(env, USER_EMAIL, GMAIL_ADDRESS, FAKE_APP_PASSWORD);

    expect(imap.calls.count).toBe(1);
    expect(state.externalAccounts).toHaveLength(1);
    const row = state.externalAccounts[0];
    expect(row.email).toBe(GMAIL_ADDRESS);
    expect(row.user_id).toBe(USER_ID);
    expect(row.status).toBe("active");
    expect(row.credential_enc.startsWith("enc:v1:")).toBe(true);
    expect(row.credential_enc).not.toContain(FAKE_APP_PASSWORD);

    const key = await getEncryptionKey(env);
    expect(await decryptText(row.credential_enc, key)).toBe("abcdefghijklmnop");
    expect(account.email).toBe(GMAIL_ADDRESS);
    expect(account).not.toHaveProperty("credential_enc");
  });

  it("strips supported Unicode separators from the App Password before LOGIN and storing", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    const imap = installFakeImap({ loginOk: true });
    const expected = "abcdefghijklmnop";
    const messyPassword = "abcd\u200B efgh\u00A0ijkl\u202Fmnop";

    await connectGmailAccount(env, USER_EMAIL, GMAIL_ADDRESS, messyPassword);

    expect(imap.loginPasswords).toEqual([expected]);
    expect(state.externalAccounts).toHaveLength(1);
    const key = await getEncryptionKey(env);
    expect(
      await decryptText(state.externalAccounts[0].credential_enc, key),
    ).toBe(expected);
  });

  it.each(["abcdefghijklmno", "abcdefghijklmnopq", "abcd\tefgh ijkl mnop", "abcd efgh ijkl mnop\n"])(
    "rejects invalid App Password %j with clear guidance and writes no row",
    async (password) => {
      const { db, state } = createMockD1();
      const env = makeEnv(db, state.rawKeys);
      installFakeImap({ loginOk: true });

      const error = await captureGmailError(() =>
        connectGmailAccount(env, USER_EMAIL, GMAIL_ADDRESS, password),
      );

      expect(error.status).toBe(400);
      expect(error.code).toBe("invalid_input");
      expect(error.message).toBe(
        "Enter the 16-character App Password Google generated (Google Account > Security > 2-Step Verification > App passwords), not your regular Gmail password.",
      );
      expect(state.externalAccounts).toHaveLength(0);
    },
  );

  it("rejects connect with 401 when the IMAP LOGIN probe fails and writes no row", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    installFakeImap({ loginOk: false });

    const error = await captureGmailError(() =>
      connectGmailAccount(env, USER_EMAIL, GMAIL_ADDRESS, FAKE_APP_PASSWORD),
    );

    expect(error).toBeInstanceOf(GmailError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("gmail_auth_failed");
    expect(error.message).toBe(
      "Gmail rejected the sign-in. Create a fresh 16-character App Password in Google Account > Security > 2-Step Verification > App passwords, then try again.",
    );
    expect(state.externalAccounts).toHaveLength(0);
  });

  it("rejects a duplicate (user_id, provider, email) connect with 400 account_exists", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    installFakeImap({ loginOk: true });

    await connectGmailAccount(env, USER_EMAIL, GMAIL_ADDRESS, FAKE_APP_PASSWORD);
    const error = await captureGmailError(() =>
      connectGmailAccount(env, USER_EMAIL, GMAIL_ADDRESS, FAKE_APP_PASSWORD),
    );

    expect(error.status).toBe(400);
    expect(error.code).toBe("account_exists");
    expect(state.externalAccounts).toHaveLength(1);
  });

  it("rejects a malformed email with 400 invalid_input and a non-Google provider with 400 invalid_provider", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);

    const badFormat = await captureGmailError(() =>
      connectGmailAccount(env, USER_EMAIL, "not-an-email", FAKE_APP_PASSWORD),
    );
    expect(badFormat.status).toBe(400);
    expect(badFormat.code).toBe("invalid_input");

    const badProvider = await captureGmailError(() =>
      connectGmailAccount(env, USER_EMAIL, "user@outlook.com", FAKE_APP_PASSWORD),
    );
    expect(badProvider.status).toBe(400);
    expect(badProvider.code).toBe("invalid_provider");

    expect(state.externalAccounts).toHaveLength(0);
  });

  it("syncs three new messages from the mock IMAP transport into the external mailbox", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    const raws = {
      101: makeRaw({ messageId: "msg-1@example.com", subject: "Hello external 1", body: "Hello external world one" }),
      102: makeRaw({ messageId: "msg-2@example.com", subject: "Hello external 2", body: "Hello external world two" }),
      103: makeRaw({ messageId: "msg-3@example.com", subject: "Hello external 3", body: "Hello external world three" }),
    };
    installFakeImap({
      loginOk: true,
      uidsByMailbox: { [GMAIL_ADDRESS]: [101, 102, 103] },
      rawByUid: raws,
    });
    const account = await seedAccount(env, state);

    const result = await syncGmailAccount(env, account.id, 1_700_000_000_000);

    expect(result).toEqual({ fetched: 3, inserted: 3, duplicates: 0, errors: 0 });
    const rows = state.messages.filter((m) => m.external_account_id === account.id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.mailbox_address).toBe(GMAIL_ADDRESS);
      expect(row.source).toBe("gmail");
      expect(row.external_account_id).toBe(account.id);
      expect(row.folder).toBe("inbox");
    }
    expect(state.externalAccounts[0].last_seen_uid).toBe(103);
    expect(state.externalAccounts[0].uid_validity).toBe(12345);
    expect(state.externalAccounts[0].status).toBe("active");
  });

  it("resumes from the stored cursor and only fetches UIDs above it", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    const raws = {
      101: makeRaw({ messageId: "msg-1@example.com", subject: "Old one", body: "Old message one" }),
      102: makeRaw({ messageId: "msg-2@example.com", subject: "Old two", body: "Old message two" }),
      103: makeRaw({ messageId: "msg-3@example.com", subject: "New three", body: "New message three" }),
    };
    installFakeImap({
      loginOk: true,
      uidsByMailbox: { [GMAIL_ADDRESS]: [101, 102, 103] },
      rawByUid: raws,
    });
    const account = await seedAccount(env, state, {
      lastSeenUid: 102,
      lastSyncedAt: 1_699_999_000_000,
    });

    const result = await syncGmailAccount(env, account.id, 1_700_000_000_000);

    expect(result).toEqual({ fetched: 1, inserted: 1, duplicates: 0, errors: 0 });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].message_id).toBe("<msg-3@example.com>");
    expect(state.externalAccounts[0].last_seen_uid).toBe(103);
  });

  it("keeps two rows when the same Message-ID arrives on two different Gmail accounts", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    const sharedRaw = makeRaw({
      messageId: "shared@example.com",
      subject: "Shared subject",
      body: "Shared body",
    });
    installFakeImap({
      loginOk: true,
      uidsByMailbox: { [GMAIL_ADDRESS]: [101], [SECOND_GMAIL_ADDRESS]: [201] },
      rawByUid: { 101: sharedRaw, 201: sharedRaw },
    });
    const first = await seedAccount(env, state, { email: GMAIL_ADDRESS, createdAt: 1_700_000_000_000 });
    const second = await seedAccount(env, state, { email: SECOND_GMAIL_ADDRESS, createdAt: 1_700_000_001_000 });

    const firstResult = await syncGmailAccount(env, first.id, 1_700_000_100_000);
    const secondResult = await syncGmailAccount(env, second.id, 1_700_000_200_000);

    expect(firstResult).toEqual({ fetched: 1, inserted: 1, duplicates: 0, errors: 0 });
    expect(secondResult).toEqual({ fetched: 1, inserted: 1, duplicates: 0, errors: 0 });

    const shared = state.messages.filter((m) => m.message_id === "<shared@example.com>");
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((m) => m.mailbox_address))).toEqual(
      new Set([GMAIL_ADDRESS, SECOND_GMAIL_ADDRESS]),
    );
  });

  it("inserts a Message-ID only once per mailbox when the same UID is synced twice", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    const raw = makeRaw({ messageId: "dup@example.com", subject: "Duplicate", body: "Duplicate body" });
    installFakeImap({
      loginOk: true,
      uidsByMailbox: { [GMAIL_ADDRESS]: [101] },
      rawByUid: { 101: raw },
    });
    const account = await seedAccount(env, state);

    const firstResult = await syncGmailAccount(env, account.id, 1_700_000_100_000);
    expect(firstResult).toEqual({ fetched: 1, inserted: 1, duplicates: 0, errors: 0 });

    // Rewind the cursor but keep uid_validity and last_synced_at -> same UID is fetched again.
    state.externalAccounts[0].last_seen_uid = 0;

    const secondResult = await syncGmailAccount(env, account.id, 1_700_000_200_000);
    expect(secondResult).toEqual({ fetched: 1, inserted: 0, duplicates: 1, errors: 0 });

    const rows = state.messages.filter((m) => m.message_id === "<dup@example.com>");
    expect(rows).toHaveLength(1);
    expect(rows[0].external_account_id).toBe(account.id);
  });

  it("does not enqueue notifications during the first sync even when settings are enabled", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    state.notificationSettings.set(GMAIL_ADDRESS, {
      mailbox_address: GMAIL_ADDRESS,
      push_enabled: 1,
      telegram_enabled: 1,
      telegram_chat_id: "123456789",
      detail_level: "full",
      updated_at: 1_700_000_000_000,
    });
    installFakeImap({
      loginOk: true,
      uidsByMailbox: { [GMAIL_ADDRESS]: [101, 102, 103] },
      rawByUid: {
        101: makeRaw({ messageId: "msg-1@example.com", subject: "First 1", body: "First body one" }),
        102: makeRaw({ messageId: "msg-2@example.com", subject: "First 2", body: "First body two" }),
        103: makeRaw({ messageId: "msg-3@example.com", subject: "First 3", body: "First body three" }),
      },
    });
    const account = await seedAccount(env, state);

    await syncGmailAccount(env, account.id, 1_700_000_100_000);

    expect(state.messages).toHaveLength(3);
    expect(state.notificationOutbox).toHaveLength(0);
  });

  it("enqueues a push notification for a new inbox message after the first sync and stops when settings are off", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    const script: ImapScript = {
      loginOk: true,
      uidsByMailbox: {
        [GMAIL_ADDRESS]: [101, 102, 103],
      },
      rawByUid: {
        101: makeRaw({ messageId: "msg-1@example.com", subject: "Sync 1", body: "Body one" }),
        102: makeRaw({ messageId: "msg-2@example.com", subject: "Sync 2", body: "Body two" }),
        103: makeRaw({ messageId: "msg-3@example.com", subject: "Sync 3", body: "Body three" }),
      },
    };
    installFakeImap(script);
    state.notificationSettings.set(GMAIL_ADDRESS, {
      mailbox_address: GMAIL_ADDRESS,
      push_enabled: 1,
      telegram_enabled: 0,
      telegram_chat_id: "",
      detail_level: "basic",
      updated_at: 1_700_000_000_000,
    });
    const account = await seedAccount(env, state);

    await syncGmailAccount(env, account.id, 1_700_000_100_000);
    expect(state.notificationOutbox).toHaveLength(0);

    script.uidsByMailbox![GMAIL_ADDRESS].push(104);
    script.rawByUid![104] = makeRaw({
      messageId: "msg-4@example.com",
      subject: "Sync 4 new",
      body: "Body four",
    });

    const second = await syncGmailAccount(env, account.id, 1_700_000_200_000);
    expect(second).toEqual({ fetched: 1, inserted: 1, duplicates: 0, errors: 0 });
    expect(state.notificationOutbox).toHaveLength(1);
    expect(state.notificationOutbox[0].channel).toBe("push");
    expect(state.notificationOutbox[0].mailbox_address).toBe(GMAIL_ADDRESS);
    expect(state.notificationOutbox[0].message_id).toBe(
      state.messages.find((m) => m.message_id === "<msg-4@example.com>")!.id,
    );

    // Turn settings off, then sync another new UID -> no additional outbox row.
    state.notificationSettings.delete(GMAIL_ADDRESS);
    script.uidsByMailbox![GMAIL_ADDRESS].push(105);
    script.rawByUid![105] = makeRaw({
      messageId: "msg-5@example.com",
      subject: "Sync 5 muted",
      body: "Body five",
    });

    const third = await syncGmailAccount(env, account.id, 1_700_000_300_000);
    expect(third).toEqual({ fetched: 1, inserted: 1, duplicates: 0, errors: 0 });
    expect(state.notificationOutbox).toHaveLength(1);
  });

  it("returns skipped without touching IMAP while another sync holds the lease", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    const imap = installFakeImap({
      loginOk: true,
      uidsByMailbox: { [GMAIL_ADDRESS]: [101] },
      rawByUid: { 101: makeRaw({ messageId: "msg-1@example.com", subject: "Leased", body: "Leased body" }) },
    });
    const now = 1_700_000_000_000;
    const account = await seedAccount(env, state, { leaseUntil: now + 600_000 });

    const result = await syncGmailAccount(env, account.id, now);

    expect(result).toEqual({ skipped: true });
    expect(imap.calls.count).toBe(0);
    expect(state.messages).toHaveLength(0);
  });

  it("counts a single failed message fetch as an error without killing the batch", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    installFakeImap({
      loginOk: true,
      uidsByMailbox: { [GMAIL_ADDRESS]: [101, 102, 103] },
      failUids: [102],
      rawByUid: {
        101: makeRaw({ messageId: "msg-1@example.com", subject: "Ok one", body: "Ok body one" }),
        102: makeRaw({ messageId: "msg-2@example.com", subject: "Broken two", body: "Broken body two" }),
        103: makeRaw({ messageId: "msg-3@example.com", subject: "Ok three", body: "Ok body three" }),
      },
    });
    const account = await seedAccount(env, state);

    const result = await syncGmailAccount(env, account.id, 1_700_000_100_000);

    expect(result).toEqual({ fetched: 3, inserted: 2, duplicates: 0, errors: 1 });
    const rows = state.messages.filter((m) => m.external_account_id === account.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((m) => m.message_id).sort()).toEqual(["<msg-1@example.com>", "<msg-3@example.com>"]);
    expect(state.externalAccounts[0].status).toBe("active");
    expect(state.externalAccounts[0].last_error).toBe("gmail_provider_error");
  });

  it("marks the account as error with an error code and no credential when sync login fails", async () => {
    const { db, state } = createMockD1();
    const env = makeEnv(db, state.rawKeys);
    installFakeImap({ loginOk: false });
    const account = await seedAccount(env, state);

    const result = await syncGmailAccount(env, account.id, 1_700_000_100_000);

    expect(result).toEqual({ fetched: 0, inserted: 0, duplicates: 0, errors: 0 });
    const row = state.externalAccounts[0];
    expect(row.status).toBe("error");
    expect(row.last_error).toBe("gmail_auth_failed");
    expect(row.last_error).not.toContain(FAKE_APP_PASSWORD);
    expect(row.lease_until).toBe(0);
  });
});
