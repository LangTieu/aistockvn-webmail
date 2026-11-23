import { describe, expect, it } from "vitest";
import {
  generateAliasLocalPart,
  isAliasDisabled,
  lookupAlias,
  lookupDomain,
  parseAliasAddress,
  slugifyLabel,
} from "./aliases";

function mockDbWithFirst<T>(result: T | null) {
  return {
    prepare: () => ({
      bind: () => ({
        first: async <R>() => result as unknown as R | null,
      }),
    }),
  };
}

describe("slugifyLabel", () => {
  it("normalizes mixed case and punctuation", () => {
    expect(slugifyLabel("Shop Aurora!")).toBe("shop-aurora");
  });

  it("trims whitespace and collapses non-alphanumeric runs", () => {
    expect(slugifyLabel("  A&B  ")).toBe("a-b");
  });

  it("returns empty string for empty or symbol-only input", () => {
    expect(slugifyLabel("")).toBe("");
    expect(slugifyLabel("!!!")).toBe("");
  });

  it("truncates long labels to at most 30 characters without trailing hyphen", () => {
    const slug = slugifyLabel("Very Long Shopping Account Name For Testing Truncation");
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("very-long-shopping-account-nam");
  });
});

describe("generateAliasLocalPart", () => {
  it("matches slug plus 4-char suffix format and starts with slug", () => {
    const local = generateAliasLocalPart("Shop Aurora");
    expect(local).toMatch(/^[a-z0-9-]+-[a-z0-9]{4}$/);
    expect(local.startsWith("shop-aurora-")).toBe(true);
  });

  it("falls back to alias- prefix when label slugifies to empty", () => {
    const local = generateAliasLocalPart("");
    expect(local).toMatch(/^alias-[a-z0-9]{4}$/);
  });

  it("produces 50 distinct values across repeated calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(generateAliasLocalPart("Newsletter"));
    }
    expect(seen.size).toBe(50);
  });
});

describe("parseAliasAddress", () => {
  it("parses valid lowercase address", () => {
    expect(parseAliasAddress("shop-9k2m@aistockvn.com")).toEqual({
      localPart: "shop-9k2m",
      domain: "aistockvn.com",
    });
  });

  it("trims and normalizes uppercase input", () => {
    expect(parseAliasAddress("  Shop.Test+1@AISTOCKVN.COM  ")).toEqual({
      localPart: "shop.test+1",
      domain: "aistockvn.com",
    });
  });

  it("returns null for malformed addresses", () => {
    expect(parseAliasAddress("not-an-email")).toBeNull();
    expect(parseAliasAddress("a@b")).toBeNull();
    expect(parseAliasAddress("a@b@c.com")).toBeNull();
  });
});

describe("lookupAlias", () => {
  it("maps database row to AliasRow", async () => {
    const db = mockDbWithFirst({
      id: "alias-1",
      local_part: "shop-9k2m",
      domain: "aistockvn.com",
      label: "Shop",
      enabled: 1,
      created_by: "user@aistockvn.com",
      created_at: 1763460000000,
    });
    const row = await lookupAlias(db, "shop-9k2m", "aistockvn.com");
    expect(row).toEqual({
      id: "alias-1",
      localPart: "shop-9k2m",
      domain: "aistockvn.com",
      label: "Shop",
      enabled: true,
      createdBy: "user@aistockvn.com",
      createdAt: 1763460000000,
    });
  });

  it("returns null when alias does not exist", async () => {
    const db = mockDbWithFirst(null);
    expect(await lookupAlias(db, "missing-1234", "aistockvn.com")).toBeNull();
  });
});

describe("isAliasDisabled", () => {
  it("returns false for unknown address or unparsable input", async () => {
    const db = mockDbWithFirst(null);
    expect(await isAliasDisabled(db, "unknown-1234@aistockvn.com")).toBe(false);
    expect(await isAliasDisabled(db, "invalid-address")).toBe(false);
  });

  it("returns false when alias is enabled and true when disabled", async () => {
    const enabledDb = mockDbWithFirst({
      id: "alias-1",
      local_part: "shop-9k2m",
      domain: "aistockvn.com",
      label: "Shop",
      enabled: 1,
      created_by: "user@aistockvn.com",
      created_at: 1763460000000,
    });
    expect(await isAliasDisabled(enabledDb, "shop-9k2m@aistockvn.com")).toBe(false);

    const disabledDb = mockDbWithFirst({
      id: "alias-2",
      local_part: "spam-9k2m",
      domain: "aistockvn.com",
      label: "Spam",
      enabled: 0,
      created_by: "user@aistockvn.com",
      created_at: 1763460000000,
    });
    expect(await isAliasDisabled(disabledDb, "spam-9k2m@aistockvn.com")).toBe(true);
  });
});

describe("lookupDomain", () => {
  it("returns domain object when present and null when missing", async () => {
    const presentDb = mockDbWithFirst({ domain: "aistockvn.com", enabled: 1 });
    expect(await lookupDomain(presentDb, "aistockvn.com")).toEqual({
      domain: "aistockvn.com",
      enabled: true,
    });

    const missingDb = mockDbWithFirst(null);
    expect(await lookupDomain(missingDb, "unknown.com")).toBeNull();
  });
});
