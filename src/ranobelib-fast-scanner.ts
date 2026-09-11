import { RanobeLibClient } from './integrations/ranobelib/client.js';
import { createRanobeLibClient } from './ranobelib-client-factory.js';
import {
  detectRecentBootstrapReleaseCandidates,
  detectReleaseDelta,
  detectScheduledReleaseTransitions,
  sortChapters,
  summarizeAdded,
} from './integrations/ranobelib/release-detector.js';
import type { RanobeLibChapter, RanobeLibTeamBookRef } from './integrations/ranobelib/types.js';
import type { D1DatabaseLike } from './ranobelib-runtime.js';

export const FAST_SCAN_LIMIT = 24;
export const FAST_SCAN_CONCURRENCY = 4;
export const IDLE_SCAN_LIMIT = 24;
export const IDLE_SCAN_DELAY_MINUTES = 180;
const DEFAULT_TEAM_REF = '11969--dom-nekromanta';

type ScannerEnv = {
  DB: D1DatabaseLike;
  RANOBELIB_TEAM_REF?: string;
  RANOBELIB_TOKEN_ENCRYPTION_KEY?: string;
};

export type DueTitle = {
  book_ref: string;
  ranobelib_id: number | string | null;
  slug: string | null;
  url: string;
  title: string | null;
  cover_url: string | null;
  snapshot_ready: number | string;
  consecutive_no_change: number | string;
  consecutive_failures: number | string;
  last_change_at: string | null;
  next_check_at: string | null;
  scan_priority: number | string;
  notification_subscriber_count: number | string;
  translation_completion_pending: number | string;
};

export type NextCheckInput = {
  changed: boolean;
  consecutiveNoChange: number;
  consecutiveFailures: number;
  lastChangeAt?: string | null;
  failed?: boolean;
  now?: Date;
};

export type FastScanResult = {
  selected: number;
  succeeded: number;
  failed: number;
  newReleases: number;
  errors: string[];
};

export type FastScanOptions = {
  limit?: number;
  now?: Date;
};

type ScanMode = 'hot' | 'idle';

type ScanOutcome = {
  succeeded: number;
  failed: number;
  newReleases: number;
  error?: string;
};

export function computeNextCheckDelayMinutes(input: NextCheckInput): number {
  if (input.failed) {
    const failures = Math.max(1, Math.floor(Number(input.consecutiveFailures) || 1));
    return Math.min(30, 5 * (2 ** Math.min(3, failures - 1)));
  }
  if (input.changed) return 1;

  const lastChangeAt = timestampMs(input.lastChangeAt ?? null);
  if (lastChangeAt !== null) {
    const nowMs = (input.now ?? new Date()).getTime();
    const ageMinutes = Math.max(0, (nowMs - lastChangeAt) / 60_000);
    if (ageMinutes <= 60) return 2;
    if (ageMinutes <= 360) return 5;
  }

  const misses = Math.max(0, Math.floor(Number(input.consecutiveNoChange) || 0));
  return misses <= 2 ? 10 : 30;
}

export async function selectDueTitles(env: ScannerEnv, limit = FAST_SCAN_LIMIT): Promise<DueTitle[]> {
  const safeLimit = clampScanLimit(limit, FAST_SCAN_LIMIT);
  const { results } = await env.DB.prepare(`
    SELECT book_ref, ranobelib_id, slug, url, title, cover_url, snapshot_ready,
           consecutive_no_change, consecutive_failures, last_change_at, next_check_at, scan_priority,
           notification_subscriber_count, translation_completion_pending
    FROM ranobelib_titles
    WHERE (translation_completion_pending = 1 OR (is_active = 1
      AND (snapshot_ready = 0 OR notification_subscriber_count > 0)))
      AND (next_check_at IS NULL OR next_check_at <= CURRENT_TIMESTAMP)
    ORDER BY translation_completion_pending DESC,
             COALESCE(next_check_at, '') ASC,
             notification_subscriber_count DESC,
             scan_priority DESC,
             book_ref ASC
    LIMIT ?
  `).bind(safeLimit).all<DueTitle>();
  return results.slice(0, safeLimit);
}

export async function selectIdleTitles(env: ScannerEnv, limit = IDLE_SCAN_LIMIT): Promise<DueTitle[]> {
  const safeLimit = clampScanLimit(limit, IDLE_SCAN_LIMIT);
  const { results } = await env.DB.prepare(`
    SELECT book_ref, ranobelib_id, slug, url, title, cover_url, snapshot_ready,
           consecutive_no_change, consecutive_failures, last_change_at, next_check_at, scan_priority,
           notification_subscriber_count, translation_completion_pending
    FROM ranobelib_titles
    WHERE is_active = 1
      AND translation_completion_pending = 0
      AND snapshot_ready = 1
      AND notification_subscriber_count = 0
      AND (next_check_at IS NULL OR next_check_at <= CURRENT_TIMESTAMP)
    ORDER BY COALESCE(next_check_at, '') ASC,
             scan_priority DESC,
             book_ref ASC
    LIMIT ?
  `).bind(safeLimit).all<DueTitle>();
  return results.slice(0, safeLimit);
}

export async function scanDueRanobeLibTitles(
  env: ScannerEnv,
  options: FastScanOptions = {},
): Promise<FastScanResult> {
  const totalLimit = clampScanLimit(options.limit ?? FAST_SCAN_LIMIT, FAST_SCAN_LIMIT);
  const selected = await selectDueTitles(env, totalLimit);
  return scanSelectedTitles(env, selected, options.now ?? new Date(), 'hot');
}

export async function scanIdleRanobeLibTitles(
  env: ScannerEnv,
  options: FastScanOptions = {},
): Promise<FastScanResult> {
  const totalLimit = clampScanLimit(options.limit ?? IDLE_SCAN_LIMIT, IDLE_SCAN_LIMIT);
  const selected = await selectIdleTitles(env, totalLimit);
  return scanSelectedTitles(env, selected, options.now ?? new Date(), 'idle');
}

async function scanSelectedTitles(
  env: ScannerEnv,
  selected: DueTitle[],
  now: Date,
  mode: ScanMode,
): Promise<FastScanResult> {
  if (!selected.length) return { selected: 0, succeeded: 0, failed: 0, newReleases: 0, errors: [] };

  const client = createRanobeLibClient(env);
  const teamRef = env.RANOBELIB_TEAM_REF?.trim() || DEFAULT_TEAM_REF;

  // Workers Paid gives this invocation far more subrequest headroom, while the platform still
  // has a small simultaneous-connection ceiling. Four workers remove the old sequential
  // bottleneck without consuming every available connection.
  const outcomes = await mapWithConcurrency(
    selected,
    FAST_SCAN_CONCURRENCY,
    async (row): Promise<ScanOutcome> => {
      const book = dueTitleToBook(row);
      if (!book) {
        const message = `${row.book_ref}: incomplete RanobeLib title metadata`;
        await scheduleFailure(env, row, message, now);
        return { succeeded: 0, failed: 1, newReleases: 0, error: message };
      }

      try {
        const sync = await scanOneBook(env, client, book, row, teamRef, now, mode);
        return {
          succeeded: 1,
          failed: 0,
          newReleases: (sync.releaseCreated ? 1 : 0) + (sync.completionFinalized ? 1 : 0),
        };
      } catch (error) {
        const message = `${row.book_ref}: ${errorMessage(error)}`;
        await scheduleFailure(env, row, message, now);
        return { succeeded: 0, failed: 1, newReleases: 0, error: message };
      }
    },
  );

  let succeeded = 0;
  let failed = 0;
  let newReleases = 0;
  const errors: string[] = [];
  for (const outcome of outcomes) {
    succeeded += outcome.succeeded;
    failed += outcome.failed;
    newReleases += outcome.newReleases;
    if (outcome.error) errors.push(outcome.error);
  }

  return { selected: selected.length, succeeded, failed, newReleases, errors };
}

async function scanOneBook(
  env: ScannerEnv,
  client: RanobeLibClient,
  book: RanobeLibTeamBookRef,
  due: DueTitle,
  teamRef: string,
  now: Date,
  mode: ScanMode,
): Promise<{ releaseCreated: boolean; releaseId: string | null; completionFinalized: boolean }> {
  const state = await env.DB.prepare(`
    SELECT snapshot_ready, last_release_at, title, summary, cover_url, translation_completion_pending
    FROM ranobelib_titles
    WHERE book_ref = ?
  `).bind(book.ref).first<{
    snapshot_ready: number | string;
    last_release_at: string | null;
    title: string | null;
    summary: string | null;
    cover_url: string | null;
    translation_completion_pending: number | string;
  }>();
  const snapshotReady = Number(state?.snapshot_ready ?? due.snapshot_ready ?? 0) === 1;
  const completionPending = Number(
    state?.translation_completion_pending ?? due.translation_completion_pending ?? 0,
  ) === 1;
  const previousRows = snapshotReady
    ? (await env.DB.prepare(`
        SELECT chapter_id AS id, volume, number, name, first_seen_at AS firstSeenAt
        FROM ranobelib_chapters WHERE book_ref = ?
      `).bind(book.ref).all<RanobeLibChapter>()).results
    : undefined;

  // Discovery is intentionally separate, so explicitly scope chapter polling to our team.
  // A pending completion is not finalized until this request succeeds.
  const chapters = await client.getChapters(book.ref, { teamRef });
  const latest = chapters.length ? chapters[chapters.length - 1]! : null;
  const delta = detectReleaseDelta(book.ref, previousRows, chapters);
  const lastReleaseMs = timestampMs(state?.last_release_at ?? null);
  const recoveredScheduled = snapshotReady && previousRows
    ? detectScheduledReleaseTransitions(previousRows, chapters, now.getTime(), lastReleaseMs)
    : [];
  const hasRecordedRelease = typeof state?.last_release_at === 'string' && state.last_release_at.trim().length > 0;
  const recentBootstrap = hasRecordedRelease
    ? []
    : detectRecentBootstrapReleaseCandidates(chapters, now.getTime());
  const releaseChapters = snapshotReady
    ? uniqueChapters([...(delta?.added ?? []), ...recoveredScheduled, ...recentBootstrap])
    : recentBootstrap;

  if (!snapshotReady) {
    await insertChapters(env, book.ref, chapters);
  } else if (delta?.added.length) {
    // ranobelib_chapters is a monotonic seen-ID ledger for legacy notification dedupe.
    // A chapter temporarily omitted upstream must stay remembered so reappearance is not "new".
    await insertChapters(env, book.ref, delta.added);
  }

  const displayTitle = book.title || state?.title || humanizeSlug(book.slug);
  const summary = state?.summary ?? null;
  const coverUrl = normalizeCoverUrl(book.coverUrl ?? state?.cover_url ?? null);
  let releaseCreated = false;
  let releaseId: string | null = null;

  if (releaseChapters.length > 0) {
    const first = releaseChapters[0]!;
    const last = releaseChapters[releaseChapters.length - 1]!;
    releaseId = `${book.ref}:${first.id}-${last.id}:${releaseChapters.length}`;
    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO ranobelib_releases (
        id, book_ref, title_snapshot, chapter_count, first_chapter_id, first_volume,
        first_number, last_chapter_id, last_volume, last_number, summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      releaseId,
      book.ref,
      displayTitle,
      releaseChapters.length,
      first.id,
      first.volume,
      first.number,
      last.id,
      last.volume,
      last.number,
      summarizeAdded(releaseChapters),
    ).run();
    releaseCreated = runChanges(result) > 0;
    if (!releaseCreated) releaseId = null;
  }

  const previousMisses = Math.max(0, Math.floor(Number(due.consecutive_no_change) || 0));
  const misses = releaseCreated ? 0 : previousMisses + 1;
  const delayMinutes = mode === 'idle'
    ? IDLE_SCAN_DELAY_MINUTES
    : computeNextCheckDelayMinutes({
        changed: releaseCreated,
        consecutiveNoChange: misses,
        consecutiveFailures: 0,
        lastChangeAt: due.last_change_at,
        now,
      });

  await env.DB.prepare(`
    UPDATE ranobelib_titles SET
      ranobelib_id = ?, slug = ?, url = ?, title = ?, summary = ?, cover_url = ?,
      chapter_count = ?, latest_chapter_id = ?, latest_volume = ?, latest_number = ?, latest_name = ?,
      snapshot_ready = 1,
      is_active = CASE WHEN translation_is_completed = 1 THEN 0 ELSE 1 END,
      last_synced_at = CURRENT_TIMESTAMP,
      last_release_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_release_at END,
      consecutive_no_change = ?, consecutive_failures = 0,
      last_change_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_change_at END,
      next_check_at = CASE
        WHEN translation_completion_pending = 1 THEN CURRENT_TIMESTAMP
        WHEN translation_is_completed = 1 THEN NULL
        ELSE datetime(CURRENT_TIMESTAMP, '+' || ? || ' minutes')
      END,
      scan_priority = CASE WHEN ? = 1 THEN scan_priority + 1 ELSE MAX(scan_priority - 1, 0) END,
      sync_error = NULL
    WHERE book_ref = ?
  `).bind(
    book.id,
    book.slug,
    book.url,
    displayTitle,
    summary,
    coverUrl,
    chapters.length,
    latest?.id ?? null,
    latest?.volume ?? null,
    latest?.number ?? null,
    latest?.name ?? null,
    releaseCreated ? 1 : 0,
    misses,
    releaseCreated ? 1 : 0,
    delayMinutes,
    releaseCreated ? 1 : 0,
    book.ref,
  ).run();

  let completionFinalized = false;
  if (completionPending) {
    // Re-check the semantic/pending state in SQL. If discovery reopened the translation while
    // this scan was in flight, this update becomes a no-op and cannot emit a false completion.
    const result = await env.DB.prepare(`
      UPDATE ranobelib_titles SET
        is_active = 0,
        translation_completion_pending = CASE
          WHEN translation_completion_pending = 1 AND translation_is_completed = 1 THEN 0
          ELSE translation_completion_pending
        END,
        notification_subscriber_count = 0,
        last_release_at = CURRENT_TIMESTAMP,
        last_change_at = CURRENT_TIMESTAMP,
        consecutive_no_change = 0,
        next_check_at = NULL,
        sync_error = NULL
      WHERE book_ref = ?
        AND translation_completion_pending = 1
        AND translation_is_completed = 1
    `).bind(book.ref).run();
    completionFinalized = runChanges(result) > 0;
  }

  return { releaseCreated, releaseId, completionFinalized };
}

async function scheduleFailure(env: ScannerEnv, row: DueTitle, message: string, now: Date): Promise<void> {
  const failures = Math.max(0, Math.floor(Number(row.consecutive_failures) || 0)) + 1;
  const delayMinutes = computeNextCheckDelayMinutes({
    changed: false,
    consecutiveNoChange: Math.max(0, Math.floor(Number(row.consecutive_no_change) || 0)),
    consecutiveFailures: failures,
    lastChangeAt: row.last_change_at,
    failed: true,
    now,
  });
  await env.DB.prepare(`
    UPDATE ranobelib_titles SET
      consecutive_failures = consecutive_failures + 1,
      next_check_at = datetime(CURRENT_TIMESTAMP, '+' || ? || ' minutes'),
      sync_error = ?
    WHERE book_ref = ?
  `).bind(delayMinutes, message.slice(0, 1000), row.book_ref).run();
}

async function insertChapters(env: ScannerEnv, bookRef: string, chapters: RanobeLibChapter[]): Promise<void> {
  if (!chapters.length) return;
  const payload = JSON.stringify(chapters.map((chapter) => ({
    id: chapter.id,
    volume: chapter.volume,
    number: chapter.number,
    name: chapter.name ?? null,
  })));
  await env.DB.prepare(`
    INSERT INTO ranobelib_chapters (book_ref, chapter_id, volume, number, name)
    SELECT ?,
           CAST(json_extract(j.value, '$.id') AS INTEGER),
           CAST(json_extract(j.value, '$.volume') AS TEXT),
           CAST(json_extract(j.value, '$.number') AS TEXT),
           json_extract(j.value, '$.name')
    FROM json_each(?) AS j
    WHERE 1
    ON CONFLICT(book_ref, chapter_id) DO UPDATE SET
      volume = excluded.volume, number = excluded.number, name = excluded.name
  `).bind(bookRef, payload).run();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function dueTitleToBook(row: DueTitle): RanobeLibTeamBookRef | null {
  const id = Number(row.ranobelib_id);
  const slug = row.slug?.trim();
  if (!Number.isSafeInteger(id) || id <= 0 || !slug || !row.book_ref || !row.url) return null;
  return {
    id,
    slug,
    ref: row.book_ref,
    url: row.url,
    ...(row.title ? { title: row.title } : {}),
    ...(row.cover_url ? { coverUrl: row.cover_url } : {}),
  };
}

function uniqueChapters(chapters: RanobeLibChapter[]): RanobeLibChapter[] {
  const byId = new Map<number, RanobeLibChapter>();
  for (const chapter of chapters) byId.set(chapter.id, chapter);
  return sortChapters([...byId.values()]);
}

function runChanges(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const meta = 'meta' in result && result.meta && typeof result.meta === 'object'
    ? result.meta as Record<string, unknown>
    : null;
  const changes = Number(meta?.changes ?? 0);
  return Number.isFinite(changes) ? changes : 0;
}

function clampScanLimit(value: number, maximum: number): number {
  const numeric = Number.isFinite(value) ? Math.floor(value) : maximum;
  return Math.max(1, Math.min(maximum, numeric));
}

function timestampMs(value: string | null): number | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCoverUrl(value: string | null): string | null {
  if (!value) return null;
  if (/^https:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://cover.imglib.info${value}`;
  if (value.startsWith('uploads/')) return `https://cover.imglib.info/${value}`;
  return null;
}

function humanizeSlug(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
