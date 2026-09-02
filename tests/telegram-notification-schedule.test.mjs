import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const entry = fs.readFileSync(new URL('../src/live-entry-v2.ts', import.meta.url), 'utf8');

test('Telegram notification delivery has its own per-minute cron invocation', () => {
  assert.match(wrangler, /"crons"\s*:\s*\[[^\]]*"\*\/10 \* \* \* \*"[^\]]*"\* \* \* \* \*"[^\]]*\]/s);
  assert.match(entry, /const\s+NOTIFICATION_DELIVERY_CRON\s*=\s*['"]\* \* \* \* \*['"]/);
  assert.match(entry, /if\s*\(controller\.cron\s*===\s*NOTIFICATION_DELIVERY_CRON\)[\s\S]*?deliverPendingReleaseNotifications\(env,\s*40\)[\s\S]*?return;/);
});

test('the normal ten-minute cron does not deliver Telegram notifications in the same invocation', () => {
  const branchEnd = entry.indexOf('return;', entry.indexOf('controller.cron === NOTIFICATION_DELIVERY_CRON'));
  const remainingScheduled = branchEnd >= 0 ? entry.slice(branchEnd + 'return;'.length) : entry;
  assert.doesNotMatch(remainingScheduled, /deliverPendingReleaseNotifications\(env,\s*40\)/);
  assert.match(remainingScheduled, /baseWorker\.scheduled/);
});
