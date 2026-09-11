import assert from 'node:assert/strict';
import test from 'node:test';

async function scanPlan() {
  return import('../dist-runtime/multi-team-scan-plan.js');
}

test('completed work context finalizes only the latest unambiguous branch participants', async () => {
  const { computeTeamScopedCompletionPlan } = await scanPlan();
  assert.equal(typeof computeTeamScopedCompletionPlan, 'function');

  const plan = computeTeamScopedCompletionPlan({
    workCompleted: true,
    translations: [
      { teamId: 1, upstreamTeamId: 101, baselineReady: true, semanticStatus: 'active' },
      { teamId: 2, upstreamTeamId: 202, baselineReady: true, semanticStatus: 'active' },
    ],
    branches: [
      {
        chapterId: 100,
        volume: '1',
        number: '100',
        branchKey: 'native:20',
        identityConfidence: 'native',
        upstreamTeamIds: [202],
      },
      {
        chapterId: 101,
        volume: '1',
        number: '101',
        branchKey: 'native:10',
        identityConfidence: 'native',
        upstreamTeamIds: [101],
      },
    ],
  });

  assert.deepEqual(plan.notifyTeamIds, [1]);
  assert.deepEqual(plan.silentTeamIds, []);
  assert.equal(plan.branchKey, 'native:10');
});

test('joint latest branch completes all participating baselined teams once', async () => {
  const { computeTeamScopedCompletionPlan } = await scanPlan();
  const plan = computeTeamScopedCompletionPlan({
    workCompleted: true,
    translations: [
      { teamId: 1, upstreamTeamId: 101, baselineReady: true, semanticStatus: 'active' },
      { teamId: 2, upstreamTeamId: 202, baselineReady: true, semanticStatus: 'active' },
    ],
    branches: [{
      chapterId: 101,
      volume: '1',
      number: '101',
      branchKey: 'native:77',
      identityConfidence: 'native',
      upstreamTeamIds: [202, 101, 202],
    }],
  });

  assert.deepEqual(plan.notifyTeamIds, [1, 2]);
  assert.deepEqual(plan.silentTeamIds, []);
});

test('initial completed classification is silent for unbaselined team', async () => {
  const { computeTeamScopedCompletionPlan } = await scanPlan();
  const plan = computeTeamScopedCompletionPlan({
    workCompleted: true,
    translations: [
      { teamId: 7, upstreamTeamId: 707, baselineReady: false, semanticStatus: 'active' },
    ],
    branches: [{
      chapterId: 50,
      volume: '1',
      number: '50',
      branchKey: 'native:7',
      identityConfidence: 'native',
      upstreamTeamIds: [707],
    }],
  });

  assert.deepEqual(plan.notifyTeamIds, []);
  assert.deepEqual(plan.silentTeamIds, [7]);
});

test('ambiguous latest branch never finalizes team completion', async () => {
  const { computeTeamScopedCompletionPlan } = await scanPlan();
  const plan = computeTeamScopedCompletionPlan({
    workCompleted: true,
    translations: [
      { teamId: 1, upstreamTeamId: 101, baselineReady: true, semanticStatus: 'active' },
      { teamId: 2, upstreamTeamId: 202, baselineReady: true, semanticStatus: 'active' },
    ],
    branches: [
      {
        chapterId: 101,
        volume: '1',
        number: '101',
        branchKey: 'fallback:a',
        identityConfidence: 'fallback',
        upstreamTeamIds: [101],
      },
      {
        chapterId: 101,
        volume: '1',
        number: '101',
        branchKey: 'fallback:b',
        identityConfidence: 'fallback',
        upstreamTeamIds: [202],
      },
    ],
  });

  assert.deepEqual(plan.notifyTeamIds, []);
  assert.deepEqual(plan.silentTeamIds, []);
  assert.equal(plan.branchKey, null);
});

test('work-level status alone is never enough to complete a team without attributable branches', async () => {
  const { computeTeamScopedCompletionPlan } = await scanPlan();
  const plan = computeTeamScopedCompletionPlan({
    workCompleted: true,
    translations: [
      { teamId: 1, upstreamTeamId: 101, baselineReady: true, semanticStatus: 'active' },
    ],
    branches: [],
  });

  assert.deepEqual(plan.notifyTeamIds, []);
  assert.deepEqual(plan.silentTeamIds, []);
});
