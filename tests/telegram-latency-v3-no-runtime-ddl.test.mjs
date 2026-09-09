import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  return source.slice(start, end === -1 ? source.length : end);
}

test('proposal webhook interactions never run runtime schema repair before Telegram output', async () => {
  const source = await read('src/telegram-title-proposals-v2.ts');
  const interactive = section(source, 'export async function handleTelegramTitleProposalV2WebhookRequest', 'async function ensureUxSchema');
  assert.doesNotMatch(interactive, /await ensureUxSchema\(env\)/);
  assert.match(source, /async function ensureUxSchema/, 'explicit repair helper may remain available outside the hot path');
});

test('legacy subscription navigation and mutation handlers do not run subscription DDL', async () => {
  const source = await read('src/telegram-subscriptions.ts');
  const updateHandler = section(source, 'export async function handleTelegramSubscriptionUpdate', 'export async function sendTelegramSubscriptionMenu');
  const menuHandler = section(source, 'export async function sendTelegramSubscriptionMenu', 'export async function sendTelegramNotificationCenter');
  const centerHandler = section(source, 'export async function sendTelegramNotificationCenter', 'export async function');
  for (const body of [updateHandler, menuHandler, centerHandler]) {
    assert.doesNotMatch(body, /await ensureTelegramSubscriptionSchema\(env\)/);
  }
  assert.match(source, /export async function ensureTelegramSubscriptionSchema/, 'repair helper remains for explicit maintenance/tests');
});

test('notification UX callbacks and dashboard command never run aggregate schema repair', async () => {
  const source = await read('src/telegram-notification-ux-runtime.ts');
  const callbackHandler = section(source, 'export async function handleTelegramNotificationUxUpdate', 'export async function handleNotificationSearchInput');
  const dashboardHandler = section(source, 'export async function sendTelegramNotificationDashboard', 'async function dashboardPayload');
  assert.doesNotMatch(callbackHandler, /await ensureNotificationUxSchema\(env\)/);
  assert.doesNotMatch(dashboardHandler, /await ensureNotificationUxSchema\(env\)/);
  assert.match(source, /async function ensureNotificationUxSchema/, 'repair helper may remain outside interactive handlers');
});

test('production migrations own the schemas that interactive handlers now assume exist', async () => {
  const migrations = await Promise.all([
    'migrations/0011_ranobelib_telegram_subscriptions.sql',
    'migrations/0012_telegram_notifications_v2.sql',
    'migrations/0013_telegram_title_proposals.sql',
    'migrations/0016_telegram_notification_delivery_modes.sql',
    'migrations/0017_telegram_text_bot_ux_v2.sql',
  ].map(read));
  const sql = migrations.join('\n');
  for (const required of [
    'telegram_subscription_settings',
    'title_subscriptions',
    'title_subscription_exclusions',
    'telegram_proposal_sessions',
    'telegram_title_delivery_settings',
    'telegram_notification_input_state',
    'telegram_notification_search_state',
    'return_to_review',
    'input_active',
  ]) {
    assert.match(sql, new RegExp(required));
  }
});
