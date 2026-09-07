import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/telegram-notification-delivery.ts', import.meta.url), 'utf8');

test('delivery imports batched reachability persistence and demand refresh helpers', () => {
  assert.match(source, /from ['"]\.\/notification-demand\.js['"]/);
  assert.match(source, /recordTelegramDeliveryReachability/);
  assert.match(source, /refreshAllNotificationDemand/);
  assert.doesNotMatch(source, /markTelegramUserBlocked|markTelegramUserReachable/);
});

test('blocked recipients are ineligible before Telegram send', () => {
  assert.match(
    source,
    /telegram_delivery_reachability[\s\S]*?(state\s*=\s*['"]blocked['"]|COALESCE\([^)]*state[^)]*['"]active['"]\)\s*!=\s*['"]blocked['"])/i,
  );
});

test('successful sends map to active while 403 maps to blocked in one batch persistence call', () => {
  assert.match(source, /outcome\.kind\s*===\s*['"]sent['"][\s\S]*?state:\s*['"]active['"]/);
  assert.match(source, /outcome\.kind\s*===\s*['"]disabled['"][\s\S]*?state:\s*['"]blocked['"]/);
  const persistenceCalls = source.match(/await recordTelegramDeliveryReachability\(env,\s*reachability\)/g) || [];
  assert.equal(persistenceCalls.length, 1);
});

test('403-triggered reachability changes refresh effective demand at most once per drain', () => {
  const refreshCalls = source.match(/await refreshAllNotificationDemand\(env\)/g) || [];
  assert.equal(refreshCalls.length, 1);
  assert.match(source, /reachabilityChanged[\s\S]*?await refreshAllNotificationDemand\(env\)/);
});
