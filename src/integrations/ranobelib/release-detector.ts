import type { RanobeLibChapter, RanobeLibReleaseDelta } from './types.js';

export interface DetectReleaseOptions {
  emitOnBootstrap?: boolean;
}

export function detectReleaseDelta(
  bookRef: string,
  previous: RanobeLibChapter[] | undefined,
  current: RanobeLibChapter[],
  options: DetectReleaseOptions = {},
): RanobeLibReleaseDelta | null {
  if (!previous) {
    if (!options.emitOnBootstrap || current.length === 0) return null;
    const added = sortChapters(current);
    return { bookRef, added, removed: [], summary: summarizeAdded(added) };
  }

  const previousIds = new Set(previous.map((chapter) => chapter.id));
  const currentIds = new Set(current.map((chapter) => chapter.id));
  const added = sortChapters(current.filter((chapter) => !previousIds.has(chapter.id)));
  const removed = sortChapters(previous.filter((chapter) => !currentIds.has(chapter.id)));

  if (added.length === 0 && removed.length === 0) return null;

  return {
    bookRef,
    added,
    removed,
    summary: added.length > 0 ? summarizeAdded(added) : 'No new chapters; existing chapter set changed',
  };
}

/**
 * Repairs snapshots created by the old sync logic, which could persist a scheduled
 * chapter before its RanobeLib branch publication time. Once that publication time
 * is reached, firstSeenAt < releasedAt proves the row was observed prematurely.
 */
export function detectScheduledReleaseTransitions(
  previous: RanobeLibChapter[],
  current: RanobeLibChapter[],
  nowMs = Date.now(),
): RanobeLibChapter[] {
  const previousById = new Map(previous.map((chapter) => [chapter.id, chapter]));
  return sortChapters(current.filter((chapter) => {
    const stored = previousById.get(chapter.id);
    if (!stored) return false;
    const firstSeenMs = parseTimestamp(stored.firstSeenAt);
    const releasedMs = parseTimestamp(chapter.releasedAt);
    if (firstSeenMs === null || releasedMs === null) return false;
    return firstSeenMs < releasedMs && releasedMs <= nowMs;
  }));
}

export function sortChapters(chapters: RanobeLibChapter[]): RanobeLibChapter[] {
  return [...chapters].sort((a, b) => {
    const volumeComparison = compareChapterToken(a.volume, b.volume);
    if (volumeComparison !== 0) return volumeComparison;
    const numberComparison = compareChapterToken(a.number, b.number);
    if (numberComparison !== 0) return numberComparison;
    return a.id - b.id;
  });
}

export function summarizeAdded(chapters: RanobeLibChapter[]): string {
  if (chapters.length === 0) return 'No new chapters';
  if (chapters.length === 1) return `Chapter ${chapters[0]!.number}`;

  const first = chapters[0]!;
  const last = chapters[chapters.length - 1]!;
  const sameVolume = chapters.every((chapter) => chapter.volume === first.volume);
  const allNumeric = chapters.every((chapter) => Number.isFinite(Number(chapter.number)));

  if (sameVolume && allNumeric) {
    return `Chapters ${first.number}–${last.number}`;
  }

  return `${chapters.length} new chapters`;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareChapterToken(a: string, b: string): number {
  const aNumber = Number(a);
  const bNumber = Number(b);
  const aNumeric = Number.isFinite(aNumber);
  const bNumeric = Number.isFinite(bNumber);

  if (aNumeric && bNumeric) return aNumber - bNumber;
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
}