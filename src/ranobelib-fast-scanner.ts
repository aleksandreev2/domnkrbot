import { RanobeLibClient } from './integrations/ranobelib/client.js';
import {
  detectRecentBootstrapReleaseCandidates,
  detectReleaseDelta,
  detectScheduledReleaseTransitions,
  sortChapters,
  summarizeAdded,
} from './integrations/ranobelib/release-detector.js';
import type { RanobeLibChapter, RanobeLibTeamBookRef } from './integrations/ranobelib/types.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './ranobelib-runtime.js';

export const FAST_SCAN_LIMIT = 6;
const DEFAULT_TEAM_REF = '11969--dom-nekromanta';

type ScannerEnv = {
  DB: D1DatabaseLike;
  RANOBELIB_TEAM_REF?: string;
};

export type DueTitle = {
  book_ref: string;
  ranobelib_id: number | string | null;
  slug: string | null;
  url: string;
  title: string | null;
  cover_url: string | null;
  consecutive_no_change: number | string;
  last_change_at: string | null;
  next_check_at: string | null;
  scan_priority: number | string;
};

export type NextCheckInput = {
  changed: boolean;
  consecutiveNoChange: number;
  lastChangeAt?: string | null;
  failed?: boolean;
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
  onRelease?: (releaseId: string) => Promise<void>;
};

export function computeNextCheckDelayMinutes(input: NextCheckInput): number {
  if (input.failed) return 10;
  if (input.changed) return 1;

  const misses = Math.max(0, Math.floor(Number(input.consecutiveNoChange) || 0));
  if (misses <= 2) return 3;
  if (misses <= 5) return 10;
  if (misses <= 11) return 20;
  return 30;
}

export async function selectDueTitles(env: ScannerEnv, limit = FAST_SCAN_LIMIT): Promise<DueTitle[]> {
  const safeLimit = Math.max(1, Math.min(FAST_SCAN_LIMIT, Math.floor(Number(limit) || FAST_SCAN_LIMIT)));
  const { results } = await env.DB.prepare(`
    SELECT book_ref, ranobelib_id, slug, url, title, cover_url,
           consecutive_no_change, last_change_at, next_check_at, scan_priority
    FROM ranobelib_titles
    WHERE is_active = 1
      AND snapshot_ready = 1
      AND (next_check_at IS NULL OR next_check_at <= CURRENT_TIMESTAMP)
    ORDER BY next_check_at ASC, scan_priority DESC, book_ref ASC
    LIMIT ?
  `).bind(safeLimit).all<DueTitle>();
  return results.slice(0, safeLimit);
}

export async function scanDueRanobeLibTitles(
  env: ScannerEnv,
  options: FastScanOptions = {},
): Promise<FastScanResult> {
  const selected = await selectDueTitles(env, options.limit ?? FAST_SCAN_LIMIT);
  const client = new RanobeLibClient();
  const teamRef = env.RANOBELIB_TEAM_REF?.trim() || DEFAULT_TEAM_REF;
  const now = options.now ?? new Date();
  let succeeded = 0;
  let failed = 0;
  let newReleases = 0;
  const errors: string[] = [];

  // Six titles is already a small Free-plan-safe batch. Keep scans sequential for now so
  // chapter polling never competes for the six-connection ceiling with Queue/Telegram work.
  for (const row of selected) {
    const book = dueTitleToBook(row);
    if (!book) {
      failed += 1;
      const message = `${row.book_ref}: incomplete RanobeLib title metadata`;
      errors.push(message);
      await scheduleFailure(env, row.book_ref, message);
      continue;
    }

    try {
      const sync = await scanOneBook(env, client, book, row, teamRef, now);
      succeeded += 1;
      if (sync.releaseCreated && sync.releaseId) {
        newReleases += 1;
        if (options.onRelease) await options.onRelease(sync.releaseId);
      }
    } catch (error) {
      failed += 1;
      const message = `${row.book_ref}: ${errorMessage(error)}`;
      errors.push(message);
      await scheduleFailure(env, row.book_ref, message);
    }
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
): Promise<{ releaseCreated: boolean; releaseId: string | null }> {
  const state = await env.DB.prepare(`
    SELECT snapshot_ready, last_release_at, title, summary, cover_url
    FROM ranobelib_titles
    WHERE book_ref = ?
  `).bind(book.ref).first<{
    snapshot_ready: number | string;
    last_release_at: string | null;
    title: string | null;
    summary: string | null;
    cover_url: string | null;
  }>();
  const snapshotReady = Number(state?.snapshot_ready ?? 0) === 1;
  if (!snapshotReady) throw new Error('fast scan requires a ready chapter snapshot');

  const previousRows = (await env.DB.prepare(`
    SELECT chapter_id AS id, volume, number, name, first_seen_at AS firstSeenAt
    FROM ranobelib_chapters WHERE book_ref = ?
  `).bind(book.ref).all<RanobeLibChapter>()).results;

  // Unlike the legacy sync, this client has not performed team discovery first. Pass the
  // team explicitly so the chapter list cannot accidentally include another translation.
  const chapters = await client.getChapters(book.ref, { teamRef });
  const latest = chapters.length ? chapters[chapters.length - 1]! : null;
  const delta = detectReleaseDelta(book.ref, previousRows, chapters);
  const recoveredScheduled = detectScheduledReleaseTransitions(previousRows, chapters, now.getTime());
  const hasRecordedRelease = typeof state?.last_release_at === 'string' && state.last_release_at.trim().length > 0;
  const recentBootstrap = hasRecordedRelease
    ? []
    : detectRecentBootstrapReleaseCandidates(chapters, now.getTime());
  const releaseChapters = uniqueChapters([...(delta?.added ?? []), ...recoveredScheduled, ...recentBootstrap]);

  if (delta?.added.length) await insertChapters(env, book.ref, delta.added);
  if (delta?.removed.length) {
    await executeStatements(env.DB, delta.removed.map((chapter) => env.DB.prepare(
      'DELETE FROM ranobelib_chapters WHERE book_ref = ? AND chapter_id = ?',
    ).bind(book.ref, chapter.id)));
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
  const delayMinutes = computeNextCheckDelayMinutes({
    changed: releaseCreated,
    consecutiveNoChange: misses,
    lastChangeAt: due.last_change_at,
  });

  await env.DB.prepare(`
    UPDATE ranobelib_titles SET
      ranobelib_id = ?, slug = ?, url = ?, title = ?, summary = ?, cover_url = ?,
      chapter_count = ?, latest_chapter_id = ?, latest_volume = ?, latest_number = ?, latest_name = ?,
      snapshot_ready = 1, is_active = 1, last_synced_at = CURRENT_TIMESTAMP,
      last_release_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_release_at END,
      consecutive_no_change = ?,
      last_change_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_change_at END,
      next_check_at = datetime(CURRENT_TIMESTAMP, '+' || ? || ' minutes'),
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

  return { releaseCreated, releaseId };
}

async function scheduleFailure(env: ScannerEnv, bookRef: string, message: string): Promise<void> {
  const delayMinutes = computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 0, failed: true });
  await env.DB.prepare(`
    UPDATE ranobelib_titles SET
      next_check_at = datetime(CURRENT_TIMESTAMP, '+' || ? || ' minutes'),
      sync_error = ?
    WHERE book_ref = ?
  `).bind(delayMinutes, message.slice(0, 1000), bookRef).run();
}

async function insertChapters(env: ScannerEnv, bookRef: string, chapters: RanobeLibChapter[]): Promise<void> {
  await executeStatements(env.DB, chapters.map((chapter) => env.DB.prepare(`
    INSERT INTO ranobelib_chapters (book_ref, chapter_id, volume, number, name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(book_ref, chapter_id) DO UPDATE SET
      volume = excluded.volume, number = excluded.number, name = excluded.name
  `).bind(bookRef, chapter.id, chapter.volume, chapter.number, chapter.name)));
}

async function executeStatements(db: D1DatabaseLike, statements: D1PreparedStatementLike[]): Promise<void> {
  if (!statements.length) return;
  if (db.batch) {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
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
