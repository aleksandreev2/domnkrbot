import { RanobeLibClient } from './integrations/ranobelib/client.js';
import { ensureRanobeLibSchema, type RanobeLibRuntimeEnv } from './ranobelib-runtime.js';
import type { TelegramSubscriptionEnv } from './telegram-subscriptions.js';

type CatalogEnv = TelegramSubscriptionEnv & RanobeLibRuntimeEnv;

type CountRow = { count: number | string };

const DEFAULT_TEAM_REF = '11969--dom-nekromanta';

export function withTelegramSubscriptionCatalogDb<T extends TelegramSubscriptionEnv>(env: T): T {
  const baseDb = env.DB;
  const DB = {
    prepare(query: string) {
      const rewritten = query.includes('FROM ranobelib_titles') && query.includes('snapshot_ready = 1')
        ? query.replace(/\s+AND snapshot_ready = 1/g, '')
        : query;
      return baseDb.prepare(rewritten);
    },
  };
  return { ...env, DB } as T;
}

export async function ensureTelegramSubscriptionCatalog(env: CatalogEnv): Promise<number> {
  await ensureRanobeLibSchema(env);
  const existing = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM ranobelib_titles WHERE is_active = 1 AND ranobelib_id IS NOT NULL',
  ).first<CountRow>();
  const activeCount = Number(existing?.count ?? 0);
  if (Number.isFinite(activeCount) && activeCount > 0) return activeCount;

  const teamRef = env.RANOBELIB_TEAM_REF?.trim() || DEFAULT_TEAM_REF;
  const client = new RanobeLibClient();
  const books = await client.discoverTeamBooks(teamRef);
  if (!books.length) throw new Error(`RanobeLib team ${teamRef} returned no book links`);

  await env.DB.prepare('UPDATE ranobelib_titles SET is_active = 0').run();
  const statements = books.map((book) => env.DB.prepare(`
    INSERT INTO ranobelib_titles (book_ref, ranobelib_id, slug, url, is_active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(book_ref) DO UPDATE SET ranobelib_id = excluded.ranobelib_id,
      slug = excluded.slug, url = excluded.url, is_active = 1
  `).bind(book.ref, book.id, book.slug, book.url));

  if (env.DB.batch) {
    const chunkSize = 50;
    for (let index = 0; index < statements.length; index += chunkSize) {
      await env.DB.batch(statements.slice(index, index + chunkSize));
    }
  } else {
    for (const statement of statements) await statement.run();
  }

  return books.length;
}
