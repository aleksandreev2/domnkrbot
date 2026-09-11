-- Stable delivery grouping for multi-team chapter branches.
-- Legacy releases keep NULL and continue to group by work while the rollout flag is disabled.

ALTER TABLE ranobelib_releases
  ADD COLUMN delivery_scope_key TEXT;

-- Multi-team release ids already encode the stable branch key before the final chapter-id suffix.
-- Backfill any rows created during a deployment overlap without rewriting legacy release identity.
-- Use exact prefix equality so stored book_ref data cannot hit SQLite pattern-length limits.
UPDATE ranobelib_releases
SET delivery_scope_key = substr(
  substr(id, length('branch-release:v1:' || book_ref || ':') + 1),
  1,
  instr(substr(id, length('branch-release:v1:' || book_ref || ':') + 1), ':') - 1
)
WHERE delivery_scope_key IS NULL
  AND substr(id, 1, length('branch-release:v1:' || book_ref || ':')) = 'branch-release:v1:' || book_ref || ':';

-- Keep new branch releases scoped without coupling the scanner insert path to rollout-only schema.
-- encodeURIComponent() escapes ':' inside branch keys, so the first ':' after the prefix is the
-- unambiguous delimiter before the comma-separated chapter id suffix.
CREATE TRIGGER IF NOT EXISTS trg_ranobelib_release_delivery_scope
AFTER INSERT ON ranobelib_releases
WHEN NEW.delivery_scope_key IS NULL
  AND substr(NEW.id, 1, length('branch-release:v1:' || NEW.book_ref || ':')) = 'branch-release:v1:' || NEW.book_ref || ':'
BEGIN
  UPDATE ranobelib_releases
  SET delivery_scope_key = substr(
    substr(id, length('branch-release:v1:' || book_ref || ':') + 1),
    1,
    instr(substr(id, length('branch-release:v1:' || book_ref || ':') + 1), ':') - 1
  )
  WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_ranobelib_releases_delivery_scope
  ON ranobelib_releases(book_ref, delivery_scope_key, created_at);
