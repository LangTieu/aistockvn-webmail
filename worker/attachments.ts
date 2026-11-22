import type { Env } from "./mail";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const B2_USAGE_LIMIT = 9 * 1024 * 1024 * 1024;
export const BLOCKED_ATTACHMENT_EXTENSIONS = new Set([
  ".exe", ".bat", ".sh", ".js", ".cmd", ".com", ".scr", ".ps1", ".msi", ".vbs",
  ".csh", ".bash", ".zsh", ".jar", ".hta", ".pif", ".wsf", ".wsh", ".dll", ".so", ".dylib",
]);

export type StoredAttachment = { key: string; filename: string; size: number; mimeType: string };

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256(value: string | ArrayBuffer): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value));
}
async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value));
}
function b64(bytes: ArrayBuffer): string {
  let raw = "";
  for (const b of new Uint8Array(bytes)) raw += String.fromCharCode(b);
  return btoa(raw);
}
function credentials(env: Env, second = false) {
  const id = second ? env.B2_KEY_ID_2 : env.B2_KEY_ID;
  const secret = second ? env.B2_APPLICATION_KEY_2 : env.B2_APPLICATION_KEY;
  if (!id || !secret || !env.B2_BUCKET_NAME || !env.B2_S3_ENDPOINT) throw new Error("B2 attachment storage is not configured");
  return { id, secret, bucket: env.B2_BUCKET_NAME, endpoint: env.B2_S3_ENDPOINT.replace(/\/$/, "") };
}
async function signedFetch(env: Env, method: string, key: string, body?: ArrayBuffer, query = ""): Promise<Response> {
  const c = credentials(env);
  const endpoint = new URL(c.endpoint.startsWith("https://") ? c.endpoint : `https://${c.endpoint}`);
  const path = `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(c.bucket)}${key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : ""}`;
  const url = `${endpoint.origin}${path}`;
  const region = endpoint.hostname.split(".")[1] || "us-east-1";
  const service = "s3";
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const payloadHash = await sha256(body || new ArrayBuffer(0));
  const canonicalHeaders = `host:${endpoint.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${method}\n${path}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${await sha256(canonicalRequest)}`;
  const kDate = await hmac(new TextEncoder().encode(`AWS4${c.secret}`), day);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = bytesToHex(await hmac(kSigning, toSign));
  return fetch(`${url}${query ? `?${query}` : ""}`, { method, body: method === "PUT" ? body : undefined, headers: {
    Authorization: `AWS4-HMAC-SHA256 Credential=${c.id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash, "x-amz-date": date,
  } });
}

async function assertB2Capacity(env: Env): Promise<void> {
  let continuationToken = "";
  let used = 0;
  do {
    const query = `list-type=2${continuationToken ? `&continuation-token=${encodeURIComponent(continuationToken)}` : ""}`;
    const response = await signedFetch(env, "GET", "", undefined, query);
    if (!response.ok) throw new Error(`Could not check B2 storage usage (${response.status}).`);
    const xml = await response.text();
    used += [...xml.matchAll(/<Size>(\d+)<\/Size>/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    if (used >= B2_USAGE_LIMIT) throw new Error("B2 attachment storage is near its 10 GB limit. You can still send this email without attachments.");
    continuationToken = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1]
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") || "";
  } while (continuationToken);
}

export function validateAttachmentName(filename: string): string | null {
  if (!filename || filename.includes("../") || filename.includes("..\\") || filename.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filename)) return "Attachment filename contains an unsafe path.";
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (BLOCKED_ATTACHMENT_EXTENSIONS.has(ext)) return `Executable attachments (${ext}) are not allowed.`;
  return null;
}

export async function uploadAttachments(env: Env, files: File[]): Promise<StoredAttachment[]> {
  let total = 0;
  for (const file of files) {
    const bad = validateAttachmentName(file.name);
    if (bad) throw new Error(bad);
    total += file.size;
  }
  if (total > MAX_ATTACHMENT_BYTES) throw new Error("Attachments exceed the 25 MB per email limit.");
  await assertB2Capacity(env);
  const stored: StoredAttachment[] = [];
  for (const file of files) {
    const key = `${crypto.randomUUID()}/${file.name}`;
    const response = await signedFetch(env, "PUT", key, await file.arrayBuffer());
    if (!response.ok) throw new Error(`B2 upload failed (${response.status}).`);
    stored.push({ key, filename: file.name, size: file.size, mimeType: file.type || "application/octet-stream" });
  }
  return stored;
}

export async function loadAttachment(env: Env, key: string): Promise<ArrayBuffer> {
  if (!/^[0-9a-f-]{36}\//i.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Invalid attachment key.");
  const response = await signedFetch(env, "GET", key);
  if (!response.ok) throw new Error(`B2 download failed (${response.status}).`);
  return response.arrayBuffer();
}
