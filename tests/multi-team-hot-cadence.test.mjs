import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('unbaselined works respect next_check_at after their first bootstrap attempt', async () => {
  const source = await readFile(new URL('../src/ranobelib-multi-team-scanner.ts', import.meta.url), 'utf8');
  const selectorStart = source.indexOf('export async function selectDueMultiTeamWorks');
  const selectorEnd = source.indexOf('async function scanOneMultiTeamWork', selectorStart);
  assert.ok(selectorStart >= 0 && selectorEnd > selectorStart, 'multi-team selector must remain inspectable');
  const selector = source.slice(selectorStart, selectorEnd);
  const scheduleStart = selector.indexOf('AND (\n        EXISTS (');
  const scheduleEnd = selector.indexOf('    ORDER BY', scheduleStart);
  assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart, 'schedule gate must remain inspectable');
  const scheduleGate = selector.slice(scheduleStart, scheduleEnd);

  assert.match(scheduleGate, /bootstrap\.completion_pending = 1/,
    'completion final scans may bypass next_check_at because they are mandatory');
  assert.doesNotMatch(scheduleGate, /bootstrap\.baseline_ready = 0\s+OR\s+bootstrap\.completion_pending = 1/,
    'ordinary baseline bootstrap must respect next_check_at after the first attempt');
  assert.match(scheduleGate, /t\.next_check_at IS NULL/,
    'a newly discovered title with no schedule must still bootstrap immediately');
  assert.match(scheduleGate, /t\.next_check_at <= CURRENT_TIMESTAMP/,
    'scheduled bootstrap scans must become due normally');
});
