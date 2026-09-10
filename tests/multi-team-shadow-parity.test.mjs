import assert from 'node:assert/strict';
import test from 'node:test';

import { comparePrimaryTeamParity } from '../dist-runtime/multi-team-shadow-parity.js';

test('primary-team shadow parity reports unexplained missing, extra and count mismatches', () => {
  const result = comparePrimaryTeamParity({
    legacy: [
      { bookRef: '1--a', chapterCount: 2 },
      { bookRef: '2--b', chapterCount: 1 },
    ],
    multiTeam: [
      { bookRef: '1--a', chapterCount: 3 },
      { bookRef: '3--c', chapterCount: 1 },
    ],
  });
  assert.deepEqual(result.missingInMultiTeam, ['2--b']);
  assert.deepEqual(result.extraInMultiTeam, ['3--c']);
  assert.deepEqual(result.chapterCountMismatches, [{ bookRef: '1--a', legacy: 2, multiTeam: 3 }]);
  assert.equal(result.ok, false);
});

test('primary-team parity is green only when the effective release set matches', () => {
  const result = comparePrimaryTeamParity({
    legacy: [{ bookRef: '1--a', chapterCount: 2 }],
    multiTeam: [{ bookRef: '1--a', chapterCount: 2 }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingInMultiTeam, []);
  assert.deepEqual(result.extraInMultiTeam, []);
  assert.deepEqual(result.chapterCountMismatches, []);
});
