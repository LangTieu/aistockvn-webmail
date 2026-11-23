import { describe, it, expect } from "vitest";
import { classifyFocused } from "./focused";

const allowlist = ["tranbinhanbr01@gmail.com", "lethanhdongus@gmail.com", "admin@aistockvn.com"];
const sentIds = ["<abc123@mail.example>"];
const userNames = ["An", "Dong", "Henrry"];

describe("focused filter", () => {
  describe("allowlisted-sender", () => {
    it("1. allowlisted sender (exact case) → focused", () => {
      const result = classifyFocused({
        from: "admin@aistockvn.com",
        subject: "Hello",
        text: "Hello world",
        inReplyTo: null,
        references: null,
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: userNames,
      });
      expect(result.focused).toBe(true);
      expect(result.reasons).toEqual(["allowlisted-sender"]);
    });

    it("2. allowlist compare is case-insensitive", () => {
      const result = classifyFocused({
        from: "ADMIN@AISTOCKVN.COM",
        subject: "Hello",
        text: "Hello world",
        inReplyTo: null,
        references: null,
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: userNames,
      });
      expect(result.focused).toBe(true);
      expect(result.reasons).toEqual(["allowlisted-sender"]);
    });
  });

  describe("unknown sender", () => {
    it("3. unknown sender, no other signal → not focused", () => {
      const result = classifyFocused({
        from: "unknown@example.com",
        subject: "Hello",
        text: "Hello world",
        inReplyTo: null,
        references: null,
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: userNames,
      });
      expect(result.focused).toBe(false);
      expect(result.reasons).toEqual([]);
    });
  });

  describe("reply-to-sent", () => {
    it("4. inReplyTo matching a sent message-id → focused", () => {
      const result = classifyFocused({
        from: "unknown@example.com",
        subject: "Hello",
        text: "Hello world",
        inReplyTo: "<abc123@mail.example>",
        references: null,
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: userNames,
      });
      expect(result.focused).toBe(true);
      expect(result.reasons).toEqual(["reply-to-sent"]);
    });

    it("5. references containing a sent message-id in <...> among other ids → focused", () => {
      const result = classifyFocused({
        from: "unknown@example.com",
        subject: "Hello",
        text: "Hello world",
        inReplyTo: null,
        references: "<other-id> <abc123@mail.example>",
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: userNames,
      });
      expect(result.focused).toBe(true);
      expect(result.reasons).toEqual(["reply-to-sent"]);
    });

    it("6. inReplyTo NOT in the sent set → not focused", () => {
      const result = classifyFocused({
        from: "unknown@example.com",
        subject: "Hello",
        text: "Hello world",
        inReplyTo: "<other-id>",
        references: null,
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: userNames,
      });
      expect(result.focused).toBe(false);
      expect(result.reasons).toEqual([]);
    });

    it("12. bracketed inReplyTo matches a BARE sent message-id → focused", () => {
      const result = classifyFocused({
        from: "unknown@example.com",
        subject: "Hello",
        text: "Hello world",
        inReplyTo: "<abc123@mail.example>",
        references: null,
        allowedEmails: allowlist,
        sentMessageIds: ["abc123@mail.example"],
        userNames: userNames,
      });
      expect(result.focused).toBe(true);
      expect(result.reasons).toEqual(["reply-to-sent"]);
    });

    it("13. bare references id matches a BRACKETED sent message-id → focused", () => {
      const result = classifyFocused({
        from: "unknown@example.com",
        subject: "Hello",
        text: "Hello world",
        inReplyTo: null,
        references: "abc123@mail.example",
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: userNames,
      });
      expect(result.focused).toBe(true);
      expect(result.reasons).toEqual(["reply-to-sent"]);
    });
  });

  describe("mentions-user", () => {
    it("7. subject contains a user name, different case → focused", () => {
      const result = classifyFocused({
        from: "unknown@example.com",
        subject: "Dong gave a presentation",
        text: "Hello world",
        inReplyTo: null,
        references: null,
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: userNames,
      });
      expect(result.focused).toBe(true);
      expect(result.reasons).toEqual(["mentions-user"]);
    });

    it("8. text body contains a user name → focused", () => {
      const result = classifyFocused({
        from: "unknown@example.com",
        subject: "Hello",
        text: "Henrry said hi",
        inReplyTo: null,
        references: null,
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: userNames,
      });
      expect(result.focused).toBe(true);
      expect(result.reasons).toEqual(["mentions-user"]);
    });

    it("9. user-name token shorter than 3 chars is ignored → not focused", () => {
      const result = classifyFocused({
        from: "unknown@example.com",
        subject: "An gave a presentation",
        text: "An said hi",
        inReplyTo: null,
        references: null,
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: ["An"],
      });
      expect(result.focused).toBe(false);
      expect(result.reasons).toEqual([]);
    });

    it("10. all three signals at once → focused with all three reasons in order", () => {
      const result = classifyFocused({
        from: "admin@aistockvn.com",
        subject: "Dong gave a presentation",
        text: "Henrry said hi",
        inReplyTo: "<abc123@mail.example>",
        references: "<abc123@mail.example>",
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: userNames,
      });
      expect(result.focused).toBe(true);
      expect(result.reasons).toEqual(["allowlisted-sender", "reply-to-sent", "mentions-user"]);
    });

    it("11. empty subject + empty text + unknown sender → not focused", () => {
      const result = classifyFocused({
        from: "unknown@example.com",
        subject: "",
        text: "",
        inReplyTo: null,
        references: null,
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: userNames,
      });
      expect(result.focused).toBe(false);
      expect(result.reasons).toEqual([]);
    });

    it("14. name with regex meta-characters matches literally (C++) → focused", () => {
      const result = classifyFocused({
        from: "unknown@example.com",
        subject: "Learn C++ today",
        text: "Hello world",
        inReplyTo: null,
        references: null,
        allowedEmails: allowlist,
        sentMessageIds: sentIds,
        userNames: ["C++"],
      });
      expect(result.focused).toBe(true);
      expect(result.reasons).toEqual(["mentions-user"]);
    });
  });
});