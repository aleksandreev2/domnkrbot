import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { classifyTelegramWebhookUpdate } from '../dist-runtime/telegram-webhook-routing.js';

const privateMessage = (text, extra = {}) => ({
  message: {
    chat: { id: 42, type: 'private' },
    from: { id: 42, first_name: 'Reader' },
    text,
    ...extra,
  },
});
const callback = (data) => ({
  callback_query: {
    id: 'cb-1',
    from: { id: 42, first_name: 'Reader' },
    data,
    message: { message_id: 1, chat: { id: 42, type: 'private' } },
  },
});

test('classifies explicit Telegram update families without DB or network state', () => {
  const cases = [
    [{ chat_member: { chat: { id: -1001 }, old_chat_member: {}, new_chat_member: {} } }, 'chat-member'],
    [privateMessage('/start dl_123'), 'download-start'],
    [privateMessage('/start@domnekromanta_bot dl_987'), 'download-start'],
    [callback('gate-thanks:12'), 'reader-gate'],
    [callback('gate-download:12'), 'reader-gate'],
    [privateMessage('', { is_automatic_forward: true }), 'reader-forward'],
    [callback('membership:appeal'), 'membership-appeal'],
    [callback('membership:appeal:cancel'), 'membership-appeal'],
    [callback('membership:appeal:approve:ap-abc123'), 'membership-appeal'],
    [callback('subs:center'), 'notifications'],
    [callback('subs:title:123:a:0'), 'notifications'],
    [callback('prop:notifications'), 'notifications'],
    [privateMessage('/notifications'), 'notifications'],
    [privateMessage('/subscriptions@domnekromanta_bot'), 'notifications'],
    [privateMessage('/stats'), 'admin-stats'],
    [privateMessage('/stats@domnekromanta_bot'), 'admin-stats'],
    [callback('stats:users'), 'admin-stats'],
    [callback('prop:new'), 'proposal'],
    [callback('prop:view:abc'), 'proposal'],
    [privateMessage('/start'), 'proposal'],
    [privateMessage('/start@domnekromanta_bot'), 'proposal'],
    [privateMessage('/propose'), 'proposal'],
    [privateMessage('обычный текст'), 'generic-private-text'],
    [privateMessage('/help'), 'compat'],
    [privateMessage('/site'), 'compat'],
    [callback('unknown:callback'), 'compat'],
    [{ message: { chat: { id: -100, type: 'group' }, text: 'hello' } }, 'compat'],
  ];

  for (const [update, expected] of cases) {
    const snapshot = structuredClone(update);
    assert.equal(classifyTelegramWebhookUpdate(update), expected, JSON.stringify(update));
    assert.deepEqual(update, snapshot, 'classifier must not mutate Telegram update');
  }
});

test('plain slash commands never enter generic private-text state consumers', () => {
  for (const text of ['/help', '/site', '/unknown']) {
    assert.notEqual(classifyTelegramWebhookUpdate(privateMessage(text)), 'generic-private-text');
  }
});

test('production entry validates once and directly dispatches classified Telegram webhook routes', async () => {
  const source = await readFile(new URL('../src/live-entry-v2.ts', import.meta.url), 'utf8');
  const outerWebhook = source.indexOf("url.pathname === '/telegram/webhook'");
  assert.ok(outerWebhook >= 0, 'live entry must own the Telegram webhook boundary');
  assert.match(source, /classifyTelegramWebhookUpdate/);
  assert.match(source, /x-telegram-bot-api-secret-token/);
  assert.match(source, /dispatchTelegramWebhook/);
  assert.match(source, /case 'chat-member'[\s\S]*handleChannelMembershipWebhook/);
  assert.match(source, /case 'download-start'[\s\S]*handleChannelMembershipAppealWebhook[\s\S]*handlePublicationReaderDeliveryWebhook/);
  assert.match(source, /case 'reader-gate'[\s\S]*handlePublicationReaderDeliveryWebhook/);
  assert.match(source, /case 'membership-appeal'[\s\S]*handleChannelMembershipAppealWebhook/);
  assert.match(source, /case 'notifications'[\s\S]*handleTelegramSubscriptionWebhookRequest/);
  assert.match(source, /case 'admin-stats'[\s\S]*handleTelegramAdminStatsWebhook/);
  assert.match(source, /case 'proposal'[\s\S]*withTrustedTelegramMigrations\(env\)[\s\S]*appEntry\.fetch\(request, trustedEnv[^\n]*ctx/);
  assert.match(source, /case 'generic-private-text'[\s\S]*handleChannelMembershipAppealWebhook[\s\S]*withTrustedTelegramMigrations\(env\)[\s\S]*appEntry\.fetch\(request, trustedEnv[^\n]*ctx/);
  assert.match(source, /Telegram webhook latency v2/);
  assert.doesNotMatch(source, /Telegram webhook handled/);

  const genericAppeal = source.indexOf('await handleChannelMembershipAppealWebhook(request', outerWebhook);
  assert.ok(genericAppeal > outerWebhook, 'generic appeal fallback must come after the outer Telegram dispatcher');
});

test('interactive Telegram execution context is preserved through the compatibility worker', async () => {
  const [entry, liveEntry] = await Promise.all([
    readFile(new URL('../src/entry.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/live-entry.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(entry, /async fetch\(request: Request, env: Env, ctx\??:/);
  assert.match(liveEntry, /return appEntry\.fetch\(request, env, ctx\);/);
});
