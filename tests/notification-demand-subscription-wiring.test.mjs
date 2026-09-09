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

test('private subscription interactions reactivate a previously blocked Telegram user without blocking navigation', () => {
  const callbackStart = source.indexOf('export async function handleTelegramSubscriptionUpdate');
  const callbackEnd = source.indexOf('export async function sendTelegramSubscriptionMenu', callbackStart);
  const callbackBody = source.slice(callbackStart, callbackEnd > callbackStart ? callbackEnd : undefined);

  assert.match(
    callbackBody,
    /if \(navigation\) \{[\s\S]{0,160}deferNavigationBookkeeping\(env, callback\.from, ctx\)[\s\S]{0,160}\} else \{[\s\S]{0,160}await upsertTelegramUser\(env, callback\.from\);[\s\S]{0,160}await markTelegramUserReachable\(env, userId\);/,
    'navigation should defer reachability bookkeeping while mutation routes keep it authoritative',
  );

  const helperStart = source.indexOf('async function deferNavigationBookkeeping');
  const helperEnd = source.indexOf('async function upsertTelegramUser', helperStart);
  const helperBody = source.slice(helperStart, helperEnd > helperStart ? helperEnd : undefined);
  assert.match(helperBody, /markTelegramUserReachable\(env, userId\)/, 'deferred navigation bookkeeping must still reactivate reachability');
  assert.match(helperBody, /ctx\.waitUntil\(pending\)/, 'navigation bookkeeping should leave the user-visible critical path when an execution context exists');

  const menuStart = source.indexOf('export async function sendTelegramSubscriptionMenu');
  const centerStart = source.indexOf('export async function sendTelegramNotificationCenter', menuStart);
  const centerEnd = source.indexOf('export async function isEffectivelySubscribed', centerStart);
  assert.match(source.slice(menuStart, centerStart), /deferNavigationBookkeeping\(env, user, ctx\)/);
  assert.match(source.slice(centerStart, centerEnd), /deferNavigationBookkeeping\(env, user, ctx\)/);
});

test('single-title subscription mutations persist first and defer only that title demand refresh', () => {
  const deferredRefreshCalls = source.match(/\(\) => refreshTitleNotificationDemand\(env, title\.book_ref\)/g) || [];
  assert.ok(deferredRefreshCalls.length >= 2, 'both direct notify toggle and title-list toggle must schedule targeted title demand refresh');

  assert.match(
    source,
    /await setEffectiveTitleSubscription\(env, userId, title\.book_ref, enabled\);[\s\S]{0,360}await deferDemandMaintenance\([\s\S]{0,120}\(\) => refreshTitleNotificationDemand\(env, title\.book_ref\)/,
    'direct notification toggle must persist before scheduling targeted demand refresh',
  );
  assert.match(
    source,
    /await setEffectiveTitleSubscription\(env, userId, title\.book_ref, !before\);[\s\S]{0,360}await deferDemandMaintenance\([\s\S]{0,120}\(\) => refreshTitleNotificationDemand\(env, title\.book_ref\)/,
    'title-list toggle must persist before scheduling targeted demand refresh',
  );
});

test('all-title on and clear mutations persist first and defer global demand refresh once per branch', () => {
  const onBranch = source.match(/parsed\.mode === 'on'[\s\S]*?await setAllTitles\(env, userId, true\);[\s\S]*?await deferDemandMaintenance\([\s\S]*?\(\) => refreshAllNotificationDemand\(env\)/);
  assert.ok(onBranch, 'all-title enable should persist first and schedule a global demand refresh');

  const clearBranch = source.match(/await setAllTitles\(env, userId, false\);[\s\S]*?DELETE FROM title_subscriptions[\s\S]*?DELETE FROM title_subscription_exclusions[\s\S]*?await deferDemandMaintenance\([\s\S]*?\(\) => refreshAllNotificationDemand\(env\)/);
  assert.ok(clearBranch, 'all-title clear should persist cleanup before scheduling a global demand refresh');
});
