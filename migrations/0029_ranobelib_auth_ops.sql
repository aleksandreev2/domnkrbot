ALTER TABLE ranobelib_auth_credentials
ADD COLUMN refresh_failures INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ranobelib_auth_credentials
ADD COLUMN last_refresh_failure_at TEXT;
