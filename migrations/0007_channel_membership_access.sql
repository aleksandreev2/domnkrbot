CREATE TABLE IF NOT EXISTS channel_access_state (
  user_telegram_id TEXT PRIMARY KEY,
  last_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TEXT,
  left_at TEXT,
  rejoined_at TEXT,
  blacklisted_at TEXT,
  blacklist_reason TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_channel_access_blacklisted
  ON channel_access_state(blacklisted_at DESC);

CREATE INDEX IF NOT EXISTS idx_channel_access_left
  ON channel_access_state(left_at, blacklisted_at);
