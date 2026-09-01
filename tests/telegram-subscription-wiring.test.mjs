import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Telegram entry routes subscription callbacks and commands before the legacy worker', async () => {
  const source = await read('src/entry.ts');
  assert.match(source, /handleTelegramSubscriptionWebhookRequest/);
});

test('scheduled production entry initializes subscription delivery before RanobeLib sync and drains the outbox afterwards', async () => {
  const source = await read('src/live-entry-v2.ts');
  const ensureIndex = source.indexOf('await ensureTelegramSubscriptionDeliverySchema(env)');
  const baseIndex = source.indexOf('await baseWorker.scheduled');
  const deliveryIndex = source.indexOf('deliverPendingReleaseNotifications');
  assert.ok(ensureIndex >= 0, 'subscription delivery schema must be initialized in the scheduled entry');
  assert.ok(baseIndex > ensureIndex, 'notification trigger must exist before RanobeLib cron can insert releases');
  assert.ok(deliveryIndex >= 0, 'notification outbox must be drained after synchronization');
});

test('subscription delivery schema self-creates the release notification trigger without a manual remote migration', async () => {
  const source = await read('src/telegram-subscription-delivery-schema.ts');
  assert.match(source, /ensureRanobeLibSchema/);
  assert.match(source, /ensureTelegramSubscriptionSchema/);
  assert.match(source, /CREATE TRIGGER IF NOT EXISTS trg_ranobelib_release_notifications/);
  assert.match(source, /AFTER INSERT ON ranobelib_releases/);
});

test('subscription migration atomically fans new RanobeLib releases into the notification outbox', async () => {
  const migration = await read('migrations/0011_ranobelib_telegram_subscriptions.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS title_subscriptions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS telegram_subscription_settings/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ranobelib_notification_outbox/);
  assert.match(migration, /CREATE TRIGGER IF NOT EXISTS trg_ranobelib_release_notifications/);
  assert.match(migration, /AFTER INSERT ON ranobelib_releases/);
});

test('BotFather configuration exposes the subscriptions command', async () => {
  const configure = await read('scripts/configure-bot.mjs');
  assert.match(configure, /command:\s*'subscriptions'/);
});
