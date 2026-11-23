import PostalMime from "postal-mime";
import {
  SESSION_COOKIE,
  isAllowed,
  readCookie,
  sessionCookie,
  signSession,
  verifyGoogleIdToken,
  verifySession,
  hashPassword,
  verifyPassword,
  validatePassword,
  safeEqual,
  sha256Hex,
  consumePasswordCost,
  b64urlEncode,
  verifyEmailToken,
} from "./auth";
import { buildFtsQuery } from "./search";
import { pickProvider } from "./send-providers";
import {
  type AttachmentMeta,
  type Env,
  ingestInbound,
  inlineCidImages,
  parseRecipients,
  textToHtml,
  makeSnippet,
} from "./mail";
import {
  generateTotpSecret,
  encryptTotpSecret,
  decryptTotpSecret,
  verifyTOTPCode,
  generateRecoveryCodes,
} from "./mfa";
import {
  getEncryptionKey,
  encryptText,
  decryptText,
  isEncrypted,
} from "./crypto";
import { summarizeText, draftReply } from "./ai";
// PHASE1-ALIASES
import { generateAliasLocalPart, isAliasDisabled, lookupAlias, lookupDomain, parseAliasAddress, type AliasRow } from "./aliases";
import { listDrafts, getDraft, upsertDraft, deleteDraft, DraftError, type DraftUpsertInput } from './drafts';
// PHASE4-R2
import { setStarred, listStarred, StarredError } from './starred';
import { listThreads, getThread, applyBatch, ThreadsError, BatchError, type ThreadMessageRow } from './threads';
// PHASE4-R4
import {
  TELEGRAM_CHAT_ID_RE,
  NotificationError,
  getNotificationSettings,
  updateNotificationSettings,
  shouldNotify,
  enqueueNotification,
  listPushSubscriptions,
  type DetailLevel,
} from "./notifications";
import { PushError, validatePushSubscriptionInput, sendPush } from "./push";
import { TelegramError, sendTelegramMessage } from "./telegram";
import { deliverPendingNotifications } from "./notify-delivery";
// PHASE4-R6
import {
  AdminError,
  requireAdmin,
  requireSuperAdmin,
  logAdminAction,
  getAdminStats,
  listUsers,
  setUserRole,
  setUserStatus,
  listDomains,
  toggleDomain,
  listAliases,
  toggleAlias,
  previewCleanup,
  runCleanup,
  listAuditLogs,
  getAdminSettings,
  updateAdminSettings,
  countSentToday,
} from "./admin";
// PHASE4-R7
import {
  GmailError,
  listExternalAccounts,
  connectGmailAccount,
  disconnectGmailAccount,
  syncGmailAccount,
} from "./gmail";
// PHASE4-R8
import {
  BackupError,
  getBackupSettings,
  updateBackupSettings,
  listBackupRuns,
  runBackup,
  listBackupObjects,
  downloadBackupObject,
} from "./backup";
import { listClientErrors, logEvent, reportClientError, safeLogText } from "./observability";
import { uploadAttachments, loadAttachment, MAX_ATTACHMENT_BYTES, validateAttachmentName } from "./attachments";
export { BackupWorkflow } from "./backup";

const testNotifyRateLimit = new Map<string, number>();

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

const err = (message: string, status: number, init?: { headers?: HeadersInit }) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(init?.headers || {}) },
  });

type Row = Record<string, any>;

function listItem(r: Row) {
  return {
    id: r.id,
    folder: r.folder,
    from: { address: r.from_addr, name: r.from_name },
    to: JSON.parse(r.to_addrs || "[]"),
    subject: r.subject,
    snippet: r.snippet,
    date: r.date,
    isRead: !!r.is_read,
    isFocused: !!r.is_focused,
    isStarred: !!r.is_starred,
    hasAttachments: r.attachments !== "[]",
    // PHASE4-R7
    mailboxAddress: r.mailbox_address,
    source: r.source,
  };
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  const secure = url.protocol === "https:";
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const nowSec = Math.floor(Date.now() / 1000);

  // Header tùy biến buộc preflight CORS cho request khác origin (không được phép) → chặn CSRF.
  if (req.method !== "GET" && req.headers.get("X-Mail-Client") !== "1") return err("Missing header", 403);

  if (path === "/api/config" && req.method === "GET") {
    return json({
      googleClientId: env.GOOGLE_CLIENT_ID || "",
      devLogin: env.DEV_LOGIN === "1",
      mailbox: env.MAILBOX_ADDRESS,
      sendingEnabled: !!env.RESEND_API_KEY,
    });
  }

  if (path === "/api/auth/google" && req.method === "POST") {
    const { credential } = (await req.json().catch(() => ({}))) as { credential?: string };
    if (!credential) return err("Missing credential", 400);
    let email: string;
    try {
      ({ email } = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID));
    } catch (e) {
      return err(`Google sign-in failed: ${(e as Error).message}`, 401);
    }
    if (!isAllowed(email, env.ALLOWED_EMAILS)) return err(`Account ${email} does not have access`, 403);
    // Check if MFA is enabled for this user
    const userRow = await env.DB.prepare("SELECT id, verified FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: number; verified: number }>();
    const mfaRow = await env.DB.prepare("SELECT enabled_at FROM admin_totp WHERE user_id = ?")
      .bind(userRow?.id ?? 0)
      .first<{ enabled_at: number }>();
    if (Boolean(mfaRow?.enabled_at) && userRow?.verified === 1) {
      // MFA enabled: create challenge instead of issuing session
      const token = crypto.getRandomValues(new Uint8Array(32));
      const tokenHash = await sha256Hex(b64urlEncode(token));
      const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 minutes
      await env.DB.prepare("INSERT INTO mfa_challenges (token_hash, user_id, channel, expires_at) VALUES (?, ?, 'browser', ?)")
        .bind(tokenHash, userRow.id, expiresAt).run();
      return json({ mfaRequired: true, email }, 200, {
        "Set-Cookie": `mail_mfa_challenge=${b64urlEncode(token)}; HttpOnly; path=/api/auth/mfa/challenge; Max-Age=300${secure ? "; Secure" : ""}`,
      });
    }
    return json({ email }, 200, { "Set-Cookie": sessionCookie(await signSession(email, env.SESSION_SECRET || ""), secure) });
  }

  if (path === "/api/auth/dev" && req.method === "POST") {
    if (env.DEV_LOGIN !== "1") return err("Not available", 404);
    const email = env.ALLOWED_EMAILS.split(",")[0].trim().toLowerCase();
    return json({ email }, 200, { "Set-Cookie": sessionCookie(await signSession(email, env.SESSION_SECRET || ""), secure) });
  }

  if (path === "/api/logout" && req.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", secure, 0) });
  }

  // ============================================================
  // POST /api/auth/password — password login
  // ============================================================
  if (path === "/api/auth/password" && req.method === "POST") {
    const { email, password } = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
    if (!email || !password) return err("Missing email or password", 400);

    const normalized = email.trim().toLowerCase();
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const nowSec = Math.floor(Date.now() / 1000);

    // Key includes IP + email
    const loginKey = await sha256Hex(`${ip}\n${normalized}`);
    const windowSeconds = 900; // 15 min
    const maxAttempts = 5;

    // FIRST check blocked BEFORE password verification
    const existingLogin = await env.DB.prepare("SELECT attempts, window_started_at FROM login_attempts WHERE key_hash = ?")
      .bind(loginKey)
      .first<{ attempts: number; window_started_at: number }>();

    if (existingLogin && nowSec - existingLogin.window_started_at < windowSeconds && existingLogin.attempts >= maxAttempts) {
      const retryAfter = Math.max(1, existingLogin.window_started_at + windowSeconds - nowSec);
      return new Response(JSON.stringify({ error: `Too many attempts, try again in ${Math.ceil(windowSeconds / 60)} minutes` }), {
        status: 429,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(retryAfter) },
      });
    }

    // Verify password
    const userRow = await env.DB.prepare("SELECT email, password_hash, verified, id, role, status FROM users WHERE email = ?")
      .bind(normalized)
      .first<{ email: string; password_hash: string; verified: number; id: number; role: string; status?: string }>();

    // Unknown email: still run dummy PBKDF2 derive (consumePasswordCost) then return same 401
    if (!userRow) {
      await consumePasswordCost(password);
      return err("Incorrect email or password", 401);
    }

    // User exists, verify password
    let passwordValid;
    try {
      passwordValid = await verifyPassword(userRow.password_hash, password);
    } catch {
      passwordValid = false;
    }
    if (!passwordValid) {
      // Record failure ONLY on password failure
      // if the stored window started before now - 900, reset attempts to 1 with a new window start, else attempts + 1
      if (existingLogin && nowSec - existingLogin.window_started_at > windowSeconds) {
        // Window expired, reset
        await env.DB.prepare("UPDATE login_attempts SET attempts = 1, window_started_at = ? WHERE key_hash = ?")
          .bind(nowSec, loginKey).run();
      } else if (existingLogin) {
        // Window still active, increment
        await env.DB.prepare("UPDATE login_attempts SET attempts = attempts + 1, window_started_at = ? WHERE key_hash = ?")
          .bind(nowSec, loginKey).run();
      } else {
        // No existing row, insert new
        await env.DB.prepare("INSERT INTO login_attempts (key_hash, attempts, window_started_at) VALUES (?, 1, ?)")
          .bind(loginKey, nowSec).run();
      }
      return err("Incorrect email or password", 401);
    }

    // PHASE4-R6: block banned accounts after password verification (never leak on wrong password)
    if (userRow.status === "banned") {
      return err("account_banned", 403);
    }

    // Check if MFA is enabled for this user
    const mfaRow = await env.DB.prepare("SELECT enabled_at FROM admin_totp WHERE user_id = ?")
      .bind(userRow.id)
      .first<{ enabled_at: number }>();

    if (Boolean(mfaRow?.enabled_at)) {
      // MFA enabled: create challenge instead of issuing session
      const token = crypto.getRandomValues(new Uint8Array(32));
      const tokenHash = await sha256Hex(b64urlEncode(token));
      const expiresAt = nowSec + 300; // 5 minutes
      await env.DB.prepare("INSERT INTO mfa_challenges (token_hash, user_id, channel, expires_at) VALUES (?, ?, 'browser', ?)")
        .bind(tokenHash, userRow.id, expiresAt).run();
      // Set challenge cookie
      return json({ mfaRequired: true, email: normalized }, 200, {
        "Set-Cookie": `mail_mfa_challenge=${b64urlEncode(token)}; HttpOnly; path=/api/auth/mfa/challenge; Max-Age=300${secure ? "; Secure" : ""}`,
      });
    }

    // Check email verified
    if (userRow.verified !== 1) {
      return err("Email not verified yet — check your inbox for the confirmation link", 403);
    }

    // Successful login: delete the login_attempts row
    await env.DB.prepare("DELETE FROM login_attempts WHERE key_hash = ?").bind(loginKey).run();

    // Issue session cookie
    const session = await signSession(normalized, env.SESSION_SECRET || "");
    return json({ email: normalized }, 200, { "Set-Cookie": sessionCookie(session, secure) });
  }

  // ============================================================
  // POST /api/auth/signup — signup
  // ============================================================
  if (path === "/api/auth/signup" && req.method === "POST") {
    const { email, password } = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
    if (!email || !password) return err("Missing email or password", 400);

    const normalized = email.trim().toLowerCase();

    // Allowlist gate: ONLY emails in ALLOWED_EMAILS may sign up
    if (!isAllowed(normalized, env.ALLOWED_EMAILS)) {
      return err("This email is not allowed to sign up", 403);
    }

    // Block SUPER_ADMIN_EMAIL from external registration
    if (normalized === "admin@aistockvn.com") {
      return err("Account already exists", 409);
    }

    // Registration rate limiting - three buckets: ip-day, ip-hour, email-hour
    const ipDayKey = await sha256Hex(`registration:ip-day\n${ip}`);
    const ipHourKey = await sha256Hex(`registration:ip-hour\n${ip}`);
    const emailHourKey = await sha256Hex(`registration:email-hour\n${normalized}`);
    const hourWindowSec = 3600;
    const dayWindowSec = 24 * 3600;
    const ipHourMax = 3;
    const emailHourMax = 3;
    const ipDayMax = 10;

    // Check/upsert ip-day bucket (24h window)
    let ipDayExisting = await env.DB.prepare("SELECT attempts, window_started_at FROM registration_attempts WHERE key_hash = ?")
      .bind(ipDayKey)
      .first<{ attempts: number; window_started_at: number }>();
    if (ipDayExisting) {
      if (nowSec - ipDayExisting.window_started_at > dayWindowSec) {
        await env.DB.prepare("UPDATE registration_attempts SET attempts = 1, window_started_at = ? WHERE key_hash = ?")
          .bind(nowSec, ipDayKey).run();
      } else {
        await env.DB.prepare("UPDATE registration_attempts SET attempts = attempts + 1, window_started_at = ? WHERE key_hash = ?")
          .bind(nowSec, ipDayKey).run();
      }
    } else {
      await env.DB.prepare("INSERT INTO registration_attempts (key_hash, attempts, window_started_at) VALUES (?, 1, ?)")
        .bind(ipDayKey, nowSec).run();
    }
    const ipDayRow = await env.DB.prepare("SELECT attempts FROM registration_attempts WHERE key_hash = ?")
      .bind(ipDayKey)
      .first<{ attempts: number }>();
    const ipDayWindowStart = ipDayExisting?.window_started_at || nowSec;
    if (ipDayRow && ipDayRow.attempts > ipDayMax) {
      const retryAfter = Math.max(1, Math.ceil(dayWindowSec - (nowSec - ipDayWindowStart)));
      return new Response(JSON.stringify({ error: "Too many sign-up attempts" }), {
        status: 429,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(retryAfter) },
      });
    }

    // Check/upsert ip-hour bucket (1h window)
    let ipHourExisting = await env.DB.prepare("SELECT attempts, window_started_at FROM registration_attempts WHERE key_hash = ?")
      .bind(ipHourKey)
      .first<{ attempts: number; window_started_at: number }>();
    if (ipHourExisting) {
      if (nowSec - ipHourExisting.window_started_at > hourWindowSec) {
        await env.DB.prepare("UPDATE registration_attempts SET attempts = 1, window_started_at = ? WHERE key_hash = ?")
          .bind(nowSec, ipHourKey).run();
      } else {
        await env.DB.prepare("UPDATE registration_attempts SET attempts = attempts + 1, window_started_at = ? WHERE key_hash = ?")
          .bind(nowSec, ipHourKey).run();
      }
    } else {
      await env.DB.prepare("INSERT INTO registration_attempts (key_hash, attempts, window_started_at) VALUES (?, 1, ?)")
        .bind(ipHourKey, nowSec).run();
    }
    const ipHourRow = await env.DB.prepare("SELECT attempts FROM registration_attempts WHERE key_hash = ?")
      .bind(ipHourKey)
      .first<{ attempts: number }>();
    const ipHourWindowStart = ipHourExisting?.window_started_at || nowSec;
    if (ipHourRow && ipHourRow.attempts > ipHourMax) {
      const retryAfter = Math.max(1, Math.ceil(hourWindowSec - (nowSec - ipHourWindowStart)));
      return new Response(JSON.stringify({ error: "Too many sign-up attempts" }), {
        status: 429,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(retryAfter) },
      });
    }

    // Check/upsert email-hour bucket (1h window)
    let emailHourExisting = await env.DB.prepare("SELECT attempts, window_started_at FROM registration_attempts WHERE key_hash = ?")
      .bind(emailHourKey)
      .first<{ attempts: number; window_started_at: number }>();
    if (emailHourExisting) {
      if (nowSec - emailHourExisting.window_started_at > hourWindowSec) {
        await env.DB.prepare("UPDATE registration_attempts SET attempts = 1, window_started_at = ? WHERE key_hash = ?")
          .bind(nowSec, emailHourKey).run();
      } else {
        await env.DB.prepare("UPDATE registration_attempts SET attempts = attempts + 1, window_started_at = ? WHERE key_hash = ?")
          .bind(nowSec, emailHourKey).run();
      }
    } else {
      await env.DB.prepare("INSERT INTO registration_attempts (key_hash, attempts, window_started_at) VALUES (?, 1, ?)")
        .bind(emailHourKey, nowSec).run();
    }
    const emailHourRow = await env.DB.prepare("SELECT attempts FROM registration_attempts WHERE key_hash = ?")
      .bind(emailHourKey)
      .first<{ attempts: number }>();
    const emailHourWindowStart = emailHourExisting?.window_started_at || nowSec;
    if (emailHourRow && emailHourRow.attempts > emailHourMax) {
      const retryAfter = Math.max(1, Math.ceil(hourWindowSec - (nowSec - emailHourWindowStart)));
      return new Response(JSON.stringify({ error: "Too many sign-up attempts" }), {
        status: 429,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(retryAfter) },
      });
    }

    // Password validation
    const pwValid = validatePassword(password);
    if (!pwValid.valid) {
      return err("Weak password (at least 10 characters)", 400);
    }

    // Check duplicate email
    const duplicate = await env.DB.prepare("SELECT id, email, verified FROM users WHERE email = ?")
      .bind(normalized)
      .first<{ id: string; email: string; verified: number }>();

    if (duplicate) {
      if (duplicate.verified === 1) {
        return err("Email already exists", 409);
      }
      // Ensure primary mailbox row exists for unverified user on resend path
      await env.DB.prepare(
        "INSERT OR IGNORE INTO mailboxes (address, user_id, is_primary, is_active) VALUES (?, ?, 1, 1)"
      )
        .bind(normalized, duplicate.id)
        .run();

      // User exists but not verified → create new verification token, resend mail
      const verificationToken = crypto.getRandomValues(new Uint8Array(32));
      const tokenB64 = b64urlEncode(new Uint8Array(verificationToken));
      const tokenHash = await sha256Hex(tokenB64);
      const expiresAt = nowSec + 3600; // 1 hour
      await env.DB.prepare("INSERT INTO email_verifications (token_hash, email, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)")
        .bind(tokenHash, normalized, expiresAt, nowSec).run();
      const verificationLink = `https://mail.aistockvn.com/#/verify?token=${tokenB64}`;
      if (env.RESEND_API_KEY) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: `${env.FROM_NAME} <${env.MAILBOX_ADDRESS}>`,
            to: [normalized],
            subject: "Confirm your email for AI Stock VN Mail",
            html: `<p>You requested email confirmation. <a href="${verificationLink}">Click here</a> to confirm your account.</p><p>If you did not make this request, you can ignore this email.</p>`,
            text: `You requested email confirmation. Click ${verificationLink} to confirm your account. If you did not make this request, you can ignore this email.`,
          }),
        });
      }
      if (env.DEV_LOGIN === "1") {
        return json({ email: normalized, verificationSent: true }, 201);
      }
      return json({ email: normalized, verificationSent: true }, 201);
    }

    // Hash password
    const passwordHash = await hashPassword(password);
    const newUserId = crypto.randomUUID();

    // Create user with verified=0
    await env.DB.prepare("INSERT INTO users (id, email, display_name, password_hash, verified, created_at) VALUES (?, ?, ?, ?, 0, ?)")
      .bind(newUserId, normalized, normalized, passwordHash, nowSec).run();

    // Create primary mailbox row for the newly created user
    await env.DB.prepare("INSERT OR IGNORE INTO mailboxes (address, user_id, is_primary, is_active) VALUES (?, ?, 1, 1)")
      .bind(normalized, newUserId).run();

    // Create verification token
    const verificationToken = crypto.getRandomValues(new Uint8Array(32));
    const tokenB64 = b64urlEncode(new Uint8Array(verificationToken));
    const tokenHash = await sha256Hex(tokenB64);
    const expiresAt = nowSec + 3600; // 1 hour
    await env.DB.prepare("INSERT INTO email_verifications (token_hash, email, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)")
      .bind(tokenHash, normalized, expiresAt, nowSec).run();

    const verificationLink = `https://mail.aistockvn.com/#/verify?token=${tokenB64}`;
    if (env.RESEND_API_KEY) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${env.FROM_NAME} <${env.MAILBOX_ADDRESS}>`,
          to: [normalized],
          subject: "Confirm your email for AI Stock VN Mail",
          html: `<p>You requested email confirmation. <a href="${verificationLink}">Click here</a> to confirm your account.</p><p>If you did not make this request, you can ignore this email.</p>`,
          text: `You requested email confirmation. Click ${verificationLink} to confirm your account. If you did not make this request, you can ignore this email.`,
        }),
      });
    }
    if (env.DEV_LOGIN === "1") {
      return json({ email: normalized, verificationSent: true, token: tokenB64 }, 201);
    }
    return json({ email: normalized, verificationSent: true }, 201);
  }

  // ============================================================
  // POST /api/auth/verify — email verification
  // ============================================================
  if (path === "/api/auth/verify" && req.method === "POST") {
    const { token } = (await req.json().catch(() => ({}))) as { token?: string };
    if (!token) return err("Missing token", 400);

    const nowSec = Math.floor(Date.now() / 1000);
    const result = await verifyEmailToken(token, env.DB, nowSec);

    if (!result.exists) return err("Invalid token", 400);
    if (result.used) return err("Token already used", 400);
    if (result.expired) {
      // Mark as used so it can't be reused
      const tokenHash = await sha256Hex(token);
      await env.DB.prepare("UPDATE email_verifications SET used = 1 WHERE token_hash = ?").bind(tokenHash).run();
      return err("Token expired", 400);
    }

    // Mark token as used
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare("UPDATE email_verifications SET used = 1 WHERE token_hash = ?").bind(tokenHash).run();

    // Mark user as verified
    await env.DB.prepare("UPDATE users SET verified = 1 WHERE email = ?").bind(result.email).run();

    return json({ success: true, email: result.email }, 200);
  }

  // ============================================================
  // POST /api/auth/forgot — forgot password
  // ============================================================
  if (path === "/api/auth/forgot" && req.method === "POST") {
    const { email } = (await req.json().catch(() => ({}))) as { email?: string };
    if (!email) return err("Missing email", 400);

    const normalized = email.trim().toLowerCase();

    // Always return success, even if email has no account
    // Generate reset token (32 random bytes)
    const resetToken = crypto.getRandomValues(new Uint8Array(32));
    const tokenB64 = b64urlEncode(new Uint8Array(resetToken));
    // Store SHA-256 hash of the base64url-encoded token in DB
    const tokenHash = await sha256Hex(tokenB64);

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = nowSec + 3600; // 1 hour

    // Store in password_resets table
    await env.DB.prepare("INSERT INTO password_resets (token_hash, email, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)")
      .bind(tokenHash, normalized, expiresAt, nowSec).run();

    // Try to send reset link via Resend
    const resendKey = env.RESEND_API_KEY;
    if (resendKey) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${env.FROM_NAME} <${env.MAILBOX_ADDRESS}>`,
          to: [normalized],
          subject: "Reset your AI Stock VN Mail password",
          html: `<p>You requested a password reset. <a href="https://mail.aistockvn.com/#/reset?token=${tokenB64}">Click here</a> to set a new password.</p>`,
          text: `You requested a password reset. Click https://mail.aistockvn.com/#/reset?token=${tokenB64} to set a new password.`,
        }),
      });
    }

    // In dev mode (DEV_LOGIN=1), return the raw token for e2e testing
    if (env.DEV_LOGIN === "1") {
      return json({ success: true, token: tokenB64 }, 200);
    }

    return json({ success: true }, 200);
  }

  // ============================================================
  // POST /api/auth/reset — reset password
  // ============================================================
  if (path === "/api/auth/reset" && req.method === "POST") {
    const { token, password } = (await req.json().catch(() => ({}))) as { token?: string; password?: string };
    if (!token || !password) return err("Missing token or password", 400);

    const nowSec = Math.floor(Date.now() / 1000);

    // Hash the token to look it up
    const tokenHash = await sha256Hex(token);

    // Look up the reset token
    const resetRow = await env.DB.prepare("SELECT * FROM password_resets WHERE token_hash = ?")
      .bind(tokenHash)
      .first<{ email: string; expires_at: number; used: number; created_at: number }>();

    if (!resetRow) return err("Invalid token", 400);
    if (resetRow.used === 1) return err("Token already used", 400);
    if (resetRow.expires_at < nowSec) {
      // Mark as used so it can't be reused
      await env.DB.prepare("UPDATE password_resets SET used = 1 WHERE token_hash = ?").bind(tokenHash).run();
      return err("Token expired", 400);
    }

    // Validate new password
    const pwValid = validatePassword(password);
    if (!pwValid.valid) return err("Weak password (at least 10 characters)", 400);

    // Hash the new password
    const newPasswordHash = await hashPassword(password);

    // Set the user's new password
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE email = ?")
      .bind(newPasswordHash, resetRow.email).run();

    // Mark token as used (single-use)
    await env.DB.prepare("UPDATE password_resets SET used = 1 WHERE token_hash = ?").bind(tokenHash).run();

    // Clear any login_attempts rows for that email
    const emailKey = await sha256Hex(`login\n${resetRow.email}`);
    await env.DB.prepare("DELETE FROM login_attempts WHERE key_hash = ?").bind(emailKey).run();

    return json({ success: true }, 200);
  }

  // MFA: status — check if MFA enabled for the authenticated user
  if (path === "/api/auth/mfa/status" && req.method === "GET") {
    const authToken = readCookie(req, "mail_session");
    const authUser = await verifySession(authToken, env.SESSION_SECRET || "", env.ALLOWED_EMAILS);
    if (!authUser) return err("Not signed in", 401);
    const mfaRow = await env.DB.prepare("SELECT enabled_at FROM admin_totp WHERE user_id = (SELECT id FROM users WHERE email = ?)")
      .bind(authUser)
      .first<{ enabled_at: number }>();
    const enabled = Boolean(mfaRow?.enabled_at);
    const ready = !!(env.TOTP_ENCRYPTION_KEY && env.TOTP_ENCRYPTION_KEY.length >= 32);
    const recoveryCodesRemaining = await env.DB.prepare("SELECT COUNT(*) AS recovery_count FROM mfa_recovery_codes WHERE user_id = (SELECT id FROM users WHERE email = ?) AND used_at IS NULL")
      .bind(authUser)
      .first<{ recovery_count: number }>();
    return json({ ready, enabled, recoveryCodesRemaining: recoveryCodesRemaining?.recovery_count ?? 0 });
  }

  // MFA: setup — admin only, generate TOTP secret and URI
  if (path === "/api/auth/mfa/setup" && req.method === "POST") {
    const authToken = readCookie(req, "mail_session");
    const authUser = await verifySession(authToken, env.SESSION_SECRET || "", env.ALLOWED_EMAILS);
    if (!authUser) return err("Not signed in", 401);
    const authRow = await env.DB.prepare("SELECT role FROM users WHERE email = ?")
      .bind(authUser)
      .first<{ role: string }>();
    if (!authRow || !(authRow.role === "super_admin" || authRow.role === "admin")) {
      return err("Forbidden", 403);
    }
    const encryptionKey = env.TOTP_ENCRYPTION_KEY;
    if (!encryptionKey || encryptionKey.length < 32) return err("TOTP_ENCRYPTION_KEY missing or too short", 503);
    const secretB32 = generateTotpSecret();
    const encryptedSecret = await encryptTotpSecret(secretB32, encryptionKey);
    const nowSec = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`INSERT INTO admin_totp (user_id, encrypted_secret, enabled_at, updated_at) VALUES ((SELECT id FROM users WHERE email = ?), ?, NULL, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_secret = excluded.encrypted_secret, enabled_at = NULL, updated_at = excluded.updated_at`)
      .bind(authUser, encryptedSecret, nowSec).run();
    const otpUri = `otpauth://totp/AI%20Stock%20VN%20Mail:${authUser}?secret=${secretB32}&issuer=AI%20Stock%20VN%20Mail&algorithm=SHA1&digits=6&period=30`;
    return json({ secret: secretB32, uri: otpUri });
  }

  // MFA: confirm — admin enables MFA for a user by confirming a code
  if (path === "/api/auth/mfa/confirm" && req.method === "POST") {
    const authToken = readCookie(req, "mail_session");
    const authUser = await verifySession(authToken, env.SESSION_SECRET || "", env.ALLOWED_EMAILS);
    if (!authUser) return err("Not signed in", 401);
    const authRow = await env.DB.prepare("SELECT role FROM users WHERE email = ?")
      .bind(authUser)
      .first<{ role: string }>();
    if (!authRow || !(authRow.role === "super_admin" || authRow.role === "admin")) {
      return err("Forbidden", 403);
    }
    const { code } = (await req.json().catch(() => ({}))) as { code?: string };
    if (!code || code.length !== 6) return err("Invalid code", 400);
    // Verify TOTP code
    const secretRow = await env.DB.prepare("SELECT encrypted_secret FROM admin_totp WHERE user_id = (SELECT id FROM users WHERE email = ?)")
      .bind(authUser)
      .first<{ encrypted_secret: string }>();
    if (!secretRow) return err("MFA not setup", 400);
    try {
      const decryptedSecret = await decryptTotpSecret(secretRow.encrypted_secret, env.TOTP_ENCRYPTION_KEY!);
      const codeValid = await verifyTOTPCode(decryptedSecret, code);
      if (!codeValid) return err("Invalid code", 400);
    } catch {
      return err("Invalid code", 400);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE admin_totp SET enabled_at = ?, updated_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)")
      .bind(nowSec, nowSec, authUser).run();
    // Generate 8 recovery codes
    const recoveryCodes = generateRecoveryCodes();
    for (const code of recoveryCodes) {
      const codeHash = await sha256Hex(code);
      await env.DB.prepare("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ((SELECT id FROM users WHERE email = ?), ?)")
        .bind(authUser, codeHash).run();
    }
    return json({ recoveryCodes });
  }

  // MFA: disable — admin disables MFA for a user by confirming a code
  if (path === "/api/auth/mfa/disable" && req.method === "POST") {
    const authToken = readCookie(req, "mail_session");
    const authUser = await verifySession(authToken, env.SESSION_SECRET || "", env.ALLOWED_EMAILS);
    if (!authUser) return err("Not signed in", 401);
    const authRow = await env.DB.prepare("SELECT role FROM users WHERE email = ?")
      .bind(authUser)
      .first<{ role: string }>();
    if (!authRow || !(authRow.role === "super_admin" || authRow.role === "admin")) {
      return err("Forbidden", 403);
    }
    const { code } = (await req.json().catch(() => ({}))) as { code?: string };
    if (!code) return err("Invalid code", 400);
    const nowSec = Math.floor(Date.now() / 1000);
    // Try TOTP verification first
    const secretRow = await env.DB.prepare("SELECT encrypted_secret FROM admin_totp WHERE user_id = (SELECT id FROM users WHERE email = ?)")
      .bind(authUser)
      .first<{ encrypted_secret: string }>();
    let codeValid = false;
    if (secretRow && code.length === 6) {
      try {
        const decryptedSecret = await decryptTotpSecret(secretRow.encrypted_secret, env.TOTP_ENCRYPTION_KEY!);
        codeValid = await verifyTOTPCode(decryptedSecret, code);
      } catch {
        codeValid = false;
      }
    }
    // If not valid TOTP, try recovery code
    if (!codeValid) {
      const codeHash = await sha256Hex(code);
      const recoveryRow = await env.DB.prepare("SELECT used_at FROM mfa_recovery_codes WHERE user_id = (SELECT id FROM users WHERE email = ?) AND code_hash = ?")
        .bind(authUser, codeHash)
        .first<{ used_at: number }>();
      if (recoveryRow && recoveryRow.used_at === null) {
        await env.DB.prepare("UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?) AND code_hash = ?")
          .bind(nowSec, authUser, codeHash).run();
        codeValid = true;
      }
    }
    if (!codeValid) return err("Invalid code", 400);
    // Delete all MFA rows
    await env.DB.prepare("DELETE FROM admin_totp WHERE user_id = (SELECT id FROM users WHERE email = ?)").bind(authUser).run();
    await env.DB.prepare("DELETE FROM mfa_challenges WHERE user_id = (SELECT id FROM users WHERE email = ?)").bind(authUser).run();
    await env.DB.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = (SELECT id FROM users WHERE email = ?)").bind(authUser).run();
    return json({ ok: true });
  }

  // MFA: challenge — complete MFA challenge to finish login
  if (path === "/api/auth/mfa/challenge" && req.method === "POST") {
    const { code } = (await req.json().catch(() => ({}))) as { code?: string };
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    // Read the challenge cookie first
    const challengeCookie = readCookie(req, "mail_mfa_challenge");
    let rateKey: string = await sha256Hex(`mfa\n${ip}\n0`); // fallback rate key
    if (challengeCookie) {
      const tokenHash = await sha256Hex(challengeCookie);
      // Look up challenge by sha256(token) JOIN users
      const challengeRow = await env.DB.prepare(`
        SELECT mc.token_hash, mc.user_id, mc.channel, mc.expires_at, mc.attempts, u.email, u.id AS user_id
        FROM mfa_challenges mc JOIN users u ON mc.user_id = u.id
        WHERE mc.token_hash = ? AND mc.channel = 'browser' AND mc.expires_at > ?
      `)
        .bind(tokenHash, nowSec)
        .first<{ token_hash: string; user_id: number; email: string; attempts: number }>();
      if (challengeRow) {
        rateKey = await sha256Hex(`mfa\n${ip}\n${challengeRow.user_id}`);
        // Check attempts limit
        if (challengeRow.attempts >= 5) {
          // Delete stale challenge row
          await env.DB.prepare("DELETE FROM mfa_challenges WHERE user_id = ?").bind(challengeRow.user_id).run();
          // Also clean up rate limit
          await env.DB.prepare("DELETE FROM login_attempts WHERE key_hash = ?").bind(rateKey).run();
          return err("MFA challenge exceeded maximum attempts", 401);
        }
        // Parse the code - determine if TOTP (6-digit) or recovery code
        let codeValid = false;
        let isRecovery = false;
        if (!code) return err("Invalid code", 400);

        if (code.length === 6) {
          // TOTP code - verify against TOTP secret
          const secretRow = await env.DB.prepare("SELECT encrypted_secret FROM admin_totp WHERE user_id = ?")
            .bind(challengeRow.user_id)
            .first<{ encrypted_secret: string }>();
          if (secretRow) {
            try {
              const decryptedSecret = await decryptTotpSecret(secretRow.encrypted_secret, env.TOTP_ENCRYPTION_KEY!);
              codeValid = await verifyTOTPCode(decryptedSecret, code);
            } catch {
              codeValid = false;
            }
          }
        } else {
          // Recovery code - single-use, mark used_at
          isRecovery = true;
          const codeHash = await sha256Hex(code);
          const recoveryRow = await env.DB.prepare("SELECT used_at FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ?")
            .bind(challengeRow.user_id, codeHash)
            .first<{ used_at: number }>();
          if (recoveryRow && recoveryRow.used_at === null) {
            await env.DB.prepare("UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ?")
              .bind(nowSec, challengeRow.user_id, codeHash).run();
            codeValid = true;
          }
        }

        if (!codeValid) {
          // Increment challenge attempts
          await env.DB.prepare("UPDATE mfa_challenges SET attempts = attempts + 1 WHERE user_id = ?")
            .bind(challengeRow.user_id).run();
          // Increment rate limit attempts
          await env.DB.prepare("UPDATE login_attempts SET attempts = attempts + 1, window_started_at = ? WHERE key_hash = ?")
            .bind(nowSec, rateKey).run();
          return err("Invalid MFA code", 401);
        }

        // Code is valid - delete the challenge row
        await env.DB.prepare("DELETE FROM mfa_challenges WHERE user_id = ?").bind(challengeRow.user_id).run();
        // Clean up rate limit - this was a successful attempt
        await env.DB.prepare("DELETE FROM login_attempts WHERE key_hash = ?").bind(rateKey).run();

        // Issue session cookie and clear challenge cookie
        const session = await signSession(challengeRow.email, env.SESSION_SECRET || "");
        const sessionCookieStr = `mail_session=${session}; HttpOnly; Path=/; Secure${secure ? "; Secure" : ""}`;
        const challengeCookieStr = `mail_mfa_challenge=; HttpOnly; path=/api/auth/mfa/challenge; Max-Age=0; Secure${secure ? "; Secure" : ""}`;
        const response: Response = json({ email: challengeRow.email, mailbox: env.MAILBOX_ADDRESS }, 200, {
          "Set-Cookie": sessionCookieStr,
        });
        response.headers.append("Set-Cookie", challengeCookieStr);
        return response;
      }
      // Challenge not found or expired - apply rate limit and return error
      if (nowSec - 0 < 900) { // simple rate check
        // Increment rate attempts for unknown challenge
        const existingRate = await env.DB.prepare("SELECT attempts, window_started_at FROM login_attempts WHERE key_hash = ?")
          .bind(rateKey)
          .first<{ attempts: number; window_started_at: number }>();
        if (existingRate && nowSec - existingRate.window_started_at < 900) {
          await env.DB.prepare("UPDATE login_attempts SET attempts = attempts + 1, window_started_at = ? WHERE key_hash = ?")
            .bind(nowSec, rateKey).run();
        } else if (!existingRate) {
          await env.DB.prepare("INSERT INTO login_attempts (key_hash, attempts, window_started_at) VALUES (?, 1, ?)")
            .bind(rateKey, nowSec).run();
        }
      }
      return err("Invalid or expired MFA challenge", 401);
    }
    // No challenge cookie - return error
    return err("No MFA challenge", 400);
  }

  // Existing session verification middleware for protected routes
  const sessionUser = await verifySession(readCookie(req, SESSION_COOKIE), env.SESSION_SECRET || "", env.ALLOWED_EMAILS);
  const apiKeyRoutes =
    (path === "/api/messages" && req.method === "GET") ||
    /^\/api\/messages\/[^/]+$/.test(path) && req.method === "GET" ||
    /^\/api\/messages\/[^/]+\/(read|star|summary|draft-reply)$/.test(path) && req.method === "POST" ||
    (path === "/api/messages/batch" && req.method === "POST") ||
    (path === "/api/search" && req.method === "GET") ||
    (path === "/api/send" && req.method === "POST") ||
    (path === "/api/threads" && req.method === "GET") ||
    /^\/api\/threads\/[^/]+$/.test(path) && req.method === "GET";
  const presentedApiKey = req.headers.get("X-Api-Key")?.trim() || "";
  const configuredApiKey = env.MAIL_API_KEY?.trim() || "";
  const validApiKey = apiKeyRoutes && configuredApiKey.length > 0 && presentedApiKey.length > 0 &&
    await safeEqual(presentedApiKey, configuredApiKey);
  const apiKeyOwner = (env.MAILBOX_ADDRESS || env.ALLOWED_EMAILS.split(",")[0] || "").trim().toLowerCase();
  const user = sessionUser || (validApiKey && apiKeyOwner ? apiKeyOwner : null);
  if (!user) return err("Not signed in", 401);

  // Resolve caller's mailboxes (user's own mailboxes + shared MAILBOX_ADDRESS)
  const callerMailboxes = await env.DB.prepare("SELECT address FROM mailboxes WHERE user_id = (SELECT id FROM users WHERE email = ?)")
    .bind(user)
    .all<{ address: string }>();
  const callerMailboxList = callerMailboxes.results
    ? callerMailboxes.results.map((r: any) => String(r.address).trim().toLowerCase()).filter(Boolean)
    : [];
  const sharedMailboxAddr = (env.MAILBOX_ADDRESS || "").trim().toLowerCase();
  if (sharedMailboxAddr && !callerMailboxList.includes(sharedMailboxAddr)) {
    callerMailboxList.push(sharedMailboxAddr);
  }
  // PHASE4-R7: append connected external Gmail accounts owned by this user (active/error still readable)
  const externalMailboxes = await env.DB.prepare(
    "SELECT email FROM external_accounts WHERE user_id = (SELECT id FROM users WHERE email = ?) AND provider = 'gmail' AND status IN ('active', 'error')",
  )
    .bind(user)
    .all<{ email: string }>();
  for (const row of externalMailboxes.results ?? []) {
    const addr = String(row.email).trim().toLowerCase();
    if (addr && !callerMailboxList.includes(addr)) callerMailboxList.push(addr);
  }

  if (path === "/api/session") {
    const sessionUserRow = await env.DB.prepare("SELECT role, status FROM users WHERE email = ?")
      .bind(user)
      .first<{ role?: string; status?: string }>()
      .catch(() => null);
    if (sessionUserRow?.status === "banned") {
      return err("account_banned", 401);
    }
    return json({
      email: user,
      mailbox: callerMailboxList.length > 0 ? callerMailboxList[0] : env.MAILBOX_ADDRESS,
      role: sessionUserRow?.role || "user",
    });
  }

  // PHASE4-R6: Admin panel routes
  const adminEnv = {
    DB: env.DB,
    R2: env.RAW,
    ALLOWED_EMAILS: env.ALLOWED_EMAILS,
    MAILBOX_ADDRESS: env.MAILBOX_ADDRESS,
  };
  const adminErr = (e: unknown): Response => {
    if (e instanceof AdminError) return json({ error: e.code, code: e.code }, e.status);
    throw e;
  };

  if (path === "/api/admin/stats" && req.method === "GET") {
    try {
      await requireAdmin(adminEnv, user);
      const stats = await getAdminStats(adminEnv);
      return json(stats);
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/users" && req.method === "GET") {
    try {
      await requireAdmin(adminEnv, user);
      const users = await listUsers(adminEnv);
      const mbRes = await env.DB.prepare("SELECT user_id, address FROM mailboxes ORDER BY is_primary DESC")
        .all<{ user_id: string; address: string }>()
        .catch(() => ({ results: [] as { user_id: string; address: string }[] }));
      const mbMap = new Map<string, string>();
      for (const mb of mbRes.results ?? []) {
        if (mb.user_id && !mbMap.has(mb.user_id)) mbMap.set(mb.user_id, mb.address);
      }
      return json({
        users: users.map((u) => ({
          ...u,
          mailbox: mbMap.get(u.id) ?? null,
        })),
      });
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/users/role" && req.method === "POST") {
    try {
      await requireSuperAdmin(adminEnv, user);
      const body = (await req.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
      if (!body || typeof body !== "object") return err("Invalid JSON body", 400);
      const email = typeof body.email === "string" ? body.email : "";
      const role = typeof body.role === "string" ? body.role : "";
      const result = await setUserRole(adminEnv, user, email, role);
      return json(result);
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/users/status" && req.method === "POST") {
    try {
      await requireAdmin(adminEnv, user);
      const body = (await req.json().catch(() => null)) as { email?: unknown; status?: unknown } | null;
      if (!body || typeof body !== "object") return err("Invalid JSON body", 400);
      const email = typeof body.email === "string" ? body.email : "";
      const status = typeof body.status === "string" ? body.status : "";
      const result = await setUserStatus(adminEnv, user, email, status);
      return json(result);
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/domains" && req.method === "GET") {
    try {
      await requireAdmin(adminEnv, user);
      const domains = await listDomains(adminEnv);
      const countRes = await env.DB.prepare("SELECT domain, COUNT(*) AS count FROM aliases GROUP BY domain")
        .all<{ domain: string; count: number }>()
        .catch(() => ({ results: [] as { domain: string; count: number }[] }));
      const countMap = new Map<string, number>();
      for (const row of countRes.results ?? []) {
        countMap.set(row.domain, Number(row.count ?? 0));
      }
      return json({
        domains: domains.map((d) => ({
          ...d,
          aliasCount: countMap.get(d.domain) ?? 0,
        })),
      });
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/domains/toggle" && req.method === "POST") {
    try {
      await requireAdmin(adminEnv, user);
      const body = (await req.json().catch(() => null)) as { domain?: unknown; enabled?: unknown } | null;
      if (!body || typeof body !== "object") return err("Invalid JSON body", 400);
      const domain = typeof body.domain === "string" ? body.domain : "";
      const enabled = body.enabled as boolean;
      const result = await toggleDomain(adminEnv, user, domain, enabled);
      return json(result);
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/aliases" && req.method === "GET") {
    try {
      await requireAdmin(adminEnv, user);
      const aliases = await listAliases(adminEnv);
      return json({ aliases });
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/aliases/toggle" && req.method === "POST") {
    try {
      await requireAdmin(adminEnv, user);
      const body = (await req.json().catch(() => null)) as { id?: unknown; enabled?: unknown } | null;
      if (!body || typeof body !== "object") return err("Invalid JSON body", 400);
      const id = typeof body.id === "string" ? body.id : "";
      const enabled = body.enabled as boolean;
      const result = await toggleAlias(adminEnv, user, id, enabled);
      return json(result);
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/mail-cleanup/preview" && req.method === "GET") {
    try {
      await requireAdmin(adminEnv, user);
      const folder = (url.searchParams.get("folder") || "").trim().toLowerCase();
      const rawDays = url.searchParams.get("olderThanDays");
      const olderThanDays = rawDays !== null && rawDays.trim() !== "" ? Number(rawDays) : NaN;
      const mailbox = (url.searchParams.get("mailbox") || "").trim() || undefined;
      if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
        return json({ error: "invalid_older_than_days", code: "invalid_older_than_days" }, 400);
      }
      const preview = await previewCleanup(adminEnv, { mailbox, folder, olderThanDays });
      return json(preview);
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/mail-cleanup" && req.method === "POST") {
    try {
      await requireAdmin(adminEnv, user);
      const body = (await req.json().catch(() => null)) as {
        mailbox?: unknown;
        folder?: unknown;
        olderThanDays?: unknown;
      } | null;
      if (!body || typeof body !== "object") return err("Invalid JSON body", 400);
      const folder = typeof body.folder === "string" ? body.folder.trim().toLowerCase() : "";
      const olderThanDays = typeof body.olderThanDays === "number" ? body.olderThanDays : NaN;
      const mailbox = typeof body.mailbox === "string" && body.mailbox.trim() ? body.mailbox.trim() : undefined;
      if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
        return json({ error: "invalid_older_than_days", code: "invalid_older_than_days" }, 400);
      }
      const result = await runCleanup(adminEnv, user, { mailbox, folder, olderThanDays });
      return json(result);
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/audit-logs" && req.method === "GET") {
    try {
      await requireAdmin(adminEnv, user);
      const action = (url.searchParams.get("action") || "").trim() || undefined;
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit !== null && rawLimit.trim() !== "" ? Number(rawLimit) : 50;
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, Math.floor(parsedLimit))) : 50;
      const rawBefore = url.searchParams.get("before");
      const parsedBefore = rawBefore !== null && rawBefore.trim() !== "" ? Number(rawBefore) : undefined;
      const before = parsedBefore !== undefined && Number.isFinite(parsedBefore) ? parsedBefore : undefined;
      const logs = await listAuditLogs(adminEnv, { action, limit, before });
      return json({ logs });
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/settings" && req.method === "GET") {
    try {
      await requireAdmin(adminEnv, user);
      const [settings, backup] = await Promise.all([
        getAdminSettings(adminEnv),
        getBackupSettings(env),
      ]);
      return json({
        allowedEmails: settings.allowedEmails,
        mailboxAddress: env.MAILBOX_ADDRESS || "",
        vapidConfigured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
        sendDailyCap: settings.sendDailyCap,
        storageQuotaMb: settings.storageQuotaMb,
        updatedAt: settings.updatedAt,
        backupEnabled: backup.backupEnabled,
        backupRetentionDays: backup.backupRetentionDays,
        backupSchedule: backup.backupSchedule,
        backupBucketConfigured: backup.backupBucketConfigured,
        lastBackupAt: backup.lastBackup ? backup.lastBackup.startedAt : null,
        lastBackupStatus: backup.lastBackup ? backup.lastBackup.status : null,
      });
    } catch (e) {
      if (e instanceof BackupError) return json({ error: e.code, code: e.code }, e.status);
      return adminErr(e);
    }
  }

  if (path === "/api/admin/settings" && req.method === "POST") {
    try {
      await requireSuperAdmin(adminEnv, user);
      const body = (await req.json().catch(() => null)) as {
        sendDailyCap?: unknown;
        storageQuotaMb?: unknown;
        backupEnabled?: unknown;
        backupRetentionDays?: unknown;
      } | null;
      if (!body || typeof body !== "object") return err("Invalid JSON body", 400);

      const hasSendDailyCap = body.sendDailyCap !== undefined;
      const hasStorageQuotaMb = body.storageQuotaMb !== undefined;
      const hasBackupEnabled = body.backupEnabled !== undefined;
      const hasBackupRetentionDays = body.backupRetentionDays !== undefined;

      if (!hasSendDailyCap && !hasStorageQuotaMb && !hasBackupEnabled && !hasBackupRetentionDays) {
        return err("Nothing to update", 400);
      }

      const settings = hasSendDailyCap || hasStorageQuotaMb
        ? await updateAdminSettings(adminEnv, user, { ...(hasSendDailyCap ? {sendDailyCap: body.sendDailyCap as number} : {}), ...(hasStorageQuotaMb ? {storageQuotaMb: body.storageQuotaMb as number} : {}) })
        : await getAdminSettings(adminEnv);

      let backup;
      if (hasBackupEnabled || hasBackupRetentionDays) {
        const backupInput: { backupEnabled?: boolean; backupRetentionDays?: number } = {};
        if (hasBackupEnabled) {
          if (typeof body.backupEnabled !== "boolean") {
            return json({ error: "invalid_input", code: "invalid_input" }, 400);
          }
          backupInput.backupEnabled = body.backupEnabled;
        }
        if (hasBackupRetentionDays) {
          backupInput.backupRetentionDays = body.backupRetentionDays as number;
        }
        backup = await updateBackupSettings(env, user, backupInput);
      } else {
        backup = await getBackupSettings(env);
      }

      return json({
        allowedEmails: settings.allowedEmails,
        mailboxAddress: env.MAILBOX_ADDRESS || "",
        vapidConfigured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
        sendDailyCap: settings.sendDailyCap,
        storageQuotaMb: settings.storageQuotaMb,
        updatedAt: settings.updatedAt,
        backupEnabled: backup.backupEnabled,
        backupRetentionDays: backup.backupRetentionDays,
        backupSchedule: backup.backupSchedule,
        backupBucketConfigured: backup.backupBucketConfigured,
        lastBackupAt: backup.lastBackup ? backup.lastBackup.startedAt : null,
        lastBackupStatus: backup.lastBackup ? backup.lastBackup.status : null,
      });
    } catch (e) {
      if (e instanceof BackupError) return json({ error: e.code, code: e.code }, e.status);
      return adminErr(e);
    }
  }

  // PHASE4-R8: Backup & Client Error routes
  if (path === "/api/admin/backups" && req.method === "GET") {
    try {
      await requireAdmin(adminEnv, user);
      const rawLimit = parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isNaN(rawLimit) ? 50 : rawLimit;
      const runs = await listBackupRuns(env, { limit });
      return json(runs);
    } catch (e) {
      if (e instanceof BackupError) return json({ error: e.code, code: e.code }, e.status);
      return adminErr(e);
    }
  }

  if (path === "/api/admin/backups/run" && req.method === "POST") {
    try {
      await requireSuperAdmin(adminEnv, user);
      const result = await runBackup(env, "manual", Date.now());
      return json(result);
    } catch (e) {
      if (e instanceof BackupError) return json({ error: e.code, code: e.code }, e.status);
      return adminErr(e);
    }
  }

  if (path === "/api/admin/backups/objects" && req.method === "GET") {
    try {
      await requireAdmin(adminEnv, user);
      const runId = url.searchParams.get("runId");
      if (!runId) return err("runId is required", 400);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const result = await listBackupObjects(env, runId, cursor);
      return json(result);
    } catch (e) {
      if (e instanceof BackupError) return json({ error: e.code, code: e.code }, e.status);
      return adminErr(e);
    }
  }

  if (path === "/api/admin/backups/download" && req.method === "GET") {
    try {
      await requireAdmin(adminEnv, user);
      const runId = url.searchParams.get("runId");
      const key = url.searchParams.get("key");
      if (!runId || !key) return err("runId and key are required", 400);
      const result = await downloadBackupObject(env, runId, key);
      const filename = (key.split("/").pop() || "backup").replace(/["\\\r\n]/g, "_");
      return new Response(result.body as BodyInit, {
        headers: {
          "Content-Type": result.contentType,
          "Content-Disposition": 'attachment; filename="' + filename + '"',
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      if (e instanceof BackupError) return json({ error: e.code, code: e.code }, e.status);
      return adminErr(e);
    }
  }

  if (path === "/api/client-errors" && req.method === "POST") {
    try {
      const rawText = await req.text();
      if (new TextEncoder().encode(rawText).byteLength > 16384) {
        return json({ error: "client_error_too_large", code: "client_error_too_large" }, 413);
      }
      let body: unknown;
      try {
        body = JSON.parse(rawText);
      } catch {
        return err("Invalid JSON body", 400);
      }
      const mailbox = callerMailboxList.length > 0 ? callerMailboxList[0] : user;
      const result = await reportClientError(adminEnv, mailbox, body);
      return json(result);
    } catch (e) {
      return adminErr(e);
    }
  }

  if (path === "/api/admin/client-errors" && req.method === "GET") {
    try {
      await requireAdmin(adminEnv, user);
      const rawLimit = parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isNaN(rawLimit) ? 50 : rawLimit;
      const entries = await listClientErrors(adminEnv, { limit });
      return json(entries);
    } catch (e) {
      if (e instanceof BackupError) return json({ error: e.code, code: e.code }, e.status);
      return adminErr(e);
    }
  }

  // PHASE4-R4: Notifications routes (browser push + Telegram)
  const notifyMailbox = callerMailboxList.length > 0 ? callerMailboxList[0] : sharedMailboxAddr;

  if (path === "/api/notifications/settings" && req.method === "GET") {
    if (!notifyMailbox) return err("Mailbox not found", 400);
    try {
      const settings = await getNotificationSettings(env.DB, notifyMailbox);
      return json({
        push_enabled: settings.pushEnabled,
        telegram_enabled: settings.telegramEnabled,
        telegram_chat_id: settings.telegramChatId,
        detail_level: settings.detailLevel,
      });
    } catch (e) {
      if (e instanceof NotificationError) return err(e.message, e.status);
      throw e;
    }
  }

  if (path === "/api/notifications/settings" && req.method === "POST") {
    if (!notifyMailbox) return err("Mailbox not found", 400);
    const body = (await req.json().catch(() => null)) as {
      push_enabled?: unknown;
      telegram_enabled?: unknown;
      telegram_chat_id?: unknown;
      detail_level?: unknown;
    } | null;
    if (!body || typeof body !== "object") return err("Invalid JSON body", 400);

    if (
      body.detail_level !== undefined &&
      body.detail_level !== "basic" &&
      body.detail_level !== "full"
    ) {
      return err('Invalid detail_level; must be "basic" or "full"', 400);
    }
    if (body.telegram_chat_id !== undefined && typeof body.telegram_chat_id !== "string") {
      return err("Invalid Telegram chat ID format", 400);
    }

    try {
      const current = await getNotificationSettings(env.DB, notifyMailbox);
      const nextTelegramEnabled =
        body.telegram_enabled !== undefined ? Boolean(body.telegram_enabled) : current.telegramEnabled;
      const nextTelegramChatId =
        body.telegram_chat_id !== undefined ? body.telegram_chat_id.trim() : current.telegramChatId;

      if (nextTelegramEnabled && !TELEGRAM_CHAT_ID_RE.test(nextTelegramChatId)) {
        return err("Invalid Telegram chat ID format", 400);
      }

      const updated = await updateNotificationSettings(env.DB, notifyMailbox, {
        pushEnabled: body.push_enabled !== undefined ? Boolean(body.push_enabled) : undefined,
        telegramEnabled:
          body.telegram_enabled !== undefined ? Boolean(body.telegram_enabled) : undefined,
        telegramChatId:
          body.telegram_chat_id !== undefined ? body.telegram_chat_id.trim() : undefined,
        detailLevel: body.detail_level as DetailLevel | undefined,
      });
      return json({
        push_enabled: updated.pushEnabled,
        telegram_enabled: updated.telegramEnabled,
        telegram_chat_id: updated.telegramChatId,
        detail_level: updated.detailLevel,
      });
    } catch (e) {
      if (e instanceof NotificationError) return err(e.message, e.status);
      throw e;
    }
  }

  if (path === "/api/notifications/push/vapid-key" && req.method === "GET") {
    const publicKey = (env.VAPID_PUBLIC_KEY || "").trim();
    if (!publicKey) {
      return json({ error: "vapid_not_configured", code: "vapid_not_configured" }, 503);
    }
    return json({ publicKey });
  }

  if (path === "/api/notifications/push/subscribe" && req.method === "POST") {
    if (!notifyMailbox) return err("Mailbox not found", 400);
    const body = (await req.json().catch(() => null)) as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    } | null;
    try {
      const valid = validatePushSubscriptionInput({
        endpoint: typeof body?.endpoint === "string" ? body.endpoint : "",
        p256dh: typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "",
        auth: typeof body?.keys?.auth === "string" ? body.keys.auth : "",
      });
      await env.DB.prepare(
        `INSERT OR REPLACE INTO push_subscriptions (id, mailbox_address, endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(crypto.randomUUID(), notifyMailbox, valid.endpoint, valid.p256dh, valid.auth, Date.now())
        .run();
      return json({ ok: true });
    } catch (e) {
      if (e instanceof PushError) {
        return json({ error: e.message, code: e.code }, e.status);
      }
      throw e;
    }
  }

  if (path === "/api/notifications/push/subscribe" && req.method === "DELETE") {
    if (!notifyMailbox) return err("Mailbox not found", 400);
    const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
    if (!endpoint) return err("Missing endpoint", 400);
    await env.DB.prepare(
      "DELETE FROM push_subscriptions WHERE mailbox_address = ? AND endpoint = ?"
    )
      .bind(notifyMailbox, endpoint)
      .run();
    return json({ ok: true });
  }

  if (path === "/api/notifications/test" && req.method === "POST") {
    if (!notifyMailbox) return err("Mailbox not found", 400);
    const body = (await req.json().catch(() => null)) as { channel?: unknown } | null;
    const channel = body?.channel;
    if (channel !== "push" && channel !== "telegram") {
      return err("Invalid channel", 400);
    }

    const nowMs = Date.now();
    const lastTestMs = testNotifyRateLimit.get(notifyMailbox) ?? 0;
    if (nowMs - lastTestMs < 60_000) {
      const retryAfter = Math.max(1, Math.ceil((60_000 - (nowMs - lastTestMs)) / 1000));
      return json(
        { error: "rate_limited", code: "rate_limited" },
        429,
        { "Retry-After": String(retryAfter) },
      );
    }

    const testMessage = "Đây là tin nhắn thử từ AI Stock VN Mail";

    if (channel === "push") {
      if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) {
        return json({ error: "push_not_configured", code: "push_not_configured" }, 503);
      }
      const subs = await listPushSubscriptions(env.DB, notifyMailbox);
      if (subs.length === 0) {
        return json({ error: "push_not_configured", code: "push_not_configured" }, 503);
      }
      testNotifyRateLimit.set(notifyMailbox, nowMs);
      let anySent = false;
      let lastErrorCode = "push_failed";
      for (const sub of subs) {
        try {
          const res = await sendPush(
            sub,
            { title: "AI Stock VN Mail", body: testMessage },
            env.VAPID_PUBLIC_KEY,
            env.VAPID_PRIVATE_KEY,
            { db: env.DB },
          );
          if (res.ok) anySent = true;
          else if (res.gone) lastErrorCode = "push_subscription_gone";
        } catch (e) {
          if (e instanceof PushError) lastErrorCode = e.code;
          else lastErrorCode = "push_failed";
        }
      }
      if (anySent) return json({ ok: true });
      return json({ error: lastErrorCode, code: lastErrorCode }, 502);
    }

    if (!env.TELEGRAM_BOT_TOKEN) {
      return json({ error: "telegram_not_configured", code: "telegram_not_configured" }, 503);
    }
    const settings = await getNotificationSettings(env.DB, notifyMailbox);
    if (!settings.telegramChatId) {
      return json({ error: "telegram_no_chat_id", code: "telegram_no_chat_id" }, 503);
    }
    testNotifyRateLimit.set(notifyMailbox, nowMs);
    try {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, settings.telegramChatId, testMessage);
      return json({ ok: true });
    } catch (e) {
      if (e instanceof TelegramError) {
        if (e.code === "telegram_forbidden") {
          return json({ error: "telegram_forbidden", code: "telegram_forbidden" }, 400);
        }
        return json({ error: e.code, code: e.code }, e.retryable ? 502 : 400);
      }
      throw e;
    }
  }

  if (path === "/api/search" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const folder = url.searchParams.get("folder") || "inbox";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100);

    if (!q) return err("Query is required", 400);

    const ftsQuery = buildFtsQuery(q);
    if (!ftsQuery) return json({ items: [], total: 0 });

    let where = "messages_fts MATCH ? AND m.folder = ?";
    const ftBinds: unknown[] = [ftsQuery, folder];
    if (callerMailboxList.length > 0) {
      where += ` AND m.mailbox_address IN (${callerMailboxList.map(() => "?").join(",")})`;
      ftBinds.push(...callerMailboxList);
    } else {
      where += " AND 1=0";
    }

    const countR = await env.DB.prepare(`SELECT COUNT(*) AS total FROM messages m JOIN messages_fts ON m.rowid = messages_fts.rowid WHERE ${where}`).bind(...ftBinds).first<{ total: number }>();
    const ftsTotal = countR?.total ?? 0;

    const { results } = await env.DB.prepare(`SELECT m.id, m.folder, m.from_addr, m.from_name, m.to_addrs, m.subject, m.snippet, m.date, m.is_read, m.is_focused, m.attachments, m.mailbox_address, m.source FROM messages m JOIN messages_fts ON m.rowid = messages_fts.rowid WHERE ${where} ORDER BY bm25(messages_fts) LIMIT ${limit + 1}`).bind(...ftBinds).all<Row>();
    const ftsItems = results.slice(0, limit).map(listItem);

    // Decrypt-match pass for encrypted rows
    let decryptCount = 0;
    let decryptItems: Row[] = [];
    // Build ftsIds set BEFORE the decrypt loop to avoid double-counting
    const ftsIds = new Set(ftsItems.map((r: Row) => r.id));
    if (q && callerMailboxList.length > 0) {
      const encBinds: unknown[] = [folder, ...callerMailboxList];
      const { results: encResults } = await env.DB.prepare(
        `SELECT id, folder, from_addr, from_name, to_addrs, subject, snippet, date, is_read, is_focused, attachments, text_body, mailbox_address, source
         FROM messages WHERE folder = ? AND text_body LIKE 'enc:v1:%' AND mailbox_address IN (${callerMailboxList.map(() => "?").join(",")})`,
      )
        .bind(...encBinds)
        .all<Row>();
      for (const row of encResults) {
        if (row.text_body && isEncrypted(row.text_body)) {
          try {
            const key = await getEncryptionKey(env);
            const decrypted = await decryptText(row.text_body, key);
            const decLower = decrypted.toLowerCase();

            // Skip rows whose id is already in ftsIds (avoid double-counting in total)
            if (ftsIds.has(row.id)) continue;

            // Tokenize q using buildFtsQuery logic
            const termQuery = buildFtsQuery(q);
            const terms: string[] = [];
            if (termQuery) {
              const tm = termQuery.match(/"([^"]+)"/g) || [];
              for (const m of tm) {
                terms.push(m.replace(/"/g, "").trim());
              }
            }

            // Also include subject and from fields in the token check
            const subjLower = (row.subject || "").toLowerCase();
            const fromLower = (row.from_addr || "").toLowerCase();

            const termMatches = terms.every((term) => {
              const termLower = term.toLowerCase();
              return (
                decLower.includes(termLower) ||
                subjLower.includes(termLower) ||
                fromLower.includes(termLower)
              );
            });

            if (termMatches) {
              decryptCount++;
              decryptItems.push(row as unknown as Row);
            }
          } catch {
            // skip rows that fail to decrypt
          }
        }
      }
    }
    // Sort: FTS results first (bm25 order), then decrypt-matches (date DESC)
    const ftsResults = ftsItems.map((r: Row) => r.id);
    const otherRows = decryptItems.filter((r: Row) => !ftsResults.includes(r.id));
    otherRows.sort((a: Row, b: Row) => b.date - a.date);
    const total = ftsTotal + decryptCount;
    const items = [...ftsItems, ...otherRows.map(listItem)].slice(0, limit);

    return json({ items, total });
  }

  // PHASE1-ALIASES
  const serializeAlias = (r: {
    id: string;
    local_part: string;
    domain: string;
    label: string;
    enabled: number;
    created_by: string;
    created_at: number;
  }): AliasRow & { address: string } => ({
    id: r.id,
    address: `${r.local_part}@${r.domain}`,
    localPart: r.local_part,
    domain: r.domain,
    label: r.label,
    enabled: r.enabled === 1,
    createdBy: r.created_by,
    createdAt: r.created_at,
  });

  if (path === "/api/domains" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT domain, enabled FROM domains ORDER BY domain ASC")
      .all<{ domain: string; enabled: number }>();
    return json({
      domains: (results || []).map((d) => ({ domain: d.domain, enabled: d.enabled === 1 })),
    });
  }

  if (path === "/api/domains" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { domain?: string };
    let domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
    if (!domain) return err("Domain is required", 400);
    if (domain.length > 253) return err("Domain must be at most 253 characters", 400);
    const domainRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    if (!domainRegex.test(domain)) return err("Invalid domain format", 400);
    await env.DB.prepare("INSERT OR IGNORE INTO domains (domain, enabled, created_at) VALUES (?, 1, ?)")
      .bind(domain, Math.floor(Date.now() / 1000)).run();
    const row = await env.DB.prepare("SELECT domain, enabled FROM domains WHERE domain = ?")
      .bind(domain)
      .first<{ domain: string; enabled: number }>();
    if (!row) {
      return err("Domain not found", 500);
    }
    return json({ domain: { domain: row.domain, enabled: row.enabled === 1 } });
  }

  if (path === "/api/aliases" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, local_part, domain, label, enabled, created_by, created_at FROM aliases ORDER BY created_at DESC",
    ).all<{
      id: string;
      local_part: string;
      domain: string;
      label: string;
      enabled: number;
      created_by: string;
      created_at: number;
    }>();
    return json({ aliases: (results || []).map(serializeAlias) });
  }

  if (path === "/api/aliases" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { label?: string; domain?: string };
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label || label.length > 100) return err("Label is required", 400);

    const defaultDomain = sharedMailboxAddr.includes("@") ? sharedMailboxAddr.split("@")[1] : "";
    const targetDomain = (typeof body.domain === "string" && body.domain.trim() ? body.domain.trim() : defaultDomain).toLowerCase();
    const domainRow = targetDomain ? await lookupDomain(env.DB, targetDomain) : null;
    if (!domainRow || !domainRow.enabled) return err("Domain is not available", 400);

    const createdAt = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = crypto.randomUUID();
      const localPart = generateAliasLocalPart(label);
      try {
        await env.DB.prepare(
          "INSERT INTO aliases (id, local_part, domain, label, enabled, created_by, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
          .bind(id, localPart, targetDomain, label, user, createdAt)
          .run();
        return json(
          {
            alias: {
              id,
              address: `${localPart}@${targetDomain}`,
              localPart,
              domain: targetDomain,
              label,
              enabled: true,
              createdBy: user,
              createdAt,
            },
          },
          201,
        );
      } catch (e) {
        if (!String((e as Error)?.message || e).includes("UNIQUE")) throw e;
      }
    }
    return err("Could not generate a unique alias", 500);
  }

  if (
    req.method === "POST" &&
    url.pathname.startsWith("/api/aliases/") &&
    (url.pathname.endsWith("/disable") || url.pathname.endsWith("/enable"))
  ) {
    const isEnable = url.pathname.endsWith("/enable");
    const suffixLen = isEnable ? "/enable".length : "/disable".length;
    const aliasId = url.pathname.slice("/api/aliases/".length, url.pathname.length - suffixLen);
    if (!aliasId || aliasId.includes("/")) return err("Alias not found", 404);
    const res = await env.DB.prepare("UPDATE aliases SET enabled = ? WHERE id = ?")
      .bind(isEnable ? 1 : 0, aliasId)
      .run();
    if (!res.meta?.changes) return err("Alias not found", 404);
    const row = await env.DB.prepare(
      "SELECT id, local_part, domain, label, enabled, created_by, created_at FROM aliases WHERE id = ?",
    )
      .bind(aliasId)
      .first<{
        id: string;
        local_part: string;
        domain: string;
        label: string;
        enabled: number;
        created_by: string;
        created_at: number;
      }>();
    if (!row) return err("Alias not found", 404);
    return json({ alias: serializeAlias(row) });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/aliases/")) {
    const aliasId = url.pathname.slice("/api/aliases/".length);
    if (!aliasId || aliasId.includes("/")) return err("Alias not found", 404);
    const res = await env.DB.prepare("DELETE FROM aliases WHERE id = ?").bind(aliasId).run();
    if (!res.meta?.changes) return err("Alias not found", 404);
    return json({ ok: true });
  }

  if (
    req.method === "POST" &&
    url.pathname.startsWith("/api/domains/") &&
    (url.pathname.endsWith("/enable") || url.pathname.endsWith("/disable"))
  ) {
    const isEnable = url.pathname.endsWith("/enable");
    const domain = url.pathname.slice("/api/domains/".length, url.pathname.length - (isEnable ? "/enable".length : "/disable".length));
    if (!domain || domain.includes("/")) return err("Domain not found", 404);
    const res = await env.DB.prepare("UPDATE domains SET enabled = ? WHERE domain = ?")
      .bind(isEnable ? 1 : 0, domain).run();
    if (!res.meta?.changes) return err("Domain not found", 404);
    const row = await env.DB.prepare("SELECT domain, enabled FROM domains WHERE domain = ?")
      .bind(domain)
      .first<{ domain: string; enabled: number }>();
    if (!row) return err("Domain not found", 404);
    return json({ domain: { domain: row.domain, enabled: row.enabled === 1 } });
  }

  if (path === "/api/messages" && req.method === "GET") {
    const rawFolder = url.searchParams.get("folder") || "inbox";
    const allowlist = ["inbox", "sent", "spam"];
    const folder = allowlist.includes(rawFolder) ? rawFolder : "inbox";
    const q = (url.searchParams.get("q") || "").trim();
    const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100);
    const tab = url.searchParams.get("tab");
    // PHASE4-R2: starred=1 lists the caller's starred mail across every folder.
    const starredOnly = url.searchParams.get("starred") === "1";
    if (starredOnly) {
      const starredRows = await listStarred(env.DB, callerMailboxList, before, limit);
      const starredItems = starredRows.slice(0, limit).map(listItem);
      const nextBefore =
        starredRows.length > limit ? starredItems[starredItems.length - 1]?.date ?? null : null;
      return json({ items: starredItems, nextBefore });
    }
    const binds: unknown[] = [folder, before];
    let where = "folder = ? AND date < ?";
    if (callerMailboxList.length > 0) {
      where += ` AND mailbox_address IN (${callerMailboxList.map(() => "?").join(",")})`;
      binds.push(...callerMailboxList);
    } else {
      where += " AND 1=0";
    }
    if (tab && folder === "inbox") {
      if (tab === "focused") {
        where += ` AND is_focused = 1`;
      } else if (tab === "other") {
        where += ` AND is_focused = 0`;
      }
    }
    let sqlWhere = `folder = ? AND date < ?`;
    const sqlBinds: unknown[] = [folder, before];
    if (callerMailboxList.length > 0) {
      sqlWhere += ` AND mailbox_address IN (${callerMailboxList.map(() => "?").join(",")})`;
      sqlBinds.push(...callerMailboxList);
    } else {
      sqlWhere += " AND 1=0";
    }
    if (tab && folder === "inbox") {
      if (tab === "focused") {
        sqlWhere += ` AND is_focused = 1`;
      } else if (tab === "other") {
        sqlWhere += ` AND is_focused = 0`;
      }
    }
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      sqlWhere += ` AND (subject LIKE ?${3 + callerMailboxList.length} ESCAPE '\\' OR from_addr LIKE ?${3 + callerMailboxList.length} ESCAPE '\\' OR from_name LIKE ?${3 + callerMailboxList.length} ESCAPE '\\'
        OR to_addrs LIKE ?${3 + callerMailboxList.length} ESCAPE '\\')`;
      sqlBinds.push(like);
    }
    const { results } = await env.DB.prepare(
      `SELECT id, folder, from_addr, from_name, to_addrs, subject, snippet, date, is_read, is_focused, is_starred, attachments, mailbox_address, source
       FROM messages WHERE ${sqlWhere} ORDER BY date DESC LIMIT ${limit + 1}`,
    )
      .bind(...sqlBinds)
      .all<Row>();
    const sqlIds = new Set(results.map((r: Row) => r.id));
    const sqlItems = results.slice(0, limit).map(listItem);

    // Decrypt-match pass for encrypted rows
    let decryptItems: Row[] = [];
    if (q && callerMailboxList.length > 0) {
      const encBinds: unknown[] = [folder, before, ...callerMailboxList];
      const { results: encResults } = await env.DB.prepare(
        `SELECT id, folder, from_addr, from_name, to_addrs, subject, snippet, date, is_read, is_focused, is_starred, attachments, text_body
         FROM messages WHERE folder = ? AND date < ? AND text_body LIKE 'enc:v1:%' AND mailbox_address IN (${callerMailboxList.map(() => "?").join(",")})`,
      )
        .bind(...encBinds)
        .all<Row>();
      for (const row of encResults) {
        if (row.text_body && isEncrypted(row.text_body)) {
          try {
            const key = await getEncryptionKey(env);
            const decrypted = await decryptText(row.text_body, key);
            if (decrypted.toLowerCase().includes(q.toLowerCase())) {
              decryptItems.push(row as unknown as Row);
            }
          } catch {
            // skip rows that fail to decrypt
          }
        }
      }
    }

    // Merge: keep SQL items, add decrypt items not already in SQL, dedupe by id
    const mergedRows: Row[] = [...results];
    for (const d of decryptItems) {
      if (!sqlIds.has(d.id)) {
        mergedRows.push(d);
        sqlIds.add(d.id);
      }
    }
    // Sort all merged by date DESC
    mergedRows.sort((a: Row, b: Row) => b.date - a.date);
    const mergedItems = mergedRows.slice(0, limit).map(listItem);
    const nextBefore = mergedRows.length > limit ? mergedItems[limit - 1].date : null;
    return json({ items: mergedItems, nextBefore });
  }

  // PHASE4-R2: GET /api/threads — one row per conversation, newest activity first
  if (path === "/api/threads" && req.method === "GET") {
    const rawFolder = url.searchParams.get("folder") || "inbox";
    const allowlist = ["inbox", "sent", "spam"];
    const folder = allowlist.includes(rawFolder) ? rawFolder : "inbox";
    const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100);
    try {
      const threads = await listThreads(env.DB, callerMailboxList, folder, before, limit);
      return json({ threads });
    } catch (e) {
      if (e instanceof ThreadsError) return err(e.message, e.status);
      throw e;
    }
  }

  // PHASE4-R2: GET /api/threads/:key — every message of one thread, oldest first
  const threadMatch = path.match(/^\/api\/threads\/([^/]+)$/);
  if (threadMatch && req.method === "GET") {
    let threadKey = threadMatch[1];
    try {
      threadKey = decodeURIComponent(threadMatch[1]);
    } catch {
      // keep the raw (possibly encoded) key
    }
    try {
      const rows = await getThread(env.DB, callerMailboxList, threadKey);
      if (rows.length === 0) return err("Thread not found", 404);
      const messages: Row[] = [];
      for (const row of rows as ThreadMessageRow[]) {
        let text: string = row.text_body ?? "";
        let html: string | null = row.html_body ?? null;
        if (isEncrypted(text)) {
          try {
            text = await decryptText(text, await getEncryptionKey(env));
          } catch {
            // keep the stored body if decryption fails
          }
        }
        if (html !== null && isEncrypted(html)) {
          try {
            html = await decryptText(html, await getEncryptionKey(env));
          } catch {
            // keep the stored body if decryption fails
          }
        }
        messages.push({
          id: row.id,
          folder: row.folder,
          date: row.date,
          from: { address: row.from_addr, name: row.from_name },
          to: JSON.parse(row.to_addrs || "[]"),
          cc: JSON.parse(row.cc_addrs || "[]"),
          subject: row.subject,
          snippet: row.snippet,
          isRead: !!row.is_read,
          isStarred: !!row.is_starred,
          hasAttachments: row.attachments !== "[]",
          messageId: row.message_id,
          inReplyTo: row.in_reply_to,
          references: row.references_hdr,
          text,
          html,
          attachments: JSON.parse(row.attachments || "[]"),
        });
      }
      return json({ messages });
    } catch (e) {
      if (e instanceof ThreadsError) return err(e.message, e.status);
      throw e;
    }
  }

  if (path === "/api/counts") {
    const where = callerMailboxList.length > 0 ? `mailbox_address IN (${callerMailboxList.map(() => "?").join(",")}) AND ` : "1=0 AND ";
    const binds: unknown[] = callerMailboxList.length > 0 ? callerMailboxList : [];
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}folder='inbox' AND is_read=0`)
      .bind(...binds)
      .first<{ n: number }>();
    return json({ unread: r?.n ?? 0 });
  }

  if (path === "/api/counts") {
    const where = callerMailboxList.length > 0 ? `mailbox_address IN (${callerMailboxList.map(() => "?").join(",")}) AND ` : "1=0 AND ";
    const binds: unknown[] = callerMailboxList.length > 0 ? callerMailboxList : [];
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}folder='inbox' AND is_read=0`)
      .bind(...binds)
      .first<{ n: number }>();
    return json({ unread: r?.n ?? 0 });
  }

  // PHASE4-R2: POST /api/messages/:id/star — toggle the starred flag
  const starMatch = path.match(/^\/api\/messages\/([^/]+)\/star$/);
  if (starMatch && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { starred?: unknown };
    let messageId = starMatch[1];
    try {
      messageId = decodeURIComponent(starMatch[1]);
    } catch {
      // keep the raw (possibly encoded) id
    }
    try {
      const result = await setStarred(env.DB, callerMailboxList, messageId, body.starred === true);
      return json(result);
    } catch (e) {
      if (e instanceof StarredError) return err(e.message, e.status);
      throw e;
    }
  }

  // PHASE4-R2: POST /api/messages/batch — read/unread/star/unstar/spam, max 50 ids
  if (path === "/api/messages/batch" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { ids?: unknown; action?: unknown };
    try {
      const result = await applyBatch(env.DB, callerMailboxList, body.ids, body.action);
      return json(result);
    } catch (e) {
      if (e instanceof BatchError) return err(e.message, e.status);
      throw e;
    }
  }

  if (path.startsWith("/api/messages/") && req.method === "POST") {
    const match = path.match(/^\/api\/messages\/([^/]+)\/(summary|draft-reply)$/);
    if (!match) return err("Not found", 404);
    const messageId = match[1];
    const action = match[2];

    const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId).first<Row>();
    if (!row) return err("Message not found", 404);

    const msgMailbox = typeof row.mailbox_address === "string" ? row.mailbox_address.toLowerCase() : null;
    if (callerMailboxList.length === 0 || !msgMailbox || !callerMailboxList.includes(msgMailbox)) {
      return err("Message not found", 404);
    }

    let text: string = row.text_body;
    if (row.folder === "inbox" && row.raw_key) {
      try {
        const obj = await env.RAW.get(row.raw_key);
        if (obj) {
          const email = await PostalMime.parse(await obj.arrayBuffer());
          text = email.text || text;
        }
      } catch {
        // continue with D1 text_body if R2 fetch fails
      }
    }
    if (isEncrypted(text)) {
      try {
        const key = await getEncryptionKey(env);
        text = await decryptText(text, key);
      } catch {
        // if decryption fails, use original text_body
      }
    }

    if (action === "summary") {
      try {
        const summary = await summarizeText(env, text);
        return json({ summary });
      } catch (e) {
        return err((e as Error).message || "AI is temporarily unavailable, please try again later", 503);
      }
    }

    if (action === "draft-reply") {
      try {
        const { subject } = row;
        const draft = await draftReply(env, { subject: subject || "", from: row.from_addr || "", text });
        return json({ draft });
      } catch (e) {
        return err((e as Error).message || "AI is temporarily unavailable, please try again later", 503);
      }
    }

    return err("Unknown action", 404);
  }

  // ... rest of existing routes (messages show, send, etc.)
  // Keep the existing routes exactly as they were before
  const m = path.match(/^\/api\/messages\/([0-9a-f-]{36})(?:\/(read|attachments\/(\d+)))?$/);
  if (m) {
    const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(m[1]).first<Row>();
    if (!row) return err("Message not found", 404);
    const msgMailbox = typeof row.mailbox_address === "string" ? row.mailbox_address.toLowerCase() : null;
    if (callerMailboxList.length === 0 || !msgMailbox || !callerMailboxList.includes(msgMailbox)) {
      return err("Message not found", 404);
    }

    if (m[2] === "read" && req.method === "POST") {
      const { read } = (await req.json().catch(() => ({}))) as { read?: boolean };
      await env.DB.prepare("UPDATE messages SET is_read = ? WHERE id = ?").bind(read === false ? 0 : 1, row.id).run();
      return json({ ok: true });
    }

    if (m[3] !== undefined && req.method === "GET") {
      const attachmentIndex = Number(m[3]);
      const metadata = JSON.parse(row.attachments || "[]") as AttachmentMeta[];
      const meta = metadata.find((attachment) => attachment.index === attachmentIndex) ?? metadata[attachmentIndex];
      if (metadata.length > 0 && attachmentIndex >= metadata.length && !metadata.some((attachment) => attachment.index === attachmentIndex)) {
        return err("File not found", 404);
      }
      if (meta?.key) {
        const bytes = await loadAttachment(env, meta.key);
        const name = (meta.filename || `tep-${attachmentIndex + 1}`).replace(/["\r\n]/g, "");
        return new Response(bytes, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
          },
        });
      }
      if (!row.raw_key) return err("No attachment", 404);
      const obj = await env.RAW.get(row.raw_key);
      if (!obj) return err("Original message missing", 404);
      const email = await PostalMime.parse(await obj.arrayBuffer());
      const a = email.attachments[Number(m[3])];
      if (!a) return err("File not found", 404);
      const name = (a.filename || `tep-${Number(m[3]) + 1}`).replace(/["\r\n]/g, "");
      return new Response(a.content as BodyInit, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        },
      });
    }

    if (!m[2] && req.method === "GET") {
      let html: string | null = row.html_body;
      let text: string = row.text_body;
      if (row.folder === "inbox" && row.raw_key) {
        const obj = await env.RAW.get(row.raw_key);
        if (obj) {
          const email = await PostalMime.parse(await obj.arrayBuffer());
          html = email.html ? inlineCidImages(email.html, email) : null;
          text = email.text || text;
        }
      }
      // Lazy decryption: only decrypt if encrypted, without requiring key for legacy plaintext
      if (isEncrypted(text)) {
        const key = await getEncryptionKey(env);
        text = await decryptText(text, key);
      }
      if (html !== null && isEncrypted(html)) {
        const key = await getEncryptionKey(env);
        html = await decryptText(html, key);
      }
      if (!row.is_read) await env.DB.prepare("UPDATE messages SET is_read = 1 WHERE id = ?").bind(row.id).run();
      return json({
        ...listItem({ ...row, is_read: 1 }),
        cc: JSON.parse(row.cc_addrs),
        replyTo: row.reply_to ? JSON.parse(row.reply_to) : [],
        messageId: row.message_id,
        references: row.references_hdr,
        text,
        html,
        attachments: (JSON.parse(row.attachments) as AttachmentMeta[]).filter((a) => !a.inline),
      });
    }
  }

  // GET /api/drafts
  if (path === '/api/drafts' && req.method === 'GET') {
    try {
      const drafts = await listDrafts(env.DB, callerMailboxList);
      return json({ drafts });
    } catch (e) {
      if (e instanceof DraftError) return err(e.message, e.status);
      return err('Failed to load drafts', 500);
    }
  }

  // POST /api/drafts
  if (path === '/api/drafts' && req.method === 'POST') {
    let body: DraftUpsertInput;
    try {
      body = (await req.json()) as DraftUpsertInput;
    } catch {
      return err('Invalid JSON body', 400);
    }

    try {
      const draft = await upsertDraft(
        env.DB,
        user,
        callerMailboxList,
        body
      );
      return json({ draft }, 200);
    } catch (e) {
      if (e instanceof DraftError) {
        return err(e.message, e.status);
      }
      return err('Failed to save draft', 500);
    }
  }

  // GET /api/drafts/:id and DELETE /api/drafts/:id
  const draftMatch = path.match(/^\/api\/drafts\/([^/]+)$/);
  if (draftMatch) {
    const draftId = decodeURIComponent(draftMatch[1]);

    if (req.method === 'GET') {
      const draft = await getDraft(env.DB, draftId, callerMailboxList);
      if (!draft) {
        return err('Draft not found', 404);
      }
      return json({ draft });
    }

    if (req.method === 'DELETE') {
      const deleted = await deleteDraft(env.DB, draftId, callerMailboxList);
      if (!deleted) {
        return err('Draft not found', 404);
      }
      return json({ ok: true });
    }
  }

  if (path === "/api/send" && req.method === "POST") {
    let encryptionKey: CryptoKey;
    try {
      encryptionKey = await getEncryptionKey(env);
    } catch {
      return err("ENCRYPTION_KEY is not configured on the server", 503);
    }
    const sharedMailbox = (env.MAILBOX_ADDRESS || "").trim().toLowerCase();
    if (!sharedMailbox) return err("MAILBOX_ADDRESS is not configured on the server", 503);
const body = (await req.json().catch(() => ({}))) as {
      from?: string;
      to?: string;
      cc?: string;
      subject?: string;
      text?: string;
      replyToId?: string;
      clientId?: string;
      draftId?: string;
      attachments?: { key: string; filename: string; size: number; mimeType: string }[];
    };
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (attachments.reduce((sum, item) => sum + Number(item.size || 0), 0) > MAX_ATTACHMENT_BYTES) return err("Attachments exceed the 25 MB per email limit.", 413);
    for (const item of attachments) {
      const bad = validateAttachmentName(item.filename || "");
      if (bad) return err(bad, 400);
    }
    let to: string[], cc: string[];
    try {
      to = parseRecipients(body.to);
      cc = parseRecipients(body.cc);
    } catch (e) {
      return err((e as Error).message, 400);
    }
    if (!to.length) return err("At least one recipient is required", 400);

    // PHASE1-ALIASES
    let fromAddr = sharedMailbox;
    if (typeof body.from === "string" && body.from.trim()) {
      const normalizedFrom = body.from.trim().toLowerCase();
      if (normalizedFrom !== sharedMailbox) {
        const parsedFrom = parseAliasAddress(normalizedFrom);
        const aliasRow = parsedFrom ? await lookupAlias(env.DB, parsedFrom.localPart, parsedFrom.domain) : null;
        const domainRow = aliasRow && aliasRow.enabled ? await lookupDomain(env.DB, aliasRow.domain) : null;
        if (!aliasRow || !aliasRow.enabled || !domainRow || !domainRow.enabled) {
          return err("From address is not one of your enabled aliases", 400);
        }
        fromAddr = `${aliasRow.localPart}@${aliasRow.domain}`;
      }
    }
    const provider = pickProvider(fromAddr.slice(fromAddr.lastIndexOf("@") + 1).toLowerCase());
    if (provider === "resend" && !env.RESEND_API_KEY) return err("RESEND_API_KEY is not configured on the server", 503);
    if (provider === "senddev" && !env.SENDDEV_API_KEY) return err("SENDDEV_API_KEY is not configured on the server", 503);

    const subject = (body.subject || "").trim();
    const text = body.text || "";
    if (!subject && !text.trim()) return err("Empty message", 400);
    if (provider === "senddev" && to.length + cc.length > 5) return err("send.dev supports at most 5 recipients across To and Cc.", 400);

    // PHASE4-R6: daily send rate limit (best-effort settings read; defaults to 200)
    let sendDailyCap = 200;
    try {
      const adminSettings = await getAdminSettings(adminEnv);
      sendDailyCap = adminSettings.sendDailyCap;
    } catch {
      sendDailyCap = 200;
    }
    let sentToday = 0;
    try {
      sentToday = await countSentToday(adminEnv, sharedMailbox);
    } catch {
      sentToday = 0;
    }
    if (sentToday >= sendDailyCap) {
      return err("send_rate_limited", 429);
    }

    const headers: Record<string, string> = {};
    if (body.replyToId) {
      const origWhere = callerMailboxList.length > 0
        ? `id = ? AND mailbox_address IN (${callerMailboxList.map(() => "?").join(",")})`
        : "id = ? AND 1=0";
      const origBinds: unknown[] = callerMailboxList.length > 0 ? [body.replyToId, ...callerMailboxList] : [body.replyToId];
      const orig = await env.DB.prepare(`SELECT message_id, references_hdr FROM messages WHERE ${origWhere}`)
        .bind(...origBinds)
        .first<Row>();
      if (orig?.message_id) {
        headers["In-Reply-To"] = orig.message_id;
        headers["References"] = [orig.references_hdr, orig.message_id].filter(Boolean).join(" ");
      }
    }
    const from = `${env.FROM_NAME} <${fromAddr}>`;
    let loadedAttachments: { filename: string; mimeType: string; base64: string }[] | undefined;
    try {
      if (attachments.length) {
        loadedAttachments = [];
        let actualAttachmentBytes = 0;
        for (const attachment of attachments) {
          const bytes = await loadAttachment(env, attachment.key);
          if (bytes.byteLength !== attachment.size) return err("Attachment size did not match uploaded file.", 400);
          actualAttachmentBytes += bytes.byteLength;
          if (actualAttachmentBytes > MAX_ATTACHMENT_BYTES) return err("Attachments exceed the 25 MB per email limit.", 413);
          let binary = "";
          const data = new Uint8Array(bytes);
          for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
          loadedAttachments.push({ filename: attachment.filename, mimeType: attachment.mimeType || "application/octet-stream", base64: btoa(binary) });
        }
      }
    } catch (e) { return err((e as Error).message || "Failed to read attachment from storage.", 400); }
    let sendUrl: string;
    let sendHeaders: Record<string, string>;
    let sendPayload: Record<string, unknown>;
    if (provider === "senddev") {
      sendUrl = "https://api.do.dev/v1/send/emails/send";
      sendHeaders = { Authorization: `Bearer ${env.SENDDEV_API_KEY}`, "Content-Type": "application/json" };
      sendPayload = {
        from: { email: fromAddr, name: env.FROM_NAME }, to, ...(cc.length ? { cc } : {}), subject: subject || "(No subject)", text, html: textToHtml(text),
        ...(loadedAttachments ? { attachments: loadedAttachments.map((a) => ({ filename: a.filename, contentType: a.mimeType, content: a.base64 })) } : {}),
      };
      if (new TextEncoder().encode(JSON.stringify(sendPayload)).byteLength >= 241664) return err("Attachments are too large for send.dev (about 170 KB per email); send large files from aistockvn.com.", 400);
    } else {
      sendUrl = "https://api.resend.com/emails";
      sendHeaders = { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", ...(body.clientId ? { "Idempotency-Key": body.clientId.slice(0, 256) } : {}) };
      sendPayload = {
        from, to, cc: cc.length ? cc : undefined, subject: subject || "(No subject)", text, html: textToHtml(text),
        headers: Object.keys(headers).length ? headers : undefined,
        ...(loadedAttachments ? { attachments: loadedAttachments.map((a) => ({ filename: a.filename, content: a.base64, content_type: a.mimeType })) } : {}),
      };
    }
    const res = await fetch(sendUrl, { method: "POST", headers: sendHeaders, body: JSON.stringify(sendPayload) });
    const out = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    const providerId = out.id || null;
    if (!res.ok || !providerId) {
      try {
        await logAdminAction(adminEnv, fromAddr, "send_failed", to[0] || "", String(res.status));
      } catch {
        // best-effort audit write; never alter the 502 response
      }
      const providerName = provider === "senddev" ? "send.dev" : "Resend";
      return err(`${providerName} rejected (${res.status}): ${out.message || "unknown"}`, 502);
    }

    if (body.draftId && body.draftId.trim().length > 0) {
      await deleteDraft(env.DB, body.draftId.trim(), callerMailboxList);
    }

    const id = crypto.randomUUID();
    const encryptedText = await encryptText(text, encryptionKey);
    await env.DB.prepare(
      `INSERT INTO messages (id, folder, mailbox_address, in_reply_to, references_hdr, from_addr, from_name, to_addrs, cc_addrs,
        subject, snippet, text_body, html_body, date, is_read, resend_id, attachments)
       VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        id,
        sharedMailbox,
        headers["In-Reply-To"] || null,
        headers["References"] || null,
        fromAddr,
        env.FROM_NAME,
        JSON.stringify(to.map((address) => ({ address, name: "" }))),
        JSON.stringify(cc.map((address) => ({ address, name: "" }))),
        subject || "(No subject)",
        makeSnippet(text),
        encryptedText,
        null,
        Date.now(),
        providerId,
        JSON.stringify(attachments.map((a, index) => ({ index, filename: a.filename, mimeType: a.mimeType, size: a.size, inline: false, key: a.key }))),
      )
      .run();
    return json({ id, resendId: providerId });
  }

  if (path === "/api/attachments/upload" && req.method === "POST") {
    if (!env.B2_KEY_ID || !env.B2_APPLICATION_KEY) return err("Attachment storage is not configured. You can still send without attachments.", 503);
    try {
      const form = await req.formData();
      const files = form.getAll("files").filter((item): item is File => item instanceof File);
      if (!files.length) return err("Choose at least one file to attach.", 400);
      return json({ attachments: await uploadAttachments(env, files) });
    } catch (e) {
      const message = (e as Error).message || "Attachment upload failed.";
      const status = message.includes("25 MB") ? 413 : message.includes("not allowed") || message.includes("unsafe") ? 400 : message.includes("usage") ? 507 : 502;
      return err(message, status);
    }
  }

  // PHASE4-R7: external Gmail accounts (session-scoped, owner-only)
  if (path === "/api/external/accounts" && req.method === "GET") {
    try {
      const accounts = await listExternalAccounts(env, user);
      return json({ accounts });
    } catch (e) {
      if (e instanceof GmailError) return json({ error: e.code, code: e.code, message: e.message }, e.status);
      throw e;
    }
  }

  if (path === "/api/external/gmail/connect" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      email?: unknown;
      appPassword?: unknown;
    } | null;
    const email = typeof body?.email === "string" ? body.email : "";
    const appPassword = typeof body?.appPassword === "string" ? body.appPassword : "";
    if (!email.trim() || !appPassword) return err("email and appPassword are required", 400);
    try {
      const account = await connectGmailAccount(env, user, email, appPassword);
      return json({ account });
    } catch (e) {
      if (e instanceof GmailError) return json({ error: e.code, code: e.code, message: e.message }, e.status);
      throw e;
    }
  }

  if (path === "/api/external/gmail/disconnect" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { accountId?: unknown } | null;
    const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
    if (!accountId) return err("accountId is required", 400);
    try {
      const account = await disconnectGmailAccount(env, user, accountId);
      return json({ account });
    } catch (e) {
      if (e instanceof GmailError) return json({ error: e.code, code: e.code, message: e.message }, e.status);
      throw e;
    }
  }

  if (path === "/api/external/gmail/sync" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { accountId?: unknown } | null;
    const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
    if (!accountId) return err("accountId is required", 400);
    try {
      const owned = await env.DB.prepare(
        "SELECT id FROM external_accounts WHERE id = ? AND user_id = (SELECT id FROM users WHERE email = ?)",
      )
        .bind(accountId, user)
        .first<{ id: string }>();
      if (!owned) return json({ error: "account_not_found", code: "account_not_found" }, 404);
      const result = await syncGmailAccount(env, accountId, Date.now());
      return json(result);
    } catch (e) {
      if (e instanceof GmailError) return json({ error: e.code, code: e.code, message: e.message }, e.status);
      throw e;
    }
  }

  return err("Not found", 404);
}

// PHASE4-R8: daily backup trigger from the main Worker's */5 cron.
// Free plan has no scheduled Workflows, so the cron handler triggers it.
const VN_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 86_400_000;

type BackupWorkflowBinding = {
  create(options?: { id?: string; params?: unknown }): Promise<unknown>;
};

/**
 * True when nowMs falls in the 20:00-20:04 UTC window (03:00-03:04 VN time).
 * Main worker cron runs every 5 minutes (minute 0, 5, 10, ...), so only
 * minute 0 lands inside this window.
 */
export function isBackupWindow(nowMs: number): boolean {
  const d = new Date(nowMs);
  return d.getUTCHours() === 20 && d.getUTCMinutes() >= 0 && d.getUTCMinutes() <= 4;
}

/**
 * Epoch ms for 00:00:00.000 of the current Vietnam day (UTC+7).
 */
export function vnDayStartMs(nowMs: number): number {
  const vnMs = nowMs + VN_OFFSET_MS;
  return Math.floor(vnMs / DAY_MS) * DAY_MS - VN_OFFSET_MS;
}

/**
 * Trigger the backup Workflow once per Vietnam day during the 20:00-20:04 UTC
 * window. Returns true if a new Workflow run was created, false otherwise.
 * Dedup (ii): check backup_runs for any run already started in the current
 * VN day before calling BACKUP_WORKFLOW.create().
 */
export async function maybeTriggerScheduledBackup(env: Env, nowMs: number): Promise<boolean> {
  if (!isBackupWindow(nowMs)) {
    return false;
  }

  const backupEnv = env as Env & { BACKUP_WORKFLOW?: BackupWorkflowBinding };
  if (!backupEnv.BACKUP_WORKFLOW) {
    return false;
  }

  const dayStart = vnDayStartMs(nowMs);
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM backup_runs WHERE started_at >= ?",
  )
    .bind(dayStart)
    .first<{ count: number }>();

  if ((row?.count ?? 0) > 0) {
    return false;
  }

  await backupEnv.BACKUP_WORKFLOW.create();
  return true;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url);
      } catch (e) {
        logEvent(env, "api_unhandled_error", { path: url.pathname });
        return err("Server error", 500);
      }
    }
    return env.ASSETS.fetch(req);
  },

  // PHASE4-R7: periodic external Gmail sync (max 20 accounts per run; one bad account must not kill the rest)
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const { results } = await env.DB.prepare(
        "SELECT id FROM external_accounts WHERE status = 'active' ORDER BY created_at ASC LIMIT 20",
      ).all<{ id: string }>();
      for (const account of results ?? []) {
        ctx.waitUntil(
          (async () => {
            try {
              await syncGmailAccount(env, account.id, Date.now());
            } catch (e) {
              // Bound the error text: a raw error object could serialize
              // large (e.g. a Gmail API error payload) into Workers Logs.
              console.error("external sync failed", account.id, safeLogText(e instanceof Error ? e.message : String(e)));
            }
          })(),
        );
      }
    } catch (e) {
      console.error("external sync scheduler failed", safeLogText(e instanceof Error ? e.message : String(e)));
    }
    // PHASE4-R8: trigger daily backup Workflow from */5 cron (Free plan has no Workflow schedules)
    try {
      const nowMs = event.scheduledTime ?? Date.now();
      await maybeTriggerScheduledBackup(env, nowMs);
    } catch (e) {
      console.error(
        "scheduled backup trigger failed",
        safeLogText(e instanceof Error ? e.message : String(e)),
      );
    }
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // PHASE4-R4: backup sweep of any leftover pending notifications before ingest
    ctx?.waitUntil(
      deliverPendingNotifications(env, Date.now()).catch(() => logEvent(env, "notify_sweep_failed", {}),
      ),
    );
    // PHASE1-ALIASES
    const _rcpt = (message.to || "").trim().toLowerCase();
    if (await isAliasDisabled(env.DB, _rcpt)) return;
    const rcptDomain = _rcpt.split("@").pop();
    if (rcptDomain) {
      const domainRow = await lookupDomain(env.DB, rcptDomain);
      if (domainRow && domainRow.enabled === false) return;
    }
    const raw = await new Response(message.raw).arrayBuffer();
    let stored = false;
    let forwarded = false;
    try {
      const res = await ingestInbound(env, raw, { from: message.from, to: message.to });
      stored = true;
      // PHASE4-R4: enqueue & deliver notifications for new non-duplicate inbox mail
      if (res.duplicate === false && res.folder === "inbox") {
        try {
          const notifyTarget = _rcpt || (env.MAILBOX_ADDRESS || "").trim().toLowerCase();
          if (notifyTarget) {
            const settings = await getNotificationSettings(env.DB, notifyTarget);
            if (shouldNotify(res.folder, res.duplicate, settings)) {
              const nowMs = Date.now();
              if (settings.pushEnabled) {
                await enqueueNotification(env.DB, notifyTarget, res.id, "push", nowMs);
              }
              if (settings.telegramEnabled) {
                await enqueueNotification(env.DB, notifyTarget, res.id, "telegram", nowMs);
              }
              ctx?.waitUntil(
                deliverPendingNotifications(env, nowMs).catch(() => logEvent(env, "notify_delivery_failed", {}),
                ),
              );
            }
          }
        } catch (e) {
          logEvent(env, "notify_enqueue_failed", {});
        }
      }
    } catch (e) {
      try {
        const errMsg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        const recipient = (message.to || "").trim().toLowerCase();

        let msgId: string | null = null;
        try {
          const { default: PostalMime } = await import("postal-mime");
          const parsed = await PostalMime.parse(raw);
          msgId = parsed.messageId?.trim() || null;
        } catch {
          msgId = null;
        }

        let failedRawKey: string | null = null;
        try {
          const candidateKey = `raw/failed/${crypto.randomUUID()}.eml`;
          await env.RAW.put(candidateKey, raw, {
            httpMetadata: { contentType: "message/rfc822" },
          });
          failedRawKey = candidateKey;
        } catch {
          failedRawKey = null;
        }

        try {
          await env.DB.prepare(
            "INSERT INTO ingest_failures (id, message_id, recipient, raw_key, error, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
            .bind(crypto.randomUUID(), msgId, recipient, failedRawKey, errMsg, Date.now())
            .run();
        } catch {
          // Best-effort durable log; never block email forwarding
        }

        logEvent(env, "ingest_failed", {
          error: errMsg,
          recipient,
          failedRawKey,
        });
      } catch {
        // Guarantee nothing escapes the ingest catch block
      }
    }
    // Giữ nguyên luồng forward hiện có để không mất thư nếu web lỗi.
    for (const dest of (env.FORWARD_TO || "").split(",").map((s) => s.trim()).filter(Boolean)) {
      try {
        await message.forward(dest);
        forwarded = true;
      } catch (e) {
        logEvent(env, "forward_failed", { mailboxHash: await sha256Hex(dest) });
      }
    }
    if (!stored && !forwarded) throw new Error("Failed to store and forward the email");
  },
} satisfies ExportedHandler<Env>;
