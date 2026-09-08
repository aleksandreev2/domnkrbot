ALTER TABLE telegram_subscription_settings ADD COLUMN stack_size INTEGER;

CREATE TABLE telegram_title_delivery_settings (
  user_telegram_id TEXT NOT NULL,
  book_ref TEXT NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('instant','stack')),
  stack_size INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, book_ref),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE,
  CHECK (
    (delivery_mode = 'instant' AND stack_size IS NULL)
    OR
    (delivery_mode = 'stack' AND stack_size BETWEEN 2 AND 100)
  )
);

CREATE TABLE telegram_notification_input_state (
  user_telegram_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','title')),
  book_ref TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE,
  CHECK (
    (scope = 'global' AND book_ref IS NULL)
    OR
    (scope = 'title' AND book_ref IS NOT NULL)
  )
);

CREATE INDEX idx_telegram_title_delivery_book
  ON telegram_title_delivery_settings(book_ref, user_telegram_id);

CREATE INDEX idx_telegram_notification_input_expiry
  ON telegram_notification_input_state(expires_at);
