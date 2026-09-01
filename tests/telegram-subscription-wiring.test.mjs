import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Telegram entry routes subscription callbacks and commands before the legacy worker', async () => {
  const source = await read('src/entry.ts');
  assert.match(source, /handleTelegramSubscriptionWebhookRequest/);
});

test('scheduled production entry drains the notification outbox after the base cron', async () => {
  const source = await read('src/live-entry-v2.ts');
  assert.match(source, /deliverPendingReleaseNotifications/);
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
