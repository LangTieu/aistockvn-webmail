// worker/observability.ts
import { AdminError, type AdminEnv } from './admin';
import type { Env } from './mail';
import { sha256Hex } from './mfa';

/**
 * Canonical observability & backup event names emitted via `logEvent`.
 */
export const BACKUP_EVENTS = {
  API_UNHANDLED_ERROR: 'api_unhandled_error',
  NOTIFY_SWEEP_FAILED: 'notify_sweep_failed',
  NOTIFY_DELIVERY_FAILED: 'notify_delivery_failed',
  NOTIFY_ENQUEUE_FAILED: 'notify_enqueue_failed',
  INGEST_FAILED: 'ingest_failed',
  FORWARD_FAILED: 'forward_failed',
  BACKUP_STARTED: 'backup_started',
  BACKUP_SUCCEEDED: 'backup_succeeded',
  BACKUP_FAILED: 'backup_failed',
  CLIENT_ERROR_RECEIVED: 'client_error_received',
} as const;

export type BackupEventName = (typeof BACKUP_EVENTS)[keyof typeof BACKUP_EVENTS];

const FORBIDDEN_LOG_KEYS: ReadonlySet<string> = new Set([
  'password',
  'appPassword',
  'app_password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'subject',
  'body',
  'text_body',
  'html_body',
  'attachment',
  'snippet',
  'raw_key',
  'resend_id',
  'mailbox',
]);

export function safeLogText(value: unknown, maxLen = 200): string {
  try {
    let raw: string;
    if (typeof value === 'string') {
      raw = value;
    } else if (value === undefined) {
      raw = 'undefined';
    } else {
      try {
        const serialized = JSON.stringify(value);
        raw = typeof serialized === 'string' ? serialized : String(value);
      } catch {
        raw = String(value);
      }
    }
    const limit = maxLen > 0 ? maxLen : 0;
    const sliced = raw.length > limit ? raw.slice(0, limit) : raw;
    let cleaned = '';
    for (let i = 0; i < sliced.length; i++) {
      const code = sliced.charCodeAt(i);
      cleaned += code < 0x20 ? ' ' : sliced[i];
    }
    return cleaned;
  } catch {
    return '';
  }
}

function sanitizeValue(val: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') return safeLogText(val, 200);
  if (typeof val === 'number') return Number.isFinite(val) ? val : String(val);
  if (typeof val === 'boolean') return val;
  if (typeof val === 'bigint') return safeLogText(val.toString(), 200);
  if (typeof val !== 'object') return safeLogText(String(val), 200);

  if (seen.has(val)) return '[Circular]';
  if (depth >= 8) return '[MaxDepth]';

  seen.add(val);
  if (Array.isArray(val)) {
    return val.map((item) => sanitizeValue(item, seen, depth + 1));
  }

  if (val instanceof Error) {
    return {
      name: safeLogText(val.name, 200),
      message: safeLogText(val.message, 200),
    };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (FORBIDDEN_LOG_KEYS.has(k)) continue;
    out[k] = sanitizeValue(v, seen, depth + 1);
  }
  return out;
}

export function logEvent(
  _env: Env | AdminEnv,
  event: string,
  fields?: Record<string, unknown>,
): void {
  try {
    const payload: Record<string, unknown> = {
      event: safeLogText(event, 200),
      ts: Date.now(),
    };
    if (fields && typeof fields === 'object') {
      const seen = new WeakSet<object>();
      seen.add(fields);
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'event' || k === 'ts') continue;
        if (FORBIDDEN_LOG_KEYS.has(k)) continue;
        payload[k] = sanitizeValue(v, seen, 1);
      }
    }
    console.log(JSON.stringify(payload));
  } catch {
    // Logging must never throw or interrupt request handling.
  }
}

function toTruncatedString(val: unknown, maxLen: number): string {
  if (typeof val !== 'string') return '';
  return val.length > maxLen ? val.slice(0, maxLen) : val;
}

export async function reportClientError(
  env: AdminEnv,
  mailbox: string,
  body: unknown,
): Promise<{ ok: true; crashId: string }> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AdminError(400, 'invalid_crash_id');
  }

  const record = body as Record<string, unknown>;
  const rawCrashId = record.crashId;
  if (typeof rawCrashId !== 'string') {
    throw new AdminError(400, 'invalid_crash_id');
  }
  const crashId = rawCrashId.trim();
  if (crashId.length === 0 || rawCrashId.length > 64) {
    throw new AdminError(400, 'invalid_crash_id');
  }

  const message = toTruncatedString(record.message, 500);
  const stack = toTruncatedString(record.stack, 4000);
  const url = toTruncatedString(record.url, 500);
  const userAgent = toTruncatedString(record.userAgent, 500);

  const mailboxHash = await sha256Hex(mailbox || '');
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  await env.DB.prepare(
    `INSERT INTO client_errors (id, crash_id, mailbox_hash, message, stack, url, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, crashId, mailboxHash, message, stack, url, userAgent, createdAt)
    .run();

  logEvent(env, BACKUP_EVENTS.CLIENT_ERROR_RECEIVED, { crashId, mailboxHash });

  return { ok: true, crashId };
}

export interface ClientErrorEntry {
  id: string;
  crashId: string;
  mailboxHash: string;
  message: string;
  stack: string;
  url: string;
  userAgent: string;
  createdAt: number;
}

interface ClientErrorRow {
  id: string;
  crash_id: string;
  mailbox_hash: string;
  message: string;
  stack: string;
  url: string;
  user_agent: string;
  created_at: number;
}

export async function listClientErrors(
  env: AdminEnv,
  opts: { limit?: number } = {},
): Promise<ClientErrorEntry[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const { results } = await env.DB.prepare(
    `SELECT id, crash_id, mailbox_hash, message, stack, url, user_agent, created_at
     FROM client_errors ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<ClientErrorRow>();
  return (results ?? []).map((r) => ({
    id: r.id,
    crashId: r.crash_id,
    mailboxHash: r.mailbox_hash,
    message: r.message,
    stack: r.stack,
    url: r.url,
    userAgent: r.user_agent,
    createdAt: r.created_at,
  }));
}
