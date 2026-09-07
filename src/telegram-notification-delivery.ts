import {
  recordTelegramDeliveryReachability,
  refreshAllNotificationDemand,
  type TelegramDeliveryReachabilityOutcome,
} from './notification-demand.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './ranobelib-runtime.js';
import { formatReleaseNotification } from './telegram-subscriptions.js';

export const DELIVERY_BATCH_LIMIT = 20;
export const TELEGRAM_SEND_CONCURRENCY = 5;
export const TELEGRAM_START_INTERVAL_MS = 100;
const TELEGRAM_STARTS_PER_INTERVAL = 2;
const CLAIM_LEASE_MINUTES = 10;
const STACK_FLUSH_MS = 7 * 24 * 60 * 60 * 1000;

export type NotificationDeliveryEnv = {
  DB: D1DatabaseLike;
  TELEGRAM_BOT_TOKEN?: string;
};

export type NotificationDrainOptions = {
  limit?: number;
};

export type NotificationDeliveryResult = {
  claimed: number;
  sent: number;
  retry: number;
  disabled: number;
  skipped: number;
  rateLimited: number;
  hasMoreDue: boolean;
};

export type NotificationGroupCandidate = {
  deliveryMode: unknown;
  stackSize: unknown;
  pendingChapters: number | string;
  oldestPendingAt: string | null;
  retryBlocked: boolean | number | string;
};

export type ClaimedDeliveryAggregationRow = {
  release_id: string;
  user_telegram_id: string;
  book_ref: string;
  ranobelib_id: number | string | null;
  title: string;
  url: string;
  chapter_count: number | string;
  first_volume: string | null;
  first_number: string | null;
  last_volume?: string | null;
  last_number: string | null;
  summary: string;
};

export type DeliveryGroup = {
  userTelegramId: string;
  bookRef: string;
  titleId: number | null;
  title: string;
  titleUrl: string;
  members: ClaimedDeliveryAggregationRow[];
  chapterCount: number;
  firstVolume: string | null;
  firstNumber: string | null;
  lastVolume: string | null;
  lastNumber: string | null;
};

export function notificationGroupReady(candidate: NotificationGroupCandidate, nowMs = Date.now()): boolean {
  const pendingChapters = Number(candidate.pendingChapters);
  if (!Number.isFinite(pendingChapters) || pendingChapters <= 0) return false;
  if (truthyDatabaseFlag(candidate.retryBlocked)) return false;

  const stackSize = Number(candidate.stackSize);
  const validStack = candidate.deliveryMode === 'stack'
    && Number.isInteger(stackSize)
    && stackSize >= 2
    && stackSize <= 100;
  if (!validStack) return true;
  if (pendingChapters >= stackSize) return true;

  const oldestMs = candidate.oldestPendingAt ? Date.parse(candidate.oldestPendingAt) : Number.NaN;
  return Number.isFinite(oldestMs) && Number.isFinite(nowMs) && nowMs - oldestMs >= STACK_FLUSH_MS;
}

export function aggregateClaimedDeliveryRows(rows: ClaimedDeliveryAggregationRow[]): DeliveryGroup[] {
  const groups = new Map<string, DeliveryGroup>();
  for (const row of rows) {
    const userTelegramId = String(row.user_telegram_id);
    const bookRef = String(row.book_ref);
    const key = `${userTelegramId}\u0000${bookRef}`;
    const chapterCount = positiveChapterCount(row.chapter_count);
    let group = groups.get(key);
    if (!group) {
      const titleId = Number(row.ranobelib_id);
      group = {
        userTelegramId,
        bookRef,
        titleId: Number.isSafeInteger(titleId) && titleId > 0 ? titleId : null,
        title: row.title,
        titleUrl: row.url,
        members: [],
        chapterCount: 0,
        firstVolume: row.first_volume ?? null,
        firstNumber: row.first_number ?? null,
        lastVolume: row.last_volume ?? row.first_volume ?? null,
        lastNumber: row.last_number ?? row.first_number ?? null,
      };
      groups.set(key, group);
    }
    group.members.push(row);
    group.chapterCount += chapterCount;
    group.lastVolume = row.last_volume ?? row.first_volume ?? group.lastVolume;
    group.lastNumber = row.last_number ?? row.first_number ?? group.lastNumber;
  }
  return [...groups.values()];
}

type ClaimedKey = {
  release_id: string;
  user_telegram_id: string;
};

type DeliveryRow = {
  release_id: string;
  user_telegram_id: string;
  status: string;
  attempts: number | string;
  book_ref: string;
  ranobelib_id: number | string | null;
  title: string;
  url: string;
  chapter_count: number | string;
  first_volume: string | null;
  first_number: string | null;
  last_number: string | null;
  summary: string;
  eligible: number | string;
  has_more_due: number | string;
};

type DeliveryOutcome =
  | { kind: 'sent'; row: DeliveryRow }
  | { kind: 'disabled'; row: DeliveryRow; error: string }
  | { kind: 'retry'; row: DeliveryRow; error: string; retryAfterSeconds?: number }
  | { kind: 'skipped'; row: DeliveryRow };

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

export async function drainNotificationOutbox(
  env: NotificationDeliveryEnv,
  options: NotificationDrainOptions = {},
): Promise<NotificationDeliveryResult> {
  const limit = clampInt(options.limit ?? DELIVERY_BATCH_LIMIT, 1, DELIVERY_BATCH_LIMIT);
  const claimToken = crypto.randomUUID();
  const claimedKeys = await claimDeliveryRows(env, limit, claimToken);
  if (!claimedKeys.length) return emptyDeliveryResult();

  const rows = await loadClaimedDeliveryRows(env, claimToken);
  const hasMoreDue = rows.some((row) => Number(row.has_more_due) === 1);
  const eligibleRows = rows.filter((row) => Number(row.eligible) === 1);
  const skippedRows = rows.filter((row) => Number(row.eligible) !== 1);

  const outcomes: DeliveryOutcome[] = skippedRows.map((row) => ({ kind: 'skipped', row }));
  const deliveryStartedAt = Date.now();
  const sendOutcomes = await mapWithConcurrency(
    eligibleRows,
    TELEGRAM_SEND_CONCURRENCY,
    async (row, index) => {
      const delayMs = computeTelegramStartDelayMs(index, deliveryStartedAt);
      if (delayMs > 0) await sleep(delayMs);
      return deliverOne(env, row);
    },
  );
  outcomes.push(...sendOutcomes);

  const mutations = outcomes.map((outcome) => outcomeMutation(env, outcome, claimToken));
  await executeStatements(env.DB, mutations);

  const reachability: TelegramDeliveryReachabilityOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'sent') {
      reachability.push({ userTelegramId: outcome.row.user_telegram_id, state: 'active' });
    } else if (outcome.kind === 'disabled') {
      reachability.push({ userTelegramId: outcome.row.user_telegram_id, state: 'blocked' });
    }
  }
  if (reachability.length) await recordTelegramDeliveryReachability(env, reachability);

  const reachabilityChanged = outcomes.some((outcome) => outcome.kind === 'disabled');
  if (reachabilityChanged) await refreshAllNotificationDemand(env);

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

  return {
    claimed: claimedKeys.length,
    sent,
    retry,
    disabled,
    skipped,
    rateLimited,
    hasMoreDue,
  };
}

async function claimDeliveryRows(
  env: NotificationDeliveryEnv,
  limit: number,
  claimToken: string,
): Promise<ClaimedKey[]> {
  const statement = env.DB.prepare(`
    WITH ready_groups AS (
      SELECT grouped.user_telegram_id, grouped.book_ref
      FROM (
        SELECT
          o.user_telegram_id,
          r.book_ref,
          SUM(r.chapter_count) AS pending_chapters,
          MIN(o.created_at) AS oldest_pending_at,
          MAX(CASE
            WHEN o.status = 'retry' AND o.available_at > CURRENT_TIMESTAMP THEN 1
            ELSE 0
          END) AS retry_blocked,
          MAX(CASE
            WHEN o.claim_token IS NOT NULL
             AND o.claim_expires_at IS NOT NULL
             AND o.claim_expires_at > CURRENT_TIMESTAMP THEN 1
            ELSE 0
          END) AS lease_blocked,
          MAX(CASE WHEN (
            (
              (COALESCE(s.all_titles, 0) = 1 AND NOT EXISTS (
                SELECT 1
                FROM title_subscription_exclusions e
                WHERE e.user_telegram_id = o.user_telegram_id
                  AND e.book_ref = r.book_ref
              ))
              OR
              (COALESCE(s.all_titles, 0) <> 1 AND EXISTS (
                SELECT 1
                FROM title_subscriptions ts
                WHERE ts.user_telegram_id = o.user_telegram_id
                  AND ts.book_ref = r.book_ref
              ))
            )
            AND NOT EXISTS (
              SELECT 1
              FROM telegram_delivery_reachability reach
              WHERE reach.user_telegram_id = o.user_telegram_id
                AND reach.state = 'blocked'
            )
          ) THEN 1 ELSE 0 END) AS eligible,
          COALESCE(MAX(td.delivery_mode), MAX(s.delivery_mode), 'instant') AS delivery_mode,
          COALESCE(MAX(td.stack_size), MAX(s.stack_size)) AS stack_size
        FROM ranobelib_notification_outbox o
        JOIN ranobelib_releases r ON r.id = o.release_id
        LEFT JOIN telegram_subscription_settings s
          ON s.user_telegram_id = o.user_telegram_id
        LEFT JOIN telegram_title_delivery_settings td
          ON td.user_telegram_id = o.user_telegram_id
         AND td.book_ref = r.book_ref
        WHERE o.status IN ('pending','retry')
        GROUP BY o.user_telegram_id, r.book_ref
      ) grouped
      WHERE grouped.lease_blocked = 0
        AND grouped.retry_blocked = 0
        AND (
          grouped.eligible = 0
          OR grouped.delivery_mode <> 'stack'
          OR grouped.stack_size IS NULL
          OR grouped.stack_size < 2
          OR grouped.stack_size > 100
          OR grouped.pending_chapters >= grouped.stack_size
          OR grouped.oldest_pending_at <= datetime('now','-7 days')
        )
      ORDER BY grouped.oldest_pending_at ASC
      LIMIT ?2
    )
    UPDATE ranobelib_notification_outbox
    SET claim_token = ?1,
        claim_expires_at = datetime('now', '+' || ${CLAIM_LEASE_MINUTES} || ' minutes'),
        updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('pending','retry')
      AND available_at <= CURRENT_TIMESTAMP
      AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)
      AND EXISTS (
        SELECT 1
        FROM ranobelib_releases claimed_release
        JOIN ready_groups selected
          ON selected.book_ref = claimed_release.book_ref
         AND selected.user_telegram_id = ranobelib_notification_outbox.user_telegram_id
        WHERE claimed_release.id = ranobelib_notification_outbox.release_id
      )
    RETURNING release_id, user_telegram_id
  `);
  return resultRows<ClaimedKey>(await statement.bind(claimToken, limit).run());
}

async function loadClaimedDeliveryRows(
  env: NotificationDeliveryEnv,
  claimToken: string,
): Promise<DeliveryRow[]> {
  const { results } = await env.DB.prepare(`
    SELECT o.release_id, o.user_telegram_id, o.status, o.attempts,
           r.book_ref, t.ranobelib_id,
           COALESCE(t.title, r.title_snapshot) AS title, t.url,
           r.chapter_count, r.first_volume, r.first_number, r.last_number, r.summary,
           CASE WHEN (
             (
               EXISTS (
                 SELECT 1
                 FROM telegram_subscription_settings s
                 WHERE s.user_telegram_id = o.user_telegram_id
                   AND s.all_titles = 1
                   AND NOT EXISTS (
                     SELECT 1
                     FROM title_subscription_exclusions e
                     WHERE e.user_telegram_id = o.user_telegram_id
                       AND e.book_ref = r.book_ref
                   )
               )
               OR EXISTS (
                 SELECT 1
                 FROM title_subscriptions ts
                 WHERE ts.user_telegram_id = o.user_telegram_id
                   AND ts.book_ref = r.book_ref
                   AND NOT EXISTS (
                     SELECT 1
                     FROM telegram_subscription_settings s2
                     WHERE s2.user_telegram_id = o.user_telegram_id
                       AND s2.all_titles = 1
                   )
               )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM telegram_delivery_reachability reach
               WHERE reach.user_telegram_id = o.user_telegram_id
                 AND reach.state = 'blocked'
             )
           ) THEN 1 ELSE 0 END AS eligible,
           EXISTS (
             SELECT 1 AS due
             FROM ranobelib_notification_outbox pending
             WHERE pending.status IN ('pending','retry')
               AND pending.available_at <= CURRENT_TIMESTAMP
               AND (
                 pending.claim_token IS NULL
                 OR pending.claim_expires_at IS NULL
                 OR pending.claim_expires_at <= CURRENT_TIMESTAMP
               )
             LIMIT 1
           ) AS has_more_due
    FROM ranobelib_notification_outbox o
    JOIN ranobelib_releases r ON r.id = o.release_id
    JOIN ranobelib_titles t ON t.book_ref = r.book_ref
    WHERE o.claim_token = ?
    ORDER BY o.created_at ASC
  `).bind(claimToken).all<DeliveryRow>();
  return results;
}

async function deliverOne(env: NotificationDeliveryEnv, row: DeliveryRow): Promise<DeliveryOutcome> {
  const titleId = Number(row.ranobelib_id);
  const payload = formatReleaseNotification({
    ...(Number.isSafeInteger(titleId) && titleId > 0 ? { titleId, subscribed: true } : {}),
    title: row.title,
    url: releaseReadUrl(row),
    chapterCount: Number(row.chapter_count) || 1,
    firstNumber: row.first_number,
    lastNumber: row.last_number,
    summary: row.summary,
  });

  try {
    await telegramCall(env, 'sendMessage', {
      chat_id: row.user_telegram_id,
      text: payload.text,
      parse_mode: payload.parse_mode,
      reply_markup: payload.reply_markup,
    });
    return { kind: 'sent', row };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof TelegramApiError) {
      if (error.status === 403 || error.errorCode === 403) {
        return { kind: 'disabled', row, error: message };
      }
      if ((error.status === 429 || error.errorCode === 429) && error.retryAfter !== null) {
        const retryAfter = clampInt(error.retryAfter, 1, 3600);
        return { kind: 'retry', row, error: message, retryAfterSeconds: retryAfter };
      }
    }
    return { kind: 'retry', row, error: message };
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
  env: NotificationDeliveryEnv,
  outcome: DeliveryOutcome,
  claimToken: string,
): D1PreparedStatementLike {
  const { release_id: releaseId, user_telegram_id: userId } = outcome.row;
  if (outcome.kind === 'skipped') {
    return env.DB.prepare(`
      DELETE FROM ranobelib_notification_outbox
      WHERE release_id = ? AND user_telegram_id = ? AND claim_token = ?
    `).bind(releaseId, userId, claimToken);
  }
  if (outcome.kind === 'sent') {
    return env.DB.prepare(`
      UPDATE ranobelib_notification_outbox
      SET status='sent', attempts=attempts+1, delivered_at=CURRENT_TIMESTAMP,
          claim_token=NULL, claim_expires_at=NULL,
          last_error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE release_id = ? AND user_telegram_id = ? AND claim_token = ?
    `).bind(releaseId, userId, claimToken);
  }
  if (outcome.kind === 'disabled') {
    return env.DB.prepare(`
      UPDATE ranobelib_notification_outbox
      SET status='disabled', attempts=attempts+1,
          claim_token=NULL, claim_expires_at=NULL,
          last_error=?, updated_at=CURRENT_TIMESTAMP
      WHERE release_id = ? AND user_telegram_id = ? AND claim_token = ?
    `).bind(outcome.error.slice(0, 800), releaseId, userId, claimToken);
  }
  if (outcome.retryAfterSeconds !== undefined) {
    return env.DB.prepare(`
      UPDATE ranobelib_notification_outbox
      SET status='retry', attempts=attempts+1,
          available_at=datetime('now', '+' || ? || ' seconds'),
          claim_token=NULL, claim_expires_at=NULL,
          last_error=?, updated_at=CURRENT_TIMESTAMP
      WHERE release_id = ? AND user_telegram_id = ? AND claim_token = ?
    `).bind(outcome.retryAfterSeconds, outcome.error.slice(0, 800), releaseId, userId, claimToken);
  }
  return env.DB.prepare(`
    UPDATE ranobelib_notification_outbox
    SET status='retry', attempts=attempts+1,
        available_at=datetime('now', '+' || MIN(30, MAX(1, attempts + 1)) || ' minutes'),
        claim_token=NULL, claim_expires_at=NULL,
        last_error=?, updated_at=CURRENT_TIMESTAMP
    WHERE release_id = ? AND user_telegram_id = ? AND claim_token = ?
  `).bind(outcome.error.slice(0, 800), releaseId, userId, claimToken);
}

async function executeStatements(db: D1DatabaseLike, statements: D1PreparedStatementLike[]): Promise<void> {
  if (!statements.length) return;
  if (db.batch) {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function computeTelegramStartDelayMs(index: number, startedAt: number): number {
  const safeIndex = Math.max(0, Math.floor(index));
  const intervalIndex = Math.floor(safeIndex / TELEGRAM_STARTS_PER_INTERVAL);
  const target = startedAt + intervalIndex * TELEGRAM_START_INTERVAL_MS;
  return Math.max(0, target - Date.now());
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function telegramCall<T>(
  env: NotificationDeliveryEnv,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as (TelegramErrorBody & { result?: T }) | null;
  if (!response.ok || !body?.ok) {
    const message = body?.description || `Telegram ${method} failed with HTTP ${response.status}`;
    const errorCode = Number.isFinite(body?.error_code) ? Number(body.error_code) : null;
    const retryAfter = Number.isFinite(body?.parameters?.retry_after) ? Number(body.parameters?.retry_after) : null;
    throw new TelegramApiError(message, response.status, errorCode, retryAfter);
  }
  return body.result as T;
}

function resultRows<T>(result: unknown): T[] {
  if (!result || typeof result !== 'object' || !('results' in result)) return [];
  const rows = (result as { results?: unknown }).results;
  return Array.isArray(rows) ? rows as T[] : [];
}

function emptyDeliveryResult(): NotificationDeliveryResult {
  return {
    claimed: 0,
    sent: 0,
    retry: 0,
    disabled: 0,
    skipped: 0,
    rateLimited: 0,
    hasMoreDue: false,
  };
}

function positiveChapterCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function truthyDatabaseFlag(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

function clampInt(value: number, min: number, max: number): number {
  const numeric = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.min(max, Math.max(min, numeric));
}