import type { RanobeLibChapterBranch } from './integrations/ranobelib/types.js';

export type TeamScopedPlanTranslation = {
  teamId: number;
  baselineReady: boolean;
};

export type TeamScopedPlanBranch = {
  chapterId: number;
  branchKey: string;
  teamIds: number[];
};

export type TeamScopedScanPlan = {
  teamIdsToBaseline: number[];
  releasableBranches: TeamScopedPlanBranch[];
};

export type TeamCompletionPlanTranslation = {
  teamId: number;
  upstreamTeamId: number;
  baselineReady: boolean;
  semanticStatus: string;
  completionPending: boolean;
  lifecycleState: string;
};

export type TeamCompletionPlanBranch = {
  chapterId: number;
  volume: string;
  number: string;
  branchKey: string;
  identityConfidence: RanobeLibChapterBranch['identityConfidence'];
  upstreamTeamIds: number[];
};

export type TeamCompletionFinalization = {
  teamId: number;
  upstreamTeamId: number;
  chapterId: number;
  branchKey: string;
};

export type TeamScopedCompletionPlan = {
  finalizations: TeamCompletionFinalization[];
  notifyTeamIds: number[];
  silentTeamIds: number[];
};

/**
 * Baseline is scoped to each `(team, work)` relationship.
 *
 * A newly discovered team is allowed to consume only its own historical branch state. Existing
 * baselined teams still release fresh branches from the same work. A non-empty upstream payload
 * with no branch attributable to an unbaselined team is deliberately inconclusive and cannot mark
 * that team baselined; this prevents a temporary parser/attribution failure from becoming replay.
 */
export function computeTeamScopedScanPlan(input: {
  translations: readonly TeamScopedPlanTranslation[];
  branches: readonly TeamScopedPlanBranch[];
  storedBranchKeys: readonly string[];
  fetchedBranchCount: number;
}): TeamScopedScanPlan {
  const readyTeams = new Set<number>();
  const unbaselinedTeams = new Set<number>();
  for (const row of input.translations) {
    const teamId = positiveTeamId(row.teamId);
    if (teamId === null) continue;
    if (row.baselineReady) readyTeams.add(teamId);
    else unbaselinedTeams.add(teamId);
  }

  const observedTeams = new Set<number>();
  for (const branch of input.branches) {
    for (const rawTeamId of branch.teamIds) {
      const teamId = positiveTeamId(rawTeamId);
      if (teamId !== null) observedTeams.add(teamId);
    }
  }

  const teamIdsToBaseline = [...unbaselinedTeams]
    .filter((teamId) => input.fetchedBranchCount === 0 || observedTeams.has(teamId))
    .sort((a, b) => a - b);

  const stored = new Set(input.storedBranchKeys);
  const releasableBranches: TeamScopedPlanBranch[] = [];
  for (const branch of input.branches) {
    if (stored.has(snapshotKey(branch.chapterId, branch.branchKey))) continue;
    const teamIds = [...new Set(branch.teamIds
      .map(positiveTeamId)
      .filter((value): value is number => value !== null && readyTeams.has(value)))]
      .sort((a, b) => a - b);
    if (teamIds.length === 0) continue;
    releasableBranches.push({
      chapterId: branch.chapterId,
      branchKey: branch.branchKey,
      teamIds,
    });
  }

  return { teamIdsToBaseline, releasableBranches };
}

/**
 * Completion is driven by an already team-scoped pending transition created by discovery. The
 * final chapter poll is used only to prove that the pending team owns an unambiguous latest branch.
 * Each team is evaluated against its own branches, never against the work-global latest chapter.
 *
 * A baselined published team receives a completion event. Hidden teams and teams being baselined
 * for the first time are finalized silently so private state and historical completion never leak.
 */
export function computeTeamScopedCompletionPlan(input: {
  translations: readonly TeamCompletionPlanTranslation[];
  branches: readonly TeamCompletionPlanBranch[];
}): TeamScopedCompletionPlan {
  const finalizations: TeamCompletionFinalization[] = [];
  const notifyTeamIds: number[] = [];
  const silentTeamIds: number[] = [];

  const pending = input.translations
    .map((row) => ({
      teamId: positiveTeamId(row.teamId),
      upstreamTeamId: positiveTeamId(row.upstreamTeamId),
      baselineReady: Boolean(row.baselineReady),
      semanticStatus: String(row.semanticStatus ?? '').trim(),
      completionPending: Boolean(row.completionPending),
      lifecycleState: String(row.lifecycleState ?? '').trim(),
    }))
    .filter((row): row is {
      teamId: number;
      upstreamTeamId: number;
      baselineReady: boolean;
      semanticStatus: string;
      completionPending: boolean;
      lifecycleState: string;
    } => row.teamId !== null
      && row.upstreamTeamId !== null
      && row.completionPending
      && row.semanticStatus !== 'completed');

  for (const row of pending) {
    const teamBranches = input.branches.filter((branch) => branch.upstreamTeamIds.some(
      (rawTeamId) => positiveTeamId(rawTeamId) === row.upstreamTeamId,
    ));
    if (teamBranches.length === 0) continue;

    const ordered = [...teamBranches].sort(compareCompletionBranchPosition);
    const latest = ordered[ordered.length - 1];
    if (!latest) continue;
    const latestAtPosition = ordered.filter((branch) => sameChapterPosition(branch, latest));
    const distinctLatest = new Map(latestAtPosition.map((branch) => [
      `${branch.chapterId}\u0000${branch.branchKey}`,
      branch,
    ]));
    if (distinctLatest.size !== 1) continue;

    const branch = [...distinctLatest.values()][0]!;
    if (branch.identityConfidence === 'ambiguous') continue;

    finalizations.push({
      teamId: row.teamId,
      upstreamTeamId: row.upstreamTeamId,
      chapterId: branch.chapterId,
      branchKey: branch.branchKey,
    });
    if (row.baselineReady && row.lifecycleState === 'published') notifyTeamIds.push(row.teamId);
    else silentTeamIds.push(row.teamId);
  }

  finalizations.sort((a, b) => a.teamId - b.teamId);
  notifyTeamIds.sort((a, b) => a - b);
  silentTeamIds.sort((a, b) => a - b);
  return { finalizations, notifyTeamIds, silentTeamIds };
}

/**
 * Stable delivery grouping is intentionally separate from branch snapshot/release identity.
 * Existing branch keys contain chapter-specific entropy in fallback mode and must never be
 * rewritten because they are part of historical dedupe. Delivery grouping may use the stable
 * upstream branch ref when present, otherwise a conservative branch slot plus the exact team set.
 */
export function multiTeamDeliveryScopeKey(
  branch: Pick<RanobeLibChapterBranch,
    'branchKey' | 'nativeBranchId' | 'identityConfidence' | 'stableBranchRef' | 'branchOrdinal'>,
  internalTeamIds: readonly number[],
): string {
  const teams = [...new Set(internalTeamIds.map(positiveTeamId).filter((value): value is number => value !== null))]
    .sort((a, b) => a - b);
  const teamScope = teams.join(',');

  if (branch.identityConfidence === 'native' && branch.nativeBranchId !== null) {
    return `delivery:v2:native:${branch.nativeBranchId}:teams:${teamScope}`;
  }
  if (branch.identityConfidence === 'ambiguous') {
    return `delivery:v2:ambiguous:${encodeURIComponent(branch.branchKey)}:teams:${teamScope}`;
  }
  if (branch.stableBranchRef) {
    return `delivery:v2:ref:${encodeURIComponent(branch.stableBranchRef)}:teams:${teamScope}`;
  }
  const slot = Number.isSafeInteger(branch.branchOrdinal) && branch.branchOrdinal >= 0
    ? branch.branchOrdinal
    : 0;
  return `delivery:v2:slot:${slot}:teams:${teamScope}`;
}

function compareCompletionBranchPosition(a: TeamCompletionPlanBranch, b: TeamCompletionPlanBranch): number {
  const volume = compareToken(a.volume, b.volume);
  if (volume !== 0) return volume;
  const number = compareToken(a.number, b.number);
  if (number !== 0) return number;
  if (a.chapterId !== b.chapterId) return a.chapterId - b.chapterId;
  return a.branchKey.localeCompare(b.branchKey);
}

function sameChapterPosition(a: TeamCompletionPlanBranch, b: TeamCompletionPlanBranch): boolean {
  return a.chapterId === b.chapterId && a.volume === b.volume && a.number === b.number;
}

function compareToken(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  const aNumeric = Number.isFinite(an);
  const bNumeric = Number.isFinite(bn);
  if (aNumeric && bNumeric) return an - bn;
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return String(a).localeCompare(String(b), 'ru', { numeric: true, sensitivity: 'base' });
}

function snapshotKey(chapterId: number, branchKey: string): string {
  return `${chapterId}\u0000${branchKey}`;
}

function positiveTeamId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
