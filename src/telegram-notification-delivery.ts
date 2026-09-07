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

  // Persist all Telegram reachability observations in one bounded D1 write. A 403 is the
  // only delivery outcome that changes effective demand; successful sends merely refresh
  // the known-active timestamp. Retryable failures intentionally leave reachability alone.
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
    UPDATE ranobelib_notification_outbox
    SET claim_token = ?,
        claim_expires_at = datetime('now', '+' || ${CLAIM_LEASE_MINUTES} || ' minutes'),
        updated_at = CURRENT_TIMESTAMP
    WHERE rowid IN (
      SELECT rowid
      FROM ranobelib_notification_outbox
      WHERE status IN ('pending','retry')
        AND available_at <= CURRENT_TIMESTAMP
        AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)
      ORDER BY created_at ASC
      LIMIT ?
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
    const errorCode = Number.isFinite(body?.error_code) ? Number(body?.error_code) : null;
    const retryAfter = Number.isFinite(body?.parameters?.retry_after) ? Number(body?.parameters?.retry_after) : null;
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

function clampInt(value: number, min: number, max: number): number {
  const numeric = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.min(max, Math.max(min, numeric));
}
