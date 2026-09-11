import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function scanPlan() {
  return import('../dist-runtime/multi-team-scan-plan.js');
}

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

const pending = (overrides = {}) => ({
  teamId: 1,
  upstreamTeamId: 101,
  baselineReady: true,
  semanticStatus: 'active',
  completionPending: true,
  lifecycleState: 'published',
  ...overrides,
});

const branch = (overrides = {}) => ({
  chapterId: 100,
  volume: '1',
  number: '100',
  branchKey: 'native:10',
  identityConfidence: 'native',
  upstreamTeamIds: [101],
  ...overrides,
});

test('pending team completion uses that team latest branch, not the work-global latest branch', async () => {
  const { computeTeamScopedCompletionPlan } = await scanPlan();
  const plan = computeTeamScopedCompletionPlan({
    translations: [
      pending(),
      pending({ teamId: 2, upstreamTeamId: 202, completionPending: false }),
    ],
    branches: [
      branch(),
      branch({ chapterId: 101, number: '101', branchKey: 'native:20', upstreamTeamIds: [202] }),
    ],
  });

  assert.deepEqual(plan.finalizations, [{
    teamId: 1,
    upstreamTeamId: 101,
    chapterId: 100,
    branchKey: 'native:10',
  }]);
  assert.deepEqual(plan.notifyTeamIds, [1]);
  assert.deepEqual(plan.silentTeamIds, []);
});

test('joint latest branch completes all pending published baselined participants once', async () => {
  const { computeTeamScopedCompletionPlan } = await scanPlan();
  const plan = computeTeamScopedCompletionPlan({
    translations: [pending(), pending({ teamId: 2, upstreamTeamId: 202 })],
    branches: [branch({ branchKey: 'native:77', upstreamTeamIds: [202, 101, 202] })],
  });

  assert.deepEqual(plan.finalizations.map((row) => row.teamId), [1, 2]);
  assert.deepEqual(plan.notifyTeamIds, [1, 2]);
  assert.deepEqual(plan.silentTeamIds, []);
});

test('initial completed classification is finalized silently for an unbaselined team', async () => {
  const { computeTeamScopedCompletionPlan } = await scanPlan();
  const plan = computeTeamScopedCompletionPlan({
    translations: [pending({ teamId: 7, upstreamTeamId: 707, baselineReady: false })],
    branches: [branch({ chapterId: 50, number: '50', branchKey: 'native:7', upstreamTeamIds: [707] })],
  });

  assert.deepEqual(plan.finalizations.map((row) => row.teamId), [7]);
  assert.deepEqual(plan.notifyTeamIds, []);
  assert.deepEqual(plan.silentTeamIds, [7]);
});

test('hidden pending team is finalized silently even when already baselined', async () => {
  const { computeTeamScopedCompletionPlan } = await scanPlan();
  const plan = computeTeamScopedCompletionPlan({
    translations: [pending({ lifecycleState: 'hidden' })],
    branches: [branch()],
  });

  assert.deepEqual(plan.finalizations.map((row) => row.teamId), [1]);
  assert.deepEqual(plan.notifyTeamIds, []);
  assert.deepEqual(plan.silentTeamIds, [1]);
});

test('ambiguous team-local latest position never finalizes completion', async () => {
  const { computeTeamScopedCompletionPlan } = await scanPlan();
  const plan = computeTeamScopedCompletionPlan({
    translations: [pending()],
    branches: [
      branch({ branchKey: 'fallback:a', identityConfidence: 'fallback' }),
      branch({ branchKey: 'fallback:b', identityConfidence: 'fallback' }),
    ],
  });

  assert.deepEqual(plan.finalizations, []);
  assert.deepEqual(plan.notifyTeamIds, []);
  assert.deepEqual(plan.silentTeamIds, []);
});

test('chapter attribution alone never completes a team without team-scoped pending evidence', async () => {
  const { computeTeamScopedCompletionPlan } = await scanPlan();
  const plan = computeTeamScopedCompletionPlan({
    translations: [pending({ completionPending: false })],
    branches: [branch()],
  });

  assert.deepEqual(plan.finalizations, []);
});

test('multi-team discovery stores team-scoped completion pending from catalog status only', async () => {
  const discovery = await source('src/ranobelib-multi-team-discovery.ts');
  assert.match(discovery, /translationStatusLabel/);
  assert.match(discovery, /completion_pending/);
  assert.match(discovery, /completion_revision/);
  assert.doesNotMatch(discovery, /getTranslationStatus\(/);
});

test('multi-team scanner finalizes team completion only after final chapter snapshot', async () => {
  const scanner = await source('src/ranobelib-multi-team-scanner.ts');
  assert.match(scanner, /computeTeamScopedCompletionPlan/);
  assert.match(scanner, /finalizeTeamCompletions/);
  assert.match(scanner, /persistTeamCompletionRelease/);
  assert.doesNotMatch(scanner, /getTranslationStatus/);

  const persistSnapshotAt = scanner.indexOf('await persistBranchSnapshot');
  const finalizeAt = scanner.indexOf('await finalizeTeamCompletions');
  assert.ok(persistSnapshotAt >= 0, 'scanner must persist the final chapter snapshot');
  assert.ok(finalizeAt > persistSnapshotAt, 'team completion must finalize only after the final chapter snapshot');
});

test('team completion release is mapped to exact teams instead of copying completion by work', async () => {
  const scanner = await source('src/ranobelib-multi-team-scanner.ts');
  assert.match(scanner, /INSERT OR IGNORE INTO ranobelib_release_teams/);
  assert.match(scanner, /release_kind[\s\S]*translation_completed/);
  assert.match(scanner, /notifyTeamIds/);
  assert.match(scanner, /completion_pending = 0/);
  assert.doesNotMatch(scanner, /UPDATE ranobelib_team_translations[\s\S]{0,400}SET semantic_status = 'completed'[\s\S]{0,400}WHERE book_ref = \?\s*(?:;|`)/);
});
