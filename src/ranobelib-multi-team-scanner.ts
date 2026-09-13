import { RanobeLibClient } from './integrations/ranobelib/client.js';
import { createRanobeLibClient } from './ranobelib-client-factory.js';
import type { RanobeLibChapterBranch } from './integrations/ranobelib/types.js';
import type { D1DatabaseLike } from './ranobelib-runtime.js';
import {
  finalizeTeamCompletions,
  markTranslationsBaselined,
  multiTeamReleaseIdentity,
  persistBranchRelease,
  persistBranchSnapshot,
} from './ranobelib-multi-team-persistence.js';
import {
  computeTeamScopedCompletionPlan,
  computeTeamScopedScanPlan,
  multiTeamDeliveryScopeKey,
} from './multi-team-scan-plan.js';

export {
  computeTeamScopedCompletionPlan,
  computeTeamScopedScanPlan,
  multiTeamDeliveryScopeKey,
} from './multi-team-scan-plan.js';
export { multiTeamReleaseIdentity } from './ranobelib-multi-team-persistence.js';

export type MultiTeamScanMode = 'baseline' | 'shadow' | 'live';
export type MultiTeamScanClass = 'hot' | 'idle' | 'all';
export type UnattributedTeamPayloadDisposition = 'ok' | 'awaiting-first-team-branch' | 'error';

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
  completion_pending: number | string;
  completion_revision: number | string;
};

type StoredBranchRow = {
  chapter_id: number | string;
  branch_key: string;
};

type ReleaseCandidate = {
  branchKey: string;
  deliveryScopeKey: string;
  teamIds: number[];
  chapters: RanobeLibChapterBranch[];
};

const DEFAULT_LIMIT = 24;
const CONCURRENCY = 4;
const IDLE_DELAY_MINUTES = 180;

export function computeMultiTeamNextCheckDelayMinutes(input: {
  scanClass: MultiTeamScanClass;
  changed: boolean;
  consecutiveNoChange: number;
}): number {
  if (input.scanClass === 'idle') return IDLE_DELAY_MINUTES;
  if (input.changed) return 1;
  const misses = Math.max(0, Math.floor(Number(input.consecutiveNoChange) || 0));
  return misses <= 2 ? 2 : 5;
}

export function classifyUnattributedTeamPayload(input: {
  fetchedBranchCount: number;
  relevantBranchCount: number;
  translations: readonly { baselineReady: boolean; completionPending: boolean }[];
}): UnattributedTeamPayloadDisposition {
  if (input.fetchedBranchCount <= 0 || input.relevantBranchCount > 0) return 'ok';
  if (
    input.translations.length > 0
    && input.translations.every((row) => !row.baselineReady && !row.completionPending)
  ) {
    return 'awaiting-first-team-branch';
  }
  return 'error';
}

export async function withOneTransientD1Retry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTransientD1ResetError(error)) throw error;
    return operation();
  }
}

function isTransientD1ResetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /D1_ERROR:[\s\S]*object to be reset/i.test(message)
    || /D1 DB storage caused object to be reset/i.test(message);
}

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
      return await withOneTransientD1Retry(
        () => scanOneMultiTeamWork(env, client, work, options.mode, scanClass, now),
      );
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
  if (scanClass === 'idle') return [];

  const safeLimit = clampInt(limit, 1, DEFAULT_LIMIT);
  const classPredicate = scanClass === 'hot'
    ? 'COALESCE(t.notification_subscriber_count, 0) > 0'
    : '1 = 1';
  const staleHotSchedulePredicate = scanClass === 'hot'
    ? `OR (COALESCE(t.notification_subscriber_count, 0) > 0
           AND t.next_check_at > datetime(CURRENT_TIMESTAMP, '+5 minutes'))`
    : '';

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
          OR tt.completion_pending = 1
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
            AND bootstrap.completion_pending = 1
        )
        OR t.next_check_at IS NULL
        OR t.next_check_at <= CURRENT_TIMESTAMP
        ${staleHotSchedulePredicate}
      )
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1 FROM ranobelib_team_translations bootstrap
        WHERE bootstrap.book_ref = t.book_ref
          AND (bootstrap.baseline_ready = 0 OR bootstrap.completion_pending = 1)
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
  const attributionDisposition = classifyUnattributedTeamPayload({
    fetchedBranchCount: fetched.length,
    relevantBranchCount: relevant.length,
    translations: translations.map((row) => ({
      baselineReady: Number(row.baseline_ready) === 1,
      completionPending: Number(row.completion_pending) === 1,
    })),
  });
  if (attributionDisposition === 'awaiting-first-team-branch') {
    await recordAwaitingFirstTeamBranch(env.DB, work, scanClass);
    return { fetchedWorks: 1, detectedReleases: 0, persistedReleases: 0, ambiguousBranches: 0 };
  }
  if (attributionDisposition === 'error') {
    const expectedTeamIds = [...upstreamToInternal.keys()].sort((a, b) => a - b);
    const actualTeamIds = [...new Set(fetched.flatMap((branch) => branch.teamIds))].sort((a, b) => a - b);
    throw new Error(
      `RanobeLib returned chapters but none were attributable to a registered actionable team; expected upstream team IDs [${expectedTeamIds.join(',')}], actual [${actualTeamIds.join(',')}]`,
    );
  }
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
  const plan = computeTeamScopedScanPlan({
    translations: translations.map((row) => ({
      teamId: Number(row.internal_team_id),
      baselineReady: Number(row.baseline_ready) === 1,
    })),
    branches: relevant.map(({ branch, teamIds }) => ({
      chapterId: branch.chapterId,
      branchKey: branch.branchKey,
      teamIds,
    })),
    storedBranchKeys: [...storedKeys],
    fetchedBranchCount: fetched.length,
  });
  const completionPlan = computeTeamScopedCompletionPlan({
    translations: translations.map((row) => ({
      teamId: Number(row.internal_team_id),
      upstreamTeamId: Number(row.upstream_team_id),
      baselineReady: Number(row.baseline_ready) === 1,
      semanticStatus: row.semantic_status,
      completionPending: Number(row.completion_pending) === 1,
      lifecycleState: row.lifecycle_state,
    })),
    branches: fetched.map((branch) => ({
      chapterId: branch.chapterId,
      volume: branch.volume,
      number: branch.number,
      branchKey: branch.branchKey,
      identityConfidence: branch.identityConfidence,
      upstreamTeamIds: branch.teamIds,
    })),
  });
  const releasableTeams = new Map(plan.releasableBranches.map((branch) => [
    branchSnapshotKey(branch.chapterId, branch.branchKey),
    branch.teamIds,
  ]));
  const candidates = groupReleaseCandidates(relevant
    .map(({ branch }) => {
      const teamIds = releasableTeams.get(branchSnapshotKey(branch.chapterId, branch.branchKey));
      return teamIds?.length ? { branch, teamIds } : null;
    })
    .filter((value): value is { branch: RanobeLibChapterBranch; teamIds: number[] } => value !== null));

  let persistedReleases = 0;
  if (mode === 'live') {
    for (const candidate of candidates) {
      if (await persistBranchRelease(env, work, candidate)) persistedReleases += 1;
    }
  }

  await persistBranchSnapshot(env.DB, work.book_ref, relevant);
  await markTranslationsBaselined(env.DB, work.book_ref, plan.teamIdsToBaseline);
  const completionInserted = await finalizeTeamCompletions(env, work, translations, completionPlan, mode);
  if (completionInserted) persistedReleases += 1;

  const completionReleaseDetected = mode === 'live' && completionPlan.notifyTeamIds.length > 0 ? 1 : 0;
  const changed = candidates.length > 0 || completionPlan.finalizations.length > 0;
  await updateWorkAfterSuccessfulScan(env.DB, work, relevant.map(({ branch }) => branch), scanClass, changed, now);

  return {
    fetchedWorks: 1,
    detectedReleases: candidates.length + completionReleaseDetected,
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
           tt.baseline_ready,
           tt.completion_pending,
           tt.completion_revision
    FROM ranobelib_team_translations tt
    JOIN ranobelib_teams team ON team.id = tt.team_id
    WHERE tt.book_ref = ?
      AND tt.presence_state = 'active'
      AND team.lifecycle_state IN ('hidden','published')
      AND (
        tt.baseline_ready = 0
        OR tt.completion_pending = 1
        OR (team.lifecycle_state = 'published' AND tt.semantic_status <> 'completed')
      )
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
      deliveryScopeKey: multiTeamDeliveryScopeKey(value.branch, value.teamIds),
      teamIds: value.teamIds,
      chapters: [value.branch],
    });
  }
  return [...groups.values()]
    .map((group) => ({ ...group, chapters: [...group.chapters].sort(compareBranchesByChapter) }))
    .sort((a, b) => compareBranchesByChapter(a.chapters[0]!, b.chapters[0]!));
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
  const delay = computeMultiTeamNextCheckDelayMinutes({
    scanClass,
    changed,
    consecutiveNoChange: misses,
  });

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

async function recordAwaitingFirstTeamBranch(
  db: D1DatabaseLike,
  work: DueWork,
  scanClass: MultiTeamScanClass,
): Promise<void> {
  const previousMisses = Math.max(0, Math.floor(Number(work.consecutive_no_change ?? 0)));
  const misses = previousMisses + 1;
  const delay = computeMultiTeamNextCheckDelayMinutes({
    scanClass,
    changed: false,
    consecutiveNoChange: misses,
  });
  await db.prepare(`
    UPDATE ranobelib_titles
    SET last_synced_at = CURRENT_TIMESTAMP,
        consecutive_no_change = ?,
        consecutive_failures = 0,
        next_check_at = datetime(CURRENT_TIMESTAMP, '+' || ? || ' minutes'),
        scan_priority = MAX(scan_priority - 1, 0),
        sync_error = NULL
    WHERE book_ref = ?
  `).bind(misses, delay, work.book_ref).run();
}

async function scheduleNextWorkCheck(
  db: D1DatabaseLike,
  work: DueWork,
  scanClass: MultiTeamScanClass,
  changed: boolean,
): Promise<void> {
  const previousMisses = Math.max(0, Math.floor(Number(work.consecutive_no_change ?? 0)));
  const misses = changed ? 0 : previousMisses + 1;
  const delay = computeMultiTeamNextCheckDelayMinutes({
    scanClass,
    changed,
    consecutiveNoChange: misses,
  });
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
