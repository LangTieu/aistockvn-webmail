export const ENC_PREFIX = "enc:v1:";

const IV_BYTES = 12;
const KEY_BYTES = 32;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(input: string): Uint8Array {
  if (!input || !/^[A-Za-z0-9\-_]+$/.test(input)) {
    throw new Error("Invalid base64url string");
  }
  const mod = input.length % 4;
  if (mod === 1) {
    throw new Error("Invalid base64url length");
  }
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + (mod === 0 ? "" : "=".repeat(4 - mod));
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function decodeBase64Strict(input: string): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error("ENCRYPTION_KEY missing or invalid");
  }
  let bin: string;
  try {
    bin = atob(trimmed);
  } catch {
    throw new Error("ENCRYPTION_KEY missing or invalid");
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX);
}

export async function getEncryptionKey(env: { ENCRYPTION_KEY?: string }): Promise<CryptoKey> {
  if (!env.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY missing or invalid");
  }
  const raw = decodeBase64Strict(env.ENCRYPTION_KEY);
  if (raw.byteLength !== KEY_BYTES) {
    throw new Error("ENCRYPTION_KEY missing or invalid");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptText(plaintext: string, key: CryptoKey): Promise<string> {
  if (plaintext === "") {
    return "";
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = encoder.encode(plaintext);
  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const ciphertext = new Uint8Array(cipherBuffer);
  return `${ENC_PREFIX}${b64urlEncode(iv)}.${b64urlEncode(ciphertext)}`;
}

export async function decryptText(stored: string, key: CryptoKey): Promise<string> {
  if (!isEncrypted(stored)) {
    return stored;
  }
  const payload = stored.slice(ENC_PREFIX.length);
  const parts = payload.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Malformed encrypted payload");
  }
  const iv = b64urlDecode(parts[0]);
  const ciphertext = b64urlDecode(parts[1]);
  if (iv.byteLength !== IV_BYTES || ciphertext.byteLength === 0) {
    throw new Error("Malformed encrypted payload");
  }
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return decoder.decode(plainBuffer);
}
