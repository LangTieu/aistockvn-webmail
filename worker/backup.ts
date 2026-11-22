// worker/backup.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./mail";
import { AdminError, logAdminAction, requireSuperAdmin, type AdminEnv } from "./admin";
import { BACKUP_EVENTS, logEvent } from "./observability";

export type BackupErrorCode =
  | "backup_forbidden"
  | "backup_not_configured"
  | "invalid_input"
  | "invalid_key"
  | "backup_not_found"
  | "backup_provider_error";

export class BackupError extends Error {
  status: number;
  code: BackupErrorCode;

  constructor(status: number, code: BackupErrorCode, message?: string) {
    super(message ?? code);
    this.name = "BackupError";
    this.status = status;
    this.code = code;
  }
}

export type BackupTrigger = "manual" | "cron";
export type BackupStatus = "running" | "succeeded" | "failed";

export interface BackupRunDto {
  id: string;
  trigger: BackupTrigger;
  status: BackupStatus;
  startedAt: number;
  finishedAt: number | null;
  d1ObjectKey: string;
  d1Size: number;
  r2Copied: number;
  r2Errors: number;
  error: string;
}

export interface BackupSettingsDto {
  backupEnabled: boolean;
  backupRetentionDays: number;
  backupSchedule: string;
  backupBucketConfigured: boolean;
  lastBackup: BackupRunDto | null;
}

export interface UpdateBackupSettingsInput {
  backupEnabled?: boolean;
  backupRetentionDays?: number;
}

export interface ListBackupRunsOptions {
  limit?: number;
  before?: number;
}

export type RunBackupResult =
  | { skipped: true }
  | {
      runId: string;
      status: "succeeded";
      d1Size: number;
      r2Copied: number;
      r2Errors: number;
    };

export interface BackupObjectSummary {
  key: string;
  size: number;
}

export interface ListBackupObjectsResult {
  d1Object: BackupObjectSummary | null;
  r2Objects: BackupObjectSummary[];
  cursor?: string;
}

export interface DownloadBackupObjectResult {
  body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;
  contentType: string;
}

export interface BackupStatsDto {
  succeededLast30d: number;
  failedLast30d: number;
  lastBackupSize: number | null;
  lastBackupAt: number | null;
}

interface BackupRunRow {
  id: string;
  trigger: BackupTrigger;
  status: BackupStatus;
  started_at: number;
  finished_at: number | null;
  d1_object_key: string;
  d1_size: number;
  r2_copied: number;
  r2_errors: number;
  error: string;
}

interface AdminSettingRow {
  key: string;
  value: string;
}

const DEFAULT_BACKUP_ENABLED = "0";
const DEFAULT_RETENTION_DAYS = "30";
const DEFAULT_BACKUP_SCHEDULE = "0 20 * * *";
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const R2_COPY_BATCH_SIZE = 10;
const R2_LIST_PAGE_SIZE = 500;
const R2_DELETE_BATCH_SIZE = 500;

function mapRunRow(row: BackupRunRow): BackupRunDto {
  return {
    id: String(row.id),
    trigger: row.trigger,
    status: row.status,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    d1ObjectKey: String(row.d1_object_key ?? ""),
    d1Size: Number(row.d1_size ?? 0),
    r2Copied: Number(row.r2_copied ?? 0),
    r2Errors: Number(row.r2_errors ?? 0),
    error: String(row.error ?? ""),
  };
}

function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isSafeBackupKey(key: string, prefix: "d1/" | "raw/"): boolean {
  if (!key || !key.startsWith(prefix)) return false;
  if (key.includes("\0") || key.includes("\\")) return false;
  const segments = key.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") return false;
  }
  return true;
}

function sanitizeErrorMessage(err: unknown, env: Env): string {
  let msg = err instanceof Error ? err.message : String(err ?? "unknown_error");
  const secretValues = [
    env.CLOUDFLARE_ACCOUNT_ID,
    env.D1_DATABASE_ID,
    env.D1_REST_API_TOKEN,
    env.ENCRYPTION_KEY,
    env.TOTP_ENCRYPTION_KEY,
    env.RESEND_API_KEY,
    env.SESSION_SECRET,
  ];
  for (const s of secretValues) {
    if (typeof s === "string" && s.length > 0 && msg.includes(s)) {
      msg = msg.split(s).join("[REDACTED]");
    }
  }
  msg = msg.replace(/[\x00-\x1f]+/g, " ").trim();
  if (msg.length > 500) {
    msg = msg.slice(0, 500);
  }
  return msg || "backup_failed";
}

function actorEmail(actor: string | { email?: string }): string {
  return typeof actor === "string" ? actor : String(actor?.email ?? "");
}

export async function getBackupSettings(env: Env): Promise<BackupSettingsDto> {
  const settingsRes = await env.DB.prepare(
    "SELECT key, value FROM admin_settings WHERE key IN ('backup_enabled', 'backup_retention_days', 'backup_schedule')"
  ).all<AdminSettingRow>();

  const map = new Map<string, string>();
  for (const row of settingsRes.results ?? []) {
    if (row && typeof row.key === "string") {
      map.set(row.key, String(row.value ?? ""));
    }
  }

  const enabledRaw = map.get("backup_enabled") ?? DEFAULT_BACKUP_ENABLED;
  const retentionRaw = map.get("backup_retention_days") ?? DEFAULT_RETENTION_DAYS;
  const scheduleRaw = map.get("backup_schedule") ?? DEFAULT_BACKUP_SCHEDULE;

  const parsedRetention = Number.parseInt(retentionRaw, 10);
  const backupRetentionDays =
    Number.isFinite(parsedRetention) && parsedRetention >= 1 && parsedRetention <= 365
      ? parsedRetention
      : 30;

  const newestRow = await env.DB.prepare(
    "SELECT id, trigger, status, started_at, finished_at, d1_object_key, d1_size, r2_copied, r2_errors, error FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT 1"
  ).first<BackupRunRow>();

  return {
    backupEnabled: enabledRaw === "1",
    backupRetentionDays,
    backupSchedule: scheduleRaw || DEFAULT_BACKUP_SCHEDULE,
    backupBucketConfigured: typeof env.BACKUP !== "undefined",
    lastBackup: newestRow ? mapRunRow(newestRow) : null,
  };
}

export async function updateBackupSettings(
  env: Env,
  actor: string,
  input: UpdateBackupSettingsInput,
  nowMs: number = Date.now(),
): Promise<BackupSettingsDto> {
  if (
    input.backupRetentionDays !== undefined &&
    (!Number.isInteger(input.backupRetentionDays) ||
      input.backupRetentionDays < 1 ||
      input.backupRetentionDays > 365)
  ) {
    throw new BackupError(400, "invalid_input", "backupRetentionDays must be an integer between 1 and 365");
  }

  if (input.backupEnabled !== undefined && typeof input.backupEnabled !== "boolean") {
    throw new BackupError(400, "invalid_input", "backupEnabled must be a boolean");
  }

  try {
    await requireSuperAdmin(env as unknown as AdminEnv, actorEmail(actor));
  } catch (e) {
    if (e instanceof AdminError && e.status === 403) {
      throw e;
    }
    throw e;
  }

  const email = actorEmail(actor);

  if (input.backupEnabled !== undefined) {
    const val = input.backupEnabled ? "1" : "0";
    await env.DB.prepare(
      "INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
      .bind("backup_enabled", val, nowMs)
      .run();
    await logAdminAction(env as unknown as AdminEnv, email, "settings_updated", "backup_enabled", val, nowMs);
  }

  if (input.backupRetentionDays !== undefined) {
    const val = String(input.backupRetentionDays);
    await env.DB.prepare(
      "INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
      .bind("backup_retention_days", val, nowMs)
      .run();
    await logAdminAction(env as unknown as AdminEnv, email, "settings_updated", "backup_retention_days", val, nowMs);
  }

  return getBackupSettings(env);
}

export async function listBackupRuns(
  env: Env,
  options: ListBackupRunsOptions = {},
): Promise<BackupRunDto[]> {
  const rawLimit = options.limit ?? 50;
  const limit = Math.max(1, Math.min(100, Math.trunc(Number.isFinite(rawLimit) ? rawLimit : 50)));

  let res: D1Result<BackupRunRow>;
  if (typeof options.before === "number" && Number.isFinite(options.before)) {
    res = await env.DB.prepare(
      "SELECT id, trigger, status, started_at, finished_at, d1_object_key, d1_size, r2_copied, r2_errors, error FROM backup_runs WHERE started_at < ? ORDER BY started_at DESC, id DESC LIMIT ?"
    )
      .bind(options.before, limit)
      .all<BackupRunRow>();
  } else {
    res = await env.DB.prepare(
      "SELECT id, trigger, status, started_at, finished_at, d1_object_key, d1_size, r2_copied, r2_errors, error FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT ?"
    )
      .bind(limit)
      .all<BackupRunRow>();
  }

  return (res.results ?? []).map(mapRunRow);
}

// Query-based D1 SQL dump engine for backup.ts (bypasses D1 export API virtual-table restriction).

const D1_PAGE_SIZE = 500;
const D1_INSERT_BATCH_SIZE = 100;

interface SchemaObject {
  name: string;
  sql: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeStatement(sql: string): string {
  return `${sql.trim().replace(/;+$/, "")};`;
}

function bytesToHex(bytes: ArrayLike<number>): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] & 0xff).toString(16).padStart(2, "0").toUpperCase();
  }
  return hex;
}

export function isSkippedBackupTable(name: string, sql?: string | null): boolean {
  if (
    name === "messages_fts" ||
    name.startsWith("messages_fts_") ||
    name === "_cf_KV" ||
    name === "sqlite_sequence"
  ) {
    return true;
  }
  if (typeof sql === "string" && sql.trim().toUpperCase().startsWith("CREATE VIRTUAL TABLE")) {
    return true;
  }
  return false;
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (typeof value === "string") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (Array.isArray(value) && value.every((item): item is number => typeof item === "number")) {
    return `X'${bytesToHex(value)}'`;
  }
  if (value instanceof ArrayBuffer) {
    return `X'${bytesToHex(new Uint8Array(value))}'`;
  }
  if (ArrayBuffer.isView(value)) {
    return `X'${bytesToHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}'`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return "NULL";
  }
  return `'${serialized.replace(/'/g, "''")}'`;
}

export async function exportD1SnapshotToBackup(
  env: Env,
  runId: string,
  nowMs: number,
): Promise<{ d1ObjectKey: string; d1Size: number }> {
  const backupBucket = env.BACKUP;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const dbId = env.D1_DATABASE_ID?.trim() ?? "";
  const apiToken = env.D1_REST_API_TOKEN?.trim() ?? "";

  if (!backupBucket || !accountId || !dbId || !apiToken) {
    throw new BackupError(400, "backup_not_configured");
  }

  const queryUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(dbId)}/query`;

  const d1Query = async (sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
    let res: Response;
    try {
      res = await fetch(queryUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify(params !== undefined ? { sql, params } : { sql }),
      });
    } catch (err) {
      throw new BackupError(502, "backup_provider_error", sanitizeErrorMessage(err, env));
    }

    if (!res.ok) {
      throw new BackupError(502, "backup_provider_error", `D1 query HTTP ${res.status}`);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new BackupError(502, "backup_provider_error", "Invalid JSON from D1 query API");
    }

    if (!isRecord(data) || data.success !== true || !Array.isArray(data.result) || data.result.length === 0) {
      throw new BackupError(502, "backup_provider_error", "D1 query returned an error");
    }

    const first = data.result[0];
    if (!isRecord(first) || first.success !== true || !Array.isArray(first.results)) {
      throw new BackupError(502, "backup_provider_error", "Unexpected D1 query response shape");
    }

    const rows: Record<string, unknown>[] = [];
    for (const item of first.results) {
      if (!isRecord(item)) {
        throw new BackupError(502, "backup_provider_error", "Unexpected D1 query row shape");
      }
      rows.push(item);
    }
    return rows;
  };

  const schemaRows = await d1Query(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
  );

  const tables: SchemaObject[] = [];
  const indexes: SchemaObject[] = [];
  const triggers: SchemaObject[] = [];

  for (const row of schemaRows) {
    const type = typeof row.type === "string" ? row.type : "";
    const name = typeof row.name === "string" ? row.name : "";
    const sql = typeof row.sql === "string" ? row.sql : "";
    if (!name || !sql) {
      continue;
    }
    if (type === "table") {
      if (!isSkippedBackupTable(name, sql)) {
        tables.push({ name, sql });
      }
    } else if (type === "index") {
      indexes.push({ name, sql });
    } else if (type === "trigger") {
      triggers.push({ name, sql });
    }
  }

  const d1ObjectKey = `d1/${formatUtcDate(nowMs)}/${runId}.sql`;
  const encoder = new TextEncoder();

  // R2 put() rejects a stream without a known length, so buffer the
  // whole dump as one string first. Live D1 is ~0.48 MB, buffering is fine.
  const parts: string[] = [];
  const emit = (text: string): void => {
    parts.push(text);
  };

  emit(
    [
      "-- aistockvn-mail D1 backup",
      `-- run: ${runId}`,
      `-- generated: ${new Date(nowMs).toISOString()}`,
      "-- engine: d1-query (no export API; FTS5 messages_fts excluded, rebuild at restore)",
      "PRAGMA foreign_keys=OFF;",
      "BEGIN TRANSACTION;",
      "",
    ].join("\n"),
  );

  for (const table of tables) {
    const quotedTable = quoteIdent(table.name);
    emit(`DROP TABLE IF EXISTS ${quotedTable};\n`);
    emit(`${normalizeStatement(table.sql)}\n`);

    const countRows = await d1Query(`SELECT COUNT(*) AS n FROM ${quotedTable}`);
    const rawCount = countRows[0]?.n;
    const totalRows = typeof rawCount === "number" ? rawCount : Number(rawCount ?? 0);

    if (!Number.isFinite(totalRows) || totalRows <= 0) {
      emit("\n");
      continue;
    }

    let columns: string[] | null = null;
    let quotedColumns = "";

    for (let offset = 0; offset < totalRows; offset += D1_PAGE_SIZE) {
      const page = await d1Query(
        `SELECT * FROM ${quotedTable} LIMIT ${D1_PAGE_SIZE} OFFSET ${offset}`,
      );
      if (page.length === 0) {
        break;
      }
      if (columns === null) {
        columns = Object.keys(page[0]);
        if (columns.length === 0) {
          break;
        }
        quotedColumns = columns.map(quoteIdent).join(",");
      }

      for (let i = 0; i < page.length; i += D1_INSERT_BATCH_SIZE) {
        const batch = page.slice(i, i + D1_INSERT_BATCH_SIZE);
        const tuples = batch.map(
          (row) => `(${columns!.map((col) => sqlLiteral(row[col])).join(",")})`,
        );
        emit(`INSERT INTO ${quotedTable} (${quotedColumns}) VALUES ${tuples.join(",")};\n`);
      }
    }

    emit("\n");
  }

  for (const index of indexes) {
    emit(`${normalizeStatement(index.sql)}\n`);
  }
  for (const trigger of triggers) {
    emit(`${normalizeStatement(trigger.sql)}\n`);
  }

  emit(
    [
      "COMMIT;",
      "-- To restore full-text search after replay: CREATE VIRTUAL TABLE messages_fts USING fts5(subject, text_body, from_addr, from_name, content='messages', content_rowid='rowid', tokenize='unicode61'); then INSERT INTO messages_fts(messages_fts) VALUES('rebuild');",
      "",
    ].join("\n"),
  );

  const body = parts.join("");
  const d1Size = encoder.encode(body).byteLength;

  try {
    await backupBucket.put(d1ObjectKey, body);
  } catch (err) {
    if (err instanceof BackupError) {
      throw err;
    }
    throw new BackupError(502, "backup_provider_error", "Failed to write D1 snapshot to backup bucket");
  }

  return { d1ObjectKey, d1Size };
}

export async function copyIncrementalRawObjects(
  env: Env,
  sinceMs: number,
  ): Promise<{ r2Copied: number; r2Errors: number; errorKeys: string[] }> {
  const backupBucket = env.BACKUP;
  if (!backupBucket) {
    throw new BackupError(400, "backup_not_configured");
  }
  let r2Copied = 0;
  let r2Errors = 0;
  const errorKeys: string[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const listed: R2Objects = await env.RAW.list({
      prefix: "raw/",
        limit: R2_LIST_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
    });
    const candidates = (listed.objects ?? []).filter((obj) => {
      if (!isSafeBackupKey(obj.key, "raw/")) return false;
      if (sinceMs <= 0) return true;
      const uploadedMs = obj.uploaded instanceof Date ? obj.uploaded.getTime() : Number(obj.uploaded ?? 0);
      return uploadedMs > sinceMs;
    });
    for (let i = 0; i < candidates.length; i += R2_COPY_BATCH_SIZE) {
      const batch = candidates.slice(i, i + R2_COPY_BATCH_SIZE);
      await Promise.all(
        batch.map(async (obj) => {
        try {
          const sourceObj = await env.RAW.get(obj.key);
          if (!sourceObj) {
            return;
          }
          const payload =
            typeof sourceObj === "object" && "body" in sourceObj && sourceObj.body !== undefined
          ? sourceObj.body
          : (sourceObj as unknown as ReadableStream | ArrayBuffer | string);
          await backupBucket.put(obj.key, payload);
          r2Copied += 1;
        } catch {
          r2Errors += 1;
          if (errorKeys.length < 10) {
            errorKeys.push(obj.key);
          }
        }
      }),
        );
    }
    if (listed.truncated && listed.cursor) {
      cursor = listed.cursor;
    } else {
      break;
    }
  }
  return { r2Copied, r2Errors, errorKeys };
}
async function purgeExpiredBackupObjects(
  env: Env,
  retentionDays: number,
  nowMs: number,
  ): Promise<Promise<number>> {
  const backupBucket = env.BACKUP;
  if (!backupBucket) return 0;
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  const runsRes = await env.DB.prepare(
    "SELECT id, status, started_at, finished_at, d1_object_key FROM backup_runs ORDER BY started_at ASC"
  ).all<{
    id: string;
    status: BackupStatus;
    started_at: number;
    finished_at: number | null;
    d1_object_key: string;
  }>();
  const allRuns = runsRes.results ?? [];
  const expiredRuns = allRuns.filter((r) => Number(r.started_at) < cutoffMs);
  const retainedRuns = allRuns.filter((r) => Number(r.started_at) >= cutoffMs);
  const expiredRunIds = new Set(expiredRuns.map((r) => r.id));
  const expiredD1Keys = new Set(
    expiredRuns
    .map((r) => String(r.d1_object_key ?? ""))
    .filter((k) => isSafeBackupKey(k, "d1/")),
    );
  let oldestRetainedStartMs = cutoffMs;
  if (retainedRuns.length > 0) {
    oldestRetainedStartMs = Math.min(...retainedRuns.map((r) => Number(r.started_at)));
  }
  let latestExpiredFinishedMs = 0;
  for (const r of expiredRuns) {
    const ts = r.finished_at !== null && r.finished_at !== undefined ? Number(r.finished_at) : Number(r.started_at);
    if (ts > latestExpiredFinishedMs) {
      latestExpiredFinishedMs = ts;
    }
  }
  const rawPurgeUpperBoundMs = Math.min(cutoffMs, oldestRetainedStartMs);
  const keysToDelete: string[] = [];
  let d1Cursor: string | undefined = undefined;
  for (;;) {
    const page: R2Objects = await backupBucket.list({
      prefix: "d1/",
        limit: R2_LIST_PAGE_SIZE,
        ...(d1Cursor ? { cursor: d1Cursor } : {}),
    });
    for (const obj of page.objects ?? []) {
      if (!isSafeBackupKey(obj.key, "d1/")) continue;
      if (expiredD1Keys.has(obj.key)) {
        keysToDelete.push(obj.key);
        continue;
      }
      const match = obj.key.match(/^d1\/[^/]+\/([^/]+)\.(sql|sqlite)$/);
      if (match && expiredRunIds.has(match[1])) {
        keysToDelete.push(obj.key);
      }
    }
    if (page.truncated && page.cursor) {
      d1Cursor = page.cursor;
    } else {
      break;
    }
  }
  if (expiredRuns.length > 0) {
    let rawCursor: string | undefined = undefined;
    for (;;) {
      const page: R2Objects = await backupBucket.list({
        prefix: "raw/",
          limit: R2_LIST_PAGE_SIZE,
          ...(rawCursor ? { cursor: rawCursor } : {}),
      });
      for (const obj of page.objects ?? []) {
        if (!isSafeBackupKey(obj.key, "raw/")) continue;
        const uploadedMs = obj.uploaded instanceof Date ? obj.uploaded.getTime() : Number(obj.uploaded ?? 0);
        if (uploadedMs > 0 && uploadedMs <= latestExpiredFinishedMs && uploadedMs < rawPurgeUpperBoundMs) {
          keysToDelete.push(obj.key);
        }
      }
      if (page.truncated && page.cursor) {
        rawCursor = page.cursor;
      } else {
        break;
      }
    }
  }
  const safeKeys = Array.from(new Set(keysToDelete)).filter(
    (k) => isSafeBackupKey(k, "d1/") || isSafeBackupKey(k, "raw/"),
    );
  for (let i = 0; i < safeKeys.length; i += R2_DELETE_BATCH_SIZE) {
    const batch = safeKeys.slice(i, i + R2_DELETE_BATCH_SIZE);
    await backupBucket.delete(batch);
  }
  return safeKeys.length;
}
export async function runBackup(
  env: Env,
  trigger: BackupTrigger,
  nowMs: number = Date.now(),
  ): Promise<Promise<RunBackupResult>> {
  const settings = await getBackupSettings(env);
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const dbId = env.D1_DATABASE_ID?.trim();
  const apiToken = env.D1_REST_API_TOKEN?.trim();
  if (!settings.backupEnabled || !env.BACKUP || !accountId || !dbId || !apiToken) {
    throw new BackupError(400, "backup_not_configured");
  }
  const activeThreshold = nowMs - SIX_HOURS_MS;
  const activeRun = await env.DB.prepare(
    "SELECT id, started_at FROM backup_runs WHERE status = 'running' AND started_at >= ? ORDER BY started_at DESC LIMIT 1"
  )
    .bind(activeThreshold)
    .first<{ id: string; started_at: number }>();
  if (activeRun) {
    return { skipped: true };
  }
  const lastSucceeded = await env.DB.prepare(
    "SELECT finished_at FROM backup_runs WHERE status = 'succeeded' ORDER BY started_at DESC, id DESC LIMIT 1"
  ).first<{ finished_at: number | null }>();
  const sinceMs =
    lastSucceeded && lastSucceeded.finished_at !== null && lastSucceeded.finished_at !== undefined
  ? Number(lastSucceeded.finished_at)
  : 0;
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO backup_runs (id, trigger, status, started_at, finished_at, d1_object_key, d1_size, r2_copied, r2_errors, error) VALUES (?, ?, 'running', ?, NULL, '', 0, 0, 0, '')"
  )
    .bind(runId, trigger, nowMs)
    .run();
  logEvent(env, BACKUP_EVENTS.BACKUP_STARTED, { runId, trigger });
  try {
    const { d1ObjectKey, d1Size } = await exportD1SnapshotToBackup(env, runId, nowMs);
    const { r2Copied, r2Errors, errorKeys } = await copyIncrementalRawObjects(env, sinceMs);
    const finishedAt = Date.now();
    const rowErrorSummary = errorKeys.length > 0 ? `r2_copy_errors: ${errorKeys.join(", ")}`.slice(0, 500) : "";
    await env.DB.prepare(
      "UPDATE backup_runs SET status = 'succeeded', finished_at = ?, d1_object_key = ?, d1_size = ?, r2_copied = ?, r2_errors = ?, error = ? WHERE id = ?"
    )
      .bind(finishedAt, d1ObjectKey, d1Size, r2Copied, r2Errors, rowErrorSummary, runId)
      .run();
    logEvent(env, BACKUP_EVENTS.BACKUP_SUCCEEDED, {
      runId,
        d1Size,
        r2Copied,
        r2Errors,
    });
    await logAdminAction(
      env as unknown as AdminEnv,
      "system",
      "backup_finished",
      runId,
      "succeeded",
      finishedAt,
      );
    try {
      const deletedObjects = await purgeExpiredBackupObjects(env, settings.backupRetentionDays, finishedAt);
      logEvent(env, "backup_retention_purged", { runId, deletedObjects });
    } catch (purgeErr) {
      logEvent(env, "backup_retention_purge_failed", {
        runId,
          error: sanitizeErrorMessage(purgeErr, env),
      });
    }
    return {
      runId,
        status: "succeeded",
        d1Size,
        r2Copied,
        r2Errors,
    };
  } catch (err) {
    const finishedAt = Date.now();
    const safeErr = sanitizeErrorMessage(err, env);
    try {
      await env.DB.prepare(
        "UPDATE backup_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?"
      )
        .bind(finishedAt, safeErr, runId)
        .run();
    } catch {
      // Best-effort status update
    }
    logEvent(env, BACKUP_EVENTS.BACKUP_FAILED, { runId, error: safeErr });
    try {
      await logAdminAction(
        env as unknown as AdminEnv,
        "system",
        "backup_finished",
        runId,
        "failed",
        finishedAt,
        );
    } catch {
      // Best-effort audit record
    }
    if (err instanceof BackupError && err.status === 400 && err.code === "backup_not_configured") {
      throw err;
    }
    throw new BackupError(502, "backup_provider_error", safeErr);
  }
}
export async function listBackupObjects(
  env: Env,
  runId: string,
  cursor?: string,
  ): Promise<Promise<ListBackupObjectsResult>> {
  const run = await env.DB.prepare(
    "SELECT id, d1_object_key, d1_size FROM backup_runs WHERE id = ?"
  )
    .bind(runId)
    .first<{ id: string; d1_object_key: string; d1_size: number }>();
  if (!run) {
    throw new BackupError(404, "backup_not_found");
  }
  const d1Key = String(run.d1_object_key ?? "");
  const d1Object: BackupObjectSummary | null = d1Key
  ? { key: d1Key, size: Number(run.d1_size ?? 0) }
  : null;
  if (!env.BACKUP) {
    return { d1Object, r2Objects: [] };
  }
  const listed = await env.BACKUP.list({
    prefix: "raw/",
      limit: 100,
      ...(cursor ? { cursor } : {}),
  });
  const r2Objects: BackupObjectSummary[] = (listed.objects ?? []).map((obj) => ({
    key: obj.key,
      size: Number(obj.size ?? 0),
  }));
  const result: ListBackupObjectsResult = {
    d1Object,
      r2Objects,
  };
  if (listed.truncated && listed.cursor) {
    result.cursor = listed.cursor;
  }
  return result;
}
export async function downloadBackupObject(
  env: Env,
  runId: string,
  key: string,
  ): Promise<Promise<DownloadBackupObjectResult>> {
  const run = await env.DB.prepare(
    "SELECT id, d1_object_key FROM backup_runs WHERE id = ?"
  )
    .bind(runId)
    .first<{ id: string; d1_object_key: string }>();
  if (!run) {
    throw new BackupError(404, "backup_not_found");
  }
  const normalizedKey = String(key ?? "");
  const runD1Key = String(run.d1_object_key ?? "");
  const isAllowedD1Key =
    normalizedKey === runD1Key && isSafeBackupKey(normalizedKey, "d1/");
  const isAllowedRawKey = isSafeBackupKey(normalizedKey, "raw/");
  if (!isAllowedD1Key && !isAllowedRawKey) {
    throw new BackupError(400, "invalid_key");
  }
  if (!env.BACKUP) {
    throw new BackupError(404, "backup_not_found");
  }
  const obj = await env.BACKUP.get(normalizedKey);
  if (!obj) {
    throw new BackupError(404, "backup_not_found");
  }
  let contentType = "application/octet-stream";
  if (normalizedKey.endsWith(".sqlite")) {
    contentType = "application/x-sqlite3";
  } else if (normalizedKey.endsWith(".sql")) {
    contentType = "application/sql";
  } else if (normalizedKey.endsWith(".eml")) {
    contentType = "message/rfc822";
  }
  const body =
    typeof obj === "object" && "body" in obj && obj.body !== undefined
  ? obj.body
  : (obj as unknown as ReadableStream | ArrayBuffer | string);
  return { body, contentType };
}
export async function getBackupStats(
  env: Env,
  nowMs: number = Date.now(),
  ): Promise<Promise<BackupStatsDto>> {
  const cutoffMs = nowMs - 30 * DAY_MS;
  const countsRes = await env.DB.prepare(
    "SELECT status, COUNT(*) as count FROM backup_runs WHERE started_at >= ? GROUP BY status"
  )
    .bind(cutoffMs)
    .all<{ status: BackupStatus; count: number }>();
  let succeededLast30d = 0;
  let failedLast30d = 0;
  for (const row of countsRes.results ?? []) {
    if (row.status === "succeeded") {
      succeededLast30d = Number(row.count ?? 0);
    } else if (row.status === "failed") {
      failedLast30d = Number(row.count ?? 0);
    }
  }
  const newest = await env.DB.prepare(
    "SELECT started_at, d1_size FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT 1"
  ).first<{ started_at: number; d1_size: number }>();
  return {
    succeededLast30d,
      failedLast30d,
      lastBackupSize: newest ? Number(newest.d1_size ?? 0) : null,
      lastBackupAt: newest ? Number(newest.started_at) : null,
  };
}
export class BackupWorkflow extends WorkflowEntrypoint<Env> {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<RunBackupResult> {
    return await step.do("run-backup", async () => {
      return await runBackup(this.env, "cron", Date.now());
    });
  }
}
