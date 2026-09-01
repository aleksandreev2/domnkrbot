import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTelegramSubscriptionWebhookRequest } from '../dist-runtime/telegram-subscription-webhook.js';

class Statement {
  constructor(query) { this.query = query.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() { return { meta: { changes: 1 } }; }
  async first() {
    if (this.query.includes('SELECT COUNT(*) AS count FROM ranobelib_titles WHERE is_active = 1')) return { count: 1 };
    if (this.query.includes('SELECT all_titles FROM telegram_subscription_settings')) return null;
    if (this.query.includes('SELECT delivery_mode')) return { delivery_mode: 'instant' };
    if (this.query.includes('COUNT(*) AS count') && this.query.includes('title_subscriptions')) return { count: 0 };
    if (this.query.includes('COUNT(*) AS count') && this.query.includes('title_subscription_exclusions')) return { count: 0 };
    return null;
  }
  async all() {
    if (this.query.includes('FROM ranobelib_titles') && this.query.includes('ORDER BY') && !this.query.includes('snapshot_ready')) {
      return { results: [{ ranobelib_id: 1000, book_ref: '1000--one', title: 'Книга 1' }] };
    }
    if (this.query.includes('FROM title_subscriptions s JOIN ranobelib_titles t')) return { results: [] };
    if (this.query.includes('FROM title_subscription_exclusions e JOIN ranobelib_titles t')) return { results: [] };
    return { results: [] };
  }
}

const env = {
  DB: { prepare: (query) => new Statement(query) },
  TELEGRAM_BOT_TOKEN: 'unit-test-token',
  TELEGRAM_WEBHOOK_SECRET: 'secret',
  BOT_USERNAME: 'domnekromanta_bot',
};

function telegramRequest(text) {
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
        ...(text === null ? {} : { text }),
      },
    }),
  });
}

async function withTelegramCalls(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ method: String(url).split('/').pop(), payload: JSON.parse(String(options.body || '{}')) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

test('plain /start opens the Telegram subscription list without requiring chapter snapshot readiness', async () => {
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(telegramRequest('/start'), env);
    assert.equal(response?.status, 200);
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.ok(send);
    assert.equal(send.payload.chat_id, 42);
    assert.match(send.payload.text, /Уведомления о новых главах/);
    assert.match(send.payload.reply_markup.inline_keyboard[0][0].text, /Книга 1/);
  });
});

test('/subscriptions opens the same Telegram subscription list', async () => {
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(telegramRequest('/subscriptions'), env);
    assert.equal(response?.status, 200);
    assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 1);
  });
});

test('/notifications opens the notification center instead of being silently swallowed', async () => {
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(telegramRequest('/notifications'), env);
    assert.equal(response?.status, 200);
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.ok(send);
    assert.match(send.payload.text, /Режим доставки: ⚡ Сразу/);
    assert.equal(send.payload.reply_markup.inline_keyboard[0][0].callback_data, 'subs:list:0');
  });
});

test('download deep-link /start dl_* is left for the existing reader-delivery handler', async () => {
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(telegramRequest('/start dl_123'), env);
    assert.equal(response, null);
    assert.equal(calls.length, 0);
  });
});

test('legacy explicit commands are left for the existing bot handler', async () => {
  for (const command of ['/site', '/help', '/propose']) {
    await withTelegramCalls(async (calls) => {
      const response = await handleTelegramSubscriptionWebhookRequest(telegramRequest(command), env);
      assert.equal(response, null);
      assert.equal(calls.length, 0);
    });
  }
});

test('ordinary private text is silently consumed instead of triggering the legacy site fallback', async () => {
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(telegramRequest('привет'), env);
    assert.equal(response?.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(calls.length, 0);
  });
});

test('unknown private commands and non-text private messages are silently consumed', async () => {
  for (const text of ['/something_unknown', null]) {
    await withTelegramCalls(async (calls) => {
      const response = await handleTelegramSubscriptionWebhookRequest(telegramRequest(text), env);
      assert.equal(response?.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(calls.length, 0);
    });
  }
});
