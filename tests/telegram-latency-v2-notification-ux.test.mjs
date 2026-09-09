import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTelegramNotificationUxUpdate } from '../dist-runtime/telegram-notification-ux-runtime.js';

const normalize = (value) => String(value).replace(/\s+/g, ' ').trim();

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = normalize(query);
    this.values = [];
    db.events.push(`d1:${this.query}`);
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (this.query.includes('WITH demand AS') && this.query.includes('RETURNING notification_subscriber_count')) {
      this.db.events.push('demand:target-start');
      return this.db.targetRefreshGate ? this.db.targetRefreshGate.promise : { notification_subscriber_count: 1 };
    }
    if (this.query.includes('FROM ranobelib_titles') && this.query.includes('WHERE ranobelib_id = ?')) {
      return { ranobelib_id: 1000, book_ref: '1000--one', title: 'Книга 1', url: 'https://ranobelib.me/ru/book/1000--one' };
    }
    if (this.query.includes('SELECT all_titles FROM telegram_subscription_settings')) return { all_titles: 0 };
    if (this.query.includes('SELECT delivery_mode, stack_size FROM telegram_subscription_settings')) return { delivery_mode: 'instant', stack_size: null };
    if (this.query.includes('FROM telegram_title_delivery_settings') && this.query.includes('book_ref = ?')) return null;
    if (this.query.includes('SELECT 1 AS subscribed FROM title_subscriptions')) return null;
    if (this.query.includes('SELECT 1 AS excluded FROM title_subscription_exclusions')) return null;
    if (this.query.includes('COUNT(*) AS count')) return { count: 0 };
    return null;
  }
  async all() {
    if (this.query.includes('FROM ranobelib_titles') && this.query.includes('is_active = 1')) {
      return { results: [{ ranobelib_id: 1000, book_ref: '1000--one', title: 'Книга 1', url: 'https://ranobelib.me/ru/book/1000--one' }] };
    }
    return { results: [] };
  }
  async run() {
    if (this.query.includes('WITH demand AS') && this.query.includes('UPDATE ranobelib_titles')) {
      this.db.events.push('demand:global-start');
      return this.db.globalRefreshGate ? this.db.globalRefreshGate.promise : { meta: { changes: 0 } };
    }
    if (this.query.startsWith('INSERT INTO users')) this.db.events.push('write:user-upsert');
    if (this.query.includes('UPDATE telegram_proposal_sessions SET input_active')) this.db.events.push('cleanup:proposal-input');
    if (this.query.includes('DELETE FROM telegram_notification_input_state')) this.db.events.push('cleanup:custom-input');
    if (this.query.startsWith('INSERT OR IGNORE INTO title_subscriptions')) this.db.events.push('write:title-subscription');
    if (this.query.startsWith('INSERT INTO telegram_subscription_settings')) this.db.events.push('write:all-setting');
    if (this.query.startsWith('DELETE FROM title_subscriptions WHERE user_telegram_id = ?')) this.db.events.push('write:clear-explicit');
    if (this.query.startsWith('DELETE FROM title_subscription_exclusions WHERE user_telegram_id = ?')) this.db.events.push('write:clear-exclusions');
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor() {
    this.events = [];
    this.targetRefreshGate = null;
    this.globalRefreshGate = null;
  }
  prepare(query) { return new Statement(this, query); }
}

function env(db) {
  return { DB: db, TELEGRAM_BOT_TOKEN: 'token', BOT_USERNAME: 'domnekromanta_bot' };
}

function callbackUpdate(data, id = 'cb') {
  return {
    callback_query: {
      id,
      from: { id: 42, first_name: 'Reader' },
      data,
      message: { message_id: 9, chat: { id: 42, type: 'private' } },
    },
  };
}

function context(events, scheduled) {
  return {
    waitUntil(promise) {
      events.push('waitUntil');
      scheduled.push(promise);
    },
  };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function withTelegram(events, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const method = String(url).split('/').pop();
    events.push(`telegram:${method}`);
    return Response.json({ ok: true, result: true });
  };
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test('v2 all-title navigation acknowledges before D1 and skips universal user/input writes', async () => {
  const db = new DB();
  const scheduled = [];
  await withTelegram(db.events, async () => {
    assert.equal(
      await handleTelegramNotificationUxUpdate(
        callbackUpdate('subs:all:0', 'cb-all-list'),
        env(db),
        context(db.events, scheduled),
      ),
      true,
    );
  });

  const ackIndex = db.events.indexOf('telegram:answerCallbackQuery');
  const firstD1Index = db.events.findIndex((event) => event.startsWith('d1:'));
  assert.ok(ackIndex >= 0, 'navigation callback must be acknowledged');
  assert.ok(firstD1Index >= 0, 'navigation still needs local D1 reads');
  assert.ok(ackIndex < firstD1Index, `ack must start before D1; events=${JSON.stringify(db.events.slice(0, 10))}`);
  assert.equal(db.events.includes('write:user-upsert'), false, 'pure callback navigation must not rewrite the users row');
  assert.equal(db.events.includes('cleanup:proposal-input'), false, 'pure callback navigation must not universally rewrite proposal input state');
  assert.equal(db.events.includes('cleanup:custom-input'), false, 'pure callback navigation must not universally clear custom notification input');
});

test('v2 title toggle persists first then defers targeted demand refresh without blocking render', async () => {
  const db = new DB();
  db.targetRefreshGate = deferred();
  const scheduled = [];

  await withTelegram(db.events, async () => {
    const handling = handleTelegramNotificationUxUpdate(
      callbackUpdate('subs:title:toggle:1000:a:0', 'cb-title-toggle'),
      env(db),
      context(db.events, scheduled),
    );

    await flush();

    const ackIndex = db.events.indexOf('telegram:answerCallbackQuery');
    const firstD1Index = db.events.findIndex((event) => event.startsWith('d1:'));
    const writeIndex = db.events.indexOf('write:title-subscription');
    const refreshIndex = db.events.indexOf('demand:target-start');
    const renderIndex = db.events.indexOf('telegram:editMessageText');

    assert.ok(ackIndex >= 0 && ackIndex < firstD1Index, 'toggle callback must acknowledge before D1');
    assert.ok(writeIndex >= 0, 'title subscription choice must be durable before maintenance');
    assert.ok(refreshIndex > writeIndex, 'targeted demand refresh must start only after subscription write');
    assert.ok(scheduled.length >= 2, 'early ack and targeted maintenance must both be registered with waitUntil');
    assert.ok(renderIndex > refreshIndex, 'title card must render without awaiting demand refresh completion');

    db.targetRefreshGate.resolve({ notification_subscriber_count: 1 });
    assert.equal(await handling, true);
    await Promise.allSettled(scheduled);
  });
});

test('v2 clear-all persists subscription cleanup then defers global demand refresh before rendering', async () => {
  const db = new DB();
  db.globalRefreshGate = deferred();
  const scheduled = [];

  await withTelegram(db.events, async () => {
    const handling = handleTelegramNotificationUxUpdate(
      callbackUpdate('subs:all:clear:yes', 'cb-clear-all'),
      env(db),
      context(db.events, scheduled),
    );

    await flush();

    const settingIndex = db.events.indexOf('write:all-setting');
    const explicitIndex = db.events.indexOf('write:clear-explicit');
    const exclusionIndex = db.events.indexOf('write:clear-exclusions');
    const refreshIndex = db.events.indexOf('demand:global-start');
    const renderIndex = db.events.indexOf('telegram:editMessageText');

    assert.ok(settingIndex >= 0, 'all_titles=0 must be durable before maintenance');
    assert.ok(explicitIndex > settingIndex && exclusionIndex > settingIndex, 'explicit subscriptions and exclusions must be cleared after all_titles=0');
    assert.ok(refreshIndex > Math.max(explicitIndex, exclusionIndex), 'global demand refresh must start only after all clear writes finish');
    assert.ok(scheduled.length >= 2, 'early ack and global demand maintenance must both be registered with waitUntil');
    assert.ok(renderIndex > refreshIndex, 'dashboard render must start without waiting for global demand refresh completion');

    db.globalRefreshGate.resolve({ meta: { changes: 0 } });
    assert.equal(await handling, true);
    await Promise.allSettled(scheduled);
  });
});
