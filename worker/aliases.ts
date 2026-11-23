type AliasDB = {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
};

export interface AliasRow {
  id: string;
  localPart: string;
  domain: string;
  label: string;
  enabled: boolean;
  createdBy: string;
  createdAt: number;
}

const SUFFIX_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
}

export function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += SUFFIX_ALPHABET[bytes[i] % SUFFIX_ALPHABET.length];
  }
  return out;
}

export function generateAliasLocalPart(label: string): string {
  const slug = slugifyLabel(label);
  return `${slug || "alias"}-${randomSuffix()}`;
}

export function parseAliasAddress(addr: string): { localPart: string; domain: string } | null {
  const normalized = addr.trim().toLowerCase();
  const parts = normalized.split("@");
  if (parts.length !== 2) return null;
  const [localPart, domain] = parts;
  if (!localPart || !/^[a-z0-9._%+-]+$/.test(localPart)) return null;
  if (!domain || !domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  return { localPart, domain };
}

export async function lookupAlias(
  db: AliasDB,
  localPart: string,
  domain: string,
): Promise<AliasRow | null> {
  const row = await db
    .prepare(
      "SELECT id, local_part, domain, label, enabled, created_by, created_at FROM aliases WHERE local_part = ? AND domain = ?",
    )
    .bind(localPart, domain)
    .first<{
      id: string;
      local_part: string;
      domain: string;
      label: string;
      enabled: number;
      created_by: string;
      created_at: number;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    localPart: row.local_part,
    domain: row.domain,
    label: row.label,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function isAliasDisabled(db: AliasDB, address: string): Promise<boolean> {
  const parsed = parseAliasAddress(address);
  if (!parsed) return false;
  const alias = await lookupAlias(db, parsed.localPart, parsed.domain);
  if (!alias) return false;
  return !alias.enabled;
}

export async function lookupDomain(
  db: AliasDB,
  domain: string,
): Promise<{ domain: string; enabled: boolean } | null> {
  const row = await db
    .prepare("SELECT domain, enabled FROM domains WHERE domain = ?")
    .bind(domain)
    .first<{ domain: string; enabled: number }>();
  if (!row) return null;
  return { domain: row.domain, enabled: row.enabled === 1 };
}
