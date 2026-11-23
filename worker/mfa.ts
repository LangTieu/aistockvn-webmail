const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base32Encode(input: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let output = "";
  let bits = 0;
  let val = 0;
  for (const b of input) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(val << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let val = 0;
  const cleaned = input.replace(/=+$/, "").replace(/[^A-Z2-7]/g, "").toUpperCase();
  const bytes: number[] = [];
  for (const char of cleaned) {
    const value = alphabet.indexOf(char);
    if (value === -1) throw new Error(`Invalid base32 character: ${char}`);
    val = (val << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((val >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function generateTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return base32Encode(bytes);
}

export async function generateTOTPCode(secretB32: string): Promise<string> {
  const secretBytes = base32Decode(secretB32);
  let counter = Math.floor(Date.now() / 1000 / 30);
  const counterBuf = new ArrayBuffer(8);
  const dv = new DataView(counterBuf);
  for (let i = 7; i >= 0; i--) {
    dv.setUint8(i, counter & 0xff);
    counter >>>= 8;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBuf));
  const offset = sig[sig.length - 1] & 0x0f;
  const truncated = sig.slice(offset, offset + 4);
  const code = ((truncated[0] & 0x7f) << 24 | (truncated[1] & 0xff) << 16 | (truncated[2] & 0xff) << 8 | (truncated[3] & 0xff)) % 1000000;
  return String(code).padStart(6, "0");
}

export async function encryptTotpSecret(secretB32: string, encryptionKey: string): Promise<string> {
  const secretBytes = base32Decode(secretB32);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyBuf = await crypto.subtle.digest("SHA-256", enc.encode(encryptionKey));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    "AES-GCM",
    true,
    ["encrypt", "decrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    secretBytes,
  );
  const ivB64 = b64urlEncode(iv);
  const ctB64 = b64urlEncode(new Uint8Array(encrypted));
  return `v1.${ivB64}.${ctB64}`;
}

export async function decryptTotpSecret(encrypted: string, encryptionKey: string): Promise<Uint8Array> {
  const parts = encrypted.split(".");
  if (parts[0] !== "v1") throw new Error("Invalid TOTP secret format");
  const iv = b64urlDecode(parts[1]);
  const ct = b64urlDecode(parts[2]);
  const keyBuf = await crypto.subtle.digest("SHA-256", enc.encode(encryptionKey));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    "AES-GCM",
    true,
    ["encrypt", "decrypt"],
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ct,
  );
  return new Uint8Array(decrypted);
}

export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    codes.push(base32Encode(bytes));
  }
  return codes;
}

export async function sha256Hex(data: string): Promise<string> {
  if (!crypto.subtle.digest) {
    return Promise.resolve(b64urlEncode(new Uint8Array(0)));
  }
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(data));
  return Promise.resolve(b64urlEncode(new Uint8Array(buf)));
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

export function verifyRecoveryCode(code: string, codeHash: string): Promise<boolean> {
  return sha256Hex(normalizeRecoveryCode(code)).then((hash) => hash === codeHash);
}

export async function verifyTOTPCode(secretBytes: Uint8Array, code: string): Promise<boolean> {
  let counter = Math.floor(Date.now() / 1000 / 30);
  // Try current and ±1 window
  for (let offset = -1; offset <= 1; offset++) {
    let c = counter + offset;
    const counterBuf = new ArrayBuffer(8);
    const dv = new DataView(counterBuf);
    for (let i = 7; i >= 0; i--) {
      dv.setUint8(i, c & 0xff);
      c >>>= 8;
    }
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBuf));
    const truncOffset = sig[sig.length - 1] & 0x0f;
    const truncated = sig.slice(truncOffset, truncOffset + 4);
    const computed = String(((truncated[0] & 0x7f) << 24 | (truncated[1] & 0xff) << 16 | (truncated[2] & 0xff) << 8 | (truncated[3] & 0xff)) % 1000000).padStart(6, "0");
    if (computed === code) return true;
  }
  return false;
}