ALTER TABLE ranobelib_titles
ADD COLUMN translation_is_completed INTEGER CHECK (translation_is_completed IN (0, 1));

-- Backfill only statuses we already know. This happens before replacing the trigger, so
-- historical completed translations cannot generate synthetic "just completed" releases.
UPDATE ranobelib_titles
SET translation_is_completed = CASE
  WHEN translation_status_id = 2 OR TRIM(COALESCE(translation_status_label, '')) = 'Завершён' THEN 1
  WHEN translation_status_id IS NOT NULL OR TRIM(COALESCE(translation_status_label, '')) <> '' THEN 0
  ELSE NULL
END;

DROP TRIGGER IF EXISTS trg_ranobelib_translation_completed;

CREATE INDEX IF NOT EXISTS idx_ranobelib_titles_translation_completed
  ON ranobelib_titles(translation_is_completed, is_active, title);

-- Notify only on a real, previously known transition 0 -> 1. NULL -> 1 is initial
-- classification of an existing title and is intentionally silent.
CREATE TRIGGER IF NOT EXISTS trg_ranobelib_translation_completed
AFTER UPDATE OF translation_is_completed ON ranobelib_titles
WHEN OLD.translation_is_completed = 0
  AND NEW.translation_is_completed = 1
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
