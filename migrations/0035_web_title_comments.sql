PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS web_title_comments (
  id TEXT PRIMARY KEY,
  book_ref TEXT NOT NULL,
  author_telegram_id TEXT NOT NULL,
  parent_comment_id TEXT,
  body TEXT NOT NULL,
  is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE,
  FOREIGN KEY (author_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_comment_id) REFERENCES web_title_comments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_title_comments_book_created
  ON web_title_comments(book_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_title_comments_parent
  ON web_title_comments(parent_comment_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_web_title_comments_author
  ON web_title_comments(author_telegram_id, created_at DESC);

CREATE TABLE IF NOT EXISTS web_title_comment_votes (
  comment_id TEXT NOT NULL,
  voter_telegram_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (comment_id, voter_telegram_id),
  FOREIGN KEY (comment_id) REFERENCES web_title_comments(id) ON DELETE CASCADE,
  FOREIGN KEY (voter_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_title_comment_votes_voter
  ON web_title_comment_votes(voter_telegram_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS web_title_comment_reports (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL,
  reporter_telegram_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (comment_id, reporter_telegram_id),
  FOREIGN KEY (comment_id) REFERENCES web_title_comments(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_title_comment_reports_status
  ON web_title_comment_reports(status, created_at DESC);
