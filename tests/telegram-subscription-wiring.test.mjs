import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Telegram entry routes title proposals before subscriptions and the legacy worker', async () => {
  const source = await read('src/entry.ts');
  const proposalIndex = source.indexOf('handleTelegramTitleProposalWebhookRequest');
  const subscriptionIndex = source.indexOf('handleTelegramSubscriptionWebhookRequest');
  const legacyIndex = source.indexOf('baseWorker.fetch');
  assert.ok(proposalIndex >= 0, 'Telegram title proposal handler must be wired into entry.ts');
  assert.ok(subscriptionIndex > proposalIndex, 'proposal handler must run before subscription handler');
  assert.ok(legacyIndex > subscriptionIndex, 'legacy worker must remain the final fallback');
});

test('Telegram subscription commands bootstrap the RanobeLib catalog before rendering', async () => {
  const webhook = await read('src/telegram-subscription-webhook.ts');
  const catalog = await read('src/telegram-subscription-catalog.ts');
  assert.match(webhook, /ensureTelegramSubscriptionCatalog/);
  assert.match(webhook, /withTelegramSubscriptionCatalogDb/);
  assert.match(catalog, /discoverRanobeLibTeam/);
  assert.match(catalog, /ranobelib-discovery-scheduler/);
  assert.match(catalog, /replace\(\/\\s\+AND snapshot_ready = 1\/g/);
});

test('scheduled production entry routes notification v3 jobs directly without the legacy combined cron', async () => {
  const source = await read('src/live-entry-v2.ts');
  const scheduled = source.slice(source.indexOf('async scheduled('));
  assert.match(scheduled, /scanDueRanobeLibTitles/);
  assert.match(scheduled, /discoverRanobeLibTeam/);
  assert.match(scheduled, /drainNotificationOutbox/);
  assert.match(scheduled, /runChannelMembershipMaintenance/);
  assert.doesNotMatch(scheduled, /baseWorker\.scheduled/);
  assert.doesNotMatch(scheduled, /deliverPendingReleaseNotifications/);
});

test('subscription delivery runtime leaves the release fanout trigger to migrations', async () => {
  const source = await read('src/telegram-subscription-delivery-schema.ts');
  const migration = await read('migrations/0012_telegram_notifications_v2.sql');
  assert.match(source, /ensureRanobeLibSchema/);
  assert.match(source, /ensureTelegramSubscriptionSchema/);
  assert.doesNotMatch(source, /DROP TRIGGER|CREATE TRIGGER/i);
  assert.match(migration, /CREATE TRIGGER trg_ranobelib_release_notifications/);
  assert.match(migration, /AFTER INSERT ON ranobelib_releases/);
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
