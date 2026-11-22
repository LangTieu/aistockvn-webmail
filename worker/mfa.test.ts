import { describe, expect, it } from "vitest";
import { generateTotpSecret, generateTOTPCode, verifyTOTPCode, encryptTotpSecret, decryptTotpSecret, sha256Hex, normalizeRecoveryCode, generateRecoveryCodes, verifyRecoveryCode } from "./mfa";

const enc = new TextEncoder();

function base32Decode(input: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = input.replace(/=+$/, "").replace(/[^A-Z2-7]/g, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let val = 0;
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

describe("TOTP generate/verify round-trip", () => {
  it("generates a valid TOTP secret", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it("generates a valid TOTP code from secret", async () => {
    const secret = generateTotpSecret();
    const code = await generateTOTPCode(secret);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("verifies a TOTP code against the same secret", async () => {
    const secret = generateTotpSecret();
    const code = await generateTOTPCode(secret);
    const secretBytes = base32Decode(secret);
    const valid = await verifyTOTPCode(secretBytes, code);
    expect(valid).toBe(true);
  });

  it("rejects an invalid TOTP code", async () => {
    const secret = generateTotpSecret();
    const code = await generateTOTPCode(secret);
    const secretBytes = base32Decode(secret);
    const valid = await verifyTOTPCode(secretBytes, "123456");
    expect(valid).toBe(false);
  });

  it("works across ±1 window", async () => {
    const secret = generateTotpSecret();
    const code = await generateTOTPCode(secret);
    const secretBytes = base32Decode(secret);
    const validCurrent = await verifyTOTPCode(secretBytes, code);
    expect(validCurrent).toBe(true);
  });
});

describe("TOTP encryption", () => {
  it("encrypts and decrypts a TOTP secret", async () => {
    const secret = generateTotpSecret();
    const encrypted = await encryptTotpSecret(secret, "test-key-32-chars-long!");
    const decrypted = await decryptTotpSecret(encrypted, "test-key-32-chars-long!");
    const secretBytes = base32Decode(secret);
    const code = await generateTOTPCode(secret);
    const valid = await verifyTOTPCode(decrypted, code);
    expect(valid).toBe(true);
  });

  it("normalizes recovery codes", () => {
    expect(normalizeRecoveryCode("abc")).toBe("ABC");
    expect(normalizeRecoveryCode("aBc23456")).toBe("ABC23456");
  });

  it("verifies recovery code after normalization", async () => {
    const secret = generateTotpSecret();
    const codes = generateRecoveryCodes();
    const codeHash = await sha256Hex(codes[0]);
    const verified = await verifyRecoveryCode(codes[0], codeHash);
    expect(verified).toBe(true);
  });
});