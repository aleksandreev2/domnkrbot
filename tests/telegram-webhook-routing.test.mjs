import assert from 'node:assert/strict';
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
