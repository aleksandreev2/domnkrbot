import { normalizeDeliverySetting } from './telegram-notification-settings.js';

export const NOTIFICATION_STACK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type DeliveryGroupReadinessCandidate = {
  deliveryMode: unknown;
  stackSize: unknown;
  pendingChapters: number | string;
  oldestPendingAt: string | null;
  retryBlocked: boolean | number | string;
};

export type ClaimedDeliveryRowLike = {
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
  [key: string]: unknown;
};

export type DeliveryGroup<T extends ClaimedDeliveryRowLike = ClaimedDeliveryRowLike> = {
  userTelegramId: string;
  bookRef: string;
  titleId: number | string | null;
  title: string;
  titleUrl: string;
  members: T[];
  chapterCount: number;
  firstVolume: string | null;
  firstNumber: string | null;
  lastVolume: string | null;
  lastNumber: string | null;
  summary: string;
};

export function notificationGroupReady(
  candidate: DeliveryGroupReadinessCandidate,
  nowMs = Date.now(),
): boolean {
  if (truthyFlag(candidate.retryBlocked)) return false;

  const setting = normalizeDeliverySetting(candidate.deliveryMode, candidate.stackSize);
  if (setting.mode === 'instant') return true;

  const pendingChapters = nonNegativeInteger(candidate.pendingChapters);
  if (pendingChapters >= setting.stackSize) return true;

  const oldestMs = candidate.oldestPendingAt ? Date.parse(candidate.oldestPendingAt) : Number.NaN;
  return Number.isFinite(oldestMs) && nowMs - oldestMs >= NOTIFICATION_STACK_MAX_AGE_MS;
}

export function aggregateClaimedDeliveryRows<T extends ClaimedDeliveryRowLike>(rows: T[]): DeliveryGroup<T>[] {
  const groups = new Map<string, DeliveryGroup<T>>();

  for (const row of rows) {
    const userTelegramId = String(row.user_telegram_id);
    const bookRef = String(row.book_ref);
    const key = `${userTelegramId}\u0000${bookRef}`;
    const chapterCount = positiveInteger(row.chapter_count, 1);
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        userTelegramId,
        bookRef,
        titleId: row.ranobelib_id,
        title: row.title,
        titleUrl: row.url,
        members: [row],
        chapterCount,
        firstVolume: row.first_volume ?? null,
        firstNumber: row.first_number ?? null,
        lastVolume: row.last_volume ?? row.first_volume ?? null,
        lastNumber: row.last_number ?? row.first_number ?? null,
        summary: row.summary,
      });
      continue;
    }

    existing.members.push(row);
    existing.chapterCount += chapterCount;
    existing.lastVolume = row.last_volume ?? row.first_volume ?? existing.lastVolume;
    existing.lastNumber = row.last_number ?? row.first_number ?? existing.lastNumber;
    if (row.summary) existing.summary = existing.summary ? `${existing.summary}; ${row.summary}` : row.summary;
  }

  return [...groups.values()];
}

function truthyFlag(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.trunc(number));
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.trunc(number));
}
