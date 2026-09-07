import { RanobeLibClient } from './integrations/ranobelib/client.js';
import type { RanobeLibTeamBookRef } from './integrations/ranobelib/types.js';
import type { D1DatabaseLike } from './ranobelib-runtime.js';

const DEFAULT_TEAM_REF = '11969--dom-nekromanta';

type DiscoveryEnv = {
  DB: D1DatabaseLike;
  RANOBELIB_TEAM_REF?: string;
};

export type RanobeLibDiscoveryResult = {
  discovered: number;
  activated: number;
  deactivated: number;
};

export async function discoverRanobeLibTeam(env: DiscoveryEnv): Promise<RanobeLibDiscoveryResult> {
  const teamRef = env.RANOBELIB_TEAM_REF?.trim() || DEFAULT_TEAM_REF;
  const client = new RanobeLibClient();
  const books = await client.discoverTeamBooks(teamRef);

  // Never collapse an existing catalog because of a transient upstream or parsing failure.
  if (books.length === 0) throw new Error(`RanobeLib team ${teamRef} returned no book links`);

  const { results: activeRows } = await env.DB.prepare(
    'SELECT book_ref FROM ranobelib_titles WHERE is_active = 1',
  ).all<{ book_ref: string }>();
  const before = new Set(activeRows.map((row) => String(row.book_ref || '')).filter(Boolean));
  const after = new Set(books.map((book) => book.ref));
  const refsJson = JSON.stringify([...after]);

  // Deactivate only titles missing from a validated non-empty discovery result. Doing this
  // before the bulk upsert lets the upsert distinguish already-active rows from titles that
  // are genuinely new/reactivated, so only the latter are scheduled immediately.
  await env.DB.prepare(`
    UPDATE ranobelib_titles SET is_active = 0
    WHERE is_active = 1
      AND book_ref NOT IN (
        SELECT CAST(value AS TEXT) FROM json_each(?)
      )
  `).bind(refsJson).run();

  await bulkUpsertTitles(env.DB, books);

  let activated = 0;
  for (const ref of after) if (!before.has(ref)) activated += 1;
  let deactivated = 0;
  for (const ref of before) if (!after.has(ref)) deactivated += 1;

  return { discovered: books.length, activated, deactivated };
}

async function bulkUpsertTitles(db: D1DatabaseLike, books: RanobeLibTeamBookRef[]): Promise<void> {
  const payload = JSON.stringify(books.map((book) => ({
    ref: book.ref,
    id: book.id,
    slug: book.slug,
    url: book.url,
    title: book.title ?? null,
    coverUrl: normalizeCoverUrl(book.coverUrl ?? null),
  })));

  // Demand is folded into the same JSON upsert so discovery remains bounded to two D1 writes
  // regardless of team size. Missing reachability rows are deliberately treated as active.
  await db.prepare(`
    WITH discovered AS (
      SELECT
        CAST(json_extract(j.value, '$.ref') AS TEXT) AS book_ref,
        CAST(json_extract(j.value, '$.id') AS INTEGER) AS ranobelib_id,
        CAST(json_extract(j.value, '$.slug') AS TEXT) AS slug,
        CAST(json_extract(j.value, '$.url') AS TEXT) AS url,
        json_extract(j.value, '$.title') AS title,
        json_extract(j.value, '$.coverUrl') AS cover_url
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
      next_check_at, notification_subscriber_count, subscriber_count_updated_at
    )
    SELECT
      book_ref,
      ranobelib_id,
      slug,
      url,
      title,
      cover_url,
      1,
      CURRENT_TIMESTAMP,
      demand_count,
      CURRENT_TIMESTAMP
    FROM discovered_with_demand
    WHERE 1
    ON CONFLICT(book_ref) DO UPDATE SET
      ranobelib_id = excluded.ranobelib_id,
      slug = excluded.slug,
      url = excluded.url,
      title = COALESCE(excluded.title, ranobelib_titles.title),
      cover_url = COALESCE(excluded.cover_url, ranobelib_titles.cover_url),
      next_check_at = CASE
        WHEN ranobelib_titles.is_active = 0 THEN CURRENT_TIMESTAMP
        WHEN ranobelib_titles.notification_subscriber_count = 0
          AND excluded.notification_subscriber_count > 0 THEN CURRENT_TIMESTAMP
        WHEN ranobelib_titles.notification_subscriber_count > 0
          AND excluded.notification_subscriber_count = 0
          THEN datetime(CURRENT_TIMESTAMP, '+180 minutes')
        ELSE ranobelib_titles.next_check_at
      END,
      scan_priority = CASE
        WHEN ranobelib_titles.notification_subscriber_count = 0
          AND excluded.notification_subscriber_count > 0
          THEN ranobelib_titles.scan_priority + 10
        ELSE ranobelib_titles.scan_priority
      END,
      notification_subscriber_count = excluded.notification_subscriber_count,
      subscriber_count_updated_at = CURRENT_TIMESTAMP,
      is_active = 1
  `).bind(payload).run();
}

function normalizeCoverUrl(value: string | null): string | null {
  if (!value) return null;
  if (/^https:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://cover.imglib.info${value}`;
  if (value.startsWith('uploads/')) return `https://cover.imglib.info/${value}`;
  return null;
}
