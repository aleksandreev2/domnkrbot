ALTER TABLE ranobelib_titles
ADD COLUMN translation_is_completed INTEGER CHECK (translation_is_completed IN (0, 1));

ALTER TABLE ranobelib_titles
ADD COLUMN translation_completion_pending INTEGER NOT NULL DEFAULT 0
  CHECK (translation_completion_pending IN (0, 1));

-- Backfill only semantic labels we already know. Numeric RanobeLib status IDs are not stable
-- completion identifiers. Historical completion is classification, not a fresh transition, so
-- pending stays at its default 0 and no synthetic completion release is created.
UPDATE ranobelib_titles
SET translation_is_completed = CASE
  WHEN TRIM(COALESCE(translation_status_label, '')) IN ('Завершён', 'Завершен', 'завершён', 'завершен') THEN 1
  WHEN TRIM(COALESCE(translation_status_label, '')) <> '' THEN 0
  ELSE NULL
END;

DROP TRIGGER IF EXISTS trg_ranobelib_translation_completed;

CREATE INDEX IF NOT EXISTS idx_ranobelib_titles_translation_completed
  ON ranobelib_titles(translation_is_completed, is_active, title);

CREATE INDEX IF NOT EXISTS idx_ranobelib_titles_completion_pending
  ON ranobelib_titles(translation_completion_pending, is_active, next_check_at);

-- Discovery marks a known 0 -> 1 transition as logically completed/inactive immediately and sets
-- pending=1. The fast scanner explicitly includes pending rows even though they are inactive and
-- clears pending only after a successful final chapter poll. This trigger therefore inserts the
-- completion release after any final chapter release, eliminating the discovery/scan race.
-- NULL -> 1 historical/initial classification never enters pending and remains silent.
CREATE TRIGGER IF NOT EXISTS trg_ranobelib_translation_completed
AFTER UPDATE OF translation_completion_pending ON ranobelib_titles
WHEN OLD.translation_completion_pending = 1
  AND NEW.translation_completion_pending = 0
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
