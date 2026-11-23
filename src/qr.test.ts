import { describe, expect, it } from "vitest";
import { qrMatrix } from "./qr";

function matrixToAscii(m: boolean[][]): string {
  return m.map((row) => row.map((cell) => (cell ? "1" : "0")).join("")).join("\n");
}

describe("qrMatrix", () => {
  it("encodes 'HELLO' (5 bytes) into a 21x21 version 1 boolean matrix", () => {
    const m = qrMatrix("HELLO");
    expect(m.length).toBe(21);
    for (const row of m) {
      expect(row.length).toBe(21);
      for (const cell of row) {
        expect(typeof cell).toBe("boolean");
      }
    }
  });

  // Pins mask 2 (the encoder's deterministic choice, decode-verified)
  it("matches the golden oracle matrix for 'HELLO' (version 1, 21x21, mask 2)", () => {
    const expected = [
      "111111100011101111111",
      "100000100001001000001",
      "101110101010101011101",
      "101110101001101011101",
      "101110101111101011101",
      "100000101100101000001",
      "111111101010101111111",
      "000000001001100000000",
      "101111100000101111100",
      "000010011100100101111",
      "110011110001010011001",
      "001100000100000110000",
      "000011110011010010100",
      "000000001011111001011",
      "111111100000101100101",
      "100000101111111001001",
      "101110101010100100100",
      "101110101000100100100",
      "101110101001010010100",
      "100000100010000110101",
      "111111101011010010100",
    ].join("\n");

    expect(matrixToAscii(qrMatrix("HELLO"))).toBe(expected);
  });

  it("matches the golden oracle matrix for the TOTP otpauth URI (version 5, 37x37)", () => {
    const expected = [
      "1111111001010000010111001101001111111",
      "1000001010001110011010001010001000001",
      "1011101010011111000001011001001011101",
      "1011101010010101110011001100001011101",
      "1011101001010111111110000101101011101",
      "1000001000100001010000101000101000001",
      "1111111010101010101010101010101111111",
      "0000000010111110111110111001100000000",
      "1000001011010001100101100010111001110",
      "0011010011100110111000010000011110010",
      "0001101101010111110101100011110001111",
      "1011110011001100000110100011010101001",
      "0111011010001011100010010001111101101",
      "0111000010001101101100110011000000001",
      "0111111101010111001011100001001011011",
      "0100110010100001100000100010101001111",
      "1000111100101001001010101101111001110",
      "0110010101011000110001010001001100010",
      "0110011110001100110101110011000001001",
      "0010110100101001100000000011010001010",
      "1111011101100100111000101110111110010",
      "1010100110100101010100110001010010110",
      "0000001011010111110001100111011000001",
      "0111010111110101011010111000111011001",
      "1101101010010101010010010001101000001",
      "1101000001110000011010110000101000000",
      "1001001110100001110101000011011100111",
      "1001010101010100100100011010101001101",
      "1010111101010111010100100101111110000",
      "0000000011110111100110010111100011010",
      "1111111000110111011110110110101010101",
      "1000001000001000100000100011100011011",
      "1011101001101011001000100111111110111",
      "1011101001111110000011010101011001101",
      "1011101000110100011001100100100100111",
      "1000001001110011100010111001000001001",
      "1111111011100110100100010000111010101",
    ].join("\n");

    const uri =
      "otpauth://totp/Test:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Test";
    expect(matrixToAscii(qrMatrix(uri))).toBe(expected);
  });

  it("is deterministic for identical inputs", () => {
    const uri =
      "otpauth://totp/Test:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Test";
    const m1 = qrMatrix(uri);
    const m2 = qrMatrix(uri);
    expect(m1).toEqual(m2);
  });

  it("produces a valid odd-sided square matrix (21..57) for a ~120-char otpauth URI", () => {
    const uri =
      "otpauth://totp/ExampleWebmail:alice.johnson@example-domain.org?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=ExampleWebmail&digits=6&period=30";
    expect(uri.length).toBeGreaterThanOrEqual(110);
    const m = qrMatrix(uri);
    const side = m.length;
    expect(side).toBeGreaterThanOrEqual(21);
    expect(side).toBeLessThanOrEqual(57);
    expect(side % 2).toBe(1);
    for (const row of m) {
      expect(row.length).toBe(side);
    }
  });

  it("renders valid 7x7 finder patterns at top-left, top-right, and bottom-left", () => {
    const m = qrMatrix("HELLO");
    const side = m.length;

    const assertFinderAt = (topR: number, leftC: number) => {
      for (let dr = 0; dr < 7; dr++) {
        for (let dc = 0; dc < 7; dc++) {
          const isOuterBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const isInnerCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          const expected = isOuterBorder || isInnerCenter;
          expect(m[topR + dr][leftC + dc]).toBe(expected);
        }
      }
    };

    assertFinderAt(0, 0);
    assertFinderAt(0, side - 7);
    assertFinderAt(side - 7, 0);
  });

  it("renders alternating dark/light timing patterns on row 6 and column 6", () => {
    const m = qrMatrix("otpauth://totp/Test:user@example.com?secret=JBSWY3DPEHPK3PXP");
    const side = m.length;
    for (let i = 8; i <= side - 9; i++) {
      const expected = i % 2 === 0;
      expect(m[6][i]).toBe(expected);
      expect(m[i][6]).toBe(expected);
    }
  });

  it("produces different matrices for different inputs", () => {
    const m1 = qrMatrix("otpauth://totp/App:user1@example.com?secret=JBSWY3DPEHPK3PXP");
    const m2 = qrMatrix("otpauth://totp/App:user2@example.com?secret=KRSXG5CTMVRXEZLU");
    expect(m1).not.toEqual(m2);
  });
});
