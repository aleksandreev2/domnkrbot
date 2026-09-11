CREATE TABLE IF NOT EXISTS ranobelib_auth_credentials (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  access_expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'expired', 'invalid')),
  last_validated_at TEXT,
  last_refreshed_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
