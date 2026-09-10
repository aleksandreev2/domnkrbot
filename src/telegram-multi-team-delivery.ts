import { recordTelegramDeliveryReachability, type TelegramDeliveryReachabilityOutcome } from './notification-demand.js';
import { refreshAllWorkNotificationDemand } from './multi-team-notification-demand.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './ranobelib-runtime.js';
import {
  aggregateClaimedDeliveryRows,
  type ClaimedDeliveryRowLike,
  type DeliveryGroup,
} from './telegram-notification-delivery-groups.js';
import {
  DELIVERY_BATCH_LIMIT,
  TELEGRAM_SEND_CONCURRENCY,
  computeTelegramStartDelayMs,
  type NotificationDeliveryEnv,
  type NotificationDeliveryResult,
  type NotificationDrainOptions,
} from './telegram-notification-delivery.js';
import { formatReleaseNotification } from './telegram-subscriptions.js';
import { formatTranslationCompletionNotification } from './telegram-translation-completion.js';

const CLAIM_LEASE_MINUTES = 10;

export type MultiTeamNotificationDeliveryEnv = NotificationDeliveryEnv;

type ReadyGroupKey = {
  user_telegram_id: string;
  book_ref: string;
  delivery_scope_key: string | null;
};

type DeliveryRow = ClaimedDeliveryRowLike & {
  status: string;
  attempts: number | string;
  eligible: number | string;
};

type DeliveryOutcome =
  | { kind: 'sent'; group: DeliveryGroup<DeliveryRow> }
  | { kind: 'disabled'; group: DeliveryGroup<DeliveryRow>; error: string }
  | { kind: 'retry'; group: DeliveryGroup<DeliveryRow>; error: string; retryAfterSeconds?: number }
  | { kind: 'skipped'; group: DeliveryGroup<DeliveryRow> };

type TelegramErrorBody = {
  ok?: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: number | null,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

/**
 * Live multi-team drain. The legacy drain stays untouched and remains the rollback path.
 * A release with ranobelib_release_teams uses team-aware eligibility and delivery overrides;
 * an older release without team mappings falls back to the legacy subscription projection.
 */
export async function drainMultiTeamNotificationOutbox(
  env: MultiTeamNotificationDeliveryEnv,
  options: NotificationDrainOptions = {},
): Promise<NotificationDeliveryResult> {
  const limit = clampInt(options.limit ?? DELIVERY_BATCH_LIMIT, 1, DELIVERY_BATCH_LIMIT);
  const selection = await selectReadyMultiTeamDeliveryGroups(env, limit);
  if (!selection.groups.length) return { ...emptyDeliveryResult(), hasMoreDue: selection.hasMoreDue };

  const claimToken = crypto.randomUUID();
  const claimedKeys = await claimMultiTeamDeliveryGroups(env, selection.groups, claimToken);
  if (!claimedKeys.length) return { ...emptyDeliveryResult(), hasMoreDue: selection.hasMoreDue };

  const rows = await loadClaimedMultiTeamDeliveryRows(env, claimToken);
  const groups = aggregateClaimedDeliveryRows(rows);
  if (!groups.length) return { ...emptyDeliveryResult(), hasMoreDue: selection.hasMoreDue };

  const eligibleGroups = groups.filter(groupEligible);
  const skippedGroups = groups.filter((group) => !groupEligible(group));
  const outcomes: DeliveryOutcome[] = skippedGroups.map((group) => ({ kind: 'skipped', group }));

  const deliveryStartedAt = Date.now();
  outcomes.push(...await mapWithConcurrency(
    eligibleGroups,
    TELEGRAM_SEND_CONCURRENCY,
    async (group, index) => {
      const delayMs = computeTelegramStartDelayMs(index, deliveryStartedAt);
      if (delayMs > 0) await sleep(delayMs);
      return deliverGroup(env, group);
    },
  ));

  await executeStatements(env.DB, outcomes.flatMap((outcome) =>
    outcome.group.members.map((row) => outcomeMutation(env, outcome, row, claimToken))));

  const reachability: TelegramDeliveryReachabilityOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'sent') reachability.push({ userTelegramId: outcome.group.userTelegramId, state: 'active' });
    if (outcome.kind === 'disabled') reachability.push({ userTelegramId: outcome.group.userTelegramId, state: 'blocked' });
  }
  if (reachability.length) await recordTelegramDeliveryReachability(env, reachability);
  if (outcomes.some((outcome) => outcome.kind === 'disabled')) await refreshAllWorkNotificationDemand(env);

  let sent = 0;
  let retry = 0;
  let disabled = 0;
  let skipped = 0;
  let rateLimited = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === 'sent') sent += 1;
    if (outcome.kind === 'disabled') disabled += 1;
    if (outcome.kind === 'skipped') skipped += 1;
    if (outcome.kind === 'retry') {
      retry += 1;
      if (outcome.retryAfterSeconds !== undefined) rateLimited += 1;
    }
  }
  return { claimed: groups.length, sent, retry, disabled, skipped, rateLimited, hasMoreDue: selection.hasMoreDue };
}

async function selectReadyMultiTeamDeliveryGroups(
  env: MultiTeamNotificationDeliveryEnv,
  limit: number,
): Promise<{ groups: ReadyGroupKey[]; hasMoreDue: boolean }> {
  const probeLimit = limit + 1;
  const { results } = await env.DB.prepare(`${multiTeamDeliveryCtes()}
    , notification_groups AS (
      SELECT
        c.user_telegram_id,
        c.book_ref,
        c.delivery_scope_key,
        SUM(CASE WHEN c.release_kind='chapters' THEN c.chapter_count ELSE 0 END) AS pending_chapters,
        MIN(c.created_at) AS oldest_pending_at,
        MAX(CASE WHEN c.release_kind='translation_completed' THEN 1 ELSE 0 END) AS translation_completed,
        MAX(CASE WHEN c.status='retry' AND c.available_at>CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS retry_blocked,
        MAX(CASE WHEN c.claim_token IS NOT NULL AND c.claim_expires_at IS NOT NULL AND c.claim_expires_at>CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS lease_blocked,
        MIN(e.eligible) AS eligible,
        CASE WHEN MAX(CASE WHEN e.delivery_mode<>'stack' THEN 1 ELSE 0 END)=1 THEN 'instant' ELSE 'stack' END AS delivery_mode,
        MIN(CASE WHEN e.delivery_mode='stack' THEN e.stack_size END) AS stack_size
      FROM candidate_rows c
      JOIN release_effective e ON e.release_id=c.release_id AND e.user_telegram_id=c.user_telegram_id
      GROUP BY c.user_telegram_id, c.book_ref, c.delivery_scope_key
    ), ready_groups AS (
      SELECT user_telegram_id, book_ref, delivery_scope_key, oldest_pending_at
      FROM notification_groups
      WHERE lease_blocked=0 AND retry_blocked=0
        AND (
          eligible=0
          OR translation_completed=1
          OR delivery_mode<>'stack'
          OR stack_size IS NULL OR stack_size<2 OR stack_size>100
          OR pending_chapters>=stack_size
          OR oldest_pending_at<=datetime('now','-7 days')
        )
      ORDER BY oldest_pending_at ASC
      LIMIT ?
    )
    SELECT user_telegram_id, book_ref, delivery_scope_key
    FROM ready_groups
    ORDER BY oldest_pending_at ASC
  `).bind(probeLimit).all<ReadyGroupKey>();
  return { groups: results.slice(0, limit), hasMoreDue: results.length > limit };
}

async function claimMultiTeamDeliveryGroups(
  env: MultiTeamNotificationDeliveryEnv,
  groups: ReadyGroupKey[],
  claimToken: string,
): Promise<Array<{ release_id: string; user_telegram_id: string }>> {
  if (!groups.length) return [];
  const selectedGroups = JSON.stringify(groups.map((group) => ({
    userTelegramId: String(group.user_telegram_id),
    bookRef: String(group.book_ref),
    deliveryScopeKey: group.delivery_scope_key ?? '',
  })));
  const statement = env.DB.prepare(`
    UPDATE ranobelib_notification_outbox
    SET claim_token=?, claim_expires_at=datetime('now','+' || ${CLAIM_LEASE_MINUTES} || ' minutes'), updated_at=CURRENT_TIMESTAMP
    WHERE status IN ('pending','retry')
      AND available_at<=CURRENT_TIMESTAMP
      AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at<=CURRENT_TIMESTAMP)
      AND EXISTS (
        SELECT 1
        FROM ranobelib_releases claimed_release
        JOIN json_each(?) selected
        WHERE claimed_release.id=ranobelib_notification_outbox.release_id
          AND CAST(json_extract(selected.value,'$.userTelegramId') AS TEXT)=ranobelib_notification_outbox.user_telegram_id
          AND CAST(json_extract(selected.value,'$.bookRef') AS TEXT)=claimed_release.book_ref
          AND CAST(json_extract(selected.value,'$.deliveryScopeKey') AS TEXT)=COALESCE(claimed_release.delivery_scope_key,'')
      )
    RETURNING release_id, user_telegram_id
  `);
  return resultRows(await statement.bind(claimToken, selectedGroups).run());
}

async function loadClaimedMultiTeamDeliveryRows(
  env: MultiTeamNotificationDeliveryEnv,
  claimToken: string,
): Promise<DeliveryRow[]> {
  const { results } = await env.DB.prepare(`${multiTeamDeliveryCtes(`o.claim_token='${escapeSqlLiteral(claimToken)}'`)}
    SELECT
      c.release_id, c.user_telegram_id, c.status, c.attempts,
      c.book_ref, c.ranobelib_id, c.title, c.url,
      c.release_kind, c.chapter_count, c.first_volume, c.first_number, c.last_volume, c.last_number, c.summary,
      c.delivery_scope_key,
      e.eligible,
      (
        SELECT json_group_array(display_name)
        FROM (
          SELECT team.display_name
          FROM ranobelib_release_teams rt
          JOIN ranobelib_teams team ON team.id=rt.team_id
          WHERE rt.release_id=c.release_id
          ORDER BY team.is_primary DESC, team.display_name COLLATE NOCASE ASC, team.id ASC
        )
      ) AS team_names_json
    FROM candidate_rows c
    JOIN release_effective e ON e.release_id=c.release_id AND e.user_telegram_id=c.user_telegram_id
    ORDER BY c.created_at ASC
  `).all<DeliveryRow>();
  return results;
}

function multiTeamDeliveryCtes(extraWhere = '1=1'): string {
  return `
    WITH candidate_rows AS (
      SELECT
        o.release_id, o.user_telegram_id, o.status, o.attempts, o.available_at,
        o.claim_token, o.claim_expires_at, o.created_at,
        r.book_ref, COALESCE(r.delivery_scope_key,'') AS delivery_scope_key,
        r.release_kind, r.chapter_count, r.first_volume, r.first_number, r.last_volume, r.last_number, r.summary,
        t.ranobelib_id, COALESCE(t.title,r.title_snapshot) AS title, t.url,
        CASE WHEN EXISTS(SELECT 1 FROM ranobelib_release_teams rt0 WHERE rt0.release_id=r.id) THEN 1 ELSE 0 END AS has_team_mapping,
        CASE WHEN (
          (
            (COALESCE(global_settings.all_titles,0)=1 AND NOT EXISTS (
              SELECT 1 FROM title_subscription_exclusions legacy_exclusion
              WHERE legacy_exclusion.user_telegram_id=o.user_telegram_id AND legacy_exclusion.book_ref=r.book_ref
            ))
            OR
            (COALESCE(global_settings.all_titles,0)<>1 AND EXISTS (
              SELECT 1 FROM title_subscriptions legacy_explicit
              WHERE legacy_explicit.user_telegram_id=o.user_telegram_id AND legacy_explicit.book_ref=r.book_ref
            ))
          )
          AND COALESCE(reach.state,'active')<>'blocked'
        ) THEN 1 ELSE 0 END AS legacy_eligible,
        COALESCE(legacy_title_mode.delivery_mode,global_settings.delivery_mode,'instant') AS legacy_delivery_mode,
        COALESCE(legacy_title_mode.stack_size,global_settings.stack_size) AS legacy_stack_size
      FROM ranobelib_notification_outbox o
      JOIN ranobelib_releases r ON r.id=o.release_id
      JOIN ranobelib_titles lifecycle ON lifecycle.book_ref=r.book_ref AND lifecycle.translation_completion_pending=0
      JOIN ranobelib_titles t ON t.book_ref=r.book_ref
      LEFT JOIN telegram_subscription_settings global_settings ON global_settings.user_telegram_id=o.user_telegram_id
      LEFT JOIN telegram_title_delivery_settings legacy_title_mode
        ON legacy_title_mode.user_telegram_id=o.user_telegram_id AND legacy_title_mode.book_ref=r.book_ref
      LEFT JOIN telegram_delivery_reachability reach ON reach.user_telegram_id=o.user_telegram_id
      WHERE o.status IN ('pending','retry') AND ${extraWhere}
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
      JOIN ranobelib_team_translations tt ON tt.team_id=rt.team_id AND tt.book_ref=c.book_ref AND tt.presence_state='active'
      LEFT JOIN telegram_subscription_settings global_settings ON global_settings.user_telegram_id=c.user_telegram_id
      LEFT JOIN telegram_team_title_delivery_settings team_title_mode
        ON team_title_mode.user_telegram_id=c.user_telegram_id AND team_title_mode.team_id=rt.team_id AND team_title_mode.book_ref=c.book_ref
      LEFT JOIN telegram_delivery_reachability reach ON reach.user_telegram_id=c.user_telegram_id
      WHERE COALESCE(reach.state,'active')<>'blocked'
        AND NOT EXISTS (
          SELECT 1 FROM telegram_team_title_exclusions exclusion
          WHERE exclusion.user_telegram_id=c.user_telegram_id AND exclusion.team_id=rt.team_id AND exclusion.book_ref=c.book_ref
        )
        AND (
          EXISTS (
            SELECT 1 FROM telegram_team_subscriptions whole
            WHERE whole.user_telegram_id=c.user_telegram_id AND whole.team_id=rt.team_id
          )
          OR EXISTS (
            SELECT 1 FROM telegram_team_title_subscriptions explicit
            WHERE explicit.user_telegram_id=c.user_telegram_id AND explicit.team_id=rt.team_id AND explicit.book_ref=c.book_ref
          )
        )
    ), team_release_effective AS (
      SELECT
        release_id, user_telegram_id,
        COUNT(*) AS eligible_team_count,
        CASE WHEN MAX(CASE WHEN delivery_mode='instant' THEN 1 ELSE 0 END)=1 THEN 'instant' ELSE 'stack' END AS delivery_mode,
        MIN(CASE WHEN delivery_mode='stack' THEN stack_size END) AS stack_size
      FROM eligible_team_settings
      GROUP BY release_id, user_telegram_id
    ), release_effective AS (
      SELECT
        c.release_id, c.user_telegram_id,
        CASE WHEN c.has_team_mapping=1 THEN CASE WHEN COALESCE(team_effective.eligible_team_count,0)>0 THEN 1 ELSE 0 END ELSE c.legacy_eligible END AS eligible,
        CASE WHEN c.has_team_mapping=1 THEN COALESCE(team_effective.delivery_mode,'instant') ELSE c.legacy_delivery_mode END AS delivery_mode,
        CASE WHEN c.has_team_mapping=1 THEN team_effective.stack_size ELSE c.legacy_stack_size END AS stack_size
      FROM candidate_rows c
      LEFT JOIN team_release_effective team_effective
        ON team_effective.release_id=c.release_id AND team_effective.user_telegram_id=c.user_telegram_id
    )`;
}

function groupEligible(group: DeliveryGroup<DeliveryRow>): boolean {
  return group.members.length > 0 && group.members.every((row) => Number(row.eligible) === 1);
}

async function deliverGroup(env: MultiTeamNotificationDeliveryEnv, group: DeliveryGroup<DeliveryRow>): Promise<DeliveryOutcome> {
  const titleId = Number(group.titleId);
  const firstChapterRow = group.members.find((row) => row.release_kind !== 'translation_completed') ?? group.members[0]!;
  const payload = group.translationCompleted
    ? formatTranslationCompletionNotification({
      title: group.title,
      url: group.titleUrl,
      chapterCount: group.chapterCount,
      firstNumber: group.firstNumber,
      lastNumber: group.lastNumber,
      teamNames: group.teamNames,
    })
    : formatReleaseNotification({
      ...(Number.isSafeInteger(titleId) && titleId > 0 ? { titleId, subscribed: true } : {}),
      title: group.title,
      url: group.chapterCount === 1 ? releaseReadUrl(firstChapterRow) : group.titleUrl,
      chapterCount: group.chapterCount || 1,
      firstNumber: group.firstNumber,
      lastNumber: group.lastNumber,
      summary: group.summary,
      teamNames: group.teamNames,
    });
  try {
    await telegramCall(env, 'sendMessage', {
      chat_id: group.userTelegramId,
      text: payload.text,
      parse_mode: payload.parse_mode,
      reply_markup: payload.reply_markup,
    });
    return { kind: 'sent', group };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof TelegramApiError) {
      if (error.status === 403 || error.errorCode === 403) return { kind: 'disabled', group, error: message };
      if ((error.status === 429 || error.errorCode === 429) && error.retryAfter !== null) {
        return { kind: 'retry', group, error: message, retryAfterSeconds: clampInt(error.retryAfter, 1, 3600) };
      }
    }
    return { kind: 'retry', group, error: message };
  }
}

function releaseReadUrl(row: DeliveryRow): string {
  if (Number(row.chapter_count) !== 1) return row.url;
  const bookRef = row.book_ref?.trim();
  const volume = row.first_volume?.trim();
  const number = row.first_number?.trim();
  if (!bookRef || !volume || !number) return row.url;
  try {
    const titleUrl = new URL(row.url);
    const locale = /^\/([^/]+)\/book(?:\/|$)/.exec(titleUrl.pathname)?.[1] || 'ru';
    return `${titleUrl.origin}/${encodeURIComponent(locale)}/${encodeURIComponent(bookRef)}/read/v${encodeURIComponent(volume)}/c${encodeURIComponent(number)}`;
  } catch {
    return row.url;
  }
}

function outcomeMutation(
  env: MultiTeamNotificationDeliveryEnv,
  outcome: DeliveryOutcome,
  row: DeliveryRow,
  claimToken: string,
): D1PreparedStatementLike {
  if (outcome.kind === 'skipped') {
    return env.DB.prepare('DELETE FROM ranobelib_notification_outbox WHERE release_id=? AND user_telegram_id=? AND claim_token=?')
      .bind(row.release_id, row.user_telegram_id, claimToken);
  }
  if (outcome.kind === 'sent') {
    return env.DB.prepare(`UPDATE ranobelib_notification_outbox
      SET status='sent', attempts=attempts+1, delivered_at=CURRENT_TIMESTAMP, claim_token=NULL, claim_expires_at=NULL,
          last_error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE release_id=? AND user_telegram_id=? AND claim_token=?`)
      .bind(row.release_id, row.user_telegram_id, claimToken);
  }
  if (outcome.kind === 'disabled') {
    return env.DB.prepare(`UPDATE ranobelib_notification_outbox
      SET status='disabled', attempts=attempts+1, claim_token=NULL, claim_expires_at=NULL, last_error=?, updated_at=CURRENT_TIMESTAMP
      WHERE release_id=? AND user_telegram_id=? AND claim_token=?`)
      .bind(outcome.error.slice(0, 800), row.release_id, row.user_telegram_id, claimToken);
  }
  if (outcome.retryAfterSeconds !== undefined) {
    return env.DB.prepare(`UPDATE ranobelib_notification_outbox
      SET status='retry', attempts=attempts+1, available_at=datetime('now','+' || ? || ' seconds'),
          claim_token=NULL, claim_expires_at=NULL, last_error=?, updated_at=CURRENT_TIMESTAMP
      WHERE release_id=? AND user_telegram_id=? AND claim_token=?`)
      .bind(outcome.retryAfterSeconds, outcome.error.slice(0, 800), row.release_id, row.user_telegram_id, claimToken);
  }
  return env.DB.prepare(`UPDATE ranobelib_notification_outbox
    SET status='retry', attempts=attempts+1, available_at=datetime('now','+' || MIN(30,MAX(1,attempts+1)) || ' minutes'),
        claim_token=NULL, claim_expires_at=NULL, last_error=?, updated_at=CURRENT_TIMESTAMP
    WHERE release_id=? AND user_telegram_id=? AND claim_token=?`)
    .bind(outcome.error.slice(0, 800), row.release_id, row.user_telegram_id, claimToken);
}

async function executeStatements(db: D1DatabaseLike, statements: D1PreparedStatementLike[]): Promise<void> {
  if (!statements.length) return;
  if (db.batch) await db.batch(statements);
  else for (const statement of statements) await statement.run();
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function telegramCall<T>(env: MultiTeamNotificationDeliveryEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as (TelegramErrorBody & { result?: T }) | null;
  if (!response.ok || !body?.ok) {
    const errorCode = Number.isFinite(body?.error_code) ? Number(body?.error_code) : null;
    const retryAfter = Number.isFinite(body?.parameters?.retry_after) ? Number(body?.parameters?.retry_after) : null;
    throw new TelegramApiError(body?.description || `Telegram ${method} failed with HTTP ${response.status}`, response.status, errorCode, retryAfter);
  }
  return body.result as T;
}

function resultRows<T>(result: unknown): T[] {
  if (!result || typeof result !== 'object' || !('results' in result)) return [];
  const rows = (result as { results?: unknown }).results;
  return Array.isArray(rows) ? rows as T[] : [];
}

function emptyDeliveryResult(): NotificationDeliveryResult {
  return { claimed: 0, sent: 0, retry: 0, disabled: 0, skipped: 0, rateLimited: 0, hasMoreDue: false };
}

function clampInt(value: number, min: number, max: number): number {
  const numeric = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.min(max, Math.max(min, numeric));
}

function escapeSqlLiteral(value: string): string {
  return String(value).replaceAll("'", "''");
}
