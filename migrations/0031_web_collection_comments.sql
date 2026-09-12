CREATE TABLE IF NOT EXISTS web_collection_comments (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  author_telegram_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (collection_id) REFERENCES web_collections(id) ON DELETE CASCADE,
  FOREIGN KEY (author_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_collection_comments_collection_created
  ON web_collection_comments(collection_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_web_collection_comments_author_created
  ON web_collection_comments(author_telegram_id, created_at DESC);
