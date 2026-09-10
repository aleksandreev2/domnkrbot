import type { D1DatabaseLike } from './ranobelib-runtime.js';

export const MULTI_TEAM_IDLE_SCAN_DELAY_MINUTES = 180;
export const MULTI_TEAM_DEMAND_WAKE_PRIORITY_BOOST = 10;

export type MultiTeamNotificationDemandEnv = { DB: D1DatabaseLike };

type CountRow = { count: number | string | null };
type DemandRow = { notification_subscriber_count: number | string | null };

/**
 * Counts reachable users who can receive at least one published, actionable translation of a work.
 * The same user is counted once even if two followed teams translate the same work.
 */
export async function countWorkNotificationDemand(
  env: MultiTeamNotificationDemandEnv,
  bookRef: string,
): Promise<number> {
  const row = await env.DB.prepare(`${effectiveWorkDemandCte()}
    SELECT COUNT(DISTINCT user_telegram_id) AS count
    FROM effective_recipients
  `).bind(bookRef, bookRef).first<CountRow>();
  return safeCount(row?.count);
}

export async function refreshWorkNotificationDemand(
  env: MultiTeamNotificationDemandEnv,
  bookRef: string,
): Promise<number> {
  const ref = String(bookRef || '').trim();
  if (!ref) return 0;

  const row = await env.DB.prepare(`${effectiveWorkDemandCte()}
    , demand AS (
      SELECT COUNT(DISTINCT user_telegram_id) AS demand_count
      FROM effective_recipients
    )
    UPDATE ranobelib_titles
    SET
      next_check_at = CASE
        WHEN notification_subscriber_count = 0 AND (SELECT demand_count FROM demand) > 0
          THEN CURRENT_TIMESTAMP
        WHEN notification_subscriber_count > 0 AND (SELECT demand_count FROM demand) = 0
          THEN datetime(CURRENT_TIMESTAMP, '+${MULTI_TEAM_IDLE_SCAN_DELAY_MINUTES} minutes')
        ELSE next_check_at
      END,
      scan_priority = CASE
        WHEN notification_subscriber_count = 0 AND (SELECT demand_count FROM demand) > 0
          THEN scan_priority + ${MULTI_TEAM_DEMAND_WAKE_PRIORITY_BOOST}
        ELSE scan_priority
      END,
      notification_subscriber_count = (SELECT demand_count FROM demand),
      subscriber_count_updated_at = CURRENT_TIMESTAMP
    WHERE book_ref = ?
    RETURNING notification_subscriber_count
  `).bind(ref, ref, ref).first<DemandRow>();
  return safeCount(row?.notification_subscriber_count);
}

export async function refreshAllWorkNotificationDemand(
  env: MultiTeamNotificationDemandEnv,
): Promise<void> {
  await env.DB.prepare(`
    WITH candidate_works AS (
      SELECT DISTINCT book_ref FROM ranobelib_team_translations
    ),
    demand AS (
      SELECT cw.book_ref,
        (
          SELECT COUNT(DISTINCT user_telegram_id)
          FROM (
            SELECT team_sub.user_telegram_id
            FROM ranobelib_team_translations tt
            JOIN ranobelib_teams team ON team.id = tt.team_id
            JOIN telegram_team_subscriptions team_sub ON team_sub.team_id = tt.team_id
            LEFT JOIN telegram_delivery_reachability reach
              ON reach.user_telegram_id = team_sub.user_telegram_id
            WHERE tt.book_ref = cw.book_ref
              AND team.lifecycle_state = 'published'
              AND tt.presence_state = 'active'
              AND tt.semantic_status <> 'completed'
              AND COALESCE(reach.state, 'active') <> 'blocked'
              AND NOT EXISTS (
                SELECT 1 FROM telegram_team_title_exclusions exclusion
                WHERE exclusion.user_telegram_id = team_sub.user_telegram_id
                  AND exclusion.team_id = tt.team_id
                  AND exclusion.book_ref = tt.book_ref
              )
            UNION
            SELECT explicit.user_telegram_id
            FROM ranobelib_team_translations tt
            JOIN ranobelib_teams team ON team.id = tt.team_id
            JOIN telegram_team_title_subscriptions explicit
              ON explicit.team_id = tt.team_id AND explicit.book_ref = tt.book_ref
            LEFT JOIN telegram_delivery_reachability reach
              ON reach.user_telegram_id = explicit.user_telegram_id
            WHERE tt.book_ref = cw.book_ref
              AND team.lifecycle_state = 'published'
              AND tt.presence_state = 'active'
              AND tt.semantic_status <> 'completed'
              AND COALESCE(reach.state, 'active') <> 'blocked'
              AND NOT EXISTS (
                SELECT 1 FROM telegram_team_title_exclusions exclusion
                WHERE exclusion.user_telegram_id = explicit.user_telegram_id
                  AND exclusion.team_id = tt.team_id
                  AND exclusion.book_ref = tt.book_ref
              )
          ) users_for_work
        ) AS demand_count
      FROM candidate_works cw
    )
    UPDATE ranobelib_titles
    SET
      next_check_at = CASE
        WHEN notification_subscriber_count = 0
          AND COALESCE((SELECT demand_count FROM demand WHERE demand.book_ref = ranobelib_titles.book_ref), 0) > 0
          THEN CURRENT_TIMESTAMP
        WHEN notification_subscriber_count > 0
          AND COALESCE((SELECT demand_count FROM demand WHERE demand.book_ref = ranobelib_titles.book_ref), 0) = 0
          THEN datetime(CURRENT_TIMESTAMP, '+${MULTI_TEAM_IDLE_SCAN_DELAY_MINUTES} minutes')
        ELSE next_check_at
      END,
      scan_priority = CASE
        WHEN notification_subscriber_count = 0
          AND COALESCE((SELECT demand_count FROM demand WHERE demand.book_ref = ranobelib_titles.book_ref), 0) > 0
          THEN scan_priority + ${MULTI_TEAM_DEMAND_WAKE_PRIORITY_BOOST}
        ELSE scan_priority
      END,
      notification_subscriber_count = COALESCE(
        (SELECT demand_count FROM demand WHERE demand.book_ref = ranobelib_titles.book_ref),
        0
      ),
      subscriber_count_updated_at = CURRENT_TIMESTAMP
    WHERE book_ref IN (SELECT book_ref FROM candidate_works)
  `).run();
}

/** Returns the distinct currently eligible recipients for a concrete branch-aware release. */
export async function eligibleReleaseRecipientIds(
  env: MultiTeamNotificationDemandEnv,
  releaseId: string,
): Promise<string[]> {
  const { results } = await env.DB.prepare(`${effectiveReleaseRecipientsCte()}
    SELECT DISTINCT user_telegram_id
    FROM effective_recipients
    ORDER BY user_telegram_id
  `).bind(releaseId).all<{ user_telegram_id: string }>();
  return results.map((row) => String(row.user_telegram_id)).filter(Boolean);
}

/**
 * Reconciles the legacy trigger's provisional rows with team-aware eligibility, then inserts any
 * new-team recipients. Sent/disabled history is never deleted.
 */
export async function reconcileReleaseOutboxRecipients(
  env: MultiTeamNotificationDemandEnv,
  releaseId: string,
): Promise<number> {
  const id = String(releaseId || '').trim();
  if (!id) return 0;

  await env.DB.prepare(`${effectiveReleaseRecipientsCte()}
    DELETE FROM ranobelib_notification_outbox
    WHERE release_id = ?
      AND status IN ('pending', 'retry')
      AND user_telegram_id NOT IN (
        SELECT DISTINCT user_telegram_id FROM effective_recipients
      )
  `).bind(id, id).run();

  await env.DB.prepare(`${effectiveReleaseRecipientsCte()}
    INSERT OR IGNORE INTO ranobelib_notification_outbox (release_id, user_telegram_id)
    SELECT ?, user_telegram_id
    FROM effective_recipients
    GROUP BY user_telegram_id
  `).bind(id, id).run();

  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM ranobelib_notification_outbox
    WHERE release_id = ? AND status IN ('pending', 'retry')
  `).bind(id).first<CountRow>();
  return safeCount(row?.count);
}

export async function isUserEligibleForRelease(
  env: MultiTeamNotificationDemandEnv,
  releaseId: string,
  userId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(`${effectiveReleaseRecipientsCte()}
    SELECT 1 AS eligible
    FROM effective_recipients
    WHERE user_telegram_id = ?
    LIMIT 1
  `).bind(releaseId, userId).first<{ eligible: number | string }>();
  return Number(row?.eligible ?? 0) === 1;
}

function effectiveWorkDemandCte(): string {
  return `
    WITH effective_recipients AS (
      SELECT team_sub.user_telegram_id
      FROM ranobelib_team_translations tt
      JOIN ranobelib_teams team ON team.id = tt.team_id
      JOIN telegram_team_subscriptions team_sub ON team_sub.team_id = tt.team_id
      LEFT JOIN telegram_delivery_reachability reach
        ON reach.user_telegram_id = team_sub.user_telegram_id
      WHERE tt.book_ref = ?
        AND team.lifecycle_state = 'published'
        AND tt.presence_state = 'active'
        AND tt.semantic_status <> 'completed'
        AND COALESCE(reach.state, 'active') <> 'blocked'
        AND NOT EXISTS (
          SELECT 1 FROM telegram_team_title_exclusions exclusion
          WHERE exclusion.user_telegram_id = team_sub.user_telegram_id
            AND exclusion.team_id = tt.team_id
            AND exclusion.book_ref = tt.book_ref
        )
      UNION
      SELECT explicit.user_telegram_id
      FROM ranobelib_team_translations tt
      JOIN ranobelib_teams team ON team.id = tt.team_id
      JOIN telegram_team_title_subscriptions explicit
        ON explicit.team_id = tt.team_id AND explicit.book_ref = tt.book_ref
      LEFT JOIN telegram_delivery_reachability reach
        ON reach.user_telegram_id = explicit.user_telegram_id
      WHERE tt.book_ref = ?
        AND team.lifecycle_state = 'published'
        AND tt.presence_state = 'active'
        AND tt.semantic_status <> 'completed'
        AND COALESCE(reach.state, 'active') <> 'blocked'
        AND NOT EXISTS (
          SELECT 1 FROM telegram_team_title_exclusions exclusion
          WHERE exclusion.user_telegram_id = explicit.user_telegram_id
            AND exclusion.team_id = tt.team_id
            AND exclusion.book_ref = tt.book_ref
        )
    )`;
}

function effectiveReleaseRecipientsCte(): string {
  return `
    WITH release_context AS (
      SELECT r.id AS release_id, r.book_ref, rt.team_id
      FROM ranobelib_releases r
      JOIN ranobelib_release_teams rt ON rt.release_id = r.id
      JOIN ranobelib_teams team ON team.id = rt.team_id
      JOIN ranobelib_team_translations tt
        ON tt.team_id = rt.team_id AND tt.book_ref = r.book_ref
      WHERE r.id = ?
        AND team.lifecycle_state = 'published'
        AND tt.presence_state = 'active'
    ),
    effective_recipients AS (
      SELECT team_sub.user_telegram_id
      FROM release_context rc
      JOIN telegram_team_subscriptions team_sub ON team_sub.team_id = rc.team_id
      LEFT JOIN telegram_delivery_reachability reach
        ON reach.user_telegram_id = team_sub.user_telegram_id
      WHERE COALESCE(reach.state, 'active') <> 'blocked'
        AND NOT EXISTS (
          SELECT 1 FROM telegram_team_title_exclusions exclusion
          WHERE exclusion.user_telegram_id = team_sub.user_telegram_id
            AND exclusion.team_id = rc.team_id
            AND exclusion.book_ref = rc.book_ref
        )
      UNION
      SELECT explicit.user_telegram_id
      FROM release_context rc
      JOIN telegram_team_title_subscriptions explicit
        ON explicit.team_id = rc.team_id AND explicit.book_ref = rc.book_ref
      LEFT JOIN telegram_delivery_reachability reach
        ON reach.user_telegram_id = explicit.user_telegram_id
      WHERE COALESCE(reach.state, 'active') <> 'blocked'
        AND NOT EXISTS (
          SELECT 1 FROM telegram_team_title_exclusions exclusion
          WHERE exclusion.user_telegram_id = explicit.user_telegram_id
            AND exclusion.team_id = rc.team_id
            AND exclusion.book_ref = rc.book_ref
        )
    )`;
}

function safeCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}
