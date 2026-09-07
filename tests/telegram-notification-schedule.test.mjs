import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const wrangler = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const entry = fs.readFileSync(new URL('../src/live-entry-v2.ts', import.meta.url), 'utf8');

test('notification schedule gives hot scan, idle scan, discovery, fallback delivery and membership independent invocations', () => {
  assert.deepEqual(
    wrangler.triggers?.crons,
    ['* * * * *', '17 */3 * * *', '*/30 * * * *', '*/5 * * * *', '0 * * * *'],
  );
  assert.match(entry, /FAST_SCAN_CRON/);
  assert.match(entry, /IDLE_SCAN_CRON/);
  assert.match(entry, /DISCOVERY_CRON/);
  assert.match(entry, /FALLBACK_DELIVERY_CRON/);
  assert.match(entry, /MEMBERSHIP_CRON/);
});

test('legacy ten-minute combined notification schedule is removed', () => {
  assert.equal(wrangler.triggers?.crons?.includes('*/10 * * * *'), false);
  const scheduledBody = entry.slice(entry.indexOf('async scheduled('));
  assert.doesNotMatch(scheduledBody, /baseWorker\.scheduled/);
  assert.doesNotMatch(scheduledBody, /deliverPendingReleaseNotifications/);
});
