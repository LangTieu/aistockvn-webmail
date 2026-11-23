CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject,
  text_body,
  from_addr,
  from_name,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61'
);

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

INSERT INTO messages_fts(rowid, subject, text_body, from_addr, from_name)
SELECT rowid, subject, text_body, from_addr, from_name FROM messages;
