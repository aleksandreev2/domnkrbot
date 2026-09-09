import { RanobeLibClient } from './integrations/ranobelib/client.js';
import { ensureRanobeLibSchema, type RanobeLibRuntimeEnv } from './ranobelib-runtime.js';
import type { TelegramSubscriptionEnv } from './telegram-subscriptions.js';

type CatalogEnv = TelegramSubscriptionEnv & RanobeLibRuntimeEnv;

type CountRow = { count: number | string; missing_titles?: number | string };

const DEFAULT_TEAM_REF = '11969--dom-nekromanta';
const COMPLETED_TRANSLATION_STATUS = 2;

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

  const teamRef = env.RANOBELIB_TEAM_REF?.trim() || DEFAULT_TEAM_REF;
  const client = new RanobeLibClient();
  const books = await client.discoverTeamBooks(teamRef);
  if (!books.length) throw new Error(`RanobeLib team ${teamRef} returned no book links`);

  await env.DB.prepare('UPDATE ranobelib_titles SET is_active = 0').run();
  const statements = books.map((book) => env.DB.prepare(`
    INSERT INTO ranobelib_titles (
      book_ref, ranobelib_id, slug, url, title, is_active,
      translation_status_id, translation_status_label, translation_status_revision,
      translation_status_changed_at, next_check_at
    )
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? = ${COMPLETED_TRANSLATION_STATUS} THEN 0 ELSE 1 END,
      ?, ?, 0, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
      CASE WHEN ? = ${COMPLETED_TRANSLATION_STATUS} THEN NULL ELSE CURRENT_TIMESTAMP END)
    ON CONFLICT(book_ref) DO UPDATE SET
      ranobelib_id = excluded.ranobelib_id,
      slug = excluded.slug,
      url = excluded.url,
      title = COALESCE(excluded.title, ranobelib_titles.title),
      translation_status_revision = CASE
        WHEN excluded.translation_status_id IS NOT NULL
          AND ranobelib_titles.translation_status_id IS NOT NULL
          AND excluded.translation_status_id <> ranobelib_titles.translation_status_id
          THEN ranobelib_titles.translation_status_revision + 1
        ELSE ranobelib_titles.translation_status_revision
      END,
      translation_status_changed_at = CASE
        WHEN excluded.translation_status_id IS NOT NULL
          AND (ranobelib_titles.translation_status_id IS NULL
            OR excluded.translation_status_id <> ranobelib_titles.translation_status_id)
          THEN CURRENT_TIMESTAMP
        ELSE ranobelib_titles.translation_status_changed_at
      END,
      translation_status_id = COALESCE(excluded.translation_status_id, ranobelib_titles.translation_status_id),
      translation_status_label = COALESCE(excluded.translation_status_label, ranobelib_titles.translation_status_label),
      next_check_at = CASE
        WHEN COALESCE(excluded.translation_status_id, ranobelib_titles.translation_status_id) = ${COMPLETED_TRANSLATION_STATUS}
          THEN NULL
        WHEN ranobelib_titles.translation_status_id = ${COMPLETED_TRANSLATION_STATUS}
          AND COALESCE(excluded.translation_status_id, ranobelib_titles.translation_status_id) <> ${COMPLETED_TRANSLATION_STATUS}
          THEN CURRENT_TIMESTAMP
        ELSE ranobelib_titles.next_check_at
      END,
      notification_subscriber_count = CASE
        WHEN COALESCE(excluded.translation_status_id, ranobelib_titles.translation_status_id) = ${COMPLETED_TRANSLATION_STATUS}
          THEN 0
        ELSE ranobelib_titles.notification_subscriber_count
      END,
      is_active = CASE
        WHEN COALESCE(excluded.translation_status_id, ranobelib_titles.translation_status_id) = ${COMPLETED_TRANSLATION_STATUS}
          THEN 0
        ELSE 1
      END
  `).bind(
    book.ref,
    book.id,
    book.slug,
    book.url,
    book.title,
    book.translationStatusId ?? null,
    book.translationStatusId ?? null,
    book.translationStatusLabel ?? null,
    book.translationStatusId ?? null,
    book.translationStatusId ?? null,
  ));

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
