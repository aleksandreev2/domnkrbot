import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateSnapshotMutationBudget } from '../dist-runtime/ranobelib-multi-team-persistence.js';
import { isRanobeLibScannerEnabled } from '../dist-runtime/ranobelib-scanner-control.js';

const policy = {
  absoluteMutationLimit: 50,
  relativeMutationLimit: 0.5,
  hardMutationLimit: 500,
  minimumExistingRows: 20,
};

test('snapshot mutation budget allows small legitimate deltas', () => {
  const result = evaluateSnapshotMutationBudget({
    branchWrites: 3,
    mappingInserts: 4,
    mappingDeletes: 1,
    existingSnapshotSize: 200,
    initialBaseline: false,
  }, policy);
  assert.equal(result.allowed, true);
  assert.equal(result.totalMutations, 8);
});

test('snapshot mutation budget fails closed on a large historical rewrite', () => {
  const result = evaluateSnapshotMutationBudget({
    branchWrites: 80,
    mappingInserts: 40,
    mappingDeletes: 60,
    existingSnapshotSize: 200,
    initialBaseline: false,
  }, policy);
  assert.equal(result.allowed, false);
  assert.equal(result.totalMutations, 180);
  assert.match(result.reason ?? '', /mutation budget/i);
});

test('hard mutation cap blocks huge deltas even when relative ratio is small', () => {
  const result = evaluateSnapshotMutationBudget({
    branchWrites: 200,
    mappingInserts: 350,
    mappingDeletes: 0,
    existingSnapshotSize: 10000,
    initialBaseline: false,
  }, policy);
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /hard/i);
});

test('explicit initial baseline path can import a large snapshot', () => {
  const result = evaluateSnapshotMutationBudget({
    branchWrites: 3000,
    mappingInserts: 3000,
    mappingDeletes: 0,
    existingSnapshotSize: 0,
    initialBaseline: true,
  }, policy);
  assert.equal(result.allowed, true);
});

test('scanner kill switch defaults enabled, recognizes off values, and fails closed on D1 errors', async () => {
  const makeDb = (value, throws = false) => ({
    prepare(sql) {
      assert.match(sql, /app_settings/);
      return {
        bind() { return this; },
        async first() {
          if (throws) throw new Error('synthetic D1 failure');
          return value === undefined ? null : { value };
        },
      };
    },
  });

  assert.equal(await isRanobeLibScannerEnabled({ DB: makeDb(undefined) }), true);
  assert.equal(await isRanobeLibScannerEnabled({ DB: makeDb('1') }), true);
  assert.equal(await isRanobeLibScannerEnabled({ DB: makeDb('0') }), false);
  assert.equal(await isRanobeLibScannerEnabled({ DB: makeDb('off') }), false);
  assert.equal(await isRanobeLibScannerEnabled({ DB: makeDb(undefined, true) }), false);
});
