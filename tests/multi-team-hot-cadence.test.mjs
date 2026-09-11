import assert from 'node:assert/strict';
import test from 'node:test';

async function loadScanner() {
  return import('../dist-runtime/ranobelib-multi-team-scanner.js');
}

test('HOT multi-team works never sleep longer than five minutes', async () => {
  const { computeMultiTeamNextCheckDelayMinutes } = await loadScanner();

  assert.equal(typeof computeMultiTeamNextCheckDelayMinutes, 'function');
  assert.equal(computeMultiTeamNextCheckDelayMinutes({
    scanClass: 'hot', changed: true, consecutiveNoChange: 0,
  }), 1, 'a detected release should be checked again after one minute');
  assert.equal(computeMultiTeamNextCheckDelayMinutes({
    scanClass: 'hot', changed: false, consecutiveNoChange: 1,
  }), 2, 'the first quiet HOT checks should stay aggressive');
  assert.equal(computeMultiTeamNextCheckDelayMinutes({
    scanClass: 'hot', changed: false, consecutiveNoChange: 2,
  }), 2, 'the second quiet HOT check should still use two minutes');
  assert.equal(computeMultiTeamNextCheckDelayMinutes({
    scanClass: 'hot', changed: false, consecutiveNoChange: 3,
  }), 5, 'quiet subscribed works should cap at five minutes instead of thirty');
  assert.equal(computeMultiTeamNextCheckDelayMinutes({
    scanClass: 'hot', changed: false, consecutiveNoChange: 100,
  }), 5, 'long-quiet subscribed works must never return to a 30-minute cadence');
  assert.equal(computeMultiTeamNextCheckDelayMinutes({
    scanClass: 'idle', changed: false, consecutiveNoChange: 100,
  }), 180, 'zero-demand IDLE works should keep the three-hour cadence');
});
