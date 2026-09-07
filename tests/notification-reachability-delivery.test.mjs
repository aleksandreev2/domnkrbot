import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/telegram-notification-delivery.ts', import.meta.url), 'utf8');

test('delivery imports reachability persistence and demand refresh helpers', () => {
  assert.match(source, /from ['"]\.\/notification-demand\.js['"]/);
  assert.match(source, /markTelegramUserBlocked/);
  assert.match(source, /markTelegramUserReachable/);
  assert.match(source, /refreshAllNotificationDemand/);
});

test('blocked recipients are ineligible before Telegram send', () => {
  assert.match(
    source,
    /telegram_delivery_reachability[\s\S]*?(state\s*=\s*['"]blocked['"]|COALESCE\([^)]*state[^)]*['"]active['"]\)\s*!=\s*['"]blocked['"])/i,
  );
});

test('successful sends mark reachability active while 403 marks blocked', () => {
  assert.match(source, /outcome\.kind\s*===\s*['"]sent['"][\s\S]*?markTelegramUserReachable\(env,\s*outcome\.row\.user_telegram_id\)/);
  assert.match(source, /outcome\.kind\s*===\s*['"]disabled['"][\s\S]*?markTelegramUserBlocked\(env,\s*outcome\.row\.user_telegram_id\)/);
});

test('403-triggered reachability changes refresh effective demand at most once per drain', () => {
  const refreshCalls = source.match(/await refreshAllNotificationDemand\(env\)/g) || [];
  assert.equal(refreshCalls.length, 1);
  assert.match(source, /reachabilityChanged[\s\S]*?await refreshAllNotificationDemand\(env\)/);
});
