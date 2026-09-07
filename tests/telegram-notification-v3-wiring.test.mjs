import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const entry = fs.readFileSync(new URL('../src/live-entry-v2.ts', import.meta.url), 'utf8');
const wranglerText = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const wrangler = JSON.parse(wranglerText);
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/0011_ranobelib_telegram_subscriptions.sql', import.meta.url), 'utf8');

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
  assert.match(entry, /NOTIFICATION_QUEUE\?:\s*QueueProducerLike/);
  assert.match(entry, /Queue wake-up failed|notification queue wake-up failed/i);
  assert.match(migration, /ranobelib_notification_outbox/);
  assert.match(migration, /AFTER INSERT ON ranobelib_releases/);
});

test('Queue consumer drains D1 by release id with a twenty-row cap and may enqueue one continuation', () => {
  assert.match(entry, /async\s+queue\s*\(/);
  assert.match(entry, /batch\.messages\[0\]/);
  assert.match(entry, /kind\s*===\s*['"]drain['"]/);
  assert.match(entry, /drainNotificationOutbox\(env,[\s\S]*?limit:\s*DELIVERY_BATCH_LIMIT[\s\S]*?releaseId/);
  assert.match(entry, /claimed\s*>=\s*DELIVERY_BATCH_LIMIT[\s\S]*?queueNotificationWakeup\(env/);
});

test('Queue absence still leaves the five-minute D1 fallback and existing fetch routing intact', () => {
  assert.match(entry, /NOTIFICATION_QUEUE\?:\s*QueueProducerLike/);
  assert.match(entry, /if\s*\(!send\)\s*return false/);
  assert.match(entry, /controller\.cron\s*===\s*FALLBACK_DELIVERY_CRON[\s\S]*?drainNotificationOutbox/);
  assert.match(entry, /handlePublicationReaderDeliveryWebhook/);
  assert.match(entry, /handlePublicationCommentGateWebhook/);
  assert.match(entry, /return baseWorker\.fetch/);
});

test('README documents notification v3 schedule, Queue wakeups and D1 source-of-truth fallback', () => {
  assert.match(readme, /Telegram Notifications v3/i);
  assert.match(readme, /\* \* \* \* \*/);
  assert.match(readme, /\*\/30 \* \* \* \*/);
  assert.match(readme, /\*\/5 \* \* \* \*/);
  assert.match(readme, /0 \* \* \* \*/);
  assert.match(readme, /NOTIFICATION_QUEUE/);
  assert.match(readme, /domnkrbot-notifications-v3/);
  assert.match(readme, /D1[^\n]*(source of truth|источник истины)/i);
  assert.match(readme, /(Queue[^\n]*(ошиб|недоступ)|ошиб[^\n]*Queue)[^\n]*(не тер|не потер)/i);
  assert.match(readme, /0014_telegram_notifications_v3\.sql/);
});
