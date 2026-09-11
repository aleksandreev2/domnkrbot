import { RanobeLibClient } from './integrations/ranobelib/client.js';
import { createRanobeLibClient } from './ranobelib-client-factory.js';
import type { RanobeLibChapterBranch } from './integrations/ranobelib/types.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './ranobelib-runtime.js';
import { reconcileReleaseOutboxRecipients } from './multi-team-notification-demand.js';

export type MultiTeamScanMode = 'baseline' | 'shadow' | 'live';
export type MultiTeamScanClass = 'hot' | 'idle' | 'all';

export type MultiTeamScanOptions = {
  limit?: number;
  now?: Date;
  mode: MultiTeamScanMode;
  scanClass?: MultiTeamScanClass;
  client?: Pick<RanobeLibClient, 'getChapterBranches'>;
};

export type MultiTeamScanResult = {
  selectedWorks: number;
  fetchedWorks: number;
  detectedReleases: number;
  persistedReleases: number;
  ambiguousBranches: number;
  errors: string[];
};

type MultiTeamScannerEnv = { DB: D1DatabaseLike; RANOBELIB_TOKEN_ENCRYPTION_KEY?: string };

type DueWork = {
  book_ref: string;
  ranobelib_id: number | string | null;
  slug: string | null;
  url: string;
  title: string | null;
  cover_url: string | null;
  notification_subscriber_count: number | string | null;
  consecutive_no_change: number | string | null;
  consecutive_failures: number | string | null;
  next_check_at: string | null;
};

type TranslationRow = {
  internal_team_id: number | string;
  upstream_team_id: number | string;
  lifecycle_state: string;
  presence_state: string;
  semantic_status: string;
  baseline_ready: number | string;
};

type StoredBranchRow = {
  chapter_id: number | string;
  branch_key: string;
};

type ReleaseCandidate = {
  branchKey: string;
  teamIds: number[];
  chapters: RanobeLibChapterBranch[];
};

const DEFAULT_LIMIT = 24;
const CONCURRENCY = 4;
const IDLE_DELAY_MINUTES = 180;

export async function scanDueMultiTeamWorks(
  env: MultiTeamScannerEnv,
  options: MultiTeamScanOptions,
): Promise<MultiTeamScanResult> {
  const limit = clampInt(options.limit ?? DEFAULT_LIMIT, 1, DEFAULT_LIMIT);
  const scanClass = options.scanClass ?? 'all';
  const selected = await selectDueMultiTeamWorks(env, limit, scanClass);
  if (selected.length === 0) return emptyResult(0);

  const client = options.client ?? createRanobeLibClient(env);
  const now = options.now ?? new Date();
  const outcomes = await mapWithConcurrency(selected, CONCURRENCY, async (work) => {
    try {
      return await scanOneMultiTeamWork(env, client, work, options.mode, scanClass, now);
    } catch (error) {
      await scheduleWorkFailure(env.DB, work.book_ref, error);
      return {
        fetchedWorks: 0,
        detectedReleases: 0,
        persistedReleases: 0,
        ambiguousBranches: 0,
        error: `${work.book_ref}: ${compactError(error)}`,
      };
    }
  });

  const result = emptyResult(selected.length);
  for (const outcome of outcomes) {
    result.fetchedWorks += outcome.fetchedWorks;
    result.detectedReleases += outcome.detectedReleases;
    result.persistedReleases += outcome.persistedReleases;
    result.ambiguousBranches += outcome.ambiguousBranches;
    if (outcome.error) result.errors.push(outcome.error);
  }
  return result;
}

export async function selectDueMultiTeamWorks(
  env: MultiTeamScannerEnv,
  limit = DEFAULT_LIMIT,
  scanClass: MultiTeamScanClass = 'all',
): Promise<DueWork[]> {
  const safeLimit = clampInt(limit, 1, DEFAULT_LIMIT);
  const classPredicate = scanClass === 'hot'
    ? `(EXISTS (
         SELECT 1 FROM ranobelib_team_translations bootstrap
         JOIN ranobelib_teams bootstrap_team ON bootstrap_team.id = bootstrap.team_id
         WHERE bootstrap.book_ref = t.book_ref
           AND bootstrap.presence_state = 'active'
           AND bootstrap_team.lifecycle_state IN ('hidden','published')
           AND bootstrap.baseline_ready = 0
       ) OR COALESCE(t.notification_subscriber_count, 0) > 0)`
    : scanClass === 'idle'
      ? `COALESCE(t.notification_subscriber_count, 0) = 0
         AND NOT EXISTS (
           SELECT 1 FROM ranobelib_team_translations bootstrap
           JOIN ranobelib_teams bootstrap_team ON bootstrap_team.id = bootstrap.team_id
           WHERE bootstrap.book_ref = t.book_ref
             AND bootstrap.presence_state = 'active'
             AND bootstrap_team.lifecycle_state IN ('hidden','published')
             AND bootstrap.baseline_ready = 0
         )`
      : '1 = 1';

  const { results } = await env.DB.prepare(`
    SELECT t.book_ref, t.ranobelib_id, t.slug, t.url, t.title, t.cover_url,
           t.notification_subscriber_count, t.consecutive_no_change,
           t.consecutive_failures, t.next_check_at
    FROM ranobelib_titles t
    WHERE EXISTS (
      SELECT 1
      FROM ranobelib_team_translations tt
      JOIN ranobelib_teams team ON team.id = tt.team_id
      WHERE tt.book_ref = t.book_ref
        AND tt.presence_state = 'active'
        AND team.lifecycle_state IN ('hidden', 'published')
        AND (
          tt.baseline_ready = 0
          OR (team.lifecycle_state = 'published' AND tt.semantic_status <> 'completed')
        )
    )
      AND (${classPredicate})
      AND (
        EXISTS (
          SELECT 1 FROM ranobelib_team_translations bootstrap
          JOIN ranobelib_teams bootstrap_team ON bootstrap_team.id = bootstrap.team_id
          WHERE bootstrap.book_ref = t.book_ref
            AND bootstrap.presence_state = 'active'
            AND bootstrap_team.lifecycle_state IN ('hidden','published')
            AND bootstrap.baseline_ready = 0
        )
        OR t.next_check_at IS NULL
        OR t.next_check_at <= CURRENT_TIMESTAMP
      )
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1 FROM ranobelib_team_translations bootstrap
        WHERE bootstrap.book_ref = t.book_ref AND bootstrap.baseline_ready = 0
      ) THEN 0 ELSE 1 END ASC,
      COALESCE(t.next_check_at, '') ASC,
      COALESCE(t.notification_subscriber_count, 0) DESC,
      t.scan_priority DESC,
      t.book_ref ASC
    LIMIT ?
  `).bind(safeLimit).all<DueWork>();
  return results.slice(0, safeLimit);
}

async function scanOneMultiTeamWork(
  env: MultiTeamScannerEnv,
  client: Pick<RanobeLibClient, 'getChapterBranches'>,
  work: DueWork,
  mode: MultiTeamScanMode,
  scanClass: MultiTeamScanClass,
  now: Date,
): Promise<{
  fetchedWorks: number;
  detectedReleases: number;
  persistedReleases: number;
  ambiguousBranches: number;
  error?: string;
}> {
  const translations = await loadActionableTranslations(env.DB, work.book_ref);
  if (translations.length === 0) {
    await scheduleNextWorkCheck(env.DB, work, scanClass, false);
    return { fetchedWorks: 0, detectedReleases: 0, persistedReleases: 0, ambiguousBranches: 0 };
  }

  const upstreamToInternal = new Map<number, number>();
  for (const row of translations) {
    const upstream = Number(row.upstream_team_id);
    const internal = Number(row.internal_team_id);
    if (Number.isSafeInteger(upstream) && upstream > 0 && Number.isSafeInteger(internal) && internal > 0) {
      upstreamToInternal.set(upstream, internal);
    }
  }

  const fetched = await client.getChapterBranches(work.book_ref);
  const relevant = fetched
    .map((branch) => mapBranchToRegisteredTeams(branch, upstreamToInternal))
    .filter((value): value is { branch: RanobeLibChapterBranch; teamIds: number[] } => value !== null);
  const ambiguousBranches = relevant.reduce(
    (count, value) => count + (value.branch.identityConfidence === 'ambiguous' ? 1 : 0),
    0,
  );

  const { results: storedRows } = await env.DB.prepare(`
    SELECT chapter_id, branch_key
    FROM ranobelib_chapter_branches
    WHERE book_ref = ?
  `).bind(work.book_ref).all<StoredBranchRow>();
  const storedKeys = new Set(storedRows.map((row) => branchSnapshotKey(Number(row.chapter_id), row.branch_key)));
  const baselineNeeded = translations.some((row) => Number(row.baseline_ready) !== 1);

  const candidates = baselineNeeded
    ? []
    : groupReleaseCandidates(relevant.filter(({ branch }) => !storedKeys.has(branchSnapshotKey(branch.chapterId, branch.branchKey))));

  let persistedReleases = 0;
  if (mode === 'live' && !baselineNeeded) {
    for (const candidate of candidates) {
      if (await persistBranchRelease(env, work, candidate)) persistedReleases += 1;
    }
  }

  // Baseline and shadow modes intentionally advance the canonical branch snapshot. During shadow,
  // legacy delivery remains authoritative, so advancing here prevents a replay when live cutover
  // happens. In live mode release rows are written before the snapshot so retry can recover safely.
  await persistBranchSnapshot(env.DB, work.book_ref, relevant);
  await markTranslationsBaselined(env.DB, work.book_ref, translations.map((row) => Number(row.internal_team_id)));
  await updateWorkAfterSuccessfulScan(env.DB, work, relevant.map(({ branch }) => branch), scanClass, candidates.length > 0, now);

  return {
    fetchedWorks: 1,
    detectedReleases: candidates.length,
    persistedReleases,
    ambiguousBranches,
  };
}

async function loadActionableTranslations(db: D1DatabaseLike, bookRef: string): Promise<TranslationRow[]> {
  const { results } = await db.prepare(`
    SELECT tt.team_id AS internal_team_id,
           team.ranobelib_team_id AS upstream_team_id,
           team.lifecycle_state,
           tt.presence_state,
           tt.semantic_status,
           tt.baseline_ready
    FROM ranobelib_team_translations tt
    JOIN ranobelib_teams team ON team.id = tt.team_id
    WHERE tt.book_ref = ?
      AND tt.presence_state = 'active'
      AND team.lifecycle_state IN ('hidden','published')
      AND (tt.baseline_ready = 0 OR (team.lifecycle_state = 'published' AND tt.semantic_status <> 'completed'))
    ORDER BY team.is_primary DESC, tt.team_id ASC
  `).bind(bookRef).all<TranslationRow>();
  return results;
}

function mapBranchToRegisteredTeams(
  branch: RanobeLibChapterBranch,
  upstreamToInternal: ReadonlyMap<number, number>,
): { branch: RanobeLibChapterBranch; teamIds: number[] } | null {
  const internal = [...new Set(branch.teamIds
    .map((upstream) => upstreamToInternal.get(upstream))
    .filter((value): value is number => value !== undefined))]
    .sort((a, b) => a - b);
  return internal.length > 0 ? { branch, teamIds: internal } : null;
}

function groupReleaseCandidates(
  branches: Array<{ branch: RanobeLibChapterBranch; teamIds: number[] }>,
): ReleaseCandidate[] {
  const groups = new Map<string, ReleaseCandidate>();
  for (const value of branches) {
    const groupKey = JSON.stringify([value.branch.branchKey, value.teamIds]);
    const existing = groups.get(groupKey);
    if (existing) existing.chapters.push(value.branch);
    else groups.set(groupKey, {
      branchKey: value.branch.branchKey,
      teamIds: value.teamIds,
      chapters: [value.branch],
    });
  }
  return [...groups.values()]
    .map((group) => ({ ...group, chapters: [...group.chapters].sort(compareBranchesByChapter) }))
    .sort((a, b) => compareBranchesByChapter(a.chapters[0]!, b.chapters[0]!));
}

async function persistBranchRelease(
  env: MultiTeamScannerEnv,
  work: DueWork,
  candidate: ReleaseCandidate,
): Promise<boolean> {
  if (candidate.chapters.length === 0 || candidate.teamIds.length === 0) return false;
  const first = candidate.chapters[0]!;
  const last = candidate.chapters[candidate.chapters.length - 1]!;
  const releaseId = multiTeamReleaseIdentity(work.book_ref, candidate.branchKey, candidate.chapters.map((row) => row.chapterId));
  const title = work.title?.trim() || work.slug?.trim() || work.book_ref;
  const summary = candidate.chapters.length === 1
    ? `Chapter ${first.number}`
    : `Chapters ${first.number}–${last.number}`;

  const insertRelease = env.DB.prepare(`
    INSERT OR IGNORE INTO ranobelib_releases (
      id, book_ref, title_snapshot, chapter_count,
      first_chapter_id, first_volume, first_number,
      last_chapter_id, last_volume, last_number,
      summary, release_kind, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'chapters', CURRENT_TIMESTAMP)
  `).bind(
    releaseId,
    work.book_ref,
    title,
    candidate.chapters.length,
    first.chapterId,
    first.volume,
    first.number,
    last.chapterId,
    last.volume,
    last.number,
    summary,
  );
  const teamStatements = candidate.teamIds.map((teamId) => env.DB.prepare(`
    INSERT OR IGNORE INTO ranobelib_release_teams (release_id, team_id)
    VALUES (?, ?)
  `).bind(releaseId, teamId));

  let inserted = false;
  if (env.DB.batch) {
    const results = await env.DB.batch([insertRelease, ...teamStatements]);
    inserted = runChanges(results[0]) > 0;
  } else {
    inserted = runChanges(await insertRelease.run()) > 0;
    for (const statement of teamStatements) await statement.run();
  }

  // The legacy release trigger may have provisionally inserted book-level recipients. Reconcile
  // them only after release-team mappings exist, before the scanner returns and wakes Queue.
  await reconcileReleaseOutboxRecipients(env, releaseId);
  return inserted;
}

async function persistBranchSnapshot(
  db: D1DatabaseLike,
  bookRef: string,
  values: Array<{ branch: RanobeLibChapterBranch; teamIds: number[] }>,
): Promise<void> {
  if (values.length === 0) return;
  const payload = JSON.stringify(values.map(({ branch, teamIds }) => ({
    chapterId: branch.chapterId,
    branchKey: branch.branchKey,
    nativeBranchId: branch.nativeBranchId,
    confidence: branch.identityConfidence,
    volume: branch.volume,
    number: branch.number,
    name: branch.name,
    releasedAt: branch.releasedAt,
    teamIds,
  })));

  await db.prepare(`
    WITH incoming AS (
      SELECT
        CAST(json_extract(j.value, '$.chapterId') AS INTEGER) AS chapter_id,
        CAST(json_extract(j.value, '$.branchKey') AS TEXT) AS branch_key,
        CAST(json_extract(j.value, '$.nativeBranchId') AS INTEGER) AS native_branch_id,
        CAST(json_extract(j.value, '$.confidence') AS TEXT) AS identity_confidence,
        CAST(json_extract(j.value, '$.volume') AS TEXT) AS volume,
        CAST(json_extract(j.value, '$.number') AS TEXT) AS number,
        json_extract(j.value, '$.name') AS name,
        json_extract(j.value, '$.releasedAt') AS released_at
      FROM json_each(?) AS j
    )
    INSERT INTO ranobelib_chapter_branches (
      book_ref, chapter_id, branch_key, native_branch_id, identity_confidence,
      volume, number, name, released_at, first_seen_at, last_seen_at
    )
    SELECT ?, chapter_id, branch_key, native_branch_id, identity_confidence,
           volume, number, name, released_at, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM incoming
    ON CONFLICT(book_ref, chapter_id, branch_key) DO UPDATE SET
      native_branch_id = COALESCE(excluded.native_branch_id, ranobelib_chapter_branches.native_branch_id),
      identity_confidence = excluded.identity_confidence,
      volume = excluded.volume,
      number = excluded.number,
      name = COALESCE(excluded.name, ranobelib_chapter_branches.name),
      released_at = COALESCE(excluded.released_at, ranobelib_chapter_branches.released_at),
      last_seen_at = CURRENT_TIMESTAMP
  `).bind(payload, bookRef).run();

  // Replace the participating team set only for branches observed in this successful payload.
  for (const { branch, teamIds } of values) {
    await db.prepare(`
      DELETE FROM ranobelib_chapter_branch_teams
      WHERE book_ref = ? AND chapter_id = ? AND branch_key = ?
    `).bind(bookRef, branch.chapterId, branch.branchKey).run();
    for (const teamId of teamIds) {
      await db.prepare(`
        INSERT OR IGNORE INTO ranobelib_chapter_branch_teams (
          book_ref, chapter_id, branch_key, team_id
        ) VALUES (?, ?, ?, ?)
      `).bind(bookRef, branch.chapterId, branch.branchKey, teamId).run();
    }
  }
}

async function markTranslationsBaselined(db: D1DatabaseLike, bookRef: string, teamIds: number[]): Promise<void> {
  const ids = [...new Set(teamIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return;
  await db.prepare(`
    UPDATE ranobelib_team_translations
    SET baseline_ready = 1,
        last_synced_at = CURRENT_TIMESTAMP,
        sync_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE book_ref = ?
      AND team_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
  `).bind(bookRef, JSON.stringify(ids)).run();
}

async function updateWorkAfterSuccessfulScan(
  db: D1DatabaseLike,
  work: DueWork,
  branches: RanobeLibChapterBranch[],
  scanClass: MultiTeamScanClass,
  changed: boolean,
  _now: Date,
): Promise<void> {
  const uniqueChapters = new Map<number, RanobeLibChapterBranch>();
  for (const branch of branches) uniqueChapters.set(branch.chapterId, branch);
  const ordered = [...uniqueChapters.values()].sort(compareBranchesByChapter);
  const latest = ordered[ordered.length - 1] ?? null;
  const previousMisses = Math.max(0, Math.floor(Number(work.consecutive_no_change ?? 0)));
  const misses = changed ? 0 : previousMisses + 1;
  const delay = scanClass === 'idle'
    ? IDLE_DELAY_MINUTES
    : changed ? 1 : misses <= 2 ? 10 : 30;

  await db.prepare(`
    UPDATE ranobelib_titles
    SET chapter_count = ?,
        latest_chapter_id = ?,
        latest_volume = ?,
        latest_number = ?,
        latest_name = ?,
        snapshot_ready = 1,
        last_synced_at = CURRENT_TIMESTAMP,
        last_release_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_release_at END,
        consecutive_no_change = ?,
        consecutive_failures = 0,
        last_change_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_change_at END,
        next_check_at = datetime(CURRENT_TIMESTAMP, '+' || ? || ' minutes'),
        scan_priority = CASE WHEN ? = 1 THEN scan_priority + 1 ELSE MAX(scan_priority - 1, 0) END,
        sync_error = NULL
    WHERE book_ref = ?
  `).bind(
    ordered.length,
    latest?.chapterId ?? null,
    latest?.volume ?? null,
    latest?.number ?? null,
    latest?.name ?? null,
    changed ? 1 : 0,
    misses,
    changed ? 1 : 0,
    delay,
    changed ? 1 : 0,
    work.book_ref,
  ).run();
}

async function scheduleNextWorkCheck(
  db: D1DatabaseLike,
  work: DueWork,
  scanClass: MultiTeamScanClass,
  changed: boolean,
): Promise<void> {
  const delay = scanClass === 'idle' ? IDLE_DELAY_MINUTES : changed ? 1 : 30;
  await db.prepare(`
    UPDATE ranobelib_titles
    SET next_check_at = datetime(CURRENT_TIMESTAMP, '+' || ? || ' minutes')
    WHERE book_ref = ?
  `).bind(delay, work.book_ref).run();
}

async function scheduleWorkFailure(db: D1DatabaseLike, bookRef: string, error: unknown): Promise<void> {
  await db.prepare(`
    UPDATE ranobelib_titles
    SET consecutive_failures = consecutive_failures + 1,
        next_check_at = datetime(CURRENT_TIMESTAMP, '+5 minutes'),
        sync_error = ?
    WHERE book_ref = ?
  `).bind(compactError(error).slice(0, 1000), bookRef).run();
}

export function multiTeamReleaseIdentity(bookRef: string, branchKey: string, chapterIds: readonly number[]): string {
  const ids = [...new Set(chapterIds.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
  return `branch-release:v1:${bookRef}:${encodeURIComponent(branchKey)}:${ids.join(',')}`;
}

function branchSnapshotKey(chapterId: number, branchKey: string): string {
  return `${chapterId}\u0000${branchKey}`;
}

function compareBranchesByChapter(a: RanobeLibChapterBranch, b: RanobeLibChapterBranch): number {
  const volume = compareToken(a.volume, b.volume);
  if (volume !== 0) return volume;
  const number = compareToken(a.number, b.number);
  if (number !== 0) return number;
  if (a.chapterId !== b.chapterId) return a.chapterId - b.chapterId;
  return a.branchKey.localeCompare(b.branchKey);
}

function compareToken(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  const aNumeric = Number.isFinite(an);
  const bNumeric = Number.isFinite(bn);
  if (aNumeric && bNumeric) return an - bn;
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function runChanges(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const object = result as { meta?: { changes?: unknown }; changes?: unknown };
  const value = object.meta?.changes ?? object.changes ?? 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampInt(value: unknown, min: number, max: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function emptyResult(selectedWorks: number): MultiTeamScanResult {
  return {
    selectedWorks,
    fetchedWorks: 0,
    detectedReleases: 0,
    persistedReleases: 0,
    ambiguousBranches: 0,
    errors: [],
  };
}
