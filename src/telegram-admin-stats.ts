import { buildTelegramDeliveryStatsQuery } from './telegram-admin-delivery-stats.js';
import { renderTelegramScreen, type TelegramScreenExecutionContext } from './telegram-screen-renderer.js';

type D1Row = Record<string, unknown>;
type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<{ results: T[] }>;
};
type D1Database = {
  prepare(query: string): D1Statement;
  batch?<T = D1Row>(statements: D1Statement[]): Promise<Array<{ results?: T[] }>>;
};

export type TelegramAdminStatsEnv = {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  ADMIN_TELEGRAM_IDS?: string;
};

type StatsExecutionContext = TelegramScreenExecutionContext;
type StatsUpdate = {
  message?: {
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { id?: number };
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
    message?: { message_id?: number; chat?: { id?: number; type?: string } };
  };
};

type StatsSection = 'home' | 'users' | 'subscriptions' | 'translations' | 'delivery' | 'proposals' | 'publications' | 'access' | 'system';

type StatsSnapshot = {
  users: D1Row;
  subscriptions: D1Row;
  translations: D1Row;
  delivery: D1Row;
  proposals: D1Row;
  publications: D1Row;
  access: D1Row;
  system: D1Row;
  translationHealth: D1Row;
  multiTeam: D1Row;
};

type TranslationProblem = {
  book_ref?: unknown;
  title?: unknown;
  unknown?: unknown;
  has_error?: unknown;
  sync_error?: unknown;
  failures?: unknown;
  delay_minutes?: unknown;
};

const SECTION_LABELS: Array<[Exclude<StatsSection, 'home'>, string]> = [
  ['users', '👥 Пользователи'],
  ['subscriptions', '🔔 Подписки'],
  ['translations', '📚 Переводы'],
  ['delivery', '📦 Доставка'],
  ['proposals', '📝 Заявки'],
  ['publications', '📖 Публикации'],
  ['access', '🛡 Доступ'],
  ['system', '⚙️ Система'],
];

export async function handleTelegramAdminStatsWebhook(
  request: Request,
  env: TelegramAdminStatsEnv,
  ctx?: StatsExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;

  const update = await request.clone().json().catch(() => null) as StatsUpdate | null;
  if (!update) return null;
  const command = update.message?.text?.trim() ?? '';
  const callbackData = update.callback_query?.data?.trim() ?? '';
  const isStatsCommand = /^\/stats(?:@[A-Za-z0-9_]+)?$/i.test(command);
  const isStatsCallback = /^stats:(?:home|refresh|users|subscriptions|translations|delivery|proposals|publications|access|system)$/.test(callbackData);
  if (!isStatsCommand && !isStatsCallback) return null;

  const userId = Number(update.callback_query?.from?.id ?? update.message?.from?.id);
  if (!Number.isSafeInteger(userId) || !isAdmin(env, userId)) {
    return new Response('ok');
  }

  const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id ?? userId;
  const chatType = update.callback_query?.message?.chat?.type ?? update.message?.chat?.type;
  if (chatType && chatType !== 'private') return new Response('ok');

  if (isStatsCallback && update.callback_query?.id) {
    await answerCallback(env, update.callback_query.id);
  }

  const section: StatsSection = callbackData === 'stats:refresh' || callbackData === 'stats:home'
    ? 'home'
    : callbackData.startsWith('stats:')
      ? callbackData.slice('stats:'.length) as StatsSection
      : 'home';
  const snapshot = await loadStatsSnapshot(env.DB);
  const payload = buildStatsScreen(section, snapshot);
  const messageId = update.callback_query?.message?.message_id;

  await renderTelegramScreen(
    env,
    { chatId, ...(messageId ? { messageId } : {}) },
    payload,
    { strategy: messageId ? 'edit' : 'send', ctx },
  );
  return new Response('ok');
}

async function loadStatsSnapshot(db: D1Database): Promise<StatsSnapshot> {
  const statements = [
    db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS new_24h,
      SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS new_7d,
      SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS new_30d
      FROM users`),
    db.prepare(`WITH rollout AS (
      SELECT COALESCE((
        SELECT CASE WHEN value='1' THEN 1 ELSE 0 END
        FROM app_settings
        WHERE key='ranobelib_multi_team_delivery'
      ),0) AS enabled
    )
    SELECT
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(*) FROM (
          SELECT s.user_telegram_id
          FROM telegram_team_subscriptions s
          JOIN ranobelib_teams team ON team.id=s.team_id
          WHERE team.lifecycle_state='published'
          UNION
          SELECT s.user_telegram_id
          FROM telegram_team_title_subscriptions s
          JOIN ranobelib_teams team ON team.id=s.team_id
          WHERE team.lifecycle_state='published'
        )
      ) ELSE (
        SELECT COUNT(*) FROM (
          SELECT user_telegram_id FROM telegram_subscription_settings WHERE all_titles=1
          UNION SELECT user_telegram_id FROM title_subscriptions
        )
      ) END AS users_enabled,
      (SELECT COUNT(*) FROM (
        SELECT user_telegram_id FROM telegram_subscription_settings WHERE all_titles=1
        UNION SELECT user_telegram_id FROM title_subscriptions
      )) AS legacy_users_enabled,
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(DISTINCT s.user_telegram_id)
        FROM telegram_team_subscriptions s
        JOIN ranobelib_teams team ON team.id=s.team_id
        WHERE team.lifecycle_state='published'
      ) ELSE (
        SELECT COUNT(*) FROM telegram_subscription_settings WHERE all_titles=1
      ) END AS all_titles_users,
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(*)
        FROM telegram_team_title_subscriptions s
        JOIN ranobelib_teams team ON team.id=s.team_id
        WHERE team.lifecycle_state='published'
      ) ELSE (
        SELECT COUNT(*) FROM title_subscriptions
      ) END AS explicit_subscriptions,
      (SELECT COUNT(*) FROM telegram_subscription_settings WHERE COALESCE(delivery_mode,'instant')='instant') AS instant_users,
      (SELECT COUNT(*) FROM telegram_subscription_settings WHERE delivery_mode='stack') AS stack_users,
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(*)
        FROM telegram_team_title_delivery_settings s
        JOIN ranobelib_teams team ON team.id=s.team_id
        WHERE team.lifecycle_state='published'
      ) ELSE (
        SELECT COUNT(*) FROM telegram_title_delivery_settings
      ) END AS title_overrides
    FROM rollout`),
    db.prepare(`WITH rollout AS (
      SELECT COALESCE((
        SELECT CASE WHEN value='1' THEN 1 ELSE 0 END
        FROM app_settings
        WHERE key='ranobelib_multi_team_delivery'
      ),0) AS enabled
    )
    SELECT
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(DISTINCT tt.book_ref)
        FROM ranobelib_team_translations tt
        JOIN ranobelib_teams team ON team.id=tt.team_id
        WHERE team.lifecycle_state='published'
      ) ELSE (SELECT COUNT(*) FROM ranobelib_titles) END AS total,
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(DISTINCT tt.book_ref)
        FROM ranobelib_team_translations tt
        JOIN ranobelib_teams team ON team.id=tt.team_id
        WHERE team.lifecycle_state='published'
          AND tt.presence_state='active'
          AND tt.semantic_status<>'completed'
      ) ELSE (SELECT COUNT(*) FROM ranobelib_titles WHERE is_active=1) END AS active,
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(DISTINCT tt.book_ref)
        FROM ranobelib_team_translations tt
        JOIN ranobelib_teams team ON team.id=tt.team_id
        WHERE team.lifecycle_state='published'
          AND tt.presence_state='active'
          AND tt.semantic_status='completed'
          AND NOT EXISTS (
            SELECT 1
            FROM ranobelib_team_translations other
            JOIN ranobelib_teams other_team ON other_team.id=other.team_id
            WHERE other.book_ref=tt.book_ref
              AND other_team.lifecycle_state='published'
              AND other.presence_state='active'
              AND other.semantic_status<>'completed'
          )
      ) ELSE (SELECT COUNT(*) FROM ranobelib_titles WHERE translation_is_completed=1) END AS completed,
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(DISTINCT tt.book_ref)
        FROM ranobelib_team_translations tt
        JOIN ranobelib_teams team ON team.id=tt.team_id
        WHERE team.lifecycle_state='published'
          AND tt.presence_state='dormant'
          AND NOT EXISTS (
            SELECT 1
            FROM ranobelib_team_translations active_tt
            JOIN ranobelib_teams active_team ON active_team.id=active_tt.team_id
            WHERE active_tt.book_ref=tt.book_ref
              AND active_team.lifecycle_state='published'
              AND active_tt.presence_state='active'
          )
      ) ELSE (
        SELECT COUNT(*) FROM ranobelib_titles
        WHERE is_active=0 AND COALESCE(translation_is_completed,0)<>1
      ) END AS archived,
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(DISTINCT tt.book_ref)
        FROM ranobelib_team_translations tt
        JOIN ranobelib_teams team ON team.id=tt.team_id
        WHERE team.lifecycle_state='published'
          AND tt.presence_state='active'
          AND tt.semantic_status='unknown'
      ) ELSE (
        SELECT COUNT(*) FROM ranobelib_titles
        WHERE is_active=1 AND translation_is_completed IS NULL
      ) END AS unknown_status,
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(*) FROM (
          SELECT tt.book_ref
          FROM ranobelib_team_translations tt
          JOIN ranobelib_teams team ON team.id=tt.team_id
          WHERE team.lifecycle_state='published' AND tt.presence_state='active'
          GROUP BY tt.book_ref
          HAVING MIN(tt.baseline_ready)=1
        )
      ) ELSE (SELECT COUNT(*) FROM ranobelib_titles WHERE snapshot_ready=1) END AS snapshot_ready,
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(*)
        FROM ranobelib_titles t
        WHERE t.sync_error IS NOT NULL AND TRIM(t.sync_error)<>''
          AND EXISTS (
            SELECT 1
            FROM ranobelib_team_translations tt
            JOIN ranobelib_teams team ON team.id=tt.team_id
            WHERE tt.book_ref=t.book_ref
              AND team.lifecycle_state='published'
              AND tt.presence_state='active'
              AND tt.semantic_status<>'completed'
          )
      ) ELSE (
        SELECT COUNT(*) FROM ranobelib_titles
        WHERE is_active=1 AND sync_error IS NOT NULL AND TRIM(sync_error)<>''
      ) END AS with_errors,
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(*)
        FROM ranobelib_titles t
        WHERE t.next_check_at IS NOT NULL AND t.next_check_at<=CURRENT_TIMESTAMP
          AND EXISTS (
            SELECT 1
            FROM ranobelib_team_translations tt
            JOIN ranobelib_teams team ON team.id=tt.team_id
            WHERE tt.book_ref=t.book_ref
              AND team.lifecycle_state='published'
              AND tt.presence_state='active'
              AND tt.semantic_status<>'completed'
          )
      ) ELSE (
        SELECT COUNT(*) FROM ranobelib_titles
        WHERE is_active=1 AND next_check_at IS NOT NULL AND next_check_at<=CURRENT_TIMESTAMP
      ) END AS due_now,
      CASE WHEN enabled=1 THEN (
        SELECT COUNT(*)
        FROM ranobelib_titles t
        WHERE t.next_check_at IS NOT NULL AND t.next_check_at<datetime('now','-5 minutes')
          AND EXISTS (
            SELECT 1
            FROM ranobelib_team_translations tt
            JOIN ranobelib_teams team ON team.id=tt.team_id
            WHERE tt.book_ref=t.book_ref
              AND team.lifecycle_state='published'
              AND tt.presence_state='active'
              AND tt.semantic_status<>'completed'
          )
      ) ELSE (
        SELECT COUNT(*) FROM ranobelib_titles
        WHERE is_active=1 AND next_check_at IS NOT NULL AND next_check_at<datetime('now','-5 minutes')
      ) END AS late_5m,
      CASE WHEN enabled=1 THEN (
        SELECT COALESCE(SUM(COALESCE(t.notification_subscriber_count,0)),0)
        FROM ranobelib_titles t
        WHERE EXISTS (
          SELECT 1
          FROM ranobelib_team_translations tt
          JOIN ranobelib_teams team ON team.id=tt.team_id
          WHERE tt.book_ref=t.book_ref
            AND team.lifecycle_state='published'
            AND tt.presence_state='active'
            AND tt.semantic_status<>'completed'
        )
      ) ELSE (
        SELECT COALESCE(SUM(COALESCE(notification_subscriber_count,0)),0) FROM ranobelib_titles
      ) END AS subscribers
    FROM rollout`),
    db.prepare(buildTelegramDeliveryStatsQuery()),
    db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN p.created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS new_24h,
      SUM(CASE WHEN p.created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS new_7d,
      SUM(CASE WHEN p.status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN p.status='approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN p.status='rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN p.status NOT IN ('pending','approved','rejected') THEN 1 ELSE 0 END) AS other,
      (SELECT COUNT(*) FROM proposal_votes) AS votes
      FROM chapter_proposals p`),
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM publications) AS publications,
      (SELECT COUNT(*) FROM publications WHERE status='published') AS published,
      (SELECT COUNT(*) FROM publication_deliveries) AS deliveries,
      (SELECT COUNT(*) FROM publication_deliveries WHERE status NOT IN ('sent','delivered') AND last_error IS NOT NULL) AS delivery_errors,
      (SELECT COUNT(DISTINCT user_telegram_id) FROM publication_reader_events WHERE user_telegram_id IS NOT NULL) AS unique_readers,
      (SELECT COUNT(*) FROM publication_reader_events) AS reader_events,
      (SELECT COUNT(*) FROM publication_thanks) AS thanks`),
    db.prepare(`SELECT
      COUNT(*) AS tracked,
      SUM(CASE WHEN a.last_status IN ('creator','administrator','member','restricted') THEN 1 ELSE 0 END) AS members,
      SUM(CASE WHEN a.left_at IS NOT NULL AND a.rejoined_at IS NULL THEN 1 ELSE 0 END) AS left_users,
      SUM(CASE WHEN a.blacklisted_at IS NOT NULL THEN 1 ELSE 0 END) AS blacklisted,
      (SELECT COUNT(*) FROM channel_telegram_bans WHERE banned_at IS NOT NULL) AS bans_done,
      (SELECT COUNT(*) FROM channel_telegram_bans WHERE banned_at IS NULL) AS bans_pending,
      (SELECT COUNT(*) FROM channel_membership_appeals WHERE status='pending') AS appeals_pending,
      (SELECT COUNT(*) FROM channel_membership_appeals WHERE status='approved') AS appeals_approved,
      (SELECT COUNT(*) FROM channel_membership_appeals WHERE status='rejected') AS appeals_rejected
      FROM channel_access_state a`),
    db.prepare(`WITH rollout AS (
      SELECT COALESCE((
        SELECT CASE WHEN value='1' THEN 1 ELSE 0 END
        FROM app_settings
        WHERE key='ranobelib_multi_team_delivery'
      ),0) AS enabled
    )
    SELECT
      SUM(CASE WHEN created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS releases_24h,
      SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS releases_7d,
      MAX(created_at) AS last_release_at,
      (SELECT MAX(t.last_synced_at)
       FROM ranobelib_titles t
       WHERE (enabled=0 AND t.is_active=1)
          OR (enabled=1 AND EXISTS (
            SELECT 1
            FROM ranobelib_team_translations tt
            JOIN ranobelib_teams team ON team.id=tt.team_id
            WHERE tt.book_ref=t.book_ref
              AND team.lifecycle_state='published'
              AND tt.presence_state='active'
              AND tt.semantic_status<>'completed'
          ))) AS last_sync_at,
      (SELECT COUNT(*)
       FROM ranobelib_titles t
       WHERE (t.consecutive_failures>0 OR (t.sync_error IS NOT NULL AND TRIM(t.sync_error)<>''))
         AND ((enabled=0 AND t.is_active=1)
          OR (enabled=1 AND EXISTS (
            SELECT 1
            FROM ranobelib_team_translations tt
            JOIN ranobelib_teams team ON team.id=tt.team_id
            WHERE tt.book_ref=t.book_ref
              AND team.lifecycle_state='published'
              AND tt.presence_state='active'
              AND tt.semantic_status<>'completed'
          )))) AS failures,
      (SELECT COUNT(*)
       FROM ranobelib_titles t
       WHERE t.next_check_at IS NOT NULL AND t.next_check_at<=CURRENT_TIMESTAMP
         AND ((enabled=0 AND t.is_active=1)
          OR (enabled=1 AND EXISTS (
            SELECT 1
            FROM ranobelib_team_translations tt
            JOIN ranobelib_teams team ON team.id=tt.team_id
            WHERE tt.book_ref=t.book_ref
              AND team.lifecycle_state='published'
              AND tt.presence_state='active'
              AND tt.semantic_status<>'completed'
          )))) AS due_scans
      FROM ranobelib_releases CROSS JOIN rollout`),
    db.prepare(`WITH rollout AS (
      SELECT COALESCE((
        SELECT CASE WHEN value='1' THEN 1 ELSE 0 END
        FROM app_settings
        WHERE key='ranobelib_multi_team_delivery'
      ),0) AS enabled
    )
    SELECT COALESCE(json_group_array(json_object(
      'book_ref', book_ref,
      'title', title,
      'unknown', unknown,
      'has_error', has_error,
      'sync_error', sync_error,
      'failures', failures,
      'delay_minutes', delay_minutes
    )), '[]') AS items
    FROM (
      SELECT
        t.book_ref AS book_ref,
        COALESCE(NULLIF(TRIM(t.title), ''), t.book_ref) AS title,
        CASE WHEN rollout.enabled=1 THEN CASE WHEN EXISTS (
          SELECT 1
          FROM ranobelib_team_translations tt
          JOIN ranobelib_teams team ON team.id=tt.team_id
          WHERE tt.book_ref=t.book_ref
            AND team.lifecycle_state='published'
            AND tt.presence_state='active'
            AND tt.semantic_status='unknown'
        ) THEN 1 ELSE 0 END ELSE CASE WHEN t.translation_is_completed IS NULL THEN 1 ELSE 0 END END AS unknown,
        CASE WHEN t.sync_error IS NOT NULL AND TRIM(t.sync_error)<>'' THEN 1 ELSE 0 END AS has_error,
        t.sync_error AS sync_error,
        COALESCE(t.consecutive_failures,0) AS failures,
        CASE
          WHEN t.next_check_at IS NOT NULL AND t.next_check_at < datetime('now','-5 minutes')
          THEN CAST(MAX(0, (julianday('now') - julianday(t.next_check_at)) * 1440) AS INTEGER)
          ELSE 0
        END AS delay_minutes
      FROM ranobelib_titles t CROSS JOIN rollout
      WHERE (
          (rollout.enabled=0 AND t.is_active=1)
          OR (rollout.enabled=1 AND EXISTS (
            SELECT 1
            FROM ranobelib_team_translations tt
            JOIN ranobelib_teams team ON team.id=tt.team_id
            WHERE tt.book_ref=t.book_ref
              AND team.lifecycle_state='published'
              AND tt.presence_state='active'
              AND tt.semantic_status<>'completed'
          ))
        )
        AND (
          (rollout.enabled=0 AND t.translation_is_completed IS NULL)
          OR (rollout.enabled=1 AND EXISTS (
            SELECT 1
            FROM ranobelib_team_translations tt
            JOIN ranobelib_teams team ON team.id=tt.team_id
            WHERE tt.book_ref=t.book_ref
              AND team.lifecycle_state='published'
              AND tt.presence_state='active'
              AND tt.semantic_status='unknown'
          ))
          OR (t.sync_error IS NOT NULL AND TRIM(t.sync_error)<>'')
          OR (t.next_check_at IS NOT NULL AND t.next_check_at < datetime('now','-5 minutes'))
        )
      ORDER BY
        CASE WHEN t.sync_error IS NOT NULL AND TRIM(t.sync_error)<>'' THEN 1 ELSE 0 END DESC,
        unknown DESC,
        t.next_check_at ASC
      LIMIT 6
    )`),
    db.prepare(`SELECT
      SUM(CASE WHEN lifecycle_state='published' THEN 1 ELSE 0 END) AS teams_published,
      SUM(CASE WHEN lifecycle_state='hidden' THEN 1 ELSE 0 END) AS teams_hidden,
      SUM(CASE WHEN lifecycle_state='paused' THEN 1 ELSE 0 END) AS teams_paused,
      SUM(CASE WHEN lifecycle_state='error' THEN 1 ELSE 0 END) AS teams_error,
      SUM(CASE WHEN lifecycle_state='error' OR (last_sync_error IS NOT NULL AND TRIM(last_sync_error)<>'' ) THEN 1 ELSE 0 END) AS teams_sync_errors,
      SUM(CASE WHEN lifecycle_state IN ('published','hidden') AND (last_sync_at IS NULL OR last_sync_at < datetime('now','-6 hours')) THEN 1 ELSE 0 END) AS teams_stale,
      (SELECT COUNT(*) FROM ranobelib_chapter_branches WHERE identity_confidence='native') AS branches_native,
      (SELECT COUNT(*) FROM ranobelib_chapter_branches WHERE identity_confidence='fallback') AS branches_fallback,
      (SELECT COUNT(*) FROM ranobelib_chapter_branches WHERE identity_confidence='ambiguous') AS branches_ambiguous,
      (SELECT COUNT(*) FROM (
        SELECT s.user_telegram_id
        FROM telegram_team_subscriptions s
        JOIN ranobelib_teams p ON p.id=s.team_id
        WHERE p.is_primary=1
        UNION
        SELECT s.user_telegram_id
        FROM telegram_team_title_subscriptions s
        JOIN ranobelib_teams p ON p.id=s.team_id
        WHERE p.is_primary=1
      )) AS primary_effective_users,
      COALESCE((SELECT CASE WHEN value='1' THEN 1 ELSE 0 END FROM app_settings WHERE key='ranobelib_multi_team_shadow'),0) AS rollout_shadow,
      COALESCE((SELECT CASE WHEN value='1' THEN 1 ELSE 0 END FROM app_settings WHERE key='ranobelib_multi_team_delivery'),0) AS rollout_delivery,
      COALESCE((SELECT CASE WHEN value='1' THEN 1 ELSE 0 END FROM app_settings WHERE key='ranobelib_multi_team_ui'),0) AS rollout_ui
      FROM ranobelib_teams`),
  ];

  const rows = await batchFirstRows(db, statements);
  return {
    users: rows[0] ?? {},
    subscriptions: rows[1] ?? {},
    translations: rows[2] ?? {},
    delivery: rows[3] ?? {},
    proposals: rows[4] ?? {},
    publications: rows[5] ?? {},
    access: rows[6] ?? {},
    system: rows[7] ?? {},
    translationHealth: rows[8] ?? {},
    multiTeam: rows[9] ?? {},
  };
}

async function batchFirstRows(db: D1Database, statements: D1Statement[]): Promise<D1Row[]> {
  if (typeof db.batch === 'function') {
    const results = await db.batch<D1Row>(statements);
    return statements.map((_, index) => results[index]?.results?.[0] ?? {});
  }
  return Promise.all(statements.map(async (statement) => await statement.first<D1Row>() ?? {}));
}

function buildStatsScreen(section: StatsSection, s: StatsSnapshot) {
  const back = [[{ text: '↩️ Сводка', callback_data: 'stats:home' }], [{ text: '🔄 Обновить', callback_data: section === 'home' ? 'stats:refresh' : `stats:${section}` }]];
  if (section === 'users') return screen('👥 Пользователи', [
    line('Всего', s.users.total), line('Новые за 24 ч', s.users.new_24h), line('Новые за 7 дней', s.users.new_7d), line('Новые за 30 дней', s.users.new_30d),
  ], back);
  if (section === 'subscriptions') return screen('🔔 Подписки', [
    line('Пользователей с уведомлениями', s.subscriptions.users_enabled), line('Подписаны на все тайтлы', s.subscriptions.all_titles_users),
    line('Явных подписок', s.subscriptions.explicit_subscriptions), line('Мгновенный режим', s.subscriptions.instant_users),
    line('Режим стака', s.subscriptions.stack_users), line('Индивидуальных режимов', s.subscriptions.title_overrides),
  ], back);
  if (section === 'translations') {
    const problems = renderTranslationProblems(s.translationHealth);
    return screen('📚 Переводы', [
      line('Всего', s.translations.total), line('Активные', s.translations.active), line('Завершённые', s.translations.completed),
      line('Убраны из команды', s.translations.archived), line('Без статуса', s.translations.unknown_status), line('Snapshot готов', s.translations.snapshot_ready),
      line('С ошибками', s.translations.with_errors), line('Ожидают сканирования', s.translations.due_now), line('Задержка &gt;5 мин', s.translations.late_5m),
      line('Суммарный спрос подписчиков', s.translations.subscribers),
      '', '<b>Проблемные тайтлы</b>', ...problems,
    ], back);
  }
  if (section === 'delivery') return screen('📦 Доставка уведомлений', [
    line('Pending rows', s.delivery.pending), line('Retry rows', s.delivery.retry), line('Sent', s.delivery.sent), line('Disabled', s.delivery.disabled),
    '', '<b>Состояние очереди по группам</b>',
    line('Готовы прямо сейчас', s.delivery.ready_now),
    line('Ждут coalescing', s.delivery.coalescing),
    line('Ждут размер стака', s.delivery.stack_waiting),
    line('Retry заблокирован до available_at', s.delivery.retry_blocked),
    line('Удерживаются lease', s.delivery.in_lease),
    line('Устарели / подписка больше не подходит', s.delivery.stale_ineligible),
    `Возраст старейшей реально готовой: ${duration(s.delivery.oldest_ready_minutes)}`,
    '', line('Отправлено за 24 ч', s.delivery.sent_24h), line('Отправлено за 7 дней', s.delivery.sent_7d),
  ], back);
  if (section === 'proposals') return screen('📝 Заявки', [
    line('Всего', s.proposals.total), line('Новые за 24 ч', s.proposals.new_24h), line('Новые за 7 дней', s.proposals.new_7d),
    line('Pending', s.proposals.pending), line('Approved', s.proposals.approved), line('Rejected', s.proposals.rejected), line('Другие статусы', s.proposals.other), line('Голосов', s.proposals.votes),
  ], back);
  if (section === 'publications') return screen('📖 Публикации и читатели', [
    line('Публикаций', s.publications.publications), line('Опубликовано', s.publications.published), line('Выдач файлов', s.publications.deliveries),
    line('Ошибок выдачи', s.publications.delivery_errors), line('Уникальных читателей', s.publications.unique_readers), line('Reader events', s.publications.reader_events), line('Спасибо', s.publications.thanks),
  ], back);
  if (section === 'access') return screen('🛡 Доступ и модерация', [
    line('Отслеживается пользователей', s.access.tracked), line('Участников', s.access.members), line('Вышли', s.access.left_users), line('В blacklist', s.access.blacklisted),
    line('Банов выполнено', s.access.bans_done), line('Банов ожидают', s.access.bans_pending), line('Апелляций pending', s.access.appeals_pending),
    line('Апелляций approved', s.access.appeals_approved), line('Апелляций rejected', s.access.appeals_rejected),
  ], back);
  if (section === 'system') return screen('⚙️ Система', [
    line('Релизов за 24 ч', s.system.releases_24h), line('Релизов за 7 дней', s.system.releases_7d),
    `Последний релиз: ${formatDate(s.system.last_release_at)}`, `Последняя синхронизация: ${formatDate(s.system.last_sync_at)}`,
    line('Тайтлов с ошибками', s.system.failures), line('Сканов готовы сейчас', s.system.due_scans),
    '', '<b>Multi-team RanobeLib</b>',
    `Команды: <b>${n(s.multiTeam.teams_published)}</b> published / <b>${n(s.multiTeam.teams_hidden)}</b> hidden / <b>${n(s.multiTeam.teams_paused)}</b> paused / <b>${n(s.multiTeam.teams_error)}</b> error`,
    `Sync: errors <b>${n(s.multiTeam.teams_sync_errors)}</b> / stale <b>${n(s.multiTeam.teams_stale)}</b>`,
    `Branch identity: native <b>${n(s.multiTeam.branches_native)}</b> / fallback <b>${n(s.multiTeam.branches_fallback)}</b> / ambiguous <b>${n(s.multiTeam.branches_ambiguous)}</b>`,
    `Migration parity: legacy <b>${n(s.subscriptions.legacy_users_enabled ?? s.subscriptions.users_enabled)}</b> / primary <b>${n(s.multiTeam.primary_effective_users)}</b> / mismatch <b>${Math.abs(n(s.subscriptions.legacy_users_enabled ?? s.subscriptions.users_enabled) - n(s.multiTeam.primary_effective_users))}</b>`,
    `Rollout: shadow <b>${flag(s.multiTeam.rollout_shadow)}</b> / delivery <b>${flag(s.multiTeam.rollout_delivery)}</b> / UI <b>${flag(s.multiTeam.rollout_ui)}</b>`,
  ], back);

  const text = [
    '📊 <b>Статистика бота</b>', '',
    `👥 Пользователи: <b>${n(s.users.total)}</b>  (+${n(s.users.new_24h)} за 24 ч)`,
    `🔔 Получают уведомления: <b>${n(s.subscriptions.users_enabled)}</b>`,
    `📚 Переводы: <b>${n(s.translations.active)}</b> активных / <b>${n(s.translations.completed)}</b> завершённых / <b>${n(s.translations.archived)}</b> архивных`,
    `🧩 Команды: <b>${n(s.multiTeam.teams_published)}</b> published / <b>${n(s.multiTeam.teams_hidden)}</b> hidden / <b>${n(s.multiTeam.teams_paused)}</b> paused / <b>${n(s.multiTeam.teams_error)}</b> error · stale <b>${n(s.multiTeam.teams_stale)}</b> · sync errors <b>${n(s.multiTeam.teams_sync_errors)}</b>`,
    `📦 Очередь: <b>${n(s.delivery.ready_now)}</b> реально готово / <b>${n(s.delivery.retry_blocked)}</b> retry blocked / <b>${n(s.delivery.in_lease)}</b> lease`,
    `📝 Заявки: <b>${n(s.proposals.total)}</b>  (+${n(s.proposals.new_24h)} за 24 ч)`,
    `📖 Уникальных читателей: <b>${n(s.publications.unique_readers)}</b>`,
    `🛡 Blacklist: <b>${n(s.access.blacklisted)}</b> / апелляций: <b>${n(s.access.appeals_pending)}</b>`,
    `⚙️ Ошибок синхронизации: <b>${n(s.system.failures)}</b>`, '',
    `Обновлено: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
  ].join('\n');
  const buttons = [];
  for (let i = 0; i < SECTION_LABELS.length; i += 2) {
    buttons.push(SECTION_LABELS.slice(i, i + 2).map(([key, label]) => ({ text: label, callback_data: `stats:${key}` })));
  }
  buttons.push([{ text: '🔄 Обновить', callback_data: 'stats:refresh' }]);
  return { text, parse_mode: 'HTML' as const, reply_markup: { inline_keyboard: buttons } };
}

function renderTranslationProblems(row: D1Row): string[] {
  const raw = String(row.items ?? '[]');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return ['Нет проблемных тайтлов.'];

  const lines: string[] = [];
  for (const item of parsed.slice(0, 6) as TranslationProblem[]) {
    const title = escapeHtml(String(item.title ?? item.book_ref ?? 'Без названия'));
    const reasons: string[] = [];
    if (n(item.unknown) > 0) reasons.push('без статуса');
    if (n(item.has_error) > 0) reasons.push(`ошибка ×${Math.max(1, n(item.failures))}`);
    if (n(item.delay_minutes) > 5) reasons.push(`задержка ${duration(item.delay_minutes)}`);
    if (reasons.length === 0) reasons.push('требует проверки');
    lines.push(`• <b>${title}</b> — ${reasons.join('; ')}`);

    const error = String(item.sync_error ?? '').trim();
    if (error) lines.push(`  ↳ <code>${escapeHtml(clip(error, 140))}</code>`);
  }
  return lines;
}

function screen(title: string, lines: string[], buttons: Array<Array<{ text: string; callback_data: string }>>) {
  return { text: [`<b>${title}</b>`, '', ...lines].join('\n'), parse_mode: 'HTML' as const, reply_markup: { inline_keyboard: buttons } };
}

function line(label: string, value: unknown): string { return `${label}: <b>${n(value)}</b>`; }
function n(value: unknown): number { const x = Number(value ?? 0); return Number.isFinite(x) ? Math.max(0, Math.trunc(x)) : 0; }
function flag(value: unknown): string { return n(value) > 0 ? 'ON' : 'OFF'; }
function duration(value: unknown): string { const minutes = n(value); return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`; }
function formatDate(value: unknown): string { const text = String(value ?? '').trim(); return text || 'нет данных'; }
function clip(value: string, maxLength: number): string { return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`; }
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function isAdmin(env: TelegramAdminStatsEnv, userId: number): boolean {
  return String(env.ADMIN_TELEGRAM_IDS ?? '').split(/[,\s]+/).some((value) => Number(value) === userId);
}

async function answerCallback(env: TelegramAdminStatsEnv, callbackId: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackId }),
  }).then(async (response) => {
    const body = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram answerCallbackQuery failed with HTTP ${response.status}`);
  });
}