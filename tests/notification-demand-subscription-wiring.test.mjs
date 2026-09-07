import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/telegram-subscriptions.ts', import.meta.url), 'utf8');

test('subscription runtime imports demand refresh and reachability helpers', () => {
  assert.match(source, /from ['"]\.\/notification-demand\.js['"]/);
  assert.match(source, /markTelegramUserReachable/);
  assert.match(source, /refreshTitleNotificationDemand/);
  assert.match(source, /refreshAllNotificationDemand/);
});

test('private subscription interactions reactivate a previously blocked Telegram user', () => {
  const callbackStart = source.indexOf('export async function handleTelegramSubscriptionUpdate');
  const callbackEnd = source.indexOf('export async function sendTelegramSubscriptionMenu', callbackStart);
  const callbackBody = source.slice(callbackStart, callbackEnd > callbackStart ? callbackEnd : undefined);
  assert.match(callbackBody, /const userId = String\(callback\.from\.id\);[\s\S]{0,300}await markTelegramUserReachable\(env, userId\)/);

  const reachableCalls = (source.match(/await markTelegramUserReachable\(env, /g) || []).length;
  assert.ok(reachableCalls >= 3, 'callback, subscriptions menu, and notification center should all reactivate reachability');
});

test('single-title subscription mutations refresh only that title demand', () => {
  const refreshCalls = source.match(/await refreshTitleNotificationDemand\(env, title\.book_ref\)/g) || [];
  assert.ok(refreshCalls.length >= 2, 'both direct notify toggle and title-list toggle must refresh title demand');

  const directToggle = source.match(/await setEffectiveTitleSubscription\(env, userId, title\.book_ref, enabled\);[\s\S]{0,180}await refreshTitleNotificationDemand\(env, title\.book_ref\)/g) || [];
  assert.ok(directToggle.length >= 2, 'every title-scoped mutation must immediately refresh demand');
});

test('all-title on and clear mutations refresh demand across active titles once per branch', () => {
  const onBranch = source.match(/parsed\.mode === 'on'[\s\S]*?await setAllTitles\(env, userId, true\);[\s\S]*?await refreshAllNotificationDemand\(env\)/);
  assert.ok(onBranch, 'all-title enable should refresh all demand counts');

  const clearBranch = source.match(/await setAllTitles\(env, userId, false\);[\s\S]*?DELETE FROM title_subscriptions[\s\S]*?DELETE FROM title_subscription_exclusions[\s\S]*?await refreshAllNotificationDemand\(env\)/);
  assert.ok(clearBranch, 'all-title clear should refresh all demand counts after subscription cleanup');
});
