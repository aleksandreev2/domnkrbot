import assert from 'node:assert/strict';
import test from 'node:test';

async function loadScanner() {
  return import('../dist-runtime/ranobelib-fast-scanner.js');
}

test('hot-title cadence keeps the 2-minute window through one hour and the 5-minute window through six hours', async () => {
  const scanner = await loadScanner();
  const now = new Date('2026-09-07T12:00:00.000Z');

  assert.equal(scanner.computeNextCheckDelayMinutes({
    changed: false,
    consecutiveNoChange: 1,
    consecutiveFailures: 0,
    lastChangeAt: '2026-09-07T11:01:00.000Z',
    now,
  }), 2, '59 minutes since the last change should remain on the 2-minute cadence');

  assert.equal(scanner.computeNextCheckDelayMinutes({
    changed: false,
    consecutiveNoChange: 1,
    consecutiveFailures: 0,
    lastChangeAt: '2026-09-07T10:59:00.000Z',
    now,
  }), 5, '61 minutes since the last change should move to the 5-minute cadence');

  assert.equal(scanner.computeNextCheckDelayMinutes({
    changed: false,
    consecutiveNoChange: 1,
    consecutiveFailures: 0,
    lastChangeAt: '2026-09-07T06:01:00.000Z',
    now,
  }), 5, '5h59m since the last change should remain on the 5-minute cadence');

  assert.equal(scanner.computeNextCheckDelayMinutes({
    changed: false,
    consecutiveNoChange: 2,
    consecutiveFailures: 0,
    lastChangeAt: '2026-09-07T05:59:00.000Z',
    now,
  }), 10, '6h01m with two misses should fall back to the 10-minute cadence');

  assert.equal(scanner.computeNextCheckDelayMinutes({
    changed: false,
    consecutiveNoChange: 3,
    consecutiveFailures: 0,
    lastChangeAt: '2026-09-07T05:59:00.000Z',
    now,
  }), 30, '6h01m with three misses should fall back to the 30-minute stable cadence');
});
