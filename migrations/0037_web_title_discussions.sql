PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS web_title_discussions (
  id TEXT PRIMARY KEY,
  book_ref TEXT NOT NULL,
  author_telegram_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Обсуждение тайтла',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE,
  FOREIGN KEY (author_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_title_discussions_book_updated
  ON web_title_discussions(book_ref, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_title_discussions_author
  ON web_title_discussions(author_telegram_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS web_title_discussion_replies (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  author_telegram_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (discussion_id) REFERENCES web_title_discussions(id) ON DELETE CASCADE,
  FOREIGN KEY (author_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_title_discussion_replies_thread_created
  ON web_title_discussion_replies(discussion_id, created_at ASC);
