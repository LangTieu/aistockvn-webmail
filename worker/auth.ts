const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type Jwks = { keys: (JsonWebKey & { kid?: string })[] };

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export async function fetchGoogleJwks(): Promise<Jwks> {
  const res = await fetch(GOOGLE_JWKS_URL, { cf: { cacheTtl: 3600 } } as RequestInit);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  return res.json();
}

/** Xác minh Google ID token (RS256) phía server; trả về email nếu hợp lệ. */
export async function verifyGoogleIdToken(
  token: string,
  clientId: string,
  getJwks: () => Promise<Jwks> = fetchGoogleJwks,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ email: string; name?: string }> {
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token format");
  const header = JSON.parse(dec.decode(b64urlDecode(parts[0])));
  const payload = JSON.parse(dec.decode(b64urlDecode(parts[1])));
  if (header.alg !== "RS256") throw new Error("Invalid alg");
  const jwk = (await getJwks()).keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Signing key not found");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlDecode(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new Error("Invalid signature");
  if (!GOOGLE_ISSUERS.has(payload.iss)) throw new Error("Invalid iss");
  if (payload.aud !== clientId) throw new Error("Invalid aud");
  if (typeof payload.exp !== "number" || payload.exp < nowSec) throw new Error("Token expired");
  if (payload.email_verified !== true || typeof payload.email !== "string")
    throw new Error("Email not verified");
  return { email: payload.email.toLowerCase(), name: payload.name };
}

export function isAllowed(email: string, allowed: string): boolean {
  return allowed
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export const SESSION_COOKIE = "mail_session";
export const SESSION_TTL_SEC = 30 * 24 * 3600;

export async function signSession(email: string, secret: string, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET is missing or too short");
  const body = b64urlEncode(enc.encode(JSON.stringify({ e: email, x: nowSec + SESSION_TTL_SEC })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

export async function verifySession(
  token: string | null,
  secret: string,
  allowed: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  if (!token || !secret || secret.length < 32) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(sig), enc.encode(body));
    if (!ok) return null;
    const { e, x } = JSON.parse(dec.decode(b64urlDecode(body)));
    if (typeof x !== "number" || x < nowSec) return null;
    // Kiểm lại allowlist để gỡ quyền có hiệu lực ngay khi đổi cấu hình.
    return isAllowed(e, allowed) ? e : null;
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | null {
  const h = req.headers.get("Cookie") || "";
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(value: string, secure: boolean, maxAge = SESSION_TTL_SEC) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/** SHA-256 hex của một chuỗi dữ liệu. */
export async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(data));
  return b64urlEncode(new Uint8Array(buf));
}

/** Xác minh token email từ email_verifications table.
 *  Trả về { email, exists: boolean, used: boolean, expired: boolean }.
 */
export async function verifyEmailToken(
  token: string,
  DB: any,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ email: string; exists: boolean; used: boolean; expired: boolean }> {
  const tokenHash = await sha256Hex(token);
  const row = await ((DB as any).prepare("SELECT * FROM email_verifications WHERE token_hash = ?") as any).bind(tokenHash).first();

  if (!row) return { email: "", exists: false, used: false, expired: false };
  if (row.used === 1) return { email: row.email, exists: true, used: true, expired: false };
  if (row.expires_at < nowSec) return { email: row.email, exists: true, used: false, expired: true };
  return { email: row.email, exists: true, used: false, expired: false };
}

/** Đạo xuất PBKDF2 với muối cố định 0_byte salt để kiểm tra chi phí (timing-safe cho unknown email). */
export async function consumePasswordCost(password: string): Promise<{ ok: boolean }> {
  const salt = new Uint8Array(16);
  for (let i = 0; i < 16; i++) salt[i] = 0;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"],
  );
  await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return { ok: true };
}

/** Kiểm tra độ dài password: tối thiểu 10, tối đa 128 ký tự. */
export function validatePassword(password: string): { valid: boolean } {
  if (password.length < 10) return { valid: false };
  if (password.length > 128) return { valid: false };
  return { valid: true };
}

/** Hash password bằng PBKDF2-SHA256, 100000 iter, salt 16 byte ngẫu nhiên.
 *  Trả về chuỗi encoded: pbkdf2-sha256$100000$<base64 16-byte salt>$<base64 32-byte derived>
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"],
  );
  const derivedKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  );
  const rawKey = await crypto.subtle.exportKey("raw", derivedKey) as ArrayBuffer;
  const derivedBytes = new Uint8Array(rawKey);
  const saltB64 = b64urlEncode(salt);
  const hashB64 = b64urlEncode(derivedBytes);
  return `pbkdf2-sha256$100000$${saltB64}$${hashB64}`;
}

/** So sánh mã hash theo thời gian liên tục (XOR accumulate, không sớm thoát).
 *  Trả về true nếu hai chuỗi encoded trùng khớp.
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** Verify password against encoded hash `pbkdf2-sha256$100000$salt$hash`.
 *  Parses the format, rejects malformed strings, checks algorithm,
 *  iterations (must be >= 100000), and compares with safeEqual.
 */
export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 4) return false;
  const [algo, iterStr, saltB64, hashB64] = parts;
  if (algo !== "pbkdf2-sha256") return false;
  const iterations = parseInt(iterStr, 10);
  if (Number.isNaN(iterations) || iterations < 100000) return false;
  if (saltB64.length === 0 || hashB64.length === 0) return false;

  const salt = b64urlDecode(saltB64);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"],
  );
  const derivedKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  );
  const rawKey = await crypto.subtle.exportKey("raw", derivedKey) as ArrayBuffer;
  const derivedBytes = new Uint8Array(rawKey);
  const computedHash = b64urlEncode(derivedBytes);
  return safeEqual(computedHash, hashB64);
}