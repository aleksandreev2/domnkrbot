import assert from 'node:assert/strict';
import test from 'node:test';

async function loadScanner() {
  return import('../dist-runtime/ranobelib-fast-scanner.js');
}

test('adaptive HOT cadence uses the frozen one-hour and six-hour activity windows', async () => {
  const scanner = await loadScanner();
  const now = new Date('2026-09-07T09:00:00.000Z');
  const delay = (lastChangeAt, misses = 1) => scanner.computeNextCheckDelayMinutes({
    changed: false,
    consecutiveNoChange: misses,
    consecutiveFailures: 0,
    lastChangeAt,
    now,
  });

  assert.equal(delay('2026-09-07T08:01:00.000Z'), 2, '59 minutes old stays on 2-minute cadence');
  assert.equal(delay('2026-09-07T07:59:00.000Z'), 5, '61 minutes old moves to 5-minute cadence');
  assert.equal(delay('2026-09-07T03:01:00.000Z'), 5, '5h59 old stays on 5-minute cadence');
  assert.equal(delay('2026-09-07T02:59:00.000Z', 1), 10, '6h01 old falls back to stale 10-minute cadence');
  assert.equal(delay('2026-09-07T02:59:00.000Z', 3), 30, 'stable stale title uses 30-minute cadence');
});
