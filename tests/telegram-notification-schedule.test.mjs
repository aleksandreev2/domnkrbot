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

test('five-minute fallback cron also advances channel membership enforcement', () => {
  const fallbackStart = entry.indexOf('if (controller.cron === FALLBACK_DELIVERY_CRON)');
  const membershipStart = entry.indexOf('if (controller.cron === MEMBERSHIP_CRON)', fallbackStart);
  assert.ok(fallbackStart >= 0 && membershipStart > fallbackStart);
  const fallbackBody = entry.slice(fallbackStart, membershipStart);
  assert.match(fallbackBody, /runChannelMembershipMaintenance\(env, 40\)/);
  assert.ok(
    fallbackBody.indexOf('runChannelMembershipMaintenance(env, 40)') < fallbackBody.indexOf('drainNotificationOutbox'),
    'membership enforcement should run before notification fallback delivery',
  );
});

test('membership cron repairs chat_member webhook subscription before running maintenance', () => {
  assert.match(entry, /ensureWebhookMembershipUpdates/);
  assert.match(
    entry,
    /if \(controller\.cron === MEMBERSHIP_CRON\) \{[\s\S]*?ensureWebhookMembershipUpdates\(env\)[\s\S]*?runChannelMembershipMaintenance\(env, 40\)/,
  );
});

test('legacy ten-minute combined notification schedule is removed', () => {
  assert.equal(wrangler.triggers?.crons?.includes('*/10 * * * *'), false);
  const scheduledBody = entry.slice(entry.indexOf('async scheduled('));
  assert.doesNotMatch(scheduledBody, /baseWorker\.scheduled/);
  assert.doesNotMatch(scheduledBody, /deliverPendingReleaseNotifications/);
});