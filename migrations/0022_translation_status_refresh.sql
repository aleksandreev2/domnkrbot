ALTER TABLE ranobelib_titles
ADD COLUMN translation_status_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_ranobelib_titles_translation_status_checked
  ON ranobelib_titles(translation_status_checked_at, translation_is_completed);
