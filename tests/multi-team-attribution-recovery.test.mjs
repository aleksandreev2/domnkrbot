import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyUnattributedTeamPayload,
  withOneTransientD1Retry,
} from '../dist-runtime/ranobelib-multi-team-scanner.js';

const translation = (baselineReady, completionPending = false) => ({
  baselineReady,
  completionPending,
});

test('foreign-only chapter branches are a normal waiting state before the first team baseline', () => {
  assert.equal(
    classifyUnattributedTeamPayload({
      fetchedBranchCount: 188,
      relevantBranchCount: 0,
      translations: [translation(false)],
    }),
    'awaiting-first-team-branch',
  );
});

test('foreign-only chapter branches remain fail-closed after a team baseline existed', () => {
  assert.equal(
    classifyUnattributedTeamPayload({
      fetchedBranchCount: 188,
      relevantBranchCount: 0,
      translations: [translation(true)],
    }),
    'error',
  );
});

test('completion final scan never downgrades missing team attribution to a waiting state', () => {
  assert.equal(
    classifyUnattributedTeamPayload({
      fetchedBranchCount: 188,
      relevantBranchCount: 0,
      translations: [translation(false, true)],
    }),
    'error',
  );
});

test('an actually empty title is not treated as an attribution mismatch', () => {
  assert.equal(
    classifyUnattributedTeamPayload({
      fetchedBranchCount: 0,
      relevantBranchCount: 0,
      translations: [translation(false)],
    }),
    'ok',
  );
});

test('any attributable team branch makes the payload normal', () => {
  assert.equal(
    classifyUnattributedTeamPayload({
      fetchedBranchCount: 188,
      relevantBranchCount: 1,
      translations: [translation(false)],
    }),
    'ok',
  );
});

test('transient D1 object reset is retried exactly once', async () => {
  let attempts = 0;
  const result = await withOneTransientD1Retry(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = test');
    }
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
});

test('ordinary scan failures are not retried by the D1 reset guard', async () => {
  let attempts = 0;
  await assert.rejects(
    () => withOneTransientD1Retry(async () => {
      attempts += 1;
      throw new Error('RanobeLib returned malformed payload');
    }),
    /malformed payload/,
  );
  assert.equal(attempts, 1);
});
