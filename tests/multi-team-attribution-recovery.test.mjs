import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverSingleTeamUnattributedBranches } from '../dist-runtime/ranobelib-multi-team-scanner.js';

function branch(chapterId, teamIds = [], branchKey = `native:${chapterId}`) {
  return {
    chapterId,
    volume: '1',
    number: String(chapterId),
    name: null,
    branchKey,
    nativeBranchId: chapterId,
    identityConfidence: 'native',
    teamIds,
    releasedAt: '2026-09-11T12:00:00Z',
    stableBranchRef: null,
    branchOrdinal: 0,
  };
}

test('single actionable team safely recovers branches only when RanobeLib omitted all team attribution', () => {
  const fetched = [branch(10), branch(11), branch(12)];
  const recovered = recoverSingleTeamUnattributedBranches(fetched, [7]);

  assert.deepEqual(recovered?.map(({ branch: value, teamIds }) => [value.chapterId, teamIds]), [
    [10, [7]],
    [11, [7]],
    [12, [7]],
  ]);
});

test('explicit foreign upstream attribution never falls back to the registered team', () => {
  const fetched = [branch(10, [999])];
  assert.equal(recoverSingleTeamUnattributedBranches(fetched, [7]), null);
});

test('multiple actionable teams remain fail-closed when upstream attribution is absent', () => {
  const fetched = [branch(10), branch(11)];
  assert.equal(recoverSingleTeamUnattributedBranches(fetched, [7, 8]), null);
});

test('multiple released branches for one chapter remain fail-closed without team attribution', () => {
  const fetched = [
    branch(10, [], 'native:1001'),
    { ...branch(10, [], 'native:1002'), nativeBranchId: 1002, branchOrdinal: 1 },
  ];
  assert.equal(recoverSingleTeamUnattributedBranches(fetched, [7]), null);
});
