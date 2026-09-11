-- Team-scoped completion lifecycle.
-- Discovery records attributable completion evidence on the exact (team, work) relation and wakes
-- one final chapter poll. Scanner clears pending only after that successful attributable poll.
ALTER TABLE ranobelib_team_translations
ADD COLUMN completion_pending INTEGER NOT NULL DEFAULT 0
  CHECK (completion_pending IN (0, 1));

ALTER TABLE ranobelib_team_translations
ADD COLUMN completion_revision INTEGER NOT NULL DEFAULT 0
  CHECK (completion_revision >= 0);

CREATE INDEX IF NOT EXISTS idx_ranobelib_team_translations_completion_pending
  ON ranobelib_team_translations(completion_pending, presence_state, team_id, book_ref);
