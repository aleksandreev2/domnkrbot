ALTER TABLE telegram_proposal_sessions
  ADD COLUMN return_to_review INTEGER NOT NULL DEFAULT 0 CHECK (return_to_review IN (0, 1));

CREATE TABLE telegram_notification_search_state (
  user_telegram_id TEXT PRIMARY KEY,
  query TEXT NOT NULL DEFAULT '',
  page INTEGER NOT NULL DEFAULT 0,
  return_scope TEXT NOT NULL DEFAULT 'home'
    CHECK (return_scope IN ('home', 'mine', 'all')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX idx_telegram_notification_search_expiry
  ON telegram_notification_search_state(expires_at);
