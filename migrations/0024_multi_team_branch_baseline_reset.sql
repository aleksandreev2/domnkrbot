-- The legacy snapshot stores chapters only by chapter_id and contains no branch identity.
-- Therefore a legacy snapshot_ready=1 row is NOT a valid branch-aware baseline. Force every
-- migrated primary-team relationship through one silent branch-aware baseline before shadow/live
-- release detection can consider any upstream branch fresh.
UPDATE ranobelib_team_translations
SET baseline_ready = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE team_id = (
  SELECT id FROM ranobelib_teams WHERE is_primary = 1 LIMIT 1
);
