ALTER TABLE ranobelib_titles
ADD COLUMN notification_subscriber_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ranobelib_titles
ADD COLUMN subscriber_count_updated_at TEXT;

CREATE TABLE IF NOT EXISTS telegram_delivery_reachability (
  user_telegram_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','blocked')),
  blocked_at TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_delivery_reachability_state
ON telegram_delivery_reachability(state, user_telegram_id);

CREATE INDEX IF NOT EXISTS idx_ranobelib_titles_notification_demand
ON ranobelib_titles(is_active, notification_subscriber_count, next_check_at, scan_priority);

-- Existing users have no reachability row and are intentionally treated as reachable.
-- Initialize every active title from the same effective-subscription semantics used by delivery.
UPDATE ranobelib_titles
SET
  notification_subscriber_count = (
    SELECT COUNT(*)
    FROM (
      SELECT s.user_telegram_id
      FROM telegram_subscription_settings s
      LEFT JOIN telegram_delivery_reachability reach
        ON reach.user_telegram_id = s.user_telegram_id
      WHERE s.all_titles = 1
        AND COALESCE(reach.state, 'active') != 'blocked'
        AND NOT EXISTS (
          SELECT 1
          FROM title_subscription_exclusions e
          WHERE e.user_telegram_id = s.user_telegram_id
            AND e.book_ref = ranobelib_titles.book_ref
        )
      UNION
      SELECT ts.user_telegram_id
      FROM title_subscriptions ts
      LEFT JOIN telegram_subscription_settings s2
        ON s2.user_telegram_id = ts.user_telegram_id
      LEFT JOIN telegram_delivery_reachability reach2
        ON reach2.user_telegram_id = ts.user_telegram_id
      WHERE ts.book_ref = ranobelib_titles.book_ref
        AND COALESCE(s2.all_titles, 0) != 1
        AND COALESCE(reach2.state, 'active') != 'blocked'
    ) effective_recipients
  ),
  subscriber_count_updated_at = CURRENT_TIMESTAMP
WHERE is_active = 1;
