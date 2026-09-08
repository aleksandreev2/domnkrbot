import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTelegramSubscriptionWebhookRequest } from '../dist-runtime/telegram-subscription-webhook.js';

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (/SELECT all_titles FROM telegram_subscription_settings/i.test(this.query)) return { all_titles: 0 };
    if (/SELECT delivery_mode, stack_size FROM telegram_subscription_settings/i.test(this.query)) {
      return { delivery_mode: this.db.global.mode, stack_size: this.db.global.stackSize };
    }
    if (/COUNT\(\*\) AS count FROM title_subscriptions/i.test(this.query)) return { count: 2 };
    if (/COUNT\(\*\) AS count FROM title_subscription_exclusions/i.test(this.query)) return { count: 0 };
    if (/COUNT\(\*\) AS count FROM telegram_title_delivery_settings/i.test(this.query)) return { count: this.db.override ? 1 : 0 };
    if (/FROM ranobelib_titles WHERE ranobelib_id = \?/i.test(this.query)) return { ...this.db.title };
    if (/FROM telegram_title_delivery_settings/i.test(this.query)) {
      if (!this.db.override) return null;
      return { delivery_mode: this.db.override.mode, stack_size: this.db.override.stackSize };
    }
    if (/FROM telegram_notification_input_state/i.test(this.query)) {
      return this.db.customInput ? { scope: this.db.customInput.scope, book_ref: this.db.customInput.bookRef } : null;
    }
    if (/SELECT 1 AS subscribed FROM title_subscriptions/i.test(this.query)) return { subscribed: 1 };
    if (/SELECT 1 AS excluded FROM title_subscription_exclusions/i.test(this.query)) return null;
    return null;
  }
  async all() { return { results: [] }; }
  async run() {
    if (this.db.rejectUnknownUserColumns && /INSERT INTO users/i.test(this.query) && /last_seen_at/i.test(this.query)) {
      throw new Error('table users has no column named last_seen_at');
    }
    if (this.db.rejectNullUserLastName && /INSERT INTO users/i.test(this.query) && this.values[3] == null) {
      throw new Error('NOT NULL constraint failed: users.last_name');
    }
    if (/INSERT INTO telegram_subscription_settings/i.test(this.query) && /delivery_mode/i.test(this.query)) {
      const mode = String(this.values.at(-2));
      const stackSize = this.values.at(-1) == null ? null : Number(this.values.at(-1));
      this.db.global = { mode, stackSize };
    }
    if (/INSERT INTO telegram_title_delivery_settings/i.test(this.query)) {
      const mode = String(this.values.at(-2));
      const stackSize = this.values.at(-1) == null ? null : Number(this.values.at(-1));
      this.db.override = { mode, stackSize };
    }
    if (/DELETE FROM telegram_title_delivery_settings/i.test(this.query)) this.db.override = null;
    if (/INSERT INTO telegram_notification_input_state/i.test(this.query)) {
      this.db.customInput = { scope: String(this.values[1]), bookRef: this.values[2] == null ? null : String(this.values[2]) };
    }
    if (/DELETE FROM telegram_notification_input_state/i.test(this.query) && !/expires_at <=/i.test(this.query)) this.db.customInput = null;
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor() {
    this.global = { mode: 'instant', stackSize: null };
    this.override = null;
    this.customInput = null;
    this.rejectUnknownUserColumns = false;
    this.rejectNullUserLastName = false;
    this.title = {
      ranobelib_id: 1000,
      book_ref: '1000--one',
      title: 'Книга 1',
      url: 'https://ranobelib.me/ru/book/1000--one',
    };
  }
  prepare(query) { return new Statement(this, query); }
}

function env(db, extra = {}) {
  return {
    DB: db,
    TELEGRAM_BOT_TOKEN: 'unit-test-token',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    BOT_USERNAME: 'domnekromanta_bot',
    ...extra,
  };
}

function queueRecorder({ fail = false } = {}) {
  const messages = [];
  return {
    messages,
    queue: {
      async send(message) {
        messages.push(message);
        if (fail) throw new Error('queue unavailable');
      },
    },
  };
}

function messageRequest(text) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
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

function callbackRequest(data) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({
      update_id: 2,
      callback_query: {
        id: 'cb-1',
        from: { id: 42, first_name: 'Reader' },
        data,
        message: { message_id: 9, chat: { id: 42, type: 'private' } },
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

test('/notifications uses the interactive delivery-mode center', async () => {
  const db = new DB();
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(messageRequest('/notifications'), env(db));
    assert.equal(response?.status, 200);
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.ok(send);
    assert.match(send.payload.text, /Режим по умолчанию: ⚡ Мгновенно/);
    const callbacks = send.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
    assert.ok(callbacks.includes('subs:mode:g:10'));
    assert.ok(callbacks.includes('subs:mode:g:c'));
  });
});

test('start notifications callback uses only columns that exist in the users table', async () => {
  const db = new DB();
  db.rejectUnknownUserColumns = true;
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(callbackRequest('prop:notifications'), env(db));
    assert.equal(response?.status, 200);
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.ok(edit);
    assert.match(edit.payload.text, /Режим по умолчанию: ⚡ Мгновенно/);
    assert.ok(calls.some((call) => call.method === 'answerCallbackQuery'));
  });
});

test('start notifications callback supports Telegram users without a last name', async () => {
  const db = new DB();
  db.rejectNullUserLastName = true;
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(callbackRequest('prop:notifications'), env(db));
    assert.equal(response?.status, 200);
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.ok(edit);
    assert.match(edit.payload.text, /Режим по умолчанию: ⚡ Мгновенно/);
    assert.ok(calls.some((call) => call.method === 'answerCallbackQuery'));
  });
});

test('global preset callback persists the mode, redraws the center and wakes delivery', async () => {
  const db = new DB();
  const recorder = queueRecorder();
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(
      callbackRequest('subs:mode:g:10'),
      env(db, { NOTIFICATION_QUEUE: recorder.queue }),
    );
    assert.equal(response?.status, 200);
    assert.deepEqual(db.global, { mode: 'stack', stackSize: 10 });
    assert.deepEqual(recorder.messages, [{ kind: 'drain' }]);
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.ok(edit);
    assert.match(edit.payload.text, /Режим по умолчанию: 📦 По 10/);
    assert.ok(calls.some((call) => call.method === 'answerCallbackQuery'));
  });
});

test('per-title preset and inherit both wake delivery after persisting the change', async () => {
  const db = new DB();
  const recorder = queueRecorder();
  await withTelegramCalls(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(
      callbackRequest('subs:mode:t:1000:5'),
      env(db, { NOTIFICATION_QUEUE: recorder.queue }),
    );
    assert.deepEqual(db.override, { mode: 'stack', stackSize: 5 });
    assert.deepEqual(recorder.messages, [{ kind: 'drain' }]);
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.ok(edit);
    assert.match(edit.payload.text, /Режим: 📦 По 5/);
  });

  await withTelegramCalls(async () => {
    await handleTelegramSubscriptionWebhookRequest(
      callbackRequest('subs:mode:t:1000:inherit'),
      env(db, { NOTIFICATION_QUEUE: recorder.queue }),
    );
    assert.equal(db.override, null);
    assert.deepEqual(recorder.messages, [{ kind: 'drain' }, { kind: 'drain' }]);
  });
});

test('custom global stack input wakes only after a valid value is saved', async () => {
  const db = new DB();
  const recorder = queueRecorder();
  await withTelegramCalls(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(
      callbackRequest('subs:mode:g:c'),
      env(db, { NOTIFICATION_QUEUE: recorder.queue }),
    );
    assert.deepEqual(db.customInput, { scope: 'global', bookRef: null });
    assert.deepEqual(recorder.messages, []);
    const prompt = calls.find((call) => call.method === 'sendMessage');
    assert.ok(prompt);
    assert.match(prompt.payload.text, /от 2 до 100/);
  });

  await withTelegramCalls(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(
      messageRequest('37'),
      env(db, { NOTIFICATION_QUEUE: recorder.queue }),
    );
    assert.deepEqual(db.global, { mode: 'stack', stackSize: 37 });
    assert.equal(db.customInput, null);
    assert.deepEqual(recorder.messages, [{ kind: 'drain' }]);
    const confirmation = calls.find((call) => call.method === 'sendMessage');
    assert.ok(confirmation);
    assert.match(confirmation.payload.text, /37 глав/);
    assert.match(confirmation.payload.text, /7 дней/);
  });
});

test('queue wake failure is best-effort and does not roll back a saved mode', async () => {
  const db = new DB();
  const recorder = queueRecorder({ fail: true });
  await withTelegramCalls(async () => {
    const response = await handleTelegramSubscriptionWebhookRequest(
      callbackRequest('subs:mode:g:20'),
      env(db, { NOTIFICATION_QUEUE: recorder.queue }),
    );
    assert.equal(response?.status, 200);
    assert.deepEqual(db.global, { mode: 'stack', stackSize: 20 });
    assert.deepEqual(recorder.messages, [{ kind: 'drain' }]);
  });
});

test('invalid custom stack value keeps the input state active and does not wake delivery', async () => {
  const db = new DB();
  const recorder = queueRecorder();
  db.customInput = { scope: 'global', bookRef: null };
  await withTelegramCalls(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(
      messageRequest('101'),
      env(db, { NOTIFICATION_QUEUE: recorder.queue }),
    );
    assert.deepEqual(db.global, { mode: 'instant', stackSize: null });
    assert.deepEqual(db.customInput, { scope: 'global', bookRef: null });
    assert.deepEqual(recorder.messages, []);
    const error = calls.find((call) => call.method === 'sendMessage');
    assert.ok(error);
    assert.match(error.payload.text, /2 до 100/);
  });
});
