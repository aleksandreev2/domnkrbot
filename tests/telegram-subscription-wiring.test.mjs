import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Telegram webhook routes subscription callbacks and commands to the subscription runtime', async () => {
  const source = await read('src/worker.ts');
  assert.match(source, /handleTelegramSubscriptionUpdate/);
  assert.match(source, /sendTelegramSubscriptionMenu/);
  assert.match(source, /callback_query/);
  assert.match(source, /\/subscriptions/);
});

test('RanobeLib release sync is team-scoped and enqueues notifications', async () => {
  const source = await read('src/ranobelib-runtime.ts');
  assert.match(source, /enqueueReleaseNotifications/);
  assert.match(source, /getChapters\(book\.ref,\s*\{\s*teamRef:/s);
});

test('scheduled worker drains the notification outbox after RanobeLib sync', async () => {
  const source = await read('src/live-entry.ts');
  assert.match(source, /deliverPendingReleaseNotifications/);
});

test('subscription D1 migration and BotFather command are present', async () => {
  const [migration, configure] = await Promise.all([
    read('migrations/0011_ranobelib_telegram_subscriptions.sql'),
    read('scripts/configure-bot.mjs'),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS title_subscriptions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS telegram_subscription_settings/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ranobelib_notification_outbox/);
  assert.match(configure, /command:\s*'subscriptions'/);
});
