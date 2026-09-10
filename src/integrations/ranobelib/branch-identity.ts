export type RanobeLibBranchIdentityConfidence = 'native' | 'fallback' | 'ambiguous';

export type RanobeLibBranchIdentity = {
  key: string;
  nativeBranchId: number | null;
  confidence: RanobeLibBranchIdentityConfidence;
};

export type RanobeLibBranchIdentityInput = {
  bookRef: string;
  chapterId: number;
  nativeBranchId: number | null;
  teamIds: readonly number[];
  releasedAt: string | null;
  stableBranchRef: string | null;
  /** Observation-local ordinal used only to avoid unsafe merging when upstream exposes no stable identity. */
  branchOrdinal?: number | null;
};

export function buildRanobeLibBranchIdentity(input: RanobeLibBranchIdentityInput): RanobeLibBranchIdentity {
  const nativeBranchId = positiveSafeIntegerOrNull(input.nativeBranchId);
  if (nativeBranchId !== null) {
    return {
      key: `native:${nativeBranchId}`,
      nativeBranchId,
      confidence: 'native',
    };
  }

  const teamIds = normalizeTeamIds(input.teamIds);
  const stableBranchRef = nonEmptyString(input.stableBranchRef);
  const releasedAt = normalizedTimestamp(input.releasedAt);

  // A team set is branch-level upstream evidence. A stable upstream branch ref or release timestamp
  // adds further separation when present. Mutable display names are deliberately excluded.
  if (teamIds.length > 0 || stableBranchRef || releasedAt) {
    const canonical = JSON.stringify([
      'v1',
      String(input.bookRef || '').trim(),
      positiveSafeIntegerOrNull(input.chapterId),
      teamIds,
      stableBranchRef,
      releasedAt,
    ]);
    return {
      key: `fp:v1:${encodeURIComponent(canonical)}`,
      nativeBranchId: null,
      confidence: 'fallback',
    };
  }

  // Never collapse two identity-less branches merely because they belong to the same chapter.
  // The ordinal is intentionally observation-local: it may create a duplicate after a pathological
  // upstream reorder, but that is safer than suppressing a legitimate independent release.
  const ordinal = nonNegativeSafeIntegerOrZero(input.branchOrdinal);
  const ambiguous = JSON.stringify([
    'amb-v1',
    String(input.bookRef || '').trim(),
    positiveSafeIntegerOrNull(input.chapterId),
    ordinal,
  ]);
  return {
    key: `amb:v1:${encodeURIComponent(ambiguous)}`,
    nativeBranchId: null,
    confidence: 'ambiguous',
  };
}

export function normalizeRanobeLibTeamIds(values: readonly unknown[]): number[] {
  const unique = new Set<number>();
  for (const value of values) {
    const id = positiveSafeIntegerOrNull(value);
    if (id !== null) unique.add(id);
  }
  return [...unique].sort((a, b) => a - b);
}

function normalizeTeamIds(values: readonly number[]): number[] {
  return normalizeRanobeLibTeamIds(values);
}

function positiveSafeIntegerOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeSafeIntegerOrZero(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedTimestamp(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}
