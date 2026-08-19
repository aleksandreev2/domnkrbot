CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'draft',
  internal_title TEXT NOT NULL,
  body_html TEXT NOT NULL,
  add_footer INTEGER NOT NULL DEFAULT 1,
  add_bot_comment INTEGER NOT NULL DEFAULT 1,
  image_key TEXT,
  image_mime TEXT,
  image_name TEXT,
  channel_message_id INTEGER,
  discussion_message_id INTEGER,
  error_text TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS publication_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  telegram_file_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(publication_id) REFERENCES publications(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS publication_editor_drafts (
  admin_user_id TEXT PRIMARY KEY,
  internal_title TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  add_footer INTEGER NOT NULL DEFAULT 1,
  add_bot_comment INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS publication_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  internal_title TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  add_footer INTEGER NOT NULL DEFAULT 1,
  add_bot_comment INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS publication_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_publications_status_created
  ON publications(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_publication_assets_publication
  ON publication_assets(publication_id, sort_order, id);
