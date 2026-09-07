import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/telegram-subscriptions.ts', import.meta.url), 'utf8');

test('subscription runtime imports only demand refresh helpers; reachability is owned by the top-level webhook entry', () => {
  assert.match(source, /from ['"]\.\/notification-demand\.js['"]/);
  assert.doesNotMatch(source, /markTelegramUserReachable/);
  assert.match(source, /refreshTitleNotificationDemand/);
  assert.match(source, /refreshAllNotificationDemand/);
});

test('ordinary subscription navigation does not recalculate all-title demand', () => {
  const callbackStart = source.indexOf('export async function handleTelegramSubscriptionUpdate');
  const callbackEnd = source.indexOf('export async function sendTelegramSubscriptionMenu', callbackStart);
  const callbackBody = source.slice(callbackStart, callbackEnd > callbackStart ? callbackEnd : undefined);
  const firstMutation = callbackBody.indexOf('if (parsed.kind === \'notify-settings\'');
  const navigationPrelude = callbackBody.slice(0, firstMutation > 0 ? firstMutation : undefined);
  assert.doesNotMatch(navigationPrelude, /refreshAllNotificationDemand\(env\)/, 'opening center/list/no-op paths must not full-refresh demand');

  const menuStart = source.indexOf('export async function sendTelegramSubscriptionMenu');
  const centerStart = source.indexOf('export async function sendTelegramNotificationCenter', menuStart);
  const effectiveStart = source.indexOf('export async function isEffectivelySubscribed', centerStart);
  assert.doesNotMatch(source.slice(menuStart, centerStart), /refreshAllNotificationDemand\(env\)/);
  assert.doesNotMatch(source.slice(centerStart, effectiveStart), /refreshAllNotificationDemand\(env\)/);
});

test('single-title subscription mutations refresh only that title demand', () => {
  const refreshCalls = source.match(/await refreshTitleNotificationDemand\(env, title\.book_ref\)/g) || [];
  assert.ok(refreshCalls.length >= 2, 'both direct notify toggle and title-list toggle must refresh title demand');

  assert.match(
    source,
    /await setEffectiveTitleSubscription\(env, userId, title\.book_ref, enabled\);[\s\S]{0,180}await refreshTitleNotificationDemand\(env, title\.book_ref\)/,
    'direct notification toggle must immediately refresh that title demand',
  );
  assert.match(
    source,
    /await setEffectiveTitleSubscription\(env, userId, title\.book_ref, !before\);[\s\S]{0,180}await refreshTitleNotificationDemand\(env, title\.book_ref\)/,
    'title-list toggle must immediately refresh that title demand',
  );
});

test('all-title on and clear mutations refresh demand across active titles once per branch', () => {
  const onBranch = source.match(/parsed\.mode === 'on'[\s\S]*?await setAllTitles\(env, userId, true\);[\s\S]*?await refreshAllNotificationDemand\(env\)/);
  assert.ok(onBranch, 'all-title enable should refresh all demand counts');

  const clearBranch = source.match(/await setAllTitles\(env, userId, false\);[\s\S]*?DELETE FROM title_subscriptions[\s\S]*?DELETE FROM title_subscription_exclusions[\s\S]*?await refreshAllNotificationDemand\(env\)/);
  assert.ok(clearBranch, 'all-title clear should refresh all demand counts after subscription cleanup');
});
