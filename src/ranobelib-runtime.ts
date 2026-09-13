type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch?(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

export interface RanobeLibRuntimeEnv {
  DB: D1DatabaseLike;
  RANOBELIB_TEAM_REF?: string;
}

export type RanobeLibTitleCard = {
  book_ref: string;
  url: string;
  title: string;
  summary: string | null;
  cover_url: string | null;
  chapter_count: number;
  latest_chapter_id: number | null;
  latest_volume: string | null;
  latest_number: string | null;
  latest_name: string | null;
  last_synced_at: string | null;
  last_release_at: string | null;
};

export type RanobeLibCatalogTitleCard = RanobeLibTitleCard & {
  translation_semantic_status: 'active' | 'completed' | 'unknown';
  translation_status_label: string | null;
};

export type RanobeLibReleaseCard = {
  id: string;
  book_ref: string;
  url: string;
  title: string;
  cover_url: string | null;
  chapter_count: number;
  first_volume: string | null;
  first_number: string | null;
  last_volume: string | null;
  last_number: string | null;
  summary: string;
  created_at: string;
};

export type RanobeLibHomeData = {
  teamRef: string;
  titles: RanobeLibTitleCard[];
  catalogTitles: RanobeLibCatalogTitleCard[];
  releases: RanobeLibReleaseCard[];
  stats: {
    activeTitles: number;
    syncedTitles: number;
    releases: number;
  };
  sync: {
    lastSyncAt: string | null;
    lastError: string | null;
    cursor: number;
    syncing: boolean;
  };
};

export type RanobeLibSyncResult = {
  teamRef: string;
  discovered: number;
  processed: number;
  succeeded: number;
  failed: number;
  newReleases: number;
  nextCursor: number;
  errors: string[];
};

const DEFAULT_TEAM_REF = '11969--dom-nekromanta';

let schemaPromise: Promise<void> | null = null;
let manualSyncPromise: Promise<RanobeLibSyncResult> | null = null;

export async function ensureRanobeLibSchema(env: RanobeLibRuntimeEnv): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = initializeSchema(env).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function initializeSchema(env: RanobeLibRuntimeEnv): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS ranobelib_titles (
      book_ref TEXT PRIMARY KEY,
      ranobelib_id INTEGER,
      slug TEXT,
      url TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      cover_url TEXT,
      chapter_count INTEGER NOT NULL DEFAULT 0,
      latest_chapter_id INTEGER,
      latest_volume TEXT,
      latest_number TEXT,
      latest_name TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      snapshot_ready INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_synced_at TEXT,
      last_release_at TEXT,
      sync_error TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS ranobelib_chapters (
      book_ref TEXT NOT NULL,
      chapter_id INTEGER NOT NULL,
      volume TEXT NOT NULL,
      number TEXT NOT NULL,
      name TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (book_ref, chapter_id),
      FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ranobelib_releases (
      id TEXT PRIMARY KEY,
      book_ref TEXT NOT NULL,
      title_snapshot TEXT NOT NULL,
      chapter_count INTEGER NOT NULL,
      first_chapter_id INTEGER,
      first_volume TEXT,
      first_number TEXT,
      last_chapter_id INTEGER,
      last_volume TEXT,
      last_number TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
    )`,
    'CREATE INDEX IF NOT EXISTS idx_ranobelib_titles_active_release ON ranobelib_titles(is_active, last_release_at DESC, last_synced_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_ranobelib_chapters_book ON ranobelib_chapters(book_ref, chapter_id)',
    'CREATE INDEX IF NOT EXISTS idx_ranobelib_releases_created ON ranobelib_releases(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_ranobelib_releases_book_created ON ranobelib_releases(book_ref, created_at DESC)',
  ];

  for (const statement of statements) await env.DB.prepare(statement).run();
}

export async function getRanobeLibHome(env: RanobeLibRuntimeEnv): Promise<RanobeLibHomeData> {
  const teamRef = teamRefFor(env);
  const [
    { results: titleRows },
    { results: catalogTitleRows },
    { results: releaseRows },
    counts,
    syncState,
  ] = await Promise.all([
    env.DB.prepare(`
      SELECT book_ref, url, title, summary, cover_url, chapter_count, latest_chapter_id,
             latest_volume, latest_number, latest_name, last_synced_at, last_release_at
      FROM ranobelib_titles
      WHERE is_active = 1 AND snapshot_ready = 1
      ORDER BY COALESCE(last_release_at, last_synced_at) DESC, title COLLATE NOCASE ASC
      LIMIT 80
    `).all<RanobeLibTitleCard>(),
    env.DB.prepare(`
      SELECT t.book_ref, t.url, t.title, t.summary, t.cover_url, t.chapter_count,
             t.latest_chapter_id, t.latest_volume, t.latest_number, t.latest_name,
             t.last_synced_at, t.last_release_at,
             tt.semantic_status AS translation_semantic_status,
             t.translation_status_label
      FROM ranobelib_titles t
      JOIN ranobelib_teams team ON team.is_primary = 1
      JOIN ranobelib_team_translations tt
        ON tt.team_id = team.id AND tt.book_ref = t.book_ref
      WHERE t.snapshot_ready = 1
        AND tt.presence_state = 'active'
      ORDER BY COALESCE(t.last_release_at, t.last_synced_at) DESC, t.title COLLATE NOCASE ASC
      LIMIT 250
    `).all<RanobeLibCatalogTitleCard>(),
    env.DB.prepare(`
      SELECT r.id, r.book_ref, t.url, COALESCE(t.title, r.title_snapshot) AS title,
             t.cover_url, r.chapter_count, r.first_volume, r.first_number,
             r.last_volume, r.last_number, r.summary, r.created_at
      FROM ranobelib_releases r
      JOIN ranobelib_titles t ON t.book_ref = r.book_ref
      WHERE t.is_active = 1
        AND r.release_kind = 'chapters'
      ORDER BY r.created_at DESC
      LIMIT 30
    `).all<RanobeLibReleaseCard>(),
    getCounts(env),
    getSchedulerState(env),
  ]);

  return {
    teamRef,
    titles: titleRows.map(normalizeTitleCard),
    catalogTitles: catalogTitleRows.map(normalizeCatalogTitleCard),
    releases: releaseRows.map(normalizeReleaseCard),
    stats: counts,
    sync: {
      lastSyncAt: syncState.lastSyncAt,
      lastError: syncState.lastError,
      cursor: 0,
      syncing: manualSyncPromise !== null,
    },
  };
}

/**
 * Compatibility shim for the older base worker. Automatic request-triggered sync is retired;
 * production scheduling is owned by live-entry-v2 HOT/IDLE cron jobs.
 */
export async function shouldKickRanobeLibSync(_env: RanobeLibRuntimeEnv): Promise<boolean> {
  return false;
}

/**
 * Compatibility adapter for the existing authenticated admin button. It no longer runs the
 * legacy circular crawler: discovery and the bounded HOT/IDLE scanners are the same modules
 * used by production scheduling.
 */
export function syncRanobeLib(
  env: RanobeLibRuntimeEnv,
  _options: { full?: boolean } = {},
): Promise<RanobeLibSyncResult> {
  if (manualSyncPromise) return manualSyncPromise;
  manualSyncPromise = runModernManualSync(env).finally(() => {
    manualSyncPromise = null;
  });
  return manualSyncPromise;
}

async function runModernManualSync(env: RanobeLibRuntimeEnv): Promise<RanobeLibSyncResult> {
  await ensureRanobeLibSchema(env);
  const [discoveryModule, scannerModule] = await Promise.all([
    import('./ranobelib-discovery-scheduler.js'),
    import('./ranobelib-fast-scanner.js'),
  ]);
  const discovery = await discoveryModule.discoverRanobeLibTeam(env);
  const hotScan = await scannerModule.scanDueRanobeLibTitles(env, {
    limit: scannerModule.FAST_SCAN_LIMIT,
  });
  const idleScan = await scannerModule.scanIdleRanobeLibTitles(env, {
    limit: scannerModule.IDLE_SCAN_LIMIT,
  });
  return {
    teamRef: teamRefFor(env),
    discovered: discovery.discovered,
    processed: hotScan.selected + idleScan.selected,
    succeeded: hotScan.succeeded + idleScan.succeeded,
    failed: hotScan.failed + idleScan.failed,
    newReleases: hotScan.newReleases + idleScan.newReleases,
    nextCursor: 0,
    errors: [...hotScan.errors, ...idleScan.errors],
  };
}

async function getCounts(env: RanobeLibRuntimeEnv): Promise<RanobeLibHomeData['stats']> {
  const row = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_titles,
      SUM(CASE WHEN is_active = 1 AND snapshot_ready = 1 THEN 1 ELSE 0 END) AS synced_titles,
      (SELECT COUNT(*) FROM ranobelib_releases WHERE release_kind = 'chapters') AS releases
    FROM ranobelib_titles
  `).first<{ active_titles: number | string | null; synced_titles: number | string | null; releases: number | string | null }>();
  return {
    activeTitles: numberFrom(row?.active_titles, 0),
    syncedTitles: numberFrom(row?.synced_titles, 0),
    releases: numberFrom(row?.releases, 0),
  };
}

async function getSchedulerState(env: RanobeLibRuntimeEnv): Promise<{ lastSyncAt: string | null; lastError: string | null }> {
  const row = await env.DB.prepare(`
    SELECT
      MAX(last_synced_at) AS last_sync_at,
      (
        SELECT sync_error
        FROM ranobelib_titles
        WHERE is_active = 1 AND sync_error IS NOT NULL AND TRIM(sync_error) != ''
        ORDER BY COALESCE(last_synced_at, first_seen_at) DESC
        LIMIT 1
      ) AS last_error
    FROM ranobelib_titles
    WHERE is_active = 1
  `).first<{ last_sync_at: string | null; last_error: string | null }>();
  return {
    lastSyncAt: typeof row?.last_sync_at === 'string' ? row.last_sync_at : null,
    lastError: typeof row?.last_error === 'string' ? row.last_error : null,
  };
}

function normalizeTitleCard(row: RanobeLibTitleCard): RanobeLibTitleCard {
  return {
    ...row,
    chapter_count: numberFrom(row.chapter_count, 0),
    latest_chapter_id: nullableNumber(row.latest_chapter_id),
  };
}

function normalizeCatalogTitleCard(row: RanobeLibCatalogTitleCard): RanobeLibCatalogTitleCard {
  const title = normalizeTitleCard(row);
  const status = row.translation_semantic_status;
  return {
    ...title,
    translation_semantic_status: status === 'active' || status === 'completed' ? status : 'unknown',
    translation_status_label: typeof row.translation_status_label === 'string' && row.translation_status_label.trim()
      ? row.translation_status_label.trim()
      : null,
  };
}

function normalizeReleaseCard(row: RanobeLibReleaseCard): RanobeLibReleaseCard {
  return { ...row, chapter_count: numberFrom(row.chapter_count, 0) };
}

function teamRefFor(env: RanobeLibRuntimeEnv): string {
  return env.RANOBELIB_TEAM_REF?.trim() || DEFAULT_TEAM_REF;
}

function numberFrom(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
