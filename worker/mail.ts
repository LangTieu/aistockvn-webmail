import PostalMime, { type Email } from "postal-mime";
import { SPAM_THRESHOLD, scoreSpam, isSpam } from "./spam";
import { classifyFocused } from "./focused";
import { getEncryptionKey, encryptText } from "./crypto";
import { isR2WriteBlocked, recordR2Write } from "./r2-guard";

export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  ASSETS: Fetcher;
  MAILBOX_ADDRESS: string;
  FROM_NAME: string;
  ALLOWED_EMAILS: string;
  GOOGLE_CLIENT_ID: string;
  FORWARD_TO: string;
  RESEND_API_KEY?: string;
  SENDDEV_API_KEY?: string;
  SESSION_SECRET?: string;
  /** Worker secret for non-interactive mail API access; never log its value. */
  MAIL_API_KEY?: string;
  /** Chỉ đặt trong .dev.vars khi chạy local; production không bao giờ có. */
  DEV_LOGIN?: string;
  TOTP_ENCRYPTION_KEY?: string;
  /** Worker secret, base64 32 bytes, set at deploy; never log its value. */
  ENCRYPTION_KEY?: string;
  /** Workers AI binding (added at deploy via [[ai]] in wrangler.jsonc). */
  AI?: import("@cloudflare/workers-types").Ai;
  VAPID_PRIVATE_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  BACKUP?: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID?: string;
  D1_DATABASE_ID?: string;
  D1_REST_API_TOKEN?: string;
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_BUCKET_NAME?: string;
  B2_S3_ENDPOINT?: string;
  B2_KEY_ID_2?: string;
  B2_APPLICATION_KEY_2?: string;
  B2_BUCKET_NAME_2?: string;
  B2_S3_ENDPOINT_2?: string;
}

export type AttachmentMeta = { index: number; filename: string; mimeType: string; size: number; inline: boolean; key?: string };

const MAX_TEXT = 200_000;

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export function makeSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

function addrList(list: Email["to"]): { address: string; name: string }[] {
  const out: { address: string; name: string }[] = [];
  for (const a of list || []) {
    if ("group" in a && a.group) for (const g of a.group) out.push({ address: g.address || "", name: g.name || "" });
    else out.push({ address: (a as any).address || "", name: a.name || "" });
  }
  return out;
}

export function attachmentMeta(email: Email): AttachmentMeta[] {
  return email.attachments.map((a, index) => ({
    index,
    filename: a.filename || `tep-${index + 1}`,
    mimeType: a.mimeType,
    size: typeof a.content === "string" ? a.content.length : (a.content as ArrayBuffer).byteLength,
    inline: a.disposition === "inline" && !!a.contentId,
  }));
}

/** Lưu một thư đến: bản gốc vào R2, siêu dữ liệu + text vào D1. Trả về id (hoặc id cũ nếu trùng). */
export async function ingestInbound(
  env: Env,
  raw: ArrayBuffer,
  envelope: { from: string; to: string },
  now = Date.now(),
  opts?: { mailboxAddress?: string; source?: string; externalAccountId?: string },
): Promise<{ id: string; duplicate: boolean; spamScore: number; spamReasons: string; folder: string }> {
  const email = await PostalMime.parse(raw);
  const messageId = email.messageId?.trim() || null;
  const dedupMailbox = (opts?.mailboxAddress ?? env.MAILBOX_ADDRESS ?? "").trim().toLowerCase();
  if (messageId) {
    const dup = await env.DB.prepare("SELECT id FROM messages WHERE mailbox_address = ? AND folder='inbox' AND message_id=?")
      .bind(dedupMailbox, messageId)
      .first<{ id: string }>();
    if (dup) return { id: dup.id, duplicate: true, spamScore: 0, spamReasons: "", folder: "inbox" };
  }
  const id = crypto.randomUUID();
  const d = new Date(now);
  const rawKey = `raw/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}.eml`;
  // RÀO CỨNG R2 (billing guard 20/11): R2 là dịch vụ duy nhất có thể tự tính
  // tiền khi vượt free (subscription r2_paid). Chạm 8 GB (80% free) hoặc
  // 800K Class A/tháng thì DỪNG ghi R2 — mail vẫn lưu D1 (chỉ thiếu file raw
  // .eml), không để vượt rồi mới báo. Fail-open: lỗi D1 thì vẫn ghi R2.
  const r2Blocked = await isR2WriteBlocked(env.DB);
  let storedRawKey: string | null = rawKey;
  if (r2Blocked) {
    storedRawKey = null;
    console.warn("[r2-guard] R2 write blocked (cap reached); storing mail in D1 only, raw_key=null");
  } else {
    await env.RAW.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } });
    await recordR2Write(env.DB, raw.byteLength);
  }

  const text = (email.text || (email.html ? htmlToText(email.html) : "")).slice(0, MAX_TEXT);
  const parsedDate = email.date ? Date.parse(email.date) : NaN;
  const from = email.from && "address" in email.from ? email.from : { address: envelope.from, name: "" };
  const fromAddr = (from.address || envelope.from || "").toLowerCase();
  const fromDomain = fromAddr.split("@").pop() || "";

  // Blocklist lookup: check domain and full address
  const blocklistDomain = await env.DB.prepare("SELECT 1 FROM spam_blocklist WHERE kind='domain' AND value=?")
    .bind(fromDomain)
    .first<{ 1: number }>();
  const blocklistAddress = await env.DB.prepare("SELECT 1 FROM spam_blocklist WHERE kind='address' AND value=?")
    .bind(fromAddr)
    .first<{ 1: number }>();
  const blocklisted = !!blocklistDomain || !!blocklistAddress;

  // Get headers for spam scoring (PostalMime headers)
  const headers: { key: string; value: string }[] = email.headers || [];

  const scored = scoreSpam({
    from: fromAddr,
    subject: email.subject || "",
    text,
    headers,
    blocklisted,
  });

  const folder = isSpam(scored) ? "spam" : "inbox";

  let is_focused = 0;
  let focused_reasons = "[]";
  if (folder === "inbox") {
    const allowedEmails = (env.ALLOWED_EMAILS || "")
      .split(",")
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);
    const sentRows = await env.DB.prepare(
      "SELECT message_id FROM messages WHERE folder='sent' AND message_id IS NOT NULL",
    )
      .all<{ message_id: string }>();
    const sentMessageIds = sentRows.results.map((r: { message_id: string }) => r.message_id);
    const userRows = await env.DB.prepare(
      "SELECT display_name FROM users WHERE display_name IS NOT NULL AND display_name != ''",
    )
      .all<{ display_name: string }>();
    let userNames = userRows.results.map((r: { display_name: string }) => r.display_name).filter(
      (name: string) => !name.includes("@"),
    );
    for (const email of allowedEmails) {
      const localPart = email.split("@")[0];
      if (localPart) userNames.push(localPart);
    }
    userNames = [...new Set(userNames)];
    const { focused, reasons } = classifyFocused({
      from: fromAddr,
      subject: email.subject || "",
      text,
      inReplyTo: email.inReplyTo || null,
      references: email.references || null,
      allowedEmails,
      sentMessageIds,
      userNames,
    });
    if (focused) {
      is_focused = 1;
      focused_reasons = JSON.stringify(reasons);
    } else {
      is_focused = 0;
      focused_reasons = "[]";
    }
  }

  const mailboxAddress =
    opts?.mailboxAddress?.trim().toLowerCase() ||
    (env.MAILBOX_ADDRESS || "").trim().toLowerCase() ||
    (envelope.to || "").trim().toLowerCase() ||
    null;

  // Encrypt body - AFTER all plaintext computations (spam, classification, snippet)
  const key = await getEncryptionKey(env);
  const storedText = await encryptText(text, key);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, folder, mailbox_address, message_id, in_reply_to, references_hdr, envelope_from, envelope_to,
      from_addr, from_name, to_addrs, cc_addrs, reply_to, subject, snippet, text_body, date, is_read, raw_key, size, attachments, spam_score, spam_reasons, is_focused, focused_reasons, source, external_account_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      folder,
      mailboxAddress,
      messageId,
      email.inReplyTo || null,
      email.references || null,
      envelope.from,
      envelope.to,
      fromAddr,
      from.name || "",
      JSON.stringify(addrList(email.to)),
      JSON.stringify(addrList(email.cc)),
      email.replyTo?.length ? JSON.stringify(addrList(email.replyTo)) : null,
      email.subject || "",
      makeSnippet(text),
      storedText,
      // Ngày nhận thực tế dùng khi header Date thiếu/lệch xa tương lai.
      Number.isFinite(parsedDate) && parsedDate < now + 86_400_000 ? parsedDate : now,
      storedRawKey, // null khi rào cứng R2 đã chặn ghi file raw
      raw.byteLength,
      JSON.stringify(attachmentMeta(email)),
      scored.score,
      JSON.stringify(scored.reasons),
      is_focused,
      focused_reasons,
      opts?.source ?? "omnimail",
      opts?.externalAccountId ?? null,
    )
    .run();
  return { id, duplicate: false, spamScore: scored.score, spamReasons: JSON.stringify(scored.reasons), folder };
}

/** Thay `cid:` trong HTML bằng data URL của ảnh nhúng để hiển thị offline. */
export function inlineCidImages(html: string, email: Email): string {
  let out = html;
  for (const a of email.attachments) {
    if (!a.contentId) continue;
    const cid = a.contentId.replace(/^<|>$/g, "");
    const bytes = typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    out = out.split(`cid:${cid}`).join(`data:${a.mimeType};base64,${btoa(bin)}`);
  }
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function textToHtml(text: string): string {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escapeHtml(text)}</div>`;
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export function parseRecipients(input: string | string[] | undefined): string[] {
  const parts = (Array.isArray(input) ? input.join(",") : input || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim().replace(/^<|>$/g, ""))
    .filter(Boolean);
  for (const p of parts) if (!EMAIL_RE.test(p)) throw new Error(`Địa chỉ không hợp lệ: ${p}`);
  return [...new Set(parts.map((p) => p.toLowerCase()))];
}
