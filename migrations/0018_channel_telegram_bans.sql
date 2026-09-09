CREATE TABLE channel_telegram_bans (
  user_telegram_id TEXT PRIMARY KEY,
  banned_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_channel_telegram_bans_pending
  ON channel_telegram_bans(banned_at, last_attempt_at);
