-- Stable delivery grouping for multi-team chapter branches.
-- Legacy releases keep NULL and continue to group by work while the rollout flag is disabled.

ALTER TABLE ranobelib_releases
  ADD COLUMN delivery_scope_key TEXT;

CREATE INDEX IF NOT EXISTS idx_ranobelib_releases_delivery_scope
  ON ranobelib_releases(book_ref, delivery_scope_key, created_at);
