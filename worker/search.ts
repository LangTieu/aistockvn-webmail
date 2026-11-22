/**
 * Builds a safe SQLite FTS5 MATCH query string from raw user search input.
 *
 * Splits input on whitespace, neutralizes FTS5 syntax/operator characters,
 * drops field-like prefixes (e.g. `subject:` → drop `subject`, keep rest),
 * drops boolean operators (OR, AND, NOT) and tokens containing `=`,
 * escapes embedded double quotes, wraps each remaining term in double quotes,
 * and joins terms with `AND`.
 */
export function buildFtsQuery(q: string): string | null {
  const trimmed = q.trim();
  if (!trimmed) {
    return null;
  }

  const rawTokens = trimmed.split(/\s+/);
  const terms: string[] = [];

  for (const token of rawTokens) {
    // Drop tokens that are boolean operators (OR, AND, NOT case-insensitive)
    if (/^\s*(or|and|not)\s*$/i.test(token)) {
      continue;
    }

    // Drop tokens containing =
    if (token.includes('=')) {
      continue;
    }

    // Strip field-like prefix (e.g. subject:urgent* → urgent*)
    // Only drops when the rest after the colon is non-empty
    let processed = token;
    const prefixMatch = token.match(/^[A-Za-z_][A-Za-z0-9_]*:(.+)$/);
    if (prefixMatch && prefixMatch[1].length > 0) {
      processed = prefixMatch[1];
    }

    // Strip FTS5 special operator characters while preserving
    // Unicode letters/diacritics, numbers, underscores
    const cleaned = processed.replace(/[*^():+-]/g, '');

    // Ignore tokens that consisted solely of stripped operators or quotes
    if (!cleaned || /^"+$/.test(cleaned)) {
      continue;
    }

    // Escape embedded double quotes by doubling them per FTS5 string literal rules
    const escaped = cleaned.replace(/"/g, '""');
    terms.push(`"${escaped}"`);
  }

  if (terms.length === 0) {
    return null;
  }

  return terms.join(' AND ');
}
