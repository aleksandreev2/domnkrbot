import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTelegramSubscriptionWebhookRequest } from '../dist-runtime/telegram-subscription-webhook.js';

const normalize = (q) => q.replace(/\s+/g, ' ').trim();

class Statement {
  constructor(db, query) { this.db = db; this.query = normalize(query); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() {
    this.db.queries.push({ kind: 'first', query: this.query, values: this.values });
    if (this.query.includes('SELECT all_titles FROM telegram_subscription_settings')) return { all_titles: this.db.allTitles ? 1 : 0 };
    if (this.query.includes('SELECT delivery_mode, stack_size FROM telegram_subscription_settings')) return { delivery_mode: this.db.global.mode, stack_size: this.db.global.stackSize };
    if (this.query.includes('FROM telegram_title_delivery_settings') && this.query.includes('book_ref = ?')) {
      const row = this.db.overrides.get(String(this.values[1]));
      return row ? { delivery_mode: row.mode, stack_size: row.stackSize } : null;
    }
    if (this.query.includes('COUNT(*) AS count FROM telegram_title_delivery_settings')) return { count: this.db.overrides.size };
    if (this.query.includes('COUNT(*) AS count FROM title_subscriptions')) return { count: this.db.subscriptions.size };
    if (this.query.includes('COUNT(*) AS count FROM title_subscription_exclusions')) return { count: this.db.exclusions.size };
    if (this.query.includes('COUNT(*) AS count FROM ranobelib_titles')) return { count: this.db.titles.length };
    if (this.query.includes('SUM(r.chapter_count)')) return { count: this.db.pendingChapters };
    if (this.query.includes('FROM ranobelib_titles') && this.query.includes('WHERE ranobelib_id = ?')) {
      return this.db.titles.find((row) => row.ranobelib_id === Number(this.values[0])) ?? null;
    }
    if (this.query.includes('SELECT 1 AS subscribed FROM title_subscriptions')) {
      return this.db.subscriptions.has(`${this.values[0]}:${this.values[1]}`) ? { subscribed: 1 } : null;
    }
    if (this.query.includes('SELECT 1 AS excluded FROM title_subscription_exclusions')) {
      return this.db.exclusions.has(`${this.values[0]}:${this.values[1]}`) ? { excluded: 1 } : null;
    }
    if (this.query.includes('FROM telegram_notification_input_state')) return null;
    return null;
  }
  async all() {
    this.db.queries.push({ kind: 'all', query: this.query, values: this.values });
    const limit = Number(this.values.at(-2) ?? 8);
    const offset = Number(this.values.at(-1) ?? 0);
    if (this.query.includes('FROM ranobelib_titles t') && this.query.includes('JOIN title_subscriptions s')) {
      const user = String(this.values[0]);
      return { results: this.db.titles.filter((t) => this.db.subscriptions.has(`${user}:${t.book_ref}`)).slice(offset, offset + limit) };
    }
    if (this.query.includes('FROM ranobelib_titles t') && this.query.includes('title_subscription_exclusions')) {
      const user = String(this.values[0]);
      return { results: this.db.titles.filter((t) => !this.db.exclusions.has(`${user}:${t.book_ref}`)).slice(offset, offset + limit) };
    }
    if (this.query.includes('FROM ranobelib_titles') && this.query.includes('is_active = 1')) {
      return { results: this.db.titles.slice(offset, offset + limit) };
    }
    if (this.query.includes('FROM title_subscriptions s JOIN ranobelib_titles t')) return { results: [] };
    return { results: [] };
  }
  async run() {
    this.db.queries.push({ kind: 'run', query: this.query, values: this.values });
    if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/.test(this.query)) return { meta: { changes: 0 } };
    if (this.query.startsWith('INSERT INTO users')) return { meta: { changes: 1 } };
    if (this.query.startsWith('INSERT OR IGNORE INTO title_subscriptions')) {
      this.db.subscriptions.add(`${this.values[0]}:${this.values[1]}`); return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('DELETE FROM title_subscriptions WHERE user_telegram_id = ? AND book_ref = ?')) {
      this.db.subscriptions.delete(`${this.values[0]}:${this.values[1]}`); return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('DELETE FROM title_subscriptions WHERE user_telegram_id = ?')) {
      const prefix = `${this.values[0]}:`; for (const key of [...this.db.subscriptions]) if (key.startsWith(prefix)) this.db.subscriptions.delete(key);
      return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('DELETE FROM title_subscription_exclusions WHERE user_telegram_id = ?')) {
      const prefix = `${this.values[0]}:`; for (const key of [...this.db.exclusions]) if (key.startsWith(prefix)) this.db.exclusions.delete(key);
      return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('INSERT OR IGNORE INTO title_subscription_exclusions')) {
      this.db.exclusions.add(`${this.values[0]}:${this.values[1]}`); return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('DELETE FROM title_subscription_exclusions WHERE user_telegram_id = ? AND book_ref = ?')) {
      this.db.exclusions.delete(`${this.values[0]}:${this.values[1]}`); return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('INSERT INTO telegram_subscription_settings') && this.query.includes('all_titles')) {
      if (this.query.includes('delivery_mode')) {
        this.db.global = { mode: String(this.values.at(-2)), stackSize: this.values.at(-1) == null ? null : Number(this.values.at(-1)) };
      } else {
        this.db.allTitles = Number(this.values[1]) === 1;
      }
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor() {
    this.titles = [
      { ranobelib_id: 1000, book_ref: '1000--one', title: 'Книга 1', url: 'https://ranobelib.me/ru/book/1000--one', is_active: 1, snapshot_ready: 1 },
      { ranobelib_id: 1001, book_ref: '1001--two', title: 'Книга 2', url: 'https://ranobelib.me/ru/book/1001--two', is_active: 1, snapshot_ready: 1 },
    ];
    this.allTitles = false;
    this.subscriptions = new Set(['42:1000--one']);
    this.exclusions = new Set();
    this.global = { mode: 'stack', stackSize: 10 };
    this.overrides = new Map();
    this.pendingChapters = 4;
    this.queries = [];
  }
  prepare(query) { return new Statement(this, query); }
}

function env(db) {
  return { DB: db, TELEGRAM_BOT_TOKEN: 'unit-test-token', TELEGRAM_WEBHOOK_SECRET: 'secret', BOT_USERNAME: 'domnekromanta_bot' };
}

function callbackRequest(data) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({ callback_query: { id: `cb-${data}`, from: { id: 42, first_name: 'Reader' }, data, message: { message_id: 9, chat: { id: 42, type: 'private' } } } }),
  });
}

function messageRequest(text) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({ message: { message_id: 5, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Reader' }, text } }),
  });
}

async function withTelegram(fn) {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (!href.includes('api.telegram.org')) throw new Error(`upstream call forbidden in notification UI test: ${href}`);
    calls.push({ method: href.split('/').pop(), payload: JSON.parse(String(options.body || '{}')) });
    return Response.json({ ok: true, result: { message_id: 10 } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

const edit = (calls) => calls.find((call) => call.method === 'editMessageText');
const send = (calls) => calls.find((call) => call.method === 'sendMessage');
const cb = (call) => call.payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);

test('prop:notifications and /notifications open dashboard without global preset buttons', async () => {
  const db = new DB();
  await withTelegram(async (calls) => {
    const response = await handleTelegramSubscriptionWebhookRequest(callbackRequest('prop:notifications'), env(db));
    assert.equal(response?.status, 200);
    const call = edit(calls);
    assert.match(call.payload.text, /Подписки:/);
    assert.ok(cb(call).includes('subs:mode:home'));
    assert.equal(cb(call).some((value) => /^subs:mode:g:/.test(value)), false);
  });
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(messageRequest('/notifications'), env(db));
    const call = send(calls);
    assert.ok(cb(call).includes('subs:mine:0'));
    assert.equal(cb(call).some((value) => /^subs:mode:g:/.test(value)), false);
  });
});

test('opening a title row does not mutate subscription; explicit toggle does and returns card', async () => {
  const db = new DB();
  db.subscriptions.clear();
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:title:1000:a:0'), env(db));
    assert.equal(db.subscriptions.size, 0);
    const card = edit(calls);
    assert.match(card.payload.text, /Уведомления: 🔕 отключены/);
    assert.ok(cb(card).includes('subs:title:toggle:1000:a:0'));
  });
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:title:toggle:1000:a:0'), env(db));
    assert.ok(db.subscriptions.has('42:1000--one'));
    const card = edit(calls);
    assert.match(card.payload.text, /Уведомления: ✅ включены/);
  });
});

test('historical title callback opens card from All instead of toggling', async () => {
  const db = new DB();
  db.subscriptions.clear();
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:title:1000:3'), env(db));
    assert.equal(db.subscriptions.size, 0);
    const card = edit(calls);
    assert.ok(cb(card).includes('subs:all:3'));
  });
});

test('My and All lists query active local catalog in pages of eight', async () => {
  const db = new DB();
  db.titles = Array.from({ length: 10 }, (_, index) => ({ ranobelib_id: 1000 + index, book_ref: `${1000 + index}--b`, title: `Книга ${index + 1}`, url: `https://ranobelib.me/ru/book/${1000 + index}--b`, is_active: 1, snapshot_ready: 1 }));
  db.subscriptions = new Set(db.titles.slice(0, 10).map((row) => `42:${row.book_ref}`));
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:mine:0'), env(db));
    const list = edit(calls);
    assert.ok(cb(list).includes('subs:mine:1'));
    const query = db.queries.find((q) => q.kind === 'all' && q.query.includes('JOIN title_subscriptions s'));
    assert.ok(query);
    assert.equal(query.values.at(-2), 8);
    assert.equal(query.values.at(-1), 0);
  });
  db.queries.length = 0;
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:all:1'), env(db));
    const list = edit(calls);
    assert.ok(cb(list).includes('subs:all:0'));
    const query = db.queries.find((q) => q.kind === 'all' && q.query.includes('FROM ranobelib_titles'));
    assert.ok(query);
    assert.equal(query.values.at(-2), 8);
    assert.equal(query.values.at(-1), 8);
  });
});

test('disable-all first asks confirmation and only confirmed callback mutates subscriptions', async () => {
  const db = new DB();
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:all:clear:confirm'), env(db));
    assert.equal(db.subscriptions.size, 1);
    assert.ok(cb(edit(calls)).includes('subs:all:clear:yes'));
  });
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:all:clear:yes'), env(db));
    assert.equal(db.subscriptions.size, 0);
    assert.match(edit(calls).payload.text, /Уведомления/);
  });
});

test('stack title card queries pending chapter sum while instant card omits it', async () => {
  const db = new DB();
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:title:1000:m:0'), env(db));
    assert.match(edit(calls).payload.text, /Накоплено: 4 \/ 10/);
    assert.ok(db.queries.some((q) => q.kind === 'first' && q.query.includes('SUM(r.chapter_count)')));
  });
  db.global = { mode: 'instant', stackSize: null };
  db.queries.length = 0;
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:title:1000:m:0'), env(db));
    assert.doesNotMatch(edit(calls).payload.text, /Накоплено:/);
    assert.equal(db.queries.some((q) => q.query.includes('SUM(r.chapter_count)')), false);
  });
});

test('mode screens are dedicated and title mode has true Back-to-card context', async () => {
  const db = new DB();
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:mode:home'), env(db));
    const mode = edit(calls);
    assert.ok(cb(mode).includes('subs:mode:g:10'));
    assert.ok(cb(mode).includes('subs:center'));
  });
  await withTelegram(async (calls) => {
    await handleTelegramSubscriptionWebhookRequest(callbackRequest('subs:title:mode:1000:a:4'), env(db));
    const mode = edit(calls);
    assert.ok(cb(mode).includes('subs:mode:t:1000:5:a:4'));
    assert.ok(cb(mode).includes('subs:title:1000:a:4'));
  });
});
