import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyUnattributedTeamPayload } from '../dist-runtime/ranobelib-multi-team-scanner.js';

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
