CREATE TABLE IF NOT EXISTS publication_deliveries (
  publication_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  user_telegram_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  first_delivered_at TEXT,
  last_delivered_at TEXT,
  telegram_message_id INTEGER,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (publication_id, asset_id, user_telegram_id),
  FOREIGN KEY(publication_id) REFERENCES publications(id) ON DELETE CASCADE,
  FOREIGN KEY(asset_id) REFERENCES publication_assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS publication_reader_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL,
  asset_id INTEGER,
  user_telegram_id TEXT,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'bot',
  success INTEGER NOT NULL DEFAULT 1,
  repeat INTEGER NOT NULL DEFAULT 0,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(publication_id) REFERENCES publications(id) ON DELETE CASCADE,
  FOREIGN KEY(asset_id) REFERENCES publication_assets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS publication_thanks (
  publication_id INTEGER NOT NULL,
  user_telegram_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (publication_id, user_telegram_id),
  FOREIGN KEY(publication_id) REFERENCES publications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_publication_deliveries_user_updated
  ON publication_deliveries(user_telegram_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_publication_reader_events_created
  ON publication_reader_events(created_at DESC, event_type);
CREATE INDEX IF NOT EXISTS idx_publication_reader_events_publication
  ON publication_reader_events(publication_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_publication_reader_events_user
  ON publication_reader_events(user_telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_publication_thanks_created
  ON publication_thanks(created_at DESC);
