import { getEncryptionKey, encryptText, decryptText } from "./crypto";
import { ingestInbound, type Env } from "./mail";
import { getNotificationSettings, shouldNotify, enqueueNotification } from "./notifications";

export type GmailErrorCode =
  | "invalid_input"
  | "invalid_provider"
  | "gmail_auth_failed"
  | "not_owner"
  | "account_not_found"
  | "account_exists"
  | "already_syncing"
  | "gmail_provider_error";

export class GmailError extends Error {
  status: number;
  code: GmailErrorCode;
  constructor(status: number, code: GmailErrorCode, message?: string) {
    super(message || code);
    this.name = "GmailError";
    this.status = status;
    this.code = code;
  }
}

const APP_PASSWORD_SEPARATORS =
  /[\u0020\u00A0\u1680\u180E\u2000-\u200F\u202F\u205F\u2060\u3000\uFEFF]/g;
const INVALID_APP_PASSWORD_MESSAGE =
  "Enter the 16-character App Password Google generated (Google Account > Security > 2-Step Verification > App passwords), not your regular Gmail password.";
const GMAIL_AUTH_FAILED_MESSAGE =
  "Gmail rejected the sign-in. Create a fresh 16-character App Password in Google Account > Security > 2-Step Verification > App passwords, then try again.";

/** Tagged NO/BAD: the server rejected one command but the IMAP session stays usable. */
class ImapTaggedError extends GmailError {}

export interface ExternalAccountDto {
  id: string;
  provider: string;
  email: string;
  status: string;
  lastSyncedAt: number | null;
  lastSeenUid: number;
  lastError: string;
}

export type GmailSyncResult =
  | { skipped: true }
  | { fetched: number; inserted: number; duplicates: number; errors: number };

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

const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 2_000;
const MAX_LINE_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const LEASE_MS = 360_000;
const BATCH_SIZE = 50;
const INITIAL_SYNC_LIMIT = 500;
const CURSOR_FLUSH = 10;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ImapSocketLike {
  opened: Promise<unknown>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close: () => Promise<void>;
}

export type ImapConnectFn = (
  address: { hostname: string; port: number },
  options: { secureTransport: "on"; allowHalfOpen: boolean },
) => ImapSocketLike;

let imapConnectOverride: ImapConnectFn | null = null;

/** Test seam: inject a fake IMAP transport so tests never touch the real network. */
export function __setImapConnectForTests(fn: ImapConnectFn | null): void {
  imapConnectOverride = fn;
}

async function openImapSocket(
  address: { hostname: string; port: number },
  options: { secureTransport: "on"; allowHalfOpen: boolean },
): Promise<ImapSocketLike> {
  if (imapConnectOverride) return imapConnectOverride(address, options);
  const mod = await import("cloudflare:sockets");
  return mod.connect(address, options);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => void, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new GmailError(502, "gmail_provider_error", message));
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

class SocketReader {
  private buffer = new Uint8Array(0);

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done || !value) throw new GmailError(502, "gmail_provider_error", "IMAP connection closed");
    const combined = new Uint8Array(this.buffer.length + value.length);
    combined.set(this.buffer);
    combined.set(value, this.buffer.length);
    this.buffer = combined;
  }

  async exactly(length: number): Promise<Uint8Array> {
    while (this.buffer.length < length) await this.fill();
    const out = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    return out;
  }

  async line(): Promise<string> {
    for (;;) {
      for (let i = 0; i < this.buffer.length - 1; i += 1) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          if (i > MAX_LINE_BYTES) throw new GmailError(502, "gmail_provider_error", "IMAP line too long");
          const line = decoder.decode(this.buffer.slice(0, i));
          this.buffer = this.buffer.slice(i + 2);
          return line;
        }
      }
      if (this.buffer.length > MAX_LINE_BYTES) {
        throw new GmailError(502, "gmail_provider_error", "IMAP line too long");
      }
      await this.fill();
    }
  }
}

interface ImapCommandResult {
  lines: string[];
  literals: Array<{ line: string; data: Uint8Array }>;
}

function quoteImapValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

class ImapConnection {
  private socket?: ImapSocketLike;
  private reader?: SocketReader;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private tagNumber = 0;

  private abort(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.reader = undefined;
    this.writer = undefined;
    if (socket) void socket.close().catch(() => undefined);
  }

  async open(): Promise<void> {
    this.socket = await openImapSocket(
      { hostname: IMAP_HOST, port: IMAP_PORT },
      { secureTransport: "on", allowHalfOpen: false },
    );
    await withTimeout(this.socket.opened, CONNECT_TIMEOUT_MS, () => this.abort(), "IMAP connect timed out");
    this.reader = new SocketReader(this.socket.readable.getReader());
    this.writer = this.socket.writable.getWriter();
    const greeting = await withTimeout(this.reader.line(), CONNECT_TIMEOUT_MS, () => this.abort(), "IMAP greeting timed out");
    if (!greeting.startsWith("* OK")) {
      throw new GmailError(502, "gmail_provider_error", "IMAP service not ready");
    }
  }

  async login(email: string, password: string): Promise<void> {
    await this.command(`LOGIN ${quoteImapValue(email)} ${quoteImapValue(password)}`, 401);
  }

  async selectInbox(): Promise<{ uidValidity: number; exists: number; uidNext: number }> {
    const result = await this.command("SELECT INBOX");
    const uidValidity = Number(result.lines.map((l) => l.match(/\[UIDVALIDITY (\d+)\]/i)?.[1]).find(Boolean));
    const uidNext = Number(result.lines.map((l) => l.match(/\[UIDNEXT (\d+)\]/i)?.[1]).find(Boolean));
    const exists = Number(result.lines.map((l) => l.match(/^\* (\d+) EXISTS$/i)?.[1]).find(Boolean) || 0);
    if (!Number.isSafeInteger(uidValidity) || uidValidity < 1) {
      throw new GmailError(502, "gmail_provider_error", "IMAP UIDVALIDITY missing");
    }
    return { uidValidity, exists, uidNext };
  }

  async searchUids(cursor: number, limit: number, newestFirst = false): Promise<number[]> {
    const command = cursor > 0 ? `UID SEARCH UID ${cursor + 1}:*` : "UID SEARCH UID 1:*";
    const result = await this.command(command);
    const searchLine = result.lines.find((l) => l.startsWith("* SEARCH"));
    const uids = (searchLine ? searchLine.slice(8).trim().split(/\s+/).filter(Boolean) : [])
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0);
    const unique = [...new Set(uids)].sort((a, b) => a - b);
    return newestFirst ? unique.slice(-limit) : unique.slice(0, limit);
  }

  async fetchMessage(uid: number): Promise<{ uid: number; data: Uint8Array }> {
    const result = await this.command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    const literal = result.literals.find(({ line }) => new RegExp(`\\bUID ${uid}\\b`, "i").test(line));
    if (!literal) throw new GmailError(502, "gmail_provider_error", "IMAP FETCH returned no message");
    return { uid, data: literal.data };
  }

  async command(command: string, failureStatus = 502, timeoutMs = COMMAND_TIMEOUT_MS): Promise<ImapCommandResult> {
    if (!this.reader || !this.writer) throw new GmailError(502, "gmail_provider_error", "IMAP not connected");
    const tag = `A${String(++this.tagNumber).padStart(4, "0")}`;
    const operation = (async () => {
      await this.writer!.write(encoder.encode(`${tag} ${command}\r\n`));
      const lines: string[] = [];
      const literals: Array<{ line: string; data: Uint8Array }> = [];
      let responseBytes = 0;
      for (;;) {
        const line = await this.reader!.line();
        responseBytes += line.length + 2;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          throw new GmailError(502, "gmail_provider_error", "IMAP response too large");
        }
        const literalMatch = line.match(/\{(\d+)\}\s*$/);
        if (literalMatch) {
          const length = Number(literalMatch[1]);
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
            throw new GmailError(502, "gmail_provider_error", "IMAP literal too large");
          }
          const data = await this.reader!.exactly(length);
          responseBytes += length;
          if (responseBytes > MAX_RESPONSE_BYTES) {
            throw new GmailError(502, "gmail_provider_error", "IMAP response too large");
          }
          literals.push({ line, data });
          continue;
        }
        lines.push(line);
        if (line.startsWith(`${tag} `)) {
          if (!line.startsWith(`${tag} OK`)) {
            throw new ImapTaggedError(
              failureStatus,
              failureStatus === 401 ? "gmail_auth_failed" : "gmail_provider_error",
              failureStatus === 401 ? GMAIL_AUTH_FAILED_MESSAGE : undefined,
            );
          }
          return { lines, literals };
        }
      }
    })();
    try {
      return await withTimeout(operation, timeoutMs, () => this.abort(), "IMAP command timed out");
    } catch (e) {
      // A tagged NO/BAD only rejects this command; keep the session so one bad message
      // cannot kill the rest of the sync batch.
      if (!(e instanceof ImapTaggedError)) this.abort();
      throw e;
    }
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    try {
      await this.command("LOGOUT", 502, CLOSE_TIMEOUT_MS);
    } catch {
      // socket may already be closed
    }
    this.socket = undefined;
    this.reader = undefined;
    this.writer = undefined;
    try {
      await withTimeout(socket.close(), CLOSE_TIMEOUT_MS, () => undefined, "IMAP close timed out");
    } catch {
      // socket may already be closed
    }
  }
}

function toDto(row: ExternalAccountRow): ExternalAccountDto {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    status: row.status,
    lastSyncedAt: row.last_synced_at ?? null,
    lastSeenUid: row.last_seen_uid ?? 0,
    lastError: row.last_error ?? "",
  };
}

async function resolveUserId(env: Env, email: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  return row?.id ?? null;
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const NON_GOOGLE_DOMAINS = new Set([
  "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "rocketmail.com", "gmx.com", "gmx.net", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "qq.com", "163.com", "126.com", "naver.com",
  "yandex.ru", "yandex.com", "mail.ru", "bk.ru", "list.ru", "inbox.ru",
  "rambler.ru", "zoho.com", "aol.com",
]);

function validateGmailAddress(email: string): GmailErrorCode | null {
  if (!EMAIL_RE.test(email)) return "invalid_input";
  const domain = email.split("@")[1].toLowerCase();
  if (domain === "gmail.com" || domain === "googlemail.com") return null;
  if (NON_GOOGLE_DOMAINS.has(domain)) return "invalid_provider";
  return null;
}

export async function listExternalAccounts(env: Env, userEmail: string): Promise<ExternalAccountDto[]> {
  const userId = await resolveUserId(env, userEmail);
  if (!userId) return [];
  const { results } = await env.DB.prepare(
    "SELECT * FROM external_accounts WHERE user_id = ? ORDER BY created_at DESC, id ASC",
  )
    .bind(userId)
    .all<ExternalAccountRow>();
  return (results ?? []).map(toDto);
}

export async function connectGmailAccount(
  env: Env,
  userEmail: string,
  email: string,
  appPassword: string,
): Promise<ExternalAccountDto> {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const password = String(appPassword ?? "").replace(APP_PASSWORD_SEPARATORS, "");
  if (!normalizedEmail) {
    throw new GmailError(400, "invalid_input");
  }
  if (!/^[\x21-\x7E]{16}$/.test(password)) {
    throw new GmailError(400, "invalid_input", INVALID_APP_PASSWORD_MESSAGE);
  }
  const invalid = validateGmailAddress(normalizedEmail);
  if (invalid) throw new GmailError(400, invalid);

  const userId = await resolveUserId(env, userEmail);
  if (!userId) throw new GmailError(403, "not_owner");

  const existing = await env.DB.prepare(
    "SELECT id FROM external_accounts WHERE user_id = ? AND provider = 'gmail' AND email = ?",
  )
    .bind(userId, normalizedEmail)
    .first<{ id: string }>();
  if (existing) throw new GmailError(400, "account_exists");

  const connection = new ImapConnection();
  try {
    await connection.open();
    await connection.login(normalizedEmail, password);
  } catch (e) {
    if (e instanceof GmailError) throw e;
    throw new GmailError(502, "gmail_provider_error");
  } finally {
    await connection.close().catch(() => undefined);
  }

  const key = await getEncryptionKey(env);
  const credentialEnc = await encryptText(password, key);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO external_accounts
      (id, user_id, provider, email, credential_enc, status, last_seen_uid, uid_validity, last_synced_at, lease_until, last_error, created_at, updated_at)
     VALUES (?, ?, 'gmail', ?, ?, 'active', 0, NULL, NULL, 0, '', ?, ?)`,
  )
    .bind(id, userId, normalizedEmail, credentialEnc, now, now)
    .run();

  return {
    id,
    provider: "gmail",
    email: normalizedEmail,
    status: "active",
    lastSyncedAt: null,
    lastSeenUid: 0,
    lastError: "",
  };
}

export async function disconnectGmailAccount(
  env: Env,
  userEmail: string,
  accountId: string,
): Promise<ExternalAccountDto> {
  const userId = await resolveUserId(env, userEmail);
  if (!userId) throw new GmailError(404, "account_not_found");
  const row = await env.DB.prepare("SELECT * FROM external_accounts WHERE id = ? AND user_id = ?")
    .bind(accountId, userId)
    .first<ExternalAccountRow>();
  if (!row) throw new GmailError(404, "account_not_found");
  await env.DB.prepare("UPDATE external_accounts SET status = 'disabled', updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(Date.now(), accountId, userId)
    .run();
  return toDto({ ...row, status: "disabled" });
}

async function notifyExternalMail(env: Env, mailboxAddress: string, messageId: string, now: number): Promise<void> {
  const settings = await getNotificationSettings(env.DB, mailboxAddress);
  if (!shouldNotify("inbox", false, settings)) return;
  if (settings.pushEnabled) {
    await enqueueNotification(env.DB, mailboxAddress, messageId, "push", now);
  }
  if (settings.telegramEnabled) {
    await enqueueNotification(env.DB, mailboxAddress, messageId, "telegram", now);
  }
}

export async function syncGmailAccount(
  env: Env,
  accountId: string,
  now = Date.now(),
): Promise<GmailSyncResult> {
  const claim = await env.DB.prepare(
    "UPDATE external_accounts SET status = 'syncing', lease_until = ?, updated_at = ? WHERE id = ? AND status = 'active' AND lease_until <= ?",
  )
    .bind(now + LEASE_MS, now, accountId, now)
    .run();
  if (!claim.meta?.changes) return { skipped: true };

  let connection: ImapConnection | null = null;
  let success = false;
  let lastError = "";
  let finalUidValidity: number | null = null;
  let finalLastSeenUid = 0;
  let fetched = 0;
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;

  try {
    const row = await env.DB.prepare("SELECT * FROM external_accounts WHERE id = ?")
      .bind(accountId)
      .first<ExternalAccountRow>();
    if (!row) throw new GmailError(404, "account_not_found");

    const key = await getEncryptionKey(env);
    const password = await decryptText(row.credential_enc, key);

    connection = new ImapConnection();
    await connection.open();
    await connection.login(row.email, password);
    const selected = await connection.selectInbox();

    const storedUidValidity = row.uid_validity ?? null;
    const reset = storedUidValidity === null || storedUidValidity !== selected.uidValidity;
    const cursor = reset ? 0 : row.last_seen_uid ?? 0;
    const firstSync = row.last_synced_at === null || row.last_synced_at === undefined;
    finalUidValidity = selected.uidValidity;
    finalLastSeenUid = cursor;
    const uids = await connection.searchUids(cursor, firstSync ? INITIAL_SYNC_LIMIT : BATCH_SIZE, firstSync);
    fetched = uids.length;

    let maxProcessed = cursor;
    let pendingFlush = 0;
    for (const uid of uids) {
      try {
        const message = await connection.fetchMessage(uid);
        const buffer = message.data.buffer.slice(
          message.data.byteOffset,
          message.data.byteOffset + message.data.byteLength,
        ) as ArrayBuffer;
        const result = await ingestInbound(env, buffer, { from: "", to: row.email }, now, {
          mailboxAddress: row.email,
          source: "gmail",
          externalAccountId: row.id,
        });
        if (result.duplicate) duplicates += 1;
        else inserted += 1;
        if (!firstSync && result.duplicate === false && result.folder === "inbox") {
          await notifyExternalMail(env, row.email, result.id, now);
        }
        maxProcessed = Math.max(maxProcessed, uid);
        finalLastSeenUid = maxProcessed;
        pendingFlush += 1;
        if (pendingFlush >= CURSOR_FLUSH) {
          await env.DB.prepare("UPDATE external_accounts SET last_seen_uid = ?, updated_at = ? WHERE id = ?")
            .bind(maxProcessed, now, accountId)
            .run();
          pendingFlush = 0;
        }
      } catch (e) {
        errors += 1;
        lastError = "gmail_provider_error";
      }
    }

    if (pendingFlush > 0) {
      await env.DB.prepare("UPDATE external_accounts SET last_seen_uid = ?, updated_at = ? WHERE id = ?")
        .bind(maxProcessed, now, accountId)
        .run();
    }

    success = true;
    return { fetched, inserted, duplicates, errors };
  } catch (e) {
    lastError = e instanceof GmailError ? e.code : "gmail_provider_error";
    return { fetched, inserted, duplicates, errors };
  } finally {
    if (connection) {
      await connection.close().catch(() => undefined);
    }
    if (success) {
      await env.DB.prepare(
        "UPDATE external_accounts SET status = 'active', uid_validity = ?, last_seen_uid = ?, last_synced_at = ?, lease_until = 0, last_error = ?, updated_at = ? WHERE id = ?",
      )
        .bind(finalUidValidity, finalLastSeenUid, now, errors > 0 ? lastError : "", now, accountId)
        .run();
    } else {
      await env.DB.prepare(
        "UPDATE external_accounts SET status = 'error', lease_until = 0, last_error = ?, updated_at = ? WHERE id = ?",
      )
        .bind(lastError, now, accountId)
        .run();
    }
  }
}
