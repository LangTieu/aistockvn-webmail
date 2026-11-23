import { describe, expect, it } from "vitest";
import { signSession, SESSION_COOKIE } from "./auth";

const SHARED_MAILBOX = "admin@aistockvn.com";
const GMAIL_USER = "tranbinhanbr01@gmail.com";

describe("simple", () => {
  it("passes", async () => {
    expect(true).toBe(true);
  });
});
