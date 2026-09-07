import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const entry = fs.readFileSync(new URL('../src/live-entry-v2.ts', import.meta.url), 'utf8');
const wranglerText = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const wrangler = JSON.parse(wranglerText);

const FAST_SCAN_CRON = '* * * * *';
const DISCOVERY_CRON = '*/30 * * * *';
const FALLBACK_DELIVERY_CRON = '*/5 * * * *';
const MEMBERSHIP_CRON = '0 * * * *';

test('Wrangler declares exactly four isolated notification v3 crons and one bounded Queue consumer', () => {
  assert.deepEqual(
    new Set(wrangler.triggers?.crons ?? []),
    new Set([FAST_SCAN_CRON, DISCOVERY_CRON, FALLBACK_DELIVERY_CRON, MEMBERSHIP_CRON]),
  );
  assert.equal(wrangler.triggers.crons.length, 4);

  const producers = wrangler.queues?.producers ?? [];
  const consumers = wrangler.queues?.consumers ?? [];
  assert.equal(producers.length, 1);
  assert.equal(consumers.length, 1);
  assert.equal(producers[0].binding, 'NOTIFICATION_QUEUE');
  assert.equal(producers[0].queue, consumers[0].queue);
  assert.equal(consumers[0].max_batch_size, 1);
  assert.equal(consumers[0].max_concurrency, 1);
});

test('scheduled routing isolates scanner, discovery, fallback delivery and membership into separate returning branches', () => {
  assert.match(entry, /const\s+FAST_SCAN_CRON\s*=\s*['"]\* \* \* \* \*['"]/);
  assert.match(entry, /const\s+DISCOVERY_CRON\s*=\s*['"]\*\/30 \* \* \* \*['"]/);
  assert.match(entry, /const\s+FALLBACK_DELIVERY_CRON\s*=\s*['"]\*\/5 \* \* \* \*['"]/);
  assert.match(entry, /const\s+MEMBERSHIP_CRON\s*=\s*['"]0 \* \* \* \*['"]/);

  assert.match(entry, /controller\.cron\s*===\s*FAST_SCAN_CRON[\s\S]*?scanDueRanobeLibTitles[\s\S]*?return;/);
  assert.match(entry, /controller\.cron\s*===\s*DISCOVERY_CRON[\s\S]*?discoverRanobeLibTeam[\s\S]*?return;/);
  assert.match(entry, /controller\.cron\s*===\s*FALLBACK_DELIVERY_CRON[\s\S]*?drainNotificationOutbox[\s\S]*?return;/);
  assert.match(entry, /controller\.cron\s*===\s*MEMBERSHIP_CRON[\s\S]*?runChannelMembershipMaintenance\(env,\s*20\)[\s\S]*?return;/);

  const scheduledBody = entry.slice(entry.indexOf('async scheduled('));
  assert.doesNotMatch(scheduledBody, /baseWorker\.scheduled/);
  assert.doesNotMatch(scheduledBody, /deliverPendingReleaseNotifications/);
});

test('fast scanner Queue wake-up is best-effort and never owns notification state', () => {
  assert.match(entry, /onRelease:\s*async\s*\(releaseId\)[\s\S]*?queueNotificationWakeup\(env,\s*releaseId\)/);
  assert.match(entry, /NOTIFICATION_QUEUE\?\.send/);
  assert.match(entry, /Queue wake-up failed|notification queue wake-up failed/i);
});

test('Queue consumer drains D1 by release id with a twenty-row cap and may enqueue one continuation', () => {
  assert.match(entry, /async\s+queue\s*\(/);
  assert.match(entry, /batch\.messages\[0\]/);
  assert.match(entry, /kind\s*===\s*['"]drain['"]/);
  assert.match(entry, /drainNotificationOutbox\(env,[\s\S]*?limit:\s*DELIVERY_BATCH_LIMIT[\s\S]*?releaseId/);
  assert.match(entry, /claimed\s*>=\s*DELIVERY_BATCH_LIMIT[\s\S]*?queueNotificationWakeup\(env/);
});
