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
  delivery_scope_key?: string | null;
  team_names_json?: string | null;
  [key: string]: unknown;
};

export type DeliveryGroup<T extends ClaimedDeliveryRowLike = ClaimedDeliveryRowLike> = {
  userTelegramId: string;
  bookRef: string;
  deliveryScopeKey: string | null;
  titleId: number | string | null;
  title: string;
  titleUrl: string;
  teamNames: string[];
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
  const buckets = new Map<string, { deliveryScopeKey: string | null; rows: T[] }>();

  for (const row of rows) {
    const userTelegramId = String(row.user_telegram_id);
    const bookRef = String(row.book_ref);
    const deliveryScopeKey = normalizedToken(row.delivery_scope_key);
    const key = `${userTelegramId}\u0000${bookRef}\u0000${deliveryScopeKey ?? ''}`;
    const existing = buckets.get(key);
    if (existing) existing.rows.push(row);
    else buckets.set(key, { deliveryScopeKey, rows: [row] });
  }

  const result: DeliveryGroup<T>[] = [];
  for (const bucket of buckets.values()) {
    const segments: T[][] = [];
    const completions: T[] = [];

    for (const row of bucket.rows) {
      if (row.release_kind === 'translation_completed') {
        completions.push(row);
        continue;
      }

      const last = segments[segments.length - 1];
      if (!last || !hasSafeContiguousRange([...last, row])) segments.push([row]);
      else last.push(row);
    }

    // Completion closes the latest contiguous pending sequence. This preserves the existing
    // "flush the final partial stack" behavior without allowing a completion event to bridge two
    // unrelated/gapped chapter ranges.
    if (completions.length > 0) {
      const target = segments[segments.length - 1];
      if (target) target.push(...completions);
      else segments.push([...completions]);
    }

    for (const segment of segments) {
      result.push(buildDeliveryGroup(segment, bucket.deliveryScopeKey));
    }
  }

  return result;
}

function buildDeliveryGroup<T extends ClaimedDeliveryRowLike>(
  rows: T[],
  deliveryScopeKey: string | null,
): DeliveryGroup<T> {
  const first = rows[0]!;
  const group: DeliveryGroup<T> = {
    userTelegramId: String(first.user_telegram_id),
    bookRef: String(first.book_ref),
    deliveryScopeKey,
    titleId: first.ranobelib_id,
    title: first.title,
    titleUrl: first.url,
    teamNames: [],
    members: [],
    chapterCount: 0,
    firstVolume: null,
    firstNumber: null,
    lastVolume: null,
    lastNumber: null,
    summary: '',
    translationCompleted: false,
  };

  for (const row of rows) {
    const isCompletion = row.release_kind === 'translation_completed';
    group.members.push(row);
    mergeTeamNames(group.teamNames, parseTeamNames(row.team_names_json));
    group.translationCompleted ||= isCompletion;
    if (isCompletion) continue;

    const chapterCount = nonNegativeInteger(row.chapter_count);
    group.chapterCount += chapterCount;
    if (group.firstVolume === null) group.firstVolume = row.first_volume ?? null;
    if (group.firstNumber === null) group.firstNumber = row.first_number ?? null;
    group.lastVolume = row.last_volume ?? row.first_volume ?? group.lastVolume;
    group.lastNumber = row.last_number ?? row.first_number ?? group.lastNumber;
    if (row.summary) group.summary = group.summary ? `${group.summary}; ${row.summary}` : row.summary;
  }

  const chapterRows = group.members.filter((row) => row.release_kind !== 'translation_completed');
  if (group.chapterCount > 1 && !hasSafeContiguousRange(chapterRows)) {
    group.firstVolume = null;
    group.firstNumber = null;
    group.lastVolume = null;
    group.lastNumber = null;
  }
  return group;
}

function parseTeamNames(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of parsed) {
      const name = typeof item === 'string' ? item.trim() : '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      result.push(name);
    }
    return result;
  } catch {
    return [];
  }
}

function mergeTeamNames(target: string[], additions: string[]): void {
  const seen = new Set(target);
  for (const name of additions) {
    if (seen.has(name)) continue;
    seen.add(name);
    target.push(name);
  }
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
