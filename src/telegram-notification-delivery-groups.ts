import { normalizeDeliverySetting } from './telegram-notification-settings.js';

export const NOTIFICATION_STACK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type DeliveryGroupReadinessCandidate = {
  deliveryMode: unknown;
  stackSize: unknown;
  pendingChapters: number | string;
  oldestPendingAt: string | null;
  retryBlocked: boolean | number | string;
  translationCompleted?: boolean | number | string;
};

export type ClaimedDeliveryRowLike = {
  release_id: string;
  user_telegram_id: string;
  book_ref: string;
  ranobelib_id: number | string | null;
  title: string;
  url: string;
  release_kind?: string | null;
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
  translationCompleted: boolean;
};

export function notificationGroupReady(
  candidate: DeliveryGroupReadinessCandidate,
  nowMs = Date.now(),
): boolean {
  if (truthyFlag(candidate.retryBlocked)) return false;
  if (truthyFlag(candidate.translationCompleted)) return true;

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
    const isCompletion = row.release_kind === 'translation_completed';
    const chapterCount = isCompletion ? 0 : nonNegativeInteger(row.chapter_count);
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
        firstVolume: isCompletion ? null : (row.first_volume ?? null),
        firstNumber: isCompletion ? null : (row.first_number ?? null),
        lastVolume: isCompletion ? null : (row.last_volume ?? row.first_volume ?? null),
        lastNumber: isCompletion ? null : (row.last_number ?? row.first_number ?? null),
        summary: isCompletion ? '' : row.summary,
        translationCompleted: isCompletion,
      });
      continue;
    }

    existing.members.push(row);
    existing.translationCompleted ||= isCompletion;
    if (!isCompletion) {
      existing.chapterCount += chapterCount;
      if (existing.firstVolume === null) existing.firstVolume = row.first_volume ?? null;
      if (existing.firstNumber === null) existing.firstNumber = row.first_number ?? null;
      existing.lastVolume = row.last_volume ?? row.first_volume ?? existing.lastVolume;
      existing.lastNumber = row.last_number ?? row.first_number ?? existing.lastNumber;
      if (row.summary) existing.summary = existing.summary ? `${existing.summary}; ${row.summary}` : row.summary;
    }
  }

  for (const group of groups.values()) {
    const chapterRows = group.members.filter((row) => row.release_kind !== 'translation_completed');
    if (group.chapterCount > 1 && !hasSafeContiguousRange(chapterRows)) {
      group.firstVolume = null;
      group.firstNumber = null;
      group.lastVolume = null;
      group.lastNumber = null;
    }
  }

  return [...groups.values()];
}

function hasSafeContiguousRange<T extends ClaimedDeliveryRowLike>(rows: T[]): boolean {
  if (!rows.length) return false;

  let commonVolume: string | null = null;
  let expectedFirst: number | null = null;

  for (const row of rows) {
    const firstVolume = normalizedToken(row.first_volume);
    const lastVolume = normalizedToken(row.last_volume ?? row.first_volume);
    const first = parseChapterOrdinal(row.first_number);
    const last = parseChapterOrdinal(row.last_number ?? row.first_number);
    const count = Number(row.chapter_count);

    if (
      !firstVolume
      || !lastVolume
      || firstVolume !== lastVolume
      || first === null
      || last === null
      || last < first
      || !Number.isSafeInteger(count)
      || count <= 0
      || last - first + 1 !== count
    ) {
      return false;
    }

    if (commonVolume === null) commonVolume = firstVolume;
    else if (firstVolume !== commonVolume) return false;

    if (expectedFirst !== null && first !== expectedFirst) return false;
    expectedFirst = last + 1;
  }

  return true;
}

function parseChapterOrdinal(value: unknown): number | null {
  const text = normalizedToken(value);
  if (!text || !/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function normalizedToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
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
