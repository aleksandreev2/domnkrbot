CREATE TABLE IF NOT EXISTS web_collections (
  id TEXT PRIMARY KEY,
  owner_telegram_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_collections_public_updated
  ON web_collections(is_public, updated_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_collections_owner_updated
  ON web_collections(owner_telegram_id, updated_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS web_collection_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id TEXT NOT NULL,
  book_ref TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (collection_id, book_ref),
  FOREIGN KEY (collection_id) REFERENCES web_collections(id) ON DELETE CASCADE,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_collection_items_collection_position
  ON web_collection_items(collection_id, group_name, position, id);
CREATE INDEX IF NOT EXISTS idx_web_collection_items_book
  ON web_collection_items(book_ref, collection_id);
