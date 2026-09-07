ALTER TABLE ranobelib_titles ADD COLUMN next_check_at TEXT;
ALTER TABLE ranobelib_titles ADD COLUMN last_change_at TEXT;
ALTER TABLE ranobelib_titles ADD COLUMN consecutive_no_change INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ranobelib_titles ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ranobelib_titles ADD COLUMN scan_priority INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ranobelib_notification_outbox ADD COLUMN claim_token TEXT;
ALTER TABLE ranobelib_notification_outbox ADD COLUMN claim_expires_at TEXT;

UPDATE ranobelib_titles
SET next_check_at = CURRENT_TIMESTAMP
WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS idx_ranobelib_titles_due_scan
  ON ranobelib_titles(is_active, snapshot_ready, next_check_at, scan_priority);

CREATE INDEX IF NOT EXISTS idx_ranobelib_notification_due_v3
  ON ranobelib_notification_outbox(status, available_at, claim_expires_at, release_id, user_telegram_id);
