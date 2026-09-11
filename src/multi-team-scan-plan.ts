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

function snapshotKey(chapterId: number, branchKey: string): string {
  return `${chapterId}\u0000${branchKey}`;
}

function positiveTeamId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
