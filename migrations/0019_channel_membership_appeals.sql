CREATE TABLE channel_membership_appeals (
  id TEXT PRIMARY KEY,
  user_telegram_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  user_comment TEXT NOT NULL DEFAULT '',
  admin_comment TEXT,
  submitted_at TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_channel_membership_appeals_user
  ON channel_membership_appeals(user_telegram_id, created_at DESC);

CREATE INDEX idx_channel_membership_appeals_status
  ON channel_membership_appeals(status, submitted_at DESC, created_at DESC);

CREATE UNIQUE INDEX idx_channel_membership_appeals_one_open
  ON channel_membership_appeals(user_telegram_id)
  WHERE status IN ('draft', 'pending');
