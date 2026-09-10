-- Multi-team RanobeLib notifications foundation.
-- Additive/forward-only by design: the legacy single-team tables and delivery trigger remain
-- authoritative until an explicit rollout flag switches production to the new model.

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ranobelib_teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ranobelib_team_id INTEGER NOT NULL,
  ranobelib_team_ref TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  lifecycle_state TEXT NOT NULL DEFAULT 'hidden'
    CHECK (lifecycle_state IN ('hidden', 'published', 'paused', 'error')),
  recommendation_chat_id TEXT,
  recommendation_chat_title TEXT,
  recommendation_chat_username TEXT,
  recommendation_membership_capable INTEGER NOT NULL DEFAULT 0
    CHECK (recommendation_membership_capable IN (0, 1)),
  last_sync_at TEXT,
  last_sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ranobelib_one_primary_team
  ON ranobelib_teams(is_primary) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS idx_ranobelib_teams_lifecycle
  ON ranobelib_teams(lifecycle_state, is_primary DESC, display_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS ranobelib_team_translations (
  team_id INTEGER NOT NULL,
  book_ref TEXT NOT NULL,
  presence_state TEXT NOT NULL DEFAULT 'active'
    CHECK (presence_state IN ('active', 'dormant')),
  semantic_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (semantic_status IN ('active', 'completed', 'unknown')),
  completion_evidence TEXT,
  baseline_ready INTEGER NOT NULL DEFAULT 0 CHECK (baseline_ready IN (0, 1)),
  notification_subscriber_count INTEGER NOT NULL DEFAULT 0
    CHECK (notification_subscriber_count >= 0),
  last_seen_at TEXT,
  last_synced_at TEXT,
  sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, book_ref),
  FOREIGN KEY (team_id) REFERENCES ranobelib_teams(id) ON DELETE CASCADE,
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ranobelib_team_translations_book
  ON ranobelib_team_translations(book_ref, team_id);
CREATE INDEX IF NOT EXISTS idx_ranobelib_team_translations_team_state
  ON ranobelib_team_translations(team_id, presence_state, semantic_status, book_ref);
CREATE INDEX IF NOT EXISTS idx_ranobelib_team_translations_demand
  ON ranobelib_team_translations(notification_subscriber_count DESC, team_id, book_ref);

CREATE TABLE IF NOT EXISTS ranobelib_chapter_branches (
  book_ref TEXT NOT NULL,
  chapter_id INTEGER NOT NULL,
  branch_key TEXT NOT NULL,
  native_branch_id INTEGER,
  identity_confidence TEXT NOT NULL
    CHECK (identity_confidence IN ('native', 'fallback', 'ambiguous')),
  volume TEXT NOT NULL,
  number TEXT NOT NULL,
  name TEXT,
  released_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (book_ref, chapter_id, branch_key),
  FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ranobelib_chapter_branches_native
  ON ranobelib_chapter_branches(book_ref, native_branch_id)
  WHERE native_branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ranobelib_chapter_branches_release
  ON ranobelib_chapter_branches(book_ref, released_at, chapter_id);

CREATE TABLE IF NOT EXISTS ranobelib_chapter_branch_teams (
  book_ref TEXT NOT NULL,
  chapter_id INTEGER NOT NULL,
  branch_key TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (book_ref, chapter_id, branch_key, team_id),
  FOREIGN KEY (book_ref, chapter_id, branch_key)
    REFERENCES ranobelib_chapter_branches(book_ref, chapter_id, branch_key)
    ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES ranobelib_teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ranobelib_chapter_branch_teams_team
  ON ranobelib_chapter_branch_teams(team_id, book_ref, chapter_id);

CREATE TABLE IF NOT EXISTS ranobelib_release_teams (
  release_id TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (release_id, team_id),
  FOREIGN KEY (release_id) REFERENCES ranobelib_releases(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES ranobelib_teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ranobelib_release_teams_team
  ON ranobelib_release_teams(team_id, release_id);

CREATE TABLE IF NOT EXISTS telegram_team_subscriptions (
  user_telegram_id TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, team_id),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES ranobelib_teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_team_subscriptions_team
  ON telegram_team_subscriptions(team_id, user_telegram_id);

CREATE TABLE IF NOT EXISTS telegram_team_title_subscriptions (
  user_telegram_id TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  book_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, team_id, book_ref),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id, book_ref)
    REFERENCES ranobelib_team_translations(team_id, book_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_team_title_subscriptions_target
  ON telegram_team_title_subscriptions(team_id, book_ref, user_telegram_id);

CREATE TABLE IF NOT EXISTS telegram_team_title_exclusions (
  user_telegram_id TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  book_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, team_id, book_ref),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id, book_ref)
    REFERENCES ranobelib_team_translations(team_id, book_ref) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_team_title_exclusions_target
  ON telegram_team_title_exclusions(team_id, book_ref, user_telegram_id);

CREATE TABLE IF NOT EXISTS telegram_team_title_delivery_settings (
  user_telegram_id TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  book_ref TEXT NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('instant', 'stack')),
  stack_size INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_telegram_id, team_id, book_ref),
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (team_id, book_ref)
    REFERENCES ranobelib_team_translations(team_id, book_ref) ON DELETE CASCADE,
  CHECK (
    (delivery_mode = 'instant' AND stack_size IS NULL)
    OR
    (delivery_mode = 'stack' AND stack_size BETWEEN 2 AND 100)
  )
);

CREATE INDEX IF NOT EXISTS idx_telegram_team_title_delivery_target
  ON telegram_team_title_delivery_settings(team_id, book_ref, user_telegram_id);

CREATE TABLE IF NOT EXISTS telegram_notification_onboarding (
  user_telegram_id TEXT PRIMARY KEY,
  completed_at TEXT,
  completion_reason TEXT
    CHECK (completion_reason IS NULL OR completion_reason IN ('team_selected', 'not_now')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  CHECK (
    (completed_at IS NULL AND completion_reason IS NULL)
    OR
    (completed_at IS NOT NULL AND completion_reason IS NOT NULL)
  )
);

-- Rollout flags are intentionally independent. The new schema can be deployed and backfilled
-- while legacy discovery, release creation and Telegram UX continue to be authoritative.
INSERT OR IGNORE INTO app_settings (key, value)
VALUES
  ('ranobelib_multi_team_shadow', '0'),
  ('ranobelib_multi_team_delivery', '0'),
  ('ranobelib_multi_team_ui', '0');

-- Seed the bot's existing team. This is the only automatic team subscription target for legacy
-- state; new/external teams are never enabled by migration.
INSERT OR IGNORE INTO ranobelib_teams (
  ranobelib_team_id,
  ranobelib_team_ref,
  display_name,
  is_primary,
  lifecycle_state
) VALUES (
  11969,
  '11969--dom-nekromanta',
  'Дом Некроманта',
  1,
  'published'
);

-- Existing catalog rows were discovered from Дом Некроманта only, so mapping them to the primary
-- team is a faithful compatibility baseline. Do not synthesize releases/outbox rows here.
INSERT OR IGNORE INTO ranobelib_team_translations (
  team_id,
  book_ref,
  presence_state,
  semantic_status,
  completion_evidence,
  baseline_ready,
  notification_subscriber_count,
  last_seen_at,
  last_synced_at,
  sync_error
)
SELECT
  p.id,
  t.book_ref,
  CASE WHEN t.is_active = 1 OR COALESCE(t.translation_is_completed, 0) = 1 THEN 'active' ELSE 'dormant' END,
  CASE
    WHEN t.translation_is_completed = 1 THEN 'completed'
    WHEN t.is_active = 1 THEN 'active'
    ELSE 'unknown'
  END,
  CASE WHEN t.translation_is_completed = 1 THEN 'legacy-primary-team' ELSE NULL END,
  CASE WHEN t.snapshot_ready = 1 THEN 1 ELSE 0 END,
  COALESCE(t.notification_subscriber_count, 0),
  COALESCE(t.last_synced_at, t.first_seen_at),
  t.last_synced_at,
  t.sync_error
FROM ranobelib_titles t
CROSS JOIN ranobelib_teams p
WHERE p.is_primary = 1;

-- Legacy "all titles" becomes "all Дом Некроманта translations", never "all teams".
INSERT OR IGNORE INTO telegram_team_subscriptions (user_telegram_id, team_id, created_at)
SELECT s.user_telegram_id, p.id, COALESCE(s.updated_at, CURRENT_TIMESTAMP)
FROM telegram_subscription_settings s
CROSS JOIN ranobelib_teams p
WHERE p.is_primary = 1
  AND s.all_titles = 1;

-- Explicit subscriptions/exclusions and delivery overrides are migrated only where the primary
-- team/work relationship exists. Legacy rows remain untouched during the compatibility window.
INSERT OR IGNORE INTO telegram_team_title_subscriptions (user_telegram_id, team_id, book_ref, created_at)
SELECT s.user_telegram_id, p.id, s.book_ref, s.created_at
FROM title_subscriptions s
CROSS JOIN ranobelib_teams p
JOIN ranobelib_team_translations tt
  ON tt.team_id = p.id AND tt.book_ref = s.book_ref
WHERE p.is_primary = 1;

INSERT OR IGNORE INTO telegram_team_title_exclusions (user_telegram_id, team_id, book_ref, created_at)
SELECT e.user_telegram_id, p.id, e.book_ref, e.created_at
FROM title_subscription_exclusions e
CROSS JOIN ranobelib_teams p
JOIN ranobelib_team_translations tt
  ON tt.team_id = p.id AND tt.book_ref = e.book_ref
WHERE p.is_primary = 1;

INSERT OR IGNORE INTO telegram_team_title_delivery_settings (
  user_telegram_id,
  team_id,
  book_ref,
  delivery_mode,
  stack_size,
  updated_at
)
SELECT d.user_telegram_id, p.id, d.book_ref, d.delivery_mode, d.stack_size, d.updated_at
FROM telegram_title_delivery_settings d
CROSS JOIN ranobelib_teams p
JOIN ranobelib_team_translations tt
  ON tt.team_id = p.id AND tt.book_ref = d.book_ref
WHERE p.is_primary = 1;
