CREATE TABLE IF NOT EXISTS reader_chapter_thanks (
  book_ref TEXT NOT NULL,
  chapter_id INTEGER NOT NULL,
  user_telegram_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (book_ref, chapter_id, user_telegram_id),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reader_chapter_thanks_chapter
  ON reader_chapter_thanks(book_ref, chapter_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reader_chapter_ratings (
  book_ref TEXT NOT NULL,
  chapter_id INTEGER NOT NULL,
  user_telegram_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 10),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (book_ref, chapter_id, user_telegram_id),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reader_chapter_ratings_chapter
  ON reader_chapter_ratings(book_ref, chapter_id, updated_at DESC);
