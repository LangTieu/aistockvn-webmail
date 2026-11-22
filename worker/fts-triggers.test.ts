import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL('../migrations/0020_fts_triggers.sql', import.meta.url);
const migrationSql = readFileSync(migrationPath, 'utf8');
const sqlBody = migrationSql.replace(/--.*$/gm, '');

const FTS_COLUMNS = ['subject', 'text_body', 'from_addr', 'from_name'] as const;

function getTriggerBody(sql: string, triggerName: string): string {
  const pattern = new RegExp(
    `CREATE\\s+TRIGGER\\s+IF\\s+NOT\\s+EXISTS\\s+${triggerName}\\b[\\s\\S]*?\\bBEGIN([\\s\\S]*?)\\bEND;`,
    'i',
  );
  const match = sql.match(pattern);
  expect(match, `Missing trigger ${triggerName}`).not.toBeNull();
  return match![1];
}

describe('migrations/0020_fts_triggers.sql', () => {
  it('defines all three FTS sync triggers with IF NOT EXISTS and expected events', () => {
    expect(sqlBody).toMatch(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+messages_ai\s+AFTER\s+INSERT\s+ON\s+messages\b/i);
    expect(sqlBody).toMatch(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+messages_ad\s+AFTER\s+DELETE\s+ON\s+messages\b/i);
    expect(sqlBody).toMatch(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+messages_au\s+AFTER\s+UPDATE\s+ON\s+messages\b/i);
  });

  it('references all FTS columns in each trigger body', () => {
    for (const triggerName of ['messages_ai', 'messages_ad', 'messages_au'] as const) {
      const body = getTriggerBody(sqlBody, triggerName);
      for (const col of FTS_COLUMNS) {
        expect(body, `${triggerName} should reference ${col}`).toContain(col);
      }
    }
  });

  it('rebuilds the messages_fts index after creating the triggers', () => {
    const rebuildStmt = "INSERT INTO messages_fts(messages_fts) VALUES('rebuild')";
    const rebuildIndex = sqlBody.indexOf(rebuildStmt);
    expect(rebuildIndex).toBeGreaterThan(-1);

    for (const triggerName of ['messages_ai', 'messages_ad', 'messages_au'] as const) {
      const triggerIndex = sqlBody.indexOf(triggerName);
      expect(triggerIndex).toBeGreaterThan(-1);
      expect(rebuildIndex).toBeGreaterThan(triggerIndex);
    }
  });

  it('does not recreate messages_fts or alter/drop/delete table data', () => {
    expect(sqlBody).not.toMatch(/\bCREATE\s+VIRTUAL\s+TABLE\b/i);
    expect(sqlBody).not.toMatch(/\b(DROP|ALTER)\s+TABLE\b/i);
    expect(sqlBody).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
