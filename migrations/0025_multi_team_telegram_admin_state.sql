-- Resumable Telegram admin input for multi-team management.
-- Additive only; safe to leave in place when multi-team rollout flags are disabled.

CREATE TABLE IF NOT EXISTS telegram_team_admin_input (
  user_telegram_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('add_team', 'recommendation_channel')),
  team_id INTEGER,
  draft_team_ref TEXT,
  draft_display_name TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES ranobelib_teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_team_admin_input_expiry
  ON telegram_team_admin_input(expires_at);
