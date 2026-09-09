import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTelegramNotificationTextInputRequest } from '../dist-runtime/telegram-subscription-webhook.js';

function requestFor(text) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'secret',
    },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 5,
        chat: { id: 42, type: 'private' },
        from: { id: 42, first_name: 'Reader' },
        text,
      },
    }),
  });
}

function noDbEnv() {
  return {
    DB: {
      prepare(query) {
        throw new Error(`D1 must not be touched by slash pre-handler: ${String(query).replace(/\s+/g, ' ').trim()}`);
      },
    },
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    TELEGRAM_BOT_TOKEN: 'token',
    BOT_USERNAME: 'domnekromanta_bot',
  };
}

for (const command of ['/start', '/propose', '/help']) {
  test(`${command} bypasses notification text-input prework without D1`, async () => {
    const response = await handleTelegramNotificationTextInputRequest(requestFor(command), noDbEnv());
    assert.equal(response, null);
  });
}
