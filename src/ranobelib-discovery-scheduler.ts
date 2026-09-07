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

  await db.prepare(`
    INSERT INTO ranobelib_titles (
      book_ref, ranobelib_id, slug, url, title, cover_url, is_active, next_check_at
    )
    SELECT
      CAST(json_extract(j.value, '$.ref') AS TEXT),
      CAST(json_extract(j.value, '$.id') AS INTEGER),
      CAST(json_extract(j.value, '$.slug') AS TEXT),
      CAST(json_extract(j.value, '$.url') AS TEXT),
      json_extract(j.value, '$.title'),
      json_extract(j.value, '$.coverUrl'),
      1,
      CURRENT_TIMESTAMP
    FROM json_each(?) AS j
    WHERE 1
    ON CONFLICT(book_ref) DO UPDATE SET
      ranobelib_id = excluded.ranobelib_id,
      slug = excluded.slug,
      url = excluded.url,
      title = COALESCE(excluded.title, ranobelib_titles.title),
      cover_url = COALESCE(excluded.cover_url, ranobelib_titles.cover_url),
      next_check_at = CASE
        WHEN ranobelib_titles.is_active = 0 THEN CURRENT_TIMESTAMP
        ELSE ranobelib_titles.next_check_at
      END,
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
