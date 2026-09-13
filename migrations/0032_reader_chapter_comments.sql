CREATE TABLE IF NOT EXISTS reader_chapter_comments (
  id TEXT PRIMARY KEY,
  book_ref TEXT NOT NULL,
  chapter_id INTEGER NOT NULL,
  author_telegram_id TEXT NOT NULL,
  parent_comment_id TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (author_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_comment_id) REFERENCES reader_chapter_comments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reader_chapter_comments_chapter_created
  ON reader_chapter_comments(book_ref, chapter_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_reader_chapter_comments_parent_created
  ON reader_chapter_comments(parent_comment_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_reader_chapter_comments_author_created
  ON reader_chapter_comments(author_telegram_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reader_chapter_comment_votes (
  comment_id TEXT NOT NULL,
  voter_telegram_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK(value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (comment_id, voter_telegram_id),
  FOREIGN KEY (comment_id) REFERENCES reader_chapter_comments(id) ON DELETE CASCADE,
  FOREIGN KEY (voter_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reader_chapter_comment_votes_voter
  ON reader_chapter_comment_votes(voter_telegram_id, updated_at DESC);
