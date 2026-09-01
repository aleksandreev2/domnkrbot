ALTER TABLE telegram_subscription_settings
  ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'instant';

CREATE TABLE IF NOT EXISTS title_subscription_exclusions (
  user_telegram_id TEXT NOT NULL,
  book_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, book_ref),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_title_subscription_exclusions_book
  ON title_subscription_exclusions(book_ref, user_telegram_id);

DROP TRIGGER IF EXISTS trg_ranobelib_release_notifications;

CREATE TRIGGER trg_ranobelib_release_notifications
AFTER INSERT ON ranobelib_releases
BEGIN
  INSERT OR IGNORE INTO ranobelib_notification_outbox (release_id, user_telegram_id)
  SELECT NEW.id, s.user_telegram_id
  FROM telegram_subscription_settings s
  WHERE s.all_titles = 1
    AND NOT EXISTS (
      SELECT 1
      FROM title_subscription_exclusions e
      WHERE e.user_telegram_id = s.user_telegram_id
        AND e.book_ref = NEW.book_ref
    )
  UNION
  SELECT NEW.id, ts.user_telegram_id
  FROM title_subscriptions ts
  WHERE ts.book_ref = NEW.book_ref
    AND NOT EXISTS (
      SELECT 1
      FROM telegram_subscription_settings s
      WHERE s.user_telegram_id = ts.user_telegram_id
        AND s.all_titles = 1
    );
END;
