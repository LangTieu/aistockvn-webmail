-- Migration 0020: Restore messages_fts sync triggers and rebuild FTS index.
-- Migration 0009 dropped the messages table, which silently dropped the three
-- FTS5 sync triggers originally created in 0008 (messages_ai, messages_ad,
-- messages_au). As a result, FTS search has missed all mail received or updated
-- since 18/11. This migration re-creates the three triggers verbatim and runs a
-- one-time FTS5 rebuild so missed rows become searchable again.

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, text_body, from_addr, from_name)
  VALUES (new.rowid, new.subject, new.text_body, new.from_addr, new.from_name);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, text_body, from_addr, from_name)
  VALUES ('delete', old.rowid, old.subject, old.text_body, old.from_addr, old.from_name);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, text_body, from_addr, from_name)
  VALUES ('delete', old.rowid, old.subject, old.text_body, old.from_addr, old.from_name);
  INSERT INTO messages_fts(rowid, subject, text_body, from_addr, from_name)
  VALUES (new.rowid, new.subject, new.text_body, new.from_addr, new.from_name);
END;

INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
