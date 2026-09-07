import assert from 'node:assert/strict';
import test from 'node:test';
import * as subscriptions from '../dist-runtime/telegram-subscriptions.js';

const normalize = (query) => query.replace(/\s+/g, ' ').trim();

class Statement {
  constructor(db, query) { this.db = db; this.query = normalize(query); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() {
    const userId = String(this.values[0] ?? '');
    if (this.query.includes('SELECT all_titles FROM telegram_subscription_settings')) {
      return { all_titles: this.db.allTitles.get(userId) ?? 0 };
    }
    if (this.query.includes('SELECT delivery_mode, stack_size') && this.query.includes('FROM telegram_subscription_settings')) {
      return this.db.global.get(userId) ?? null;
    }
    if (this.query.includes('SELECT delivery_mode, stack_size') && this.query.includes('FROM telegram_title_delivery_settings')) {
      return this.db.titleSettings.get(`${userId}:${this.values[1]}`) ?? null;
    }
    if (this.query.includes('FROM telegram_notification_input_state')) {
      return this.db.inputState.get(userId) ?? null;
    }
    if (this.query.includes('FROM ranobelib_titles') && this.query.includes('ranobelib_id = ?')) {
      const title = this.db.titles.find((row) => row.ranobelib_id === Number(this.values[0]));
      return title ?? null;
    }
    if (this.query.includes('SELECT 1 AS subscribed FROM title_subscriptions')) {
      return this.db.subscriptions.has(`${userId}:${this.values[1]}`) ? { subscribed: 1 } : null;
    }
    if (this.query.includes('SELECT 1 AS excluded FROM title_subscription_exclusions')) return null;
    if (this.query.includes('COUNT(*) AS count') && this.query.includes('telegram_title_delivery_settings')) {
      return { count: [...this.db.titleSettings.keys()].filter((key) => key.startsWith(`${userId}:`)).length };
    }
    if (this.query.includes('COUNT(*) AS count') && this.query.includes('title_subscriptions')) return { count: 1 };
    if (this.query.includes('COUNT(*) AS count') && this.query.includes('title_subscription_exclusions')) return { count: 0 };
    return null;
  }
  async all() { return { results: [] }; }
  async run() {
    this.db.queries.push({ query: this.query, values: [...this.values] });
    if (/^(CREATE TABLE|CREATE INDEX)/.test(this.query)) return { meta: { changes: 0 } };
    if (this.query.startsWith('ALTER TABLE')) throw new Error('duplicate column name: delivery_mode');
    if (this.query.startsWith('INSERT INTO users')) return { meta: { changes: 1 } };
    if (this.query.startsWith('INSERT INTO telegram_subscription_settings')) {
      const [userId, maybeAllOrMode, maybeMode, maybeStack] = this.values;
      if (typeof maybeAllOrMode === 'string' && ['instant', 'stack'].includes(maybeAllOrMode)) {
        this.db.global.set(String(userId), { delivery_mode: maybeAllOrMode, stack_size: maybeMode });
      } else if (typeof maybeMode === 'string') {
        this.db.global.set(String(userId), { delivery_mode: maybeMode, stack_size: maybeStack });
      }
      return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('INSERT INTO telegram_title_delivery_settings')) {
      const [userId, bookRef, mode, stackSize] = this.values;
      this.db.titleSettings.set(`${userId}:${bookRef}`, { delivery_mode: mode, stack_size: stackSize });
      return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('DELETE FROM telegram_title_delivery_settings')) {
      this.db.titleSettings.delete(`${this.values[0]}:${this.values[1]}`);
      return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('INSERT INTO telegram_notification_input_state')) {
      const [userId, scope, bookRef] = this.values;
      this.db.inputState.set(String(userId), { scope, book_ref: bookRef });
      return { meta: { changes: 1 } };
    }
    if (this.query.startsWith('DELETE FROM telegram_notification_input_state') && !this.query.includes('expires_at <=')) {
      this.db.inputState.delete(String(this.values[0]));
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

class DB {
  constructor() {
    this.global = new Map([['42', { delivery_mode: 'instant', stack_size: null }]]);
    this.allTitles = new Map([['42', 0]]);
    this.titleSettings = new Map();
    this.inputState = new Map();
    this.subscriptions = new Set(['42:1000--one']);
    this.titles = [{ ranobelib_id: 1000, book_ref: '1000--one', title: 'Книга 1', url: 'https://ranobelib.me/ru/book/1000--one', is_active: 1 }];
    this.queries = [];
  }
  prepare(query) { return new Statement(this, query); }
}

function env(db) {
  return { DB: db, TELEGRAM_BOT_TOKEN: 'unit-test-token', BOT_USERNAME: 'domnekromanta_bot' };
}

function callback(data) {
  return { callback_query: { id: 'cb-1', from: { id: 42, first_name: 'Reader' }, data, message: { message_id: 9, chat: { id: 42, type: 'private' } } } };
}

function textUpdate(text) {
  return { message: { message_id: 10, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Reader' }, text } };
}

async function withTelegram(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = String(url).split('/').pop();
    calls.push({ method, payload: JSON.parse(String(options.body || '{}')) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 11 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

test('global preset callback persists stack 10 and redraws the notification center', async () => {
  const db = new DB();
  await withTelegram(async (calls) => {
    assert.equal(await subscriptions.handleTelegramSubscriptionUpdate(callback('subs:mode:g:10'), env(db)), true);
    assert.deepEqual(db.global.get('42'), { delivery_mode: 'stack', stack_size: 10 });
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.ok(edit);
    assert.match(edit.payload.text, /Режим по умолчанию: 📦 По 10/);
  });
});

test('per-title preset creates an override without changing the global setting', async () => {
  const db = new DB();
  await withTelegram(async (calls) => {
    assert.equal(await subscriptions.handleTelegramSubscriptionUpdate(callback('subs:mode:t:1000:5'), env(db)), true);
    assert.deepEqual(db.global.get('42'), { delivery_mode: 'instant', stack_size: null });
    assert.deepEqual(db.titleSettings.get('42:1000--one'), { delivery_mode: 'stack', stack_size: 5 });
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.ok(edit);
    assert.match(edit.payload.text, /Режим: 📦 По 5/);
  });
});

test('custom callback stores scoped input state and prompts for 2 through 100', async () => {
  const db = new DB();
  await withTelegram(async (calls) => {
    assert.equal(await subscriptions.handleTelegramSubscriptionUpdate(callback('subs:mode:t:1000:c'), env(db)), true);
    assert.deepEqual(db.inputState.get('42'), { scope: 'title', book_ref: '1000--one' });
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.ok(send);
    assert.match(send.payload.text, /Введите размер стака от 2 до 100/);
  });
});

test('custom input accepts integer 37, rejects invalid input without clearing state, and ignores slash commands', async () => {
  const db = new DB();
  db.inputState.set('42', { scope: 'global', book_ref: null });
  assert.equal(typeof subscriptions.handleNotificationCustomInput, 'function');

  await withTelegram(async (calls) => {
    assert.equal(await subscriptions.handleNotificationCustomInput(textUpdate('1'), env(db)), true);
    assert.ok(db.inputState.has('42'));
    assert.match(calls.at(-1).payload.text, /целое число от 2 до 100/);
  });

  await withTelegram(async (calls) => {
    assert.equal(await subscriptions.handleNotificationCustomInput(textUpdate('/notifications'), env(db)), false);
    assert.equal(calls.length, 0);
    assert.ok(db.inputState.has('42'));
  });

  await withTelegram(async (calls) => {
    assert.equal(await subscriptions.handleNotificationCustomInput(textUpdate('37'), env(db)), true);
    assert.deepEqual(db.global.get('42'), { delivery_mode: 'stack', stack_size: 37 });
    assert.equal(db.inputState.has('42'), false);
    assert.match(calls.at(-1).payload.text, /накопления 37 глав/);
    assert.match(calls.at(-1).payload.text, /7 дней/);
  });
});
