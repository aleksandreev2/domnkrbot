DROP TRIGGER IF EXISTS trg_ranobelib_release_notifications;

DROP TABLE IF EXISTS telegram_subscription_settings_v2;
CREATE TABLE telegram_subscription_settings_v2 (
  user_telegram_id TEXT PRIMARY KEY,
  all_titles INTEGER NOT NULL DEFAULT 0 CHECK (all_titles IN (0, 1)),
  delivery_mode TEXT NOT NULL DEFAULT 'instant',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

INSERT INTO telegram_subscription_settings_v2 (user_telegram_id, all_titles, delivery_mode, updated_at)
SELECT user_telegram_id, all_titles, 'instant', updated_at
FROM telegram_subscription_settings;

DROP TABLE telegram_subscription_settings;
ALTER TABLE telegram_subscription_settings_v2 RENAME TO telegram_subscription_settings;

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
