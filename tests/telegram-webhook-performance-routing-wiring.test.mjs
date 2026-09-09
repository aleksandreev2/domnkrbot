import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const liveV2 = readFileSync(new URL('../src/live-entry-v2.ts', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/entry.ts', import.meta.url), 'utf8');
const liveEntry = readFileSync(new URL('../src/live-entry.ts', import.meta.url), 'utf8');

test('live-entry-v2 classifies Telegram webhooks before unrelated handler chains', () => {
  assert.match(liveV2, /from '\.\/telegram-webhook-routing\.js'/);
  assert.match(liveV2, /handleChannelMembershipWebhook/);
  assert.match(liveV2, /handleTelegramSubscriptionWebhookRequest/);
  assert.match(liveV2, /import appEntry from '\.\/entry\.js'/);

  const telegramBranch = liveV2.indexOf("url.pathname === '/telegram/webhook'");
  const genericAppealChain = liveV2.indexOf('const membershipAppealWebhook =');
  assert.ok(telegramBranch >= 0, 'outer Telegram webhook branch must exist');
  assert.ok(genericAppealChain >= 0, 'compatibility appeal chain should remain for non-fast paths');
  assert.ok(telegramBranch < genericAppealChain, 'Telegram routing must happen before generic handler probing');

  for (const route of [
    'chat-member',
    'download-start',
    'reader-gate',
    'reader-forward',
    'membership-appeal',
    'notifications',
    'proposal',
    'generic-private-text',
    'compat',
  ]) {
    assert.match(liveV2, new RegExp(`['\"]${route}['\"]`), `missing explicit ${route} dispatch`);
  }
});

test('outer Telegram route is fail-closed and logs only route-level timing metadata', () => {
  assert.match(liveV2, /!expected[^\n]*\|\|[^\n]*x-telegram-bot-api-secret-token[^\n]*!== expected/);
  assert.match(liveV2, /Forbidden/);
  assert.match(liveV2, /Telegram webhook handled/);
  assert.match(liveV2, /durationMs/);
  assert.doesNotMatch(liveV2, /Telegram webhook handled[^\n]*(?:text|callbackData|token|secret)/i);
});

test('interactive entry accepts execution context and live-entry forwards it', () => {
  assert.match(entry, /waitUntil\(promise: Promise<unknown>\): void/);
  assert.match(entry, /async fetch\(request: Request, env: Env, ctx\?/);
  assert.match(liveEntry, /appEntry\.fetch\(request, env, ctx\)/);
});
