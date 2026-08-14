CREATE TABLE IF NOT EXISTS ranobelib_titles (
  book_ref TEXT PRIMARY KEY,
  ranobelib_id INTEGER,
  slug TEXT,
  url TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  cover_url TEXT,
  chapter_count INTEGER NOT NULL DEFAULT 0,
  latest_chapter_id INTEGER,
  latest_volume TEXT,
  latest_number TEXT,
  latest_name TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  snapshot_ready INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at TEXT,
  last_release_at TEXT,
  sync_error TEXT
);

CREATE TABLE IF NOT EXISTS ranobelib_chapters (
  book_ref TEXT NOT NULL,
  chapter_id INTEGER NOT NULL,
  volume TEXT NOT NULL,
  number TEXT NOT NULL,
  name TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (book_ref, chapter_id),
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ranobelib_releases (
  id TEXT PRIMARY KEY,
  book_ref TEXT NOT NULL,
  title_snapshot TEXT NOT NULL,
  chapter_count INTEGER NOT NULL,
  first_chapter_id INTEGER,
  first_volume TEXT,
  first_number TEXT,
  last_chapter_id INTEGER,
  last_volume TEXT,
  last_number TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ranobelib_titles_active_release
  ON ranobelib_titles(is_active, last_release_at DESC, last_synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_ranobelib_chapters_book
  ON ranobelib_chapters(book_ref, chapter_id);
CREATE INDEX IF NOT EXISTS idx_ranobelib_releases_created
  ON ranobelib_releases(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ranobelib_releases_book_created
  ON ranobelib_releases(book_ref, created_at DESC);
