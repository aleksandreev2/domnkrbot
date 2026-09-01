CREATE TABLE IF NOT EXISTS telegram_subscription_settings (
  user_telegram_id TEXT PRIMARY KEY,
  all_titles INTEGER NOT NULL DEFAULT 0 CHECK (all_titles IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS title_subscriptions (
  user_telegram_id TEXT NOT NULL,
  book_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, book_ref),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ranobelib_notification_outbox (
  release_id TEXT NOT NULL,
  user_telegram_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retry', 'sent', 'disabled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (release_id, user_telegram_id),
  FOREIGN KEY (release_id) REFERENCES ranobelib_releases(id) ON DELETE CASCADE,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_title_subscriptions_book
  ON title_subscriptions(book_ref, user_telegram_id);

CREATE INDEX IF NOT EXISTS idx_ranobelib_notification_pending
  ON ranobelib_notification_outbox(status, available_at, created_at);

CREATE TRIGGER IF NOT EXISTS trg_ranobelib_release_notifications
AFTER INSERT ON ranobelib_releases
BEGIN
  INSERT OR IGNORE INTO ranobelib_notification_outbox (release_id, user_telegram_id)
  SELECT NEW.id, user_telegram_id
  FROM telegram_subscription_settings
  WHERE all_titles = 1
  UNION
  SELECT NEW.id, user_telegram_id
  FROM title_subscriptions
  WHERE book_ref = NEW.book_ref;
END;
