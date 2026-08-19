CREATE TABLE IF NOT EXISTS publication_asset_cache_locks (
  asset_id INTEGER PRIMARY KEY,
  owner_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES publication_assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_publication_asset_cache_locks_expires
  ON publication_asset_cache_locks(expires_at);
