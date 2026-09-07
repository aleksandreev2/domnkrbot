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

  // A valid team should never collapse an existing catalog to zero because of a transient
  // upstream/API parsing failure. Validate before the first destructive membership update.
  if (books.length === 0) throw new Error(`RanobeLib team ${teamRef} returned no book links`);

  const { results: activeRows } = await env.DB.prepare(
    'SELECT book_ref FROM ranobelib_titles WHERE is_active = 1',
  ).all<{ book_ref: string }>();
  const before = new Set(activeRows.map((row) => String(row.book_ref || '')).filter(Boolean));
  const after = new Set(books.map((book) => book.ref));

  await env.DB.prepare('UPDATE ranobelib_titles SET is_active = 0').run();
  await executeStatements(env.DB, books.map((book) => titleUpsert(env.DB, book)));

  let activated = 0;
  for (const ref of after) if (!before.has(ref)) activated += 1;
  let deactivated = 0;
  for (const ref of before) if (!after.has(ref)) deactivated += 1;

  return { discovered: books.length, activated, deactivated };
}

function titleUpsert(db: D1DatabaseLike, book: RanobeLibTeamBookRef) {
  return db.prepare(`
    INSERT INTO ranobelib_titles (book_ref, ranobelib_id, slug, url, title, cover_url, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(book_ref) DO UPDATE SET
      ranobelib_id = excluded.ranobelib_id,
      slug = excluded.slug,
      url = excluded.url,
      title = COALESCE(excluded.title, ranobelib_titles.title),
      cover_url = COALESCE(excluded.cover_url, ranobelib_titles.cover_url),
      is_active = 1
  `).bind(
    book.ref,
    book.id,
    book.slug,
    book.url,
    book.title ?? null,
    normalizeCoverUrl(book.coverUrl ?? null),
  );
}

async function executeStatements(db: D1DatabaseLike, statements: ReturnType<D1DatabaseLike['prepare']>[]): Promise<void> {
  if (!statements.length) return;
  if (db.batch) {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

function normalizeCoverUrl(value: string | null): string | null {
  if (!value) return null;
  if (/^https:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://cover.imglib.info${value}`;
  if (value.startsWith('uploads/')) return `https://cover.imglib.info/${value}`;
  return null;
}
