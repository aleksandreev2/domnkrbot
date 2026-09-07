import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTelegramTitleProposalWebhookRequest } from '../dist-runtime/telegram-title-proposals.js';

const env = {
  TELEGRAM_BOT_TOKEN: 'unit-test-token',
  TELEGRAM_WEBHOOK_SECRET: 'secret',
};

function telegramRequest(text, secret = 'secret') {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
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

async function withTelegramCalls(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ method: href.split('/').pop(), payload: JSON.parse(String(options.body || '{}')) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

test('plain /start opens the Dom Nekromanta main menu', async () => {
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(telegramRequest('/start'), env);
    assert.equal(response?.status, 200);
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.ok(send);
    assert.equal(send.payload.chat_id, 42);
    assert.match(send.payload.text, /Дом Некроманта/);
    const rows = send.payload.reply_markup.inline_keyboard;
    assert.equal(rows[0][0].callback_data, 'prop:new');
    assert.equal(rows[1][0].callback_data, 'prop:notifications');
    assert.equal(rows[1][1].callback_data, 'prop:mine');
    assert.equal(rows[2][0].url, 'https://bot.example/');
  });
});

test('invalid Telegram webhook secret is not claimed by the proposal handler', async () => {
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(telegramRequest('/start', 'wrong'), env);
    assert.equal(response, null);
    assert.equal(calls.length, 0);
  });
});
