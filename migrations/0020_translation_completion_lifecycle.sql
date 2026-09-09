ALTER TABLE ranobelib_titles
ADD COLUMN translation_status_id INTEGER;

ALTER TABLE ranobelib_titles
ADD COLUMN translation_status_label TEXT;

ALTER TABLE ranobelib_titles
ADD COLUMN translation_status_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ranobelib_titles
ADD COLUMN translation_status_changed_at TEXT;

ALTER TABLE ranobelib_releases
ADD COLUMN release_kind TEXT NOT NULL DEFAULT 'chapters';

CREATE INDEX IF NOT EXISTS idx_ranobelib_titles_translation_status
  ON ranobelib_titles(translation_status_id, is_active, title);

CREATE INDEX IF NOT EXISTS idx_ranobelib_releases_kind_created
  ON ranobelib_releases(release_kind, created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_notification_callback_dedup (
  callback_query_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_telegram_notification_callback_dedup_created
  ON telegram_notification_callback_dedup(created_at);

-- A completion event is emitted only for an observed transition from a known non-completed
-- translation status to "completed". The first discovery after this migration therefore
-- cannot send historical completion notices for titles that were already complete.
CREATE TRIGGER IF NOT EXISTS trg_ranobelib_translation_completed
AFTER UPDATE OF translation_status_id ON ranobelib_titles
WHEN OLD.translation_status_id IS NOT NULL
  AND OLD.translation_status_id <> 2
  AND NEW.translation_status_id = 2
BEGIN
  INSERT OR IGNORE INTO ranobelib_releases (
    id,
    book_ref,
    title_snapshot,
    chapter_count,
    first_chapter_id,
    first_volume,
    first_number,
    last_chapter_id,
    last_volume,
    last_number,
    summary,
    release_kind,
    created_at
  ) VALUES (
    'translation-completed:' || NEW.book_ref || ':' || NEW.translation_status_revision,
    NEW.book_ref,
    COALESCE(NEW.title, NEW.slug, NEW.book_ref),
    0,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    'Перевод завершён',
    'translation_completed',
    CURRENT_TIMESTAMP
  );
END;
