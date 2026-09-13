PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS web_title_reviews (
  id TEXT PRIMARY KEY,
  book_ref TEXT NOT NULL,
  author_telegram_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  UNIQUE (book_ref, author_telegram_id),
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE,
  FOREIGN KEY (author_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_title_reviews_book_created
  ON web_title_reviews(book_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_title_reviews_author
  ON web_title_reviews(author_telegram_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS web_title_review_votes (
  review_id TEXT NOT NULL,
  voter_telegram_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (review_id, voter_telegram_id),
  FOREIGN KEY (review_id) REFERENCES web_title_reviews(id) ON DELETE CASCADE,
  FOREIGN KEY (voter_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_title_review_votes_voter
  ON web_title_review_votes(voter_telegram_id, updated_at DESC);
