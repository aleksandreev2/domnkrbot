ALTER TABLE chapter_proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE chapter_proposals ADD COLUMN ranobelib_book_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_chapter_proposals_ranobelib_active
  ON chapter_proposals(ranobelib_book_ref, status);

CREATE TABLE IF NOT EXISTS telegram_proposal_sessions (
  user_telegram_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  step TEXT NOT NULL,
  source_kind TEXT,
  ranobelib_book_ref TEXT,
  title TEXT NOT NULL DEFAULT '',
  original_title TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  raw_file_id TEXT,
  raw_file_unique_id TEXT,
  raw_file_name TEXT,
  raw_file_size INTEGER,
  raw_mime_type TEXT,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_proposal_sessions_updated
  ON telegram_proposal_sessions(updated_at);
