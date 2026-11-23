import { describe, it, expect } from "vitest";
import { ENC_PREFIX, isEncrypted, getEncryptionKey, encryptText, decryptText } from "./crypto";

const TEST_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh4=";
const OTHER_KEY_B64 = "Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=";
const SHORT_KEY_16_B64 = "AAECAwQFBgcICQoLDA0ODw==";

describe("worker/crypto AES-GCM helpers", () => {
  it("1. round-trip ASCII", async () => {
    const key = await getEncryptionKey({ ENCRYPTION_KEY: TEST_KEY_B64 });
    const plaintext = "Hello, AI Stock VN Mail! Order #12345.";
    const encrypted = await encryptText(plaintext, key);
    const decrypted = await decryptText(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("2. round-trip unicode (Vietnamese + emoji) and long text (5000 chars)", async () => {
    const key = await getEncryptionKey({ ENCRYPTION_KEY: TEST_KEY_B64 });
    const unicode = "Xin chào Việt Nam 🇻🇳 — Báo cáo cổ phiếu 📈🚀 & ký tự đặc biệt: ăâđêôơư";
    const encUnicode = await encryptText(unicode, key);
    expect(await decryptText(encUnicode, key)).toBe(unicode);

    const longText = "Phân tích thị trường chứng khoán hôm nay. ".repeat(125).slice(0, 5000);
    expect(longText.length).toBe(5000);
    const encLong = await encryptText(longText, key);
    expect(await decryptText(encLong, key)).toBe(longText);
  });

  it("3. empty string encrypts to '' and isEncrypted('') is false", async () => {
    const key = await getEncryptionKey({ ENCRYPTION_KEY: TEST_KEY_B64 });
    const encrypted = await encryptText("", key);
    expect(encrypted).toBe("");
    expect(isEncrypted("")).toBe(false);
  });

  it("4. isEncrypted true for ciphertext, false for plaintext", async () => {
    const key = await getEncryptionKey({ ENCRYPTION_KEY: TEST_KEY_B64 });
    const encrypted = await encryptText("secret body", key);
    expect(encrypted.startsWith(ENC_PREFIX)).toBe(true);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(isEncrypted("plain legacy message body")).toBe(false);
  });

  it("5. decryptText passes legacy plaintext through unchanged", async () => {
    const key = await getEncryptionKey({ ENCRYPTION_KEY: TEST_KEY_B64 });
    const legacy = "Legacy unencrypted email body.";
    expect(await decryptText(legacy, key)).toBe(legacy);
  });

  it("6. getEncryptionKey throws when the key is missing", async () => {
    await expect(getEncryptionKey({})).rejects.toThrow("ENCRYPTION_KEY missing or invalid");
    await expect(getEncryptionKey({ ENCRYPTION_KEY: "" })).rejects.toThrow("ENCRYPTION_KEY missing or invalid");
  });

  it("7. getEncryptionKey throws when the key decodes to the wrong length (16 bytes)", async () => {
    await expect(getEncryptionKey({ ENCRYPTION_KEY: SHORT_KEY_16_B64 })).rejects.toThrow(
      "ENCRYPTION_KEY missing or invalid",
    );
  });

  it("8. decrypt with a DIFFERENT valid key throws", async () => {
    const keyA = await getEncryptionKey({ ENCRYPTION_KEY: TEST_KEY_B64 });
    const keyB = await getEncryptionKey({ ENCRYPTION_KEY: OTHER_KEY_B64 });
    const encrypted = await encryptText("confidential payload", keyA);
    await expect(decryptText(encrypted, keyB)).rejects.toThrow();
  });

  it("9. tampered ciphertext (flip one char in the ct part) throws", async () => {
    const key = await getEncryptionKey({ ENCRYPTION_KEY: TEST_KEY_B64 });
    const encrypted = await encryptText("integrity check payload", key);
    const body = encrypted.slice(ENC_PREFIX.length);
    const [ivPart, ctPart] = body.split(".");
    const flippedFirst = ctPart[0] === "A" ? "B" : "A";
    const tampered = `${ENC_PREFIX}${ivPart}.${flippedFirst}${ctPart.slice(1)}`;
    await expect(decryptText(tampered, key)).rejects.toThrow();
  });

  it("10. two encryptions of the same text produce different ciphertexts, both decrypt to the original", async () => {
    const key = await getEncryptionKey({ ENCRYPTION_KEY: TEST_KEY_B64 });
    const plaintext = "Same message encrypted twice";
    const enc1 = await encryptText(plaintext, key);
    const enc2 = await encryptText(plaintext, key);
    expect(enc1).not.toBe(enc2);
    expect(await decryptText(enc1, key)).toBe(plaintext);
    expect(await decryptText(enc2, key)).toBe(plaintext);
  });
});
