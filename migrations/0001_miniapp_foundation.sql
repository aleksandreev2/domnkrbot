PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  language_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chapter_proposals (
  id TEXT PRIMARY KEY,
  user_telegram_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  proposal_type TEXT NOT NULL CHECK (proposal_type IN ('title', 'chapters')),
  title TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  chapter_from REAL,
  chapter_to REAL,
  comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'planned', 'in_progress', 'done', 'rejected')),
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    proposal_type = 'title'
    OR (chapter_from IS NOT NULL AND chapter_to IS NOT NULL AND chapter_from >= 0 AND chapter_to >= chapter_from)
  )
);

CREATE INDEX IF NOT EXISTS idx_chapter_proposals_status_created
  ON chapter_proposals(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chapter_proposals_user_created
  ON chapter_proposals(user_telegram_id, created_at DESC);
