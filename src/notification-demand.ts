import type { D1DatabaseLike } from './ranobelib-runtime.js';

export const IDLE_SCAN_DELAY_MINUTES = 180;
export const DEMAND_WAKE_PRIORITY_BOOST = 10;

type NotificationDemandEnv = { DB: D1DatabaseLike };

type DemandCountRow = { notification_subscriber_count: number | string };

export type TelegramDeliveryReachabilityOutcome = {
  userTelegramId: string;
  state: 'active' | 'blocked';
};

export async function refreshTitleNotificationDemand(
  env: NotificationDemandEnv,
  bookRef: string,
): Promise<number> {
  const ref = String(bookRef || '').trim();
  if (!ref) return 0;

  const row = await env.DB.prepare(`
    WITH demand AS (
      SELECT COUNT(*) AS demand_count
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
              AND e.book_ref = ?
          )
        UNION
        SELECT ts.user_telegram_id
        FROM title_subscriptions ts
        LEFT JOIN telegram_subscription_settings s2
          ON s2.user_telegram_id = ts.user_telegram_id
        LEFT JOIN telegram_delivery_reachability reach2
          ON reach2.user_telegram_id = ts.user_telegram_id
        WHERE ts.book_ref = ?
          AND COALESCE(s2.all_titles, 0) != 1
          AND COALESCE(reach2.state, 'active') != 'blocked'
      ) effective_recipients
    )
    UPDATE ranobelib_titles
    SET
      next_check_at = CASE
        WHEN notification_subscriber_count = 0
          AND (SELECT demand_count FROM demand) > 0
          THEN CURRENT_TIMESTAMP
        WHEN notification_subscriber_count > 0
          AND (SELECT demand_count FROM demand) = 0
          THEN datetime(CURRENT_TIMESTAMP, '+180 minutes')
        ELSE next_check_at
      END,
      scan_priority = CASE
        WHEN notification_subscriber_count = 0
          AND (SELECT demand_count FROM demand) > 0
          THEN scan_priority + 10
        ELSE scan_priority
      END,
      notification_subscriber_count = (SELECT demand_count FROM demand),
      subscriber_count_updated_at = CURRENT_TIMESTAMP
    WHERE book_ref = ?
    RETURNING notification_subscriber_count
  `).bind(ref, ref, ref).first<DemandCountRow>();

  const count = Number(row?.notification_subscriber_count ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export async function refreshAllNotificationDemand(env: NotificationDemandEnv): Promise<void> {
  await env.DB.prepare(`
    WITH demand AS (
      SELECT t.book_ref,
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
                  AND e.book_ref = t.book_ref
              )
            UNION
            SELECT ts.user_telegram_id
            FROM title_subscriptions ts
            LEFT JOIN telegram_subscription_settings s2
              ON s2.user_telegram_id = ts.user_telegram_id
            LEFT JOIN telegram_delivery_reachability reach2
              ON reach2.user_telegram_id = ts.user_telegram_id
            WHERE ts.book_ref = t.book_ref
              AND COALESCE(s2.all_titles, 0) != 1
              AND COALESCE(reach2.state, 'active') != 'blocked'
          ) effective_recipients
        ) AS demand_count
      FROM ranobelib_titles t
      WHERE t.is_active = 1
    )
    UPDATE ranobelib_titles
    SET
      next_check_at = CASE
        WHEN notification_subscriber_count = 0
          AND COALESCE((SELECT demand_count FROM demand WHERE demand.book_ref = ranobelib_titles.book_ref), 0) > 0
          THEN CURRENT_TIMESTAMP
        WHEN notification_subscriber_count > 0
          AND COALESCE((SELECT demand_count FROM demand WHERE demand.book_ref = ranobelib_titles.book_ref), 0) = 0
          THEN datetime(CURRENT_TIMESTAMP, '+180 minutes')
        ELSE next_check_at
      END,
      scan_priority = CASE
        WHEN notification_subscriber_count = 0
          AND COALESCE((SELECT demand_count FROM demand WHERE demand.book_ref = ranobelib_titles.book_ref), 0) > 0
          THEN scan_priority + 10
        ELSE scan_priority
      END,
      notification_subscriber_count = COALESCE(
        (SELECT demand_count FROM demand WHERE demand.book_ref = ranobelib_titles.book_ref),
        0
      ),
      subscriber_count_updated_at = CURRENT_TIMESTAMP
    WHERE is_active = 1
  `).run();
}

export async function markTelegramUserBlocked(env: NotificationDemandEnv, userId: string): Promise<void> {
  const id = String(userId || '').trim();
  if (!id) return;
  await env.DB.prepare(`
    INSERT INTO telegram_delivery_reachability (
      user_telegram_id, state, blocked_at, last_success_at, updated_at
    ) VALUES (?, 'blocked', CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET
      state = 'blocked',
      blocked_at = COALESCE(telegram_delivery_reachability.blocked_at, CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP
  `).bind(id).run();
}

export async function markTelegramUserReachable(env: NotificationDemandEnv, userId: string): Promise<void> {
  const id = String(userId || '').trim();
  if (!id) return;
  await env.DB.prepare(`
    INSERT INTO telegram_delivery_reachability (
      user_telegram_id, state, blocked_at, last_success_at, updated_at
    ) VALUES (?, 'active', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET
      state = 'active',
      blocked_at = NULL,
      last_success_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).bind(id).run();
}

export async function recordTelegramDeliveryReachability(
  env: NotificationDemandEnv,
  outcomes: TelegramDeliveryReachabilityOutcome[],
): Promise<void> {
  if (!outcomes.length) return;

  // Last delivery result wins for duplicate users in the same drain. This keeps the JSON
  // payload unique by primary key and guarantees a single bounded D1 write for the batch.
  const byUser = new Map<string, 'active' | 'blocked'>();
  for (const outcome of outcomes) {
    const userTelegramId = String(outcome?.userTelegramId || '').trim();
    if (!userTelegramId) continue;
    if (outcome.state !== 'active' && outcome.state !== 'blocked') continue;
    byUser.set(userTelegramId, outcome.state);
  }
  if (!byUser.size) return;

  const payload = JSON.stringify([...byUser].map(([userTelegramId, state]) => ({ userTelegramId, state })));
  await env.DB.prepare(`
    WITH incoming AS (
      SELECT
        CAST(json_extract(j.value, '$.userTelegramId') AS TEXT) AS user_telegram_id,
        CAST(json_extract(j.value, '$.state') AS TEXT) AS state
      FROM json_each(?) AS j
    )
    INSERT INTO telegram_delivery_reachability (
      user_telegram_id, state, blocked_at, last_success_at, updated_at
    )
    SELECT
      user_telegram_id,
      state,
      CASE WHEN state = 'blocked' THEN CURRENT_TIMESTAMP ELSE NULL END,
      CASE WHEN state = 'active' THEN CURRENT_TIMESTAMP ELSE NULL END,
      CURRENT_TIMESTAMP
    FROM incoming
    WHERE user_telegram_id != '' AND state IN ('active', 'blocked')
    ON CONFLICT(user_telegram_id) DO UPDATE SET
      state = excluded.state,
      blocked_at = CASE
        WHEN excluded.state = 'blocked'
          THEN COALESCE(telegram_delivery_reachability.blocked_at, CURRENT_TIMESTAMP)
        ELSE NULL
      END,
      last_success_at = CASE
        WHEN excluded.state = 'active' THEN CURRENT_TIMESTAMP
        ELSE telegram_delivery_reachability.last_success_at
      END,
      updated_at = CURRENT_TIMESTAMP
  `).bind(payload).run();
}
