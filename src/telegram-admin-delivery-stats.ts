const INSTANT_COALESCE_SECONDS = 30;

/**
 * Admin diagnostics mirror the live multi-team delivery selector at group granularity.
 * A group is one user + work + delivery scope, matching the unit claimed by the live drain.
 */
export function buildTelegramDeliveryStatsQuery(): string {
  return `
    WITH candidate_rows AS (
      SELECT
        o.release_id, o.user_telegram_id, o.status, o.available_at,
        o.claim_token, o.claim_expires_at, o.created_at,
        r.book_ref, COALESCE(r.delivery_scope_key,'') AS delivery_scope_key,
        r.release_kind, r.chapter_count,
        CASE WHEN EXISTS(SELECT 1 FROM ranobelib_release_teams rt0 WHERE rt0.release_id=r.id) THEN 1 ELSE 0 END AS has_team_mapping,
        CASE WHEN (
          (
            (COALESCE(global_settings.all_titles,0)=1 AND NOT EXISTS (
              SELECT 1 FROM title_subscription_exclusions legacy_exclusion
              WHERE legacy_exclusion.user_telegram_id=o.user_telegram_id
                AND legacy_exclusion.book_ref=r.book_ref
            ))
            OR
            (COALESCE(global_settings.all_titles,0)<>1 AND EXISTS (
              SELECT 1 FROM title_subscriptions legacy_explicit
              WHERE legacy_explicit.user_telegram_id=o.user_telegram_id
                AND legacy_explicit.book_ref=r.book_ref
            ))
          )
          AND COALESCE(reach.state,'active')<>'blocked'
        ) THEN 1 ELSE 0 END AS legacy_eligible,
        COALESCE(legacy_title_mode.delivery_mode,global_settings.delivery_mode,'instant') AS legacy_delivery_mode,
        COALESCE(legacy_title_mode.stack_size,global_settings.stack_size) AS legacy_stack_size
      FROM ranobelib_notification_outbox o
      JOIN ranobelib_releases r ON r.id=o.release_id
      JOIN ranobelib_titles lifecycle
        ON lifecycle.book_ref=r.book_ref AND lifecycle.translation_completion_pending=0
      LEFT JOIN telegram_subscription_settings global_settings
        ON global_settings.user_telegram_id=o.user_telegram_id
      LEFT JOIN telegram_title_delivery_settings legacy_title_mode
        ON legacy_title_mode.user_telegram_id=o.user_telegram_id
       AND legacy_title_mode.book_ref=r.book_ref
      LEFT JOIN telegram_delivery_reachability reach
        ON reach.user_telegram_id=o.user_telegram_id
      WHERE o.status IN ('pending','retry')
    ), eligible_team_settings AS (
      SELECT
        c.release_id, c.user_telegram_id,
        CASE
          WHEN COALESCE(team_title_mode.delivery_mode,global_settings.delivery_mode,'instant')='stack'
            AND COALESCE(team_title_mode.stack_size,global_settings.stack_size) BETWEEN 2 AND 100
          THEN 'stack' ELSE 'instant'
        END AS delivery_mode,
        CASE
          WHEN COALESCE(team_title_mode.delivery_mode,global_settings.delivery_mode,'instant')='stack'
            AND COALESCE(team_title_mode.stack_size,global_settings.stack_size) BETWEEN 2 AND 100
          THEN COALESCE(team_title_mode.stack_size,global_settings.stack_size)
          ELSE NULL
        END AS stack_size
      FROM candidate_rows c
      JOIN ranobelib_release_teams rt ON rt.release_id=c.release_id
      JOIN ranobelib_teams team ON team.id=rt.team_id AND team.lifecycle_state='published'
      JOIN ranobelib_team_translations tt
        ON tt.team_id=rt.team_id AND tt.book_ref=c.book_ref AND tt.presence_state='active'
      LEFT JOIN telegram_subscription_settings global_settings
        ON global_settings.user_telegram_id=c.user_telegram_id
      LEFT JOIN telegram_team_title_delivery_settings team_title_mode
        ON team_title_mode.user_telegram_id=c.user_telegram_id
       AND team_title_mode.team_id=rt.team_id
       AND team_title_mode.book_ref=c.book_ref
      LEFT JOIN telegram_delivery_reachability reach
        ON reach.user_telegram_id=c.user_telegram_id
      WHERE COALESCE(reach.state,'active')<>'blocked'
        AND NOT EXISTS (
          SELECT 1 FROM telegram_team_title_exclusions exclusion
          WHERE exclusion.user_telegram_id=c.user_telegram_id
            AND exclusion.team_id=rt.team_id
            AND exclusion.book_ref=c.book_ref
        )
        AND (
          EXISTS (
            SELECT 1 FROM telegram_team_subscriptions whole
            WHERE whole.user_telegram_id=c.user_telegram_id AND whole.team_id=rt.team_id
          )
          OR EXISTS (
            SELECT 1 FROM telegram_team_title_subscriptions explicit
            WHERE explicit.user_telegram_id=c.user_telegram_id
              AND explicit.team_id=rt.team_id
              AND explicit.book_ref=c.book_ref
          )
        )
    ), team_release_effective AS (
      SELECT
        release_id, user_telegram_id,
        COUNT(*) AS eligible_team_count,
        CASE WHEN MAX(CASE WHEN delivery_mode='instant' THEN 1 ELSE 0 END)=1
          THEN 'instant' ELSE 'stack' END AS delivery_mode,
        MIN(CASE WHEN delivery_mode='stack' THEN stack_size END) AS stack_size
      FROM eligible_team_settings
      GROUP BY release_id, user_telegram_id
    ), release_effective AS (
      SELECT
        c.release_id, c.user_telegram_id,
        CASE WHEN c.has_team_mapping=1
          THEN CASE WHEN COALESCE(team_effective.eligible_team_count,0)>0 THEN 1 ELSE 0 END
          ELSE c.legacy_eligible END AS eligible,
        CASE WHEN c.has_team_mapping=1
          THEN COALESCE(team_effective.delivery_mode,'instant')
          ELSE c.legacy_delivery_mode END AS delivery_mode,
        CASE WHEN c.has_team_mapping=1
          THEN team_effective.stack_size ELSE c.legacy_stack_size END AS stack_size
      FROM candidate_rows c
      LEFT JOIN team_release_effective team_effective
        ON team_effective.release_id=c.release_id
       AND team_effective.user_telegram_id=c.user_telegram_id
    ), notification_groups AS (
      SELECT
        c.user_telegram_id,
        c.book_ref,
        c.delivery_scope_key,
        SUM(CASE WHEN c.release_kind='chapters' THEN c.chapter_count ELSE 0 END) AS pending_chapters,
        MIN(c.created_at) AS oldest_pending_at,
        MAX(CASE WHEN c.release_kind='translation_completed' THEN 1 ELSE 0 END) AS translation_completed,
        MAX(CASE WHEN c.status='retry' AND c.available_at>CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS retry_blocked,
        MAX(CASE WHEN c.claim_token IS NOT NULL AND c.claim_expires_at IS NOT NULL
          AND c.claim_expires_at>CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS lease_blocked,
        MIN(e.eligible) AS eligible,
        CASE WHEN MAX(CASE WHEN e.delivery_mode<>'stack' THEN 1 ELSE 0 END)=1
          THEN 'instant' ELSE 'stack' END AS delivery_mode,
        MIN(CASE WHEN e.delivery_mode='stack' THEN e.stack_size END) AS stack_size
      FROM candidate_rows c
      JOIN release_effective e
        ON e.release_id=c.release_id AND e.user_telegram_id=c.user_telegram_id
      GROUP BY c.user_telegram_id, c.book_ref, c.delivery_scope_key
    ), classified AS (
      SELECT *, CASE
        WHEN eligible=0 THEN 'stale_ineligible'
        WHEN lease_blocked=1 THEN 'in_lease'
        WHEN retry_blocked=1 THEN 'retry_blocked'
        WHEN translation_completed=1 THEN 'ready_now'
        WHEN delivery_mode<>'stack'
          AND oldest_pending_at<=datetime('now','-${INSTANT_COALESCE_SECONDS} seconds') THEN 'ready_now'
        WHEN delivery_mode<>'stack' THEN 'coalescing'
        WHEN stack_size IS NULL OR stack_size<2 OR stack_size>100 THEN 'ready_now'
        WHEN pending_chapters>=stack_size THEN 'ready_now'
        WHEN oldest_pending_at<=datetime('now','-7 days') THEN 'ready_now'
        ELSE 'stack_waiting'
      END AS delivery_bucket
      FROM notification_groups
    )
    SELECT
      (SELECT COUNT(*) FROM ranobelib_notification_outbox WHERE status='pending') AS pending,
      (SELECT COUNT(*) FROM ranobelib_notification_outbox WHERE status='retry') AS retry,
      (SELECT COUNT(*) FROM ranobelib_notification_outbox WHERE status='sent') AS sent,
      (SELECT COUNT(*) FROM ranobelib_notification_outbox WHERE status='disabled') AS disabled,
      (SELECT COUNT(*) FROM ranobelib_notification_outbox
        WHERE status='sent' AND delivered_at>=datetime('now','-24 hours')) AS sent_24h,
      (SELECT COUNT(*) FROM ranobelib_notification_outbox
        WHERE status='sent' AND delivered_at>=datetime('now','-7 days')) AS sent_7d,
      (SELECT COUNT(*) FROM classified WHERE delivery_bucket='ready_now') AS ready_now,
      (SELECT COUNT(*) FROM classified WHERE delivery_bucket='coalescing') AS coalescing,
      (SELECT COUNT(*) FROM classified WHERE delivery_bucket='stack_waiting') AS stack_waiting,
      (SELECT COUNT(*) FROM classified WHERE delivery_bucket='retry_blocked') AS retry_blocked,
      (SELECT COUNT(*) FROM classified WHERE delivery_bucket='in_lease') AS in_lease,
      (SELECT COUNT(*) FROM classified WHERE delivery_bucket='stale_ineligible') AS stale_ineligible,
      CAST(COALESCE((julianday('now') - julianday((
        SELECT MIN(oldest_pending_at) FROM classified WHERE delivery_bucket='ready_now'
      ))) * 1440,0) AS INTEGER) AS oldest_ready_minutes
  `;
}
