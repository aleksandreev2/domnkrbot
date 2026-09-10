import { ensureRanobeLibSchema, type RanobeLibRuntimeEnv } from './ranobelib-runtime.js';
import { discoverRanobeLibTeam } from './ranobelib-discovery-scheduler.js';
import type { TelegramSubscriptionEnv } from './telegram-subscriptions.js';

type CatalogEnv = TelegramSubscriptionEnv & RanobeLibRuntimeEnv & {
  RANOBELIB_TEAM_REF?: string;
};

type CountRow = { count: number | string; missing_titles?: number | string };

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
  const existing = await env.DB.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(CASE WHEN title IS NULL OR TRIM(title) = '' THEN 1 ELSE 0 END), 0) AS missing_titles
    FROM ranobelib_titles
    WHERE is_active = 1 AND ranobelib_id IS NOT NULL
  `).first<CountRow>();
  const activeCount = Number(existing?.count ?? 0);
  const missingTitles = Number(existing?.missing_titles ?? 0);
  if (Number.isFinite(activeCount) && activeCount > 0 && Number.isFinite(missingTitles) && missingTitles === 0) {
    return activeCount;
  }

  // Keep catalog bootstrap and scheduled discovery on one status/demand implementation. This
  // prevents the fallback path from accidentally reactivating semantically completed titles.
  const discovery = await discoverRanobeLibTeam(env);
  return discovery.discovered;
}
