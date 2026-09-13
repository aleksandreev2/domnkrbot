CREATE TABLE IF NOT EXISTS web_title_user_state (
  book_ref TEXT NOT NULL,
  user_telegram_id TEXT NOT NULL,
  list_status TEXT CHECK(list_status IN ('reading', 'planned', 'dropped', 'completed', 'favorite', 'other')),
  rating INTEGER CHECK(rating BETWEEN 1 AND 10),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (book_ref, user_telegram_id),
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_title_user_state_list
  ON web_title_user_state(book_ref, list_status);

CREATE INDEX IF NOT EXISTS idx_web_title_user_state_rating
  ON web_title_user_state(book_ref, rating);

CREATE INDEX IF NOT EXISTS idx_web_title_user_state_user
  ON web_title_user_state(user_telegram_id, updated_at DESC);
