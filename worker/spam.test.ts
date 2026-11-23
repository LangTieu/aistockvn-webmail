import { describe, it, expect } from "vitest";
import { SPAM_THRESHOLD, parseAuthResults, scoreSpam, isSpam } from "./spam";

describe("spam filter", () => {
  describe("parseAuthResults", () => {
    it("all-pass header → all pass", () => {
      const headers = [
        { key: "Authentication-Results", value: "spf=pass dkim=pass dmarc=pass" },
      ];
      const result = parseAuthResults(headers);
      expect(result).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
    });

    it("mixed fail header → correct words", () => {
      const headers = [
        { key: "Authentication-Results", value: "spf=fail dkim=neutral dmarc=softfail" },
      ];
      const result = parseAuthResults(headers);
      expect(result).toEqual({ spf: "fail", dkim: "neutral", dmarc: "softfail" });
    });

    it("missing header → all none", () => {
      const headers = [
        { key: "X-Something", value: "hello" },
      ];
      const result = parseAuthResults(headers);
      expect(result).toEqual({ spf: "none", dkim: "none", dmarc: "none" });
    });

    it("case-insensitive", () => {
      const headers = [
        { key: "Authentication-Results", value: "SPF=FAIL DKIM=FAIL DMARC=FAIL" },
      ];
      const result = parseAuthResults(headers);
      expect(result).toEqual({ spf: "fail", dkim: "fail", dmarc: "fail" });
    });
  });

  describe("scoreSpam", () => {
    it("spf fail alone = 3 (not spam)", () => {
      const result = scoreSpam({
        from: "user@example.com",
        subject: "Hello",
        text: "Hello world",
        headers: [{ key: "Authentication-Results", value: "spf=fail" }],
        blocklisted: false,
      });
      expect(result.score).toBe(3);
      expect(result.reasons).toEqual(["spf-fail"]);
    });

    it("spf+dkim fail = 6 (spam)", () => {
      const result = scoreSpam({
        from: "user@example.com",
        subject: "Hello",
        text: "Hello world",
        headers: [
          { key: "Authentication-Results", value: "spf=fail dkim=fail" },
        ],
        blocklisted: false,
      });
      expect(result.score).toBe(6);
      expect(result.reasons).toEqual(["spf-fail", "dkim-fail"]);
    });

    it("blocklisted alone = 5 (spam, boundary)", () => {
      const result = scoreSpam({
        from: "scammer@evil.example",
        subject: "Hello",
        text: "Hello world",
        headers: [{ key: "Authentication-Results", value: "spf=pass dkim=pass dmarc=pass" }],
        blocklisted: true,
      });
      expect(result.score).toBe(5);
      expect(result.reasons).toEqual(["blocklisted"]);
    });

    it("empty-short = 2 (not spam)", () => {
      const result = scoreSpam({
        from: "user@example.com",
        subject: "",
        text: "hi",
        headers: [{ key: "Authentication-Results", value: "spf=pass dkim=pass dmarc=pass" }],
        blocklisted: false,
      });
      expect(result.score).toBe(2);
      expect(result.reasons).toEqual(["empty-short"]);
    });

    it("many-links + spf softfail = 3 (not spam)", () => {
      const body = "Check out these links: " + "http://example.com ".repeat(15);
      const result = scoreSpam({
        from: "user@example.com",
        subject: "Newsletter",
        text: body,
        headers: [{ key: "Authentication-Results", value: "spf=softfail dkim=pass dmarc=pass" }],
        blocklisted: false,
      });
      expect(result.score).toBe(3);
      expect(result.reasons).toEqual(["spf-softfail", "many-links"]);
    });
  });

  describe("isSpam boundary", () => {
    it("score 4 → false", () => {
      expect(isSpam({ score: 4 })).toBe(false);
    });
    it("score 5 → true", () => {
      expect(isSpam({ score: 5 })).toBe(true);
    });
  });
});