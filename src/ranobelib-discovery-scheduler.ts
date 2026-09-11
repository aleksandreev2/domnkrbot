import { RanobeLibClient } from './integrations/ranobelib/client.js';
import { createRanobeLibClient } from './ranobelib-client-factory.js';
import type { RanobeLibTeamBookRef } from './integrations/ranobelib/types.js';
import type { D1DatabaseLike } from './ranobelib-runtime.js';

const DEFAULT_TEAM_REF = '11969--dom-nekromanta';
const INITIAL_STATUS_BACKFILL_LIMIT = 48;
const PERIODIC_STATUS_REFRESH_LIMIT = 8;
const STATUS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATUS_REFRESH_CONCURRENCY = 4;

type DiscoveryEnv = {
  DB: D1DatabaseLike;
  RANOBELIB_TEAM_REF?: string;
  RANOBELIB_TOKEN_ENCRYPTION_KEY?: string;
};

type StoredTranslationStatus = {
  book_ref: string;
  translation_status_id: number | null;
  translation_status_label: string | null;
  translation_is_completed: number | null;
  translation_status_checked_at: string | null;
};

export type RanobeLibDiscoveryResult = {
  discovered: number;
  activated: number;
  deactivated: number;
};

export async function discoverRanobeLibTeam(env: DiscoveryEnv): Promise<RanobeLibDiscoveryResult> {
  const teamRef = env.RANOBELIB_TEAM_REF?.trim() || DEFAULT_TEAM_REF;
  const client = createRanobeLibClient(env);
  const books = await client.discoverTeamBooks(teamRef);

  // Never collapse an existing catalog because of a transient upstream or parsing failure.
  if (books.length === 0) throw new Error(`RanobeLib team ${teamRef} returned no book links`);

  const discoveredRefs = new Set(books.map((book) => book.ref));
  const refsJson = JSON.stringify([...discoveredRefs]);
  const [{ results: activeRows }, { results: statusRows }] = await Promise.all([
    env.DB.prepare('SELECT book_ref FROM ranobelib_titles WHERE is_active = 1').all<{ book_ref: string }>(),
    env.DB.prepare(`
      SELECT book_ref, translation_status_id, translation_status_label,
        translation_is_completed, translation_status_checked_at
      FROM ranobelib_titles
      WHERE book_ref IN (SELECT CAST(value AS TEXT) FROM json_each(?))
    `).bind(refsJson).all<StoredTranslationStatus>(),
  ]);

  const before = new Set(activeRows.map((row) => String(row.book_ref || '')).filter(Boolean));
  const storedByRef = new Map(statusRows.map((row) => [String(row.book_ref), row]));
  hydrateStoredTranslationStatus(books, storedByRef);
  const checkedRefs = await refreshTranslationStatuses(client, books, storedByRef);

  const activeAfter = new Set(
    books.filter((book) => inferTranslationCompleted(book) !== true).map((book) => book.ref),
  );

  // A title missing from the authoritative team catalog becomes a dormant archive row. Keep
  // history and user subscriptions intact so discovery can reactivate it later, but clear stale
  // scanner state: it is no longer an actionable sync failure while it is outside the team.
  await env.DB.prepare(`
    UPDATE ranobelib_titles SET
      is_active = 0,
      next_check_at = NULL,
      notification_subscriber_count = 0,
      subscriber_count_updated_at = CURRENT_TIMESTAMP,
      consecutive_failures = 0,
      sync_error = NULL
    WHERE book_ref NOT IN (
        SELECT CAST(value AS TEXT) FROM json_each(?)
      )
      AND (
        is_active = 1
        OR next_check_at IS NOT NULL
        OR COALESCE(notification_subscriber_count, 0) <> 0
        OR COALESCE(consecutive_failures, 0) <> 0
        OR (sync_error IS NOT NULL AND TRIM(sync_error) <> '')
      )
  `).bind(refsJson).run();

  await bulkUpsertTitles(env.DB, books, checkedRefs);

  let activated = 0;
  for (const ref of activeAfter) if (!before.has(ref)) activated += 1;
  let deactivated = 0;
  for (const ref of before) if (!activeAfter.has(ref)) deactivated += 1;

  return { discovered: books.length, activated, deactivated };
}

function hydrateStoredTranslationStatus(
  books: RanobeLibTeamBookRef[],
  storedByRef: ReadonlyMap<string, StoredTranslationStatus>,
): void {
  for (const book of books) {
    const stored = storedByRef.get(book.ref);
    if (!stored) continue;
    if (book.translationStatusId == null && stored.translation_status_id != null) {
      book.translationStatusId = Number(stored.translation_status_id);
    }
    if (!book.translationStatusLabel && stored.translation_status_label) {
      book.translationStatusLabel = String(stored.translation_status_label);
    }
  }
}

async function refreshTranslationStatuses(
  client: RanobeLibClient,
  books: RanobeLibTeamBookRef[],
  storedByRef: ReadonlyMap<string, StoredTranslationStatus>,
): Promise<Set<string>> {
  const neverChecked = books.filter((book) => !storedByRef.get(book.ref)?.translation_status_checked_at);
  const candidates = neverChecked.length > 0
    ? neverChecked.slice(0, INITIAL_STATUS_BACKFILL_LIMIT)
    : books
        .filter((book) => isStatusRefreshDue(storedByRef.get(book.ref)?.translation_status_checked_at ?? null))
        .sort((a, b) => statusCheckedAtMs(storedByRef.get(a.ref)?.translation_status_checked_at ?? null)
          - statusCheckedAtMs(storedByRef.get(b.ref)?.translation_status_checked_at ?? null))
        .slice(0, PERIODIC_STATUS_REFRESH_LIMIT);

  const checked = new Set<string>();
  for (let start = 0; start < candidates.length; start += STATUS_REFRESH_CONCURRENCY) {
    const chunk = candidates.slice(start, start + STATUS_REFRESH_CONCURRENCY);
    await Promise.all(chunk.map(async (book) => {
      try {
        const status = await client.getTranslationStatus(book.ref);
        checked.add(book.ref);
        if (status.id !== null) book.translationStatusId = status.id;
        if (status.label) book.translationStatusLabel = status.label;
      } catch (error) {
        console.warn('RanobeLib translation status refresh failed', book.ref, compactError(error));
      }
    }));
  }
  return checked;
}

function isStatusRefreshDue(checkedAt: string | null): boolean {
  const checkedAtMs = statusCheckedAtMs(checkedAt);
  return checkedAtMs === 0 || Date.now() - checkedAtMs >= STATUS_REFRESH_INTERVAL_MS;
}

function statusCheckedAtMs(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function bulkUpsertTitles(
  db: D1DatabaseLike,
  books: RanobeLibTeamBookRef[],
  checkedRefs: ReadonlySet<string>,
): Promise<void> {
  const payload = JSON.stringify(books.map((book) => ({
    ref: book.ref,
    id: book.id,
    slug: book.slug,
    url: book.url,
    title: book.title ?? null,
    coverUrl: normalizeCoverUrl(book.coverUrl ?? null),
    translationStatusId: book.translationStatusId ?? null,
    translationStatusLabel: book.translationStatusLabel ?? null,
    translationCompleted: inferTranslationCompleted(book),
    translationStatusChecked: checkedRefs.has(book.ref) ? 1 : 0,
  })));

  // Unknown upstream status preserves a previously known semantic state. A brand-new unknown
  // title fails open as active. A known active -> completed transition becomes logically inactive
  // immediately for UX, while translation_completion_pending guarantees one final scanner poll.
  await db.prepare(`
    WITH discovered AS (
      SELECT
        CAST(json_extract(j.value, '$.ref') AS TEXT) AS book_ref,
        CAST(json_extract(j.value, '$.id') AS INTEGER) AS ranobelib_id,
        CAST(json_extract(j.value, '$.slug') AS TEXT) AS slug,
        CAST(json_extract(j.value, '$.url') AS TEXT) AS url,
        json_extract(j.value, '$.title') AS title,
        json_extract(j.value, '$.coverUrl') AS cover_url,
        CAST(json_extract(j.value, '$.translationStatusId') AS INTEGER) AS translation_status_id,
        json_extract(j.value, '$.translationStatusLabel') AS translation_status_label,
        CAST(json_extract(j.value, '$.translationCompleted') AS INTEGER) AS translation_is_completed,
        CAST(json_extract(j.value, '$.translationStatusChecked') AS INTEGER) AS translation_status_checked
      FROM json_each(?) AS j
    ),
    discovered_with_demand AS (
      SELECT d.*,
        (
          SELECT COUNT(*)
          FROM (
            SELECT s.user_telegram_id
            FROM telegram_subscription_settings s
            LEFT JOIN telegram_delivery_reachability reach
              ON reach.user_telegram_id = s.user_telegram_id
            WHERE s.all_titles = 1
              AND COALESCE(reach.state, 'active') != 'blocked'
              AND NOT EXISTS (
                SELECT 1
                FROM title_subscription_exclusions e
                WHERE e.user_telegram_id = s.user_telegram_id
                  AND e.book_ref = d.book_ref
              )
            UNION
            SELECT ts.user_telegram_id
            FROM title_subscriptions ts
            LEFT JOIN telegram_subscription_settings s2
              ON s2.user_telegram_id = ts.user_telegram_id
            LEFT JOIN telegram_delivery_reachability reach2
              ON reach2.user_telegram_id = ts.user_telegram_id
            WHERE ts.book_ref = d.book_ref
              AND COALESCE(s2.all_titles, 0) != 1
              AND COALESCE(reach2.state, 'active') != 'blocked'
          ) effective_recipients
        ) AS demand_count
      FROM discovered d
    )
    INSERT INTO ranobelib_titles (
      book_ref, ranobelib_id, slug, url, title, cover_url, is_active,
      next_check_at, notification_subscriber_count, subscriber_count_updated_at,
      translation_status_id, translation_status_label, translation_is_completed,
      translation_completion_pending, translation_status_revision, translation_status_changed_at,
      translation_status_checked_at
    )
    SELECT
      book_ref,
      ranobelib_id,
      slug,
      url,
      title,
      cover_url,
      CASE WHEN translation_is_completed = 1 THEN 0 ELSE 1 END,
      CASE WHEN translation_is_completed = 1 THEN NULL ELSE CURRENT_TIMESTAMP END,
      CASE WHEN translation_is_completed = 1 THEN 0 ELSE demand_count END,
      CURRENT_TIMESTAMP,
      translation_status_id,
      translation_status_label,
      translation_is_completed,
      0,
      0,
      CASE WHEN translation_is_completed IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
      CASE WHEN translation_status_checked = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
    FROM discovered_with_demand
    WHERE 1
    ON CONFLICT(book_ref) DO UPDATE SET
      ranobelib_id = excluded.ranobelib_id,
      slug = excluded.slug,
      url = excluded.url,
      title = COALESCE(excluded.title, ranobelib_titles.title),
      cover_url = COALESCE(excluded.cover_url, ranobelib_titles.cover_url),
      translation_status_revision = CASE
        WHEN excluded.translation_is_completed IS NOT NULL
          AND ranobelib_titles.translation_is_completed IS NOT NULL
          AND excluded.translation_is_completed <> ranobelib_titles.translation_is_completed
          THEN ranobelib_titles.translation_status_revision + 1
        WHEN excluded.translation_status_id IS NOT NULL
          AND ranobelib_titles.translation_status_id IS NOT NULL
          AND excluded.translation_status_id <> ranobelib_titles.translation_status_id
          THEN ranobelib_titles.translation_status_revision + 1
        WHEN excluded.translation_status_label IS NOT NULL
          AND ranobelib_titles.translation_status_label IS NOT NULL
          AND excluded.translation_status_label <> ranobelib_titles.translation_status_label
          THEN ranobelib_titles.translation_status_revision + 1
        ELSE ranobelib_titles.translation_status_revision
      END,
      translation_status_changed_at = CASE
        WHEN excluded.translation_is_completed IS NOT NULL
          AND (ranobelib_titles.translation_is_completed IS NULL
            OR excluded.translation_is_completed <> ranobelib_titles.translation_is_completed)
          THEN CURRENT_TIMESTAMP
        WHEN excluded.translation_status_id IS NOT NULL
          AND (ranobelib_titles.translation_status_id IS NULL
            OR excluded.translation_status_id <> ranobelib_titles.translation_status_id)
          THEN CURRENT_TIMESTAMP
        WHEN excluded.translation_status_label IS NOT NULL
          AND (ranobelib_titles.translation_status_label IS NULL
            OR excluded.translation_status_label <> ranobelib_titles.translation_status_label)
          THEN CURRENT_TIMESTAMP
        ELSE ranobelib_titles.translation_status_changed_at
      END,
      translation_status_id = COALESCE(excluded.translation_status_id, ranobelib_titles.translation_status_id),
      translation_status_label = COALESCE(excluded.translation_status_label, ranobelib_titles.translation_status_label),
      translation_is_completed = COALESCE(excluded.translation_is_completed, ranobelib_titles.translation_is_completed),
      translation_status_checked_at = COALESCE(excluded.translation_status_checked_at, ranobelib_titles.translation_status_checked_at),
      translation_completion_pending = CASE
        WHEN excluded.translation_is_completed IS NULL
          THEN ranobelib_titles.translation_completion_pending
        WHEN ranobelib_titles.translation_completion_pending = 1
          AND excluded.translation_is_completed = 1
          THEN 1
        WHEN ranobelib_titles.translation_is_completed = 0
          AND excluded.translation_is_completed = 1
          THEN 1
        ELSE 0
      END,
      next_check_at = CASE
        WHEN excluded.translation_is_completed IS NULL
          AND ranobelib_titles.translation_completion_pending = 1
          THEN CURRENT_TIMESTAMP
        WHEN ranobelib_titles.translation_completion_pending = 1
          AND excluded.translation_is_completed = 1
          THEN CURRENT_TIMESTAMP
        WHEN ranobelib_titles.translation_is_completed = 0
          AND excluded.translation_is_completed = 1
          THEN CURRENT_TIMESTAMP
        WHEN COALESCE(excluded.translation_is_completed, ranobelib_titles.translation_is_completed, 0) = 1
          THEN NULL
        WHEN ranobelib_titles.translation_is_completed = 1
          AND excluded.translation_is_completed = 0
          THEN CURRENT_TIMESTAMP
        WHEN ranobelib_titles.is_active = 0 THEN CURRENT_TIMESTAMP
        WHEN ranobelib_titles.notification_subscriber_count = 0
          AND excluded.notification_subscriber_count > 0 THEN CURRENT_TIMESTAMP
        WHEN ranobelib_titles.notification_subscriber_count > 0
          AND excluded.notification_subscriber_count = 0
          THEN datetime(CURRENT_TIMESTAMP, '+180 minutes')
        ELSE ranobelib_titles.next_check_at
      END,
      scan_priority = CASE
        WHEN COALESCE(excluded.translation_is_completed, ranobelib_titles.translation_is_completed, 0) <> 1
          AND ranobelib_titles.notification_subscriber_count = 0
          AND excluded.notification_subscriber_count > 0
          THEN ranobelib_titles.scan_priority + 10
        ELSE ranobelib_titles.scan_priority
      END,
      notification_subscriber_count = CASE
        WHEN COALESCE(excluded.translation_is_completed, ranobelib_titles.translation_is_completed, 0) = 1
          THEN 0
        ELSE excluded.notification_subscriber_count
      END,
      subscriber_count_updated_at = CURRENT_TIMESTAMP,
      is_active = CASE
        WHEN COALESCE(excluded.translation_is_completed, ranobelib_titles.translation_is_completed, 0) = 1
          THEN 0
        ELSE 1
      END
  `).bind(payload).run();
}

function inferTranslationCompleted(book: Pick<RanobeLibTeamBookRef, 'translationStatusLabel'>): boolean | null {
  const label = String(book.translationStatusLabel ?? '')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е');
  if (!label) return null;
  return label === 'завершен';
}

function normalizeCoverUrl(value: string | null): string | null {
  if (!value) return null;
  if (/^https:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://cover.imglib.info${value}`;
  if (value.startsWith('uploads/')) return `https://cover.imglib.info/${value}`;
  return null;
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}
