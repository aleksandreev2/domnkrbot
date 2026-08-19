CREATE TABLE IF NOT EXISTS publication_comment_gates (
  publication_id INTEGER PRIMARY KEY,
  discussion_message_id INTEGER,
  gate_message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'waiting_forward',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(publication_id) REFERENCES publications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_publication_comment_gates_status
  ON publication_comment_gates(status, updated_at DESC);
