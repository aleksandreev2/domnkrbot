import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTelegramSubscriptionWebhookRequest } from '../dist-runtime/telegram-subscription-webhook.js';

const normalize = (value) => value.replace(/\s+/g, ' ').trim();

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = normalize(query);
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async run() {
    this.db.queries.push({ kind: 'run', query: this.query, values: this.values });
    if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/.test(this.query)) return { meta: { changes: 0 } };
    if (this.query.startsWith('INSERT INTO users')) return { meta: { changes: 1 } };
    if (this.query.includes('INSERT INTO telegram_notification_search_state')) {
      this.db.searchState = {
        query: String(this.values[1] ?? ''),
        page: Number(this.values[2] ?? 0),
        returnScope: String(this.values[3] ?? 'home'),
        active: true,
      };
      return { meta: { changes: 1 } };
    }
    if (this.query.includes('UPDATE telegram_notification_search_state') && this.query.includes('SET query')) {
      if (this.db.searchState) {
        this.db.searchState.query = String(this.values[0] ?? '');
        this.db.searchState.page = Number(this.values[1] ?? 0);
      }
      return { meta: { changes: 1 } };
    }
    if (this.query.includes('UPDATE telegram_notification_search_state') && this.query.includes('SET page')) {
      if (this.db.searchState) this.db.searchState.page = Number(this.values[0] ?? 0);
      return { meta: { changes: 1 } };
    }
    if (this.query.includes('DELETE FROM telegram_notification_search_state')) {
      this.db.searchState = null;
      return { meta: { changes: 1 } };
    }
    if (this.query.includes('INSERT INTO telegram_subscription_settings') && this.query.includes('delivery_mode')) {
      this.db.global = {
        mode: String(this.values.at(-2)),
        stackSize: this.values.at(-1) == null ? null : Number(this.values.at(-1)),
      };
      return { meta: { changes: 1 } };
    }
    if (this.query.includes('INSERT INTO telegram_notification_input_state')) {
      this.db.customInput = {
        scope: String(this.values[1]),
        bookRef: this.values[2] == null ? null : String(this.values[2]),
      };
      return { meta: { changes: 1 } };
    }
    if (this.query.includes('DELETE FROM telegram_notification_input_state') && !this.query.includes('expires_at <=')) {
      this.db.customInput = null;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }
  async first() {
    this.db.queries.push({ kind: 'first', query: this.query, values: this.values });
    if (this.query.includes('FROM telegram_notification_search_state')) {
      if (!this.db.searchState?.active) return null;
      return {
        query: this.db.searchState.query,
        page: this.db.searchState.page,
        return_scope: this.db.searchState.returnScope,
      };
    }
    if (this.query.includes('FROM telegram_notification_input_state')) {
      return this.db.customInput
        ? { scope: this.db.customInput.scope, book_ref: this.db.customInput.bookRef }
        : null;
    }
    if (this.query.includes('SELECT delivery_mode, stack_size FROM telegram_subscription_settings')) {
      return { delivery_mode: this.db.global.mode, stack_size: this.db.global.stackSize };
    }
    if (this.query.includes('SELECT all_titles FROM telegram_subscription_settings')) return { all_titles: 0 };
    if (this.query.includes('FROM telegram_title_delivery_settings') && this.query.includes('book_ref = ?')) return null;
    if (this.query.includes('COUNT(*) AS count FROM telegram_title_delivery_settings')) return { count: 0 };
    if (this.query.includes('COUNT(*) AS count FROM title_subscriptions')) return { count: 0 };
    if (this.query.includes('COUNT(*) AS count FROM title_subscription_exclusions')) return { count: 0 };
    if (this.query.includes('COUNT(*) AS count FROM ranobelib_titles')) return { count: this.db.titles.length };
    if (this.query.includes('FROM ranobelib_titles') && this.query.includes('WHERE ranobelib_id = ?')) {
      return this.db.titles.find((row) => row.ranobelib_id === Number(this.values[0])) ?? null;
    }
    if (this.query.includes('SELECT 1 AS subscribed FROM title_subscriptions')) return null;
    if (this.query.includes('SELECT 1 AS excluded FROM title_subscription_exclusions')) return null;
    return null;
  }
  async all() {
    this.db.queries.push({ kind: 'all', query: this.query, values: this.values });
    if (this.query.includes('FROM ranobelib_titles') && this.query.includes('LIKE')) {
      const pattern = String(this.values[0] ?? '').replaceAll('%', '').toLocaleLowerCase('ru');
      const limit = Number(this.values.at(-2) ?? 8);
      const offset = Number(this.values.at(-1) ?? 0);
      return {
        results: this.db.titles
          .filter((row) => row.title.toLocaleLowerCase('ru').includes(pattern))
          .slice(offset, offset + limit),
      };
    }
    return { results: [] };
  }
}

class DB {
  constructor() {
    this.titles = [
      { ranobelib_id: 1000, book_ref: '1000--cultivation-online', title: 'Культивация Онлайн', url: 'https://ranobelib.me/ru/book/1000--cultivation-online', is_active: 1, snapshot_ready: 1 },
      { ranobelib_id: 1001, book_ref: '1001--cultivation-god', title: 'Бог культивации', url: 'https://ranobelib.me/ru/book/1001--cultivation-god', is_active: 1, snapshot_ready: 1 },
      { ranobelib_id: 1002, book_ref: '1002--academy', title: 'Академия магии', url: 'https://ranobelib.me/ru/book/1002--academy', is_active: 1, snapshot_ready: 1 },
    ];
    this.searchState = null;
    this.customInput = null;
    this.global = { mode: 'instant', stackSize: null };
    this.queries = [];
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

function callbackRequest(data) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({
      callback_query: {
        id: `cb-${data}`,
        from: { id: 42, first_name: 'Reader' },
        data,
        message: { message_id: 9, chat: { id: 42, type: 'private' } },
      },
    }),
  });
}

function messageRequest(text) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({
      message: {
        message_id: 10,
        chat: { id: 42, type: 'private' },
        from: { id: 42, first_name: 'Reader' },
        text,
      },
    }),
  });
}

async function withTelegram(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (!href.includes('api.telegram.org')) throw new Error(`search must stay local D1-only: ${href}`);
    calls.push({ method: href.split('/').pop(), payload: JSON.parse(String(options.body || '{}')) });
    return Response.json({ ok: true, result: { message_id: 11 } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

const callbacks = (call) => call.payload.reply_markup.inline_keyboard.flat()
  .map((button) => button.callback_data).filter(Boolean);

const telegramCall = (calls, method) => calls.find((call) => call.method === method);

test('search-state helpers keep a ten-minute scoped resumable query and clear it explicitly', async () => {
  const schema = await import('../dist-runtime/telegram-text-bot-ux-schema.js');
  const db = new DB();
  assert.equal(typeof schema.beginNotificationSearch, 'function');
  assert.equal(typeof schema.getNotificationSearchState, 'function');
  assert.equal(typeof schema.saveNotificationSearchQuery, 'function');
  assert.equal(typeof schema.clearNotificationSearch, 'function');

  await schema.beginNotificationSearch({ DB: db }, '42', 'mine');
  assert.deepEqual(db.searchState, { query: '', page: 0, returnScope: 'mine', active: true });
  assert.ok(db.queries.some((entry) => entry.kind === 'run' && entry.query.includes("datetime(CURRENT_TIMESTAMP, '+10 minutes')")));

  await schema.saveNotificationSearchQuery({ DB: db }, '42', 'культивация');
  assert.deepEqual(await schema.getNotificationSearchState({ DB: db }, '42'), {
    query: 'культивация', page: 0, returnScope: 'mine',
  });

  await schema.clearNotificationSearch({ DB: db }, '42');
  assert.equal(db.searchState, null);
});

test('search callback parser accepts start/page/again routes and search-origin title cards', async () => {
  const ux = await import('../dist-runtime/telegram-notification-ux.js');
  assert.deepEqual(ux.parseNotificationUxCallback('subs:search:h'), { kind: 'search-start', returnScope: 'home' });
  assert.deepEqual(ux.parseNotificationUxCallback('subs:search:m'), { kind: 'search-start', returnScope: 'mine' });
  assert.deepEqual(ux.parseNotificationUxCallback('subs:search:a'), { kind: 'search-start', returnScope: 'all' });
  assert.deepEqual(ux.parseNotificationUxCallback('subs:search:page:3'), { kind: 'search-page', page: 3 });
  assert.deepEqual(ux.parseNotificationUxCallback('subs:search:again'), { kind: 'search-again' });
  assert.deepEqual(ux.parseNotificationUxCallback('subs:title:1000:s:2'), { kind: 'title', titleId: 1000, origin: 's', page: 2 });
});

test('starting search stores return scope and renders a prompt without any upstream request', async () => {
  const db = new DB();
  await withTelegram(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:search:m'), env(db));
    assert.equal(response?.status, 200);
    assert.deepEqual(db.searchState, { query: '', page: 0, returnScope: 'mine', active: true });
    const edit = telegramCall(calls, 'editMessageText');
    assert.ok(edit);
    assert.match(edit.payload.text, /Введите название/i);
    assert.ok(callbacks(edit).includes('subs:mine:0'));
    assert.ok(callbacks(edit).includes('prop:home'));
  });
});

test('ordinary search text queries only active local titles, paginates by eight and opens search-origin cards', async () => {
  const db = new DB();
  db.searchState = { query: '', page: 0, returnScope: 'home', active: true };
  db.titles = Array.from({ length: 11 }, (_, index) => ({
    ranobelib_id: 2000 + index,
    book_ref: `${2000 + index}--cultivation`,
    title: `Культивация ${index + 1}`,
    url: `https://ranobelib.me/ru/book/${2000 + index}--cultivation`,
    is_active: 1,
    snapshot_ready: 1,
  }));

  await withTelegram(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(messageRequest('КУЛЬТИВАЦИЯ'), env(db));
    assert.equal(response?.status, 200);
    assert.equal(db.searchState.query, 'КУЛЬТИВАЦИЯ');
    assert.equal(db.searchState.page, 0);
    const send = telegramCall(calls, 'sendMessage');
    assert.ok(send);
    assert.match(send.payload.text, /Результаты поиска/i);
    assert.ok(callbacks(send).includes('subs:title:2000:s:0'));
    assert.ok(callbacks(send).includes('subs:search:page:1'));
    assert.ok(callbacks(send).includes('subs:search:again'));
    const query = db.queries.find((entry) => entry.kind === 'all' && entry.query.includes('FROM ranobelib_titles') && entry.query.includes('LIKE'));
    assert.ok(query);
    assert.match(query.query, /is_active = 1/i);
    assert.match(query.query, /snapshot_ready = 1/i);
    assert.equal(query.values.at(-2), 8);
    assert.equal(query.values.at(-1), 0);
  });

  db.queries.length = 0;
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:search:page:1'), env(db));
    const edit = telegramCall(calls, 'editMessageText');
    assert.ok(edit);
    assert.ok(callbacks(edit).includes('subs:title:2008:s:1'));
    assert.ok(callbacks(edit).includes('subs:search:page:0'));
    const query = db.queries.find((entry) => entry.kind === 'all' && entry.query.includes('LIKE'));
    assert.equal(query.values.at(-2), 8);
    assert.equal(query.values.at(-1), 8);
  });
});

test('empty search results keep the query and offer try-again plus the original return context', async () => {
  const db = new DB();
  db.searchState = { query: '', page: 0, returnScope: 'all', active: true };
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(messageRequest('такого точно нет'), env(db));
    const send = telegramCall(calls, 'sendMessage');
    assert.ok(send);
    assert.match(send.payload.text, /ничего не найдено/i);
    assert.ok(callbacks(send).includes('subs:search:again'));
    assert.ok(callbacks(send).includes('subs:all:0'));
  });
});

test('custom stack input has priority over active search input', async () => {
  const db = new DB();
  db.searchState = { query: '', page: 0, returnScope: 'home', active: true };
  db.customInput = { scope: 'global', bookRef: null };
  await withTelegram(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(messageRequest('37'), env(db));
    assert.equal(response?.status, 200);
    assert.deepEqual(db.global, { mode: 'stack', stackSize: 37 });
    assert.equal(db.customInput, null);
    assert.equal(db.searchState.query, '', 'search state must not consume custom-stack text');
    const send = telegramCall(calls, 'sendMessage');
    assert.match(send.payload.text, /37 глав/);
  });
});
