import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleTelegramSubscriptionUpdate,
  sendTelegramNotificationCenter,
  sendTelegramSubscriptionMenu,
} from '../dist-runtime/telegram-subscriptions.js';

const normalize = (value) => String(value).replace(/\s+/g, ' ').trim();

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

class LatencyStatement {
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
    if (this.query.includes('SELECT book_ref FROM ranobelib_titles WHERE ranobelib_id = ?')) return { book_ref: '100--one' };
    if (this.query.includes('SELECT all_titles FROM telegram_subscription_settings')) return null;
    if (this.query.includes('SELECT delivery_mode FROM telegram_subscription_settings')) return null;
    if (this.query.includes('SELECT 1 AS subscribed FROM title_subscriptions')) return null;
    if (this.query.includes('SELECT 1 AS excluded FROM title_subscription_exclusions')) return null;
    if (this.query.includes('SELECT COUNT(*) AS count')) return { count: 0 };
    return null;
  }
  async all() { return { results: [] }; }
  async run() {
    if (this.query.includes('WITH demand AS') && this.query.includes('UPDATE ranobelib_titles')) {
      this.db.globalDemandRefreshes += 1;
      this.db.events.push('demand:global-start');
      return this.db.globalRefreshGate ? this.db.globalRefreshGate.promise : { meta: { changes: 0 } };
    }
    if (this.query.startsWith('INSERT INTO users')) {
      this.db.events.push('bookkeeping:user-upsert');
      if (this.db.bookkeepingGate) await this.db.bookkeepingGate.promise;
    }
    if (this.query.startsWith('INSERT INTO telegram_delivery_reachability')) {
      this.db.events.push('bookkeeping:reachable');
      if (this.db.bookkeepingGate) await this.db.bookkeepingGate.promise;
    }
    if (this.query.startsWith('INSERT OR IGNORE INTO title_subscriptions')
      || this.query.startsWith('DELETE FROM title_subscriptions WHERE user_telegram_id = ? AND book_ref = ?')
      || this.query.startsWith('INSERT OR IGNORE INTO title_subscription_exclusions')) {
      this.db.events.push('mutation:title-write');
    }
    if (this.query.startsWith('INSERT INTO telegram_subscription_settings')) {
      this.db.events.push('mutation:all-write');
    }
    return { meta: { changes: 0 } };
  }
}

class LatencyDB {
  constructor() {
    this.events = [];
    this.globalDemandRefreshes = 0;
    this.targetRefreshGate = null;
    this.globalRefreshGate = null;
    this.bookkeepingGate = null;
  }
  prepare(query) { return new LatencyStatement(this, query); }
}

function callbackUpdate(data, id = 'cb') {
  return {
    callback_query: {
      id,
      from: { id: 42, first_name: 'Reader' },
      data,
      message: { message_id: 7, chat: { id: 42, type: 'private' } },
    },
  };
}

function centerUpdate() { return callbackUpdate('subs:center', 'cb-center'); }

function env(db) {
  return { DB: db, TELEGRAM_BOT_TOKEN: 'token', BOT_USERNAME: 'domnekromanta_bot' };
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

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function firstD1Index(events) {
  return events.findIndex((event) => event.startsWith('d1:'));
}

test('subs:center starts callback acknowledgement before its first D1 operation', async () => {
  const db = new LatencyDB();
  const scheduled = [];
  await withTelegram(db.events, async () => {
    assert.equal(
      await handleTelegramSubscriptionUpdate(centerUpdate(), env(db), { waitUntil(promise) { scheduled.push(promise); } }),
      true,
    );
  });

  const ackIndex = db.events.indexOf('telegram:answerCallbackQuery');
  const d1Index = firstD1Index(db.events);
  assert.ok(ackIndex >= 0, 'callback must be acknowledged');
  assert.ok(d1Index >= 0, 'center still needs D1 reads');
  assert.ok(ackIndex < d1Index, `ack must start before D1; events=${JSON.stringify(db.events.slice(0, 8))}`);
});

test('legacy center renders while user/reachability bookkeeping is still pending', async () => {
  const db = new LatencyDB();
  db.bookkeepingGate = deferred();
  const scheduled = [];

  await withTelegram(db.events, async () => {
    const handling = handleTelegramSubscriptionUpdate(
      centerUpdate(),
      env(db),
      { waitUntil(promise) { scheduled.push(promise); } },
    );
    await flush();

    assert.ok(db.events.includes('bookkeeping:user-upsert'), 'interaction bookkeeping should still be started');
    assert.ok(db.events.includes('telegram:editMessageText'), `navigation render must not wait for bookkeeping; events=${JSON.stringify(db.events)}`);
    assert.ok(scheduled.length >= 2, 'early ack and navigation bookkeeping must both be registered with waitUntil');

    db.bookkeepingGate.resolve();
    assert.equal(await handling, true);
    await Promise.allSettled(scheduled);
  });
});

test('single-title mutation starts callback acknowledgement before its first D1 operation', async () => {
  const db = new LatencyDB();
  const scheduled = [];
  await withTelegram(db.events, async () => {
    assert.equal(
      await handleTelegramSubscriptionUpdate(
        callbackUpdate('subs:title:100:0', 'cb-title-ack'),
        env(db),
        { waitUntil(promise) { scheduled.push(promise); } },
      ),
      true,
    );
  });

  const ackIndex = db.events.indexOf('telegram:answerCallbackQuery');
  const d1Index = firstD1Index(db.events);
  assert.ok(ackIndex >= 0, 'single-title mutation callback must be acknowledged');
  assert.ok(d1Index >= 0, 'single-title mutation still needs D1');
  assert.ok(ackIndex < d1Index, `single-title ack must start before D1; events=${JSON.stringify(db.events.slice(0, 8))}`);
  assert.ok(scheduled.length >= 2, 'execution context should track both early ack and deferred demand maintenance');
});

test('all-title mutation starts callback acknowledgement before its first D1 operation', async () => {
  const db = new LatencyDB();
  const scheduled = [];
  await withTelegram(db.events, async () => {
    assert.equal(
      await handleTelegramSubscriptionUpdate(
        callbackUpdate('subs:all:on', 'cb-all-ack'),
        env(db),
        { waitUntil(promise) { scheduled.push(promise); } },
      ),
      true,
    );
  });

  const ackIndex = db.events.indexOf('telegram:answerCallbackQuery');
  const d1Index = firstD1Index(db.events);
  assert.ok(ackIndex >= 0, 'all-title mutation callback must be acknowledged');
  assert.ok(d1Index >= 0, 'all-title mutation still needs D1');
  assert.ok(ackIndex < d1Index, `all-title ack must start before D1; events=${JSON.stringify(db.events.slice(0, 8))}`);
  assert.ok(scheduled.length >= 2, 'execution context should track both early ack and deferred demand maintenance');
});

test('subs:center performs zero global notification-demand refreshes', async () => {
  const db = new LatencyDB();
  await withTelegram(db.events, async () => {
    assert.equal(await handleTelegramSubscriptionUpdate(centerUpdate(), env(db), { waitUntil() {} }), true);
  });
  assert.equal(db.globalDemandRefreshes, 0, 'read-only navigation must not recompute demand for every active title');
});

test('subscription and notification command menus perform zero global demand refreshes', async () => {
  for (const send of [sendTelegramSubscriptionMenu, sendTelegramNotificationCenter]) {
    const db = new LatencyDB();
    const scheduled = [];
    await withTelegram(db.events, async () => {
      await send(
        env(db),
        { id: 42, first_name: 'Reader' },
        42,
        ...(send === sendTelegramSubscriptionMenu ? [0, { waitUntil(promise) { scheduled.push(promise); } }] : [{ waitUntil(promise) { scheduled.push(promise); } }]),
      );
    });
    assert.equal(db.globalDemandRefreshes, 0, 'pure command navigation must not recompute demand for every active title');
  }
});

test('single-title mutation persists before targeted demand refresh is deferred', async () => {
  const db = new LatencyDB();
  db.targetRefreshGate = deferred();
  const scheduled = [];

  await withTelegram(db.events, async () => {
    const handling = handleTelegramSubscriptionUpdate(
      callbackUpdate('subs:title:100:0', 'cb-title'),
      env(db),
      { waitUntil(promise) { scheduled.push(promise); } },
    );
    await flush();

    const writeIndex = db.events.indexOf('mutation:title-write');
    const refreshIndex = db.events.indexOf('demand:target-start');
    assert.ok(writeIndex >= 0, 'subscription choice must be persisted');
    assert.ok(refreshIndex > writeIndex, 'targeted demand refresh must start only after durable write');
    assert.ok(scheduled.length >= 2, 'early ack and targeted demand refresh must both be registered with waitUntil');

    db.targetRefreshGate.resolve({ notification_subscriber_count: 1 });
    await handling;
    await Promise.all(scheduled);
  });
  assert.equal(db.globalDemandRefreshes, 0, 'single-title mutation must never trigger global demand refresh');
});

test('all-title mutation persists before global demand refresh is deferred', async () => {
  const db = new LatencyDB();
  db.globalRefreshGate = deferred();
  const scheduled = [];

  await withTelegram(db.events, async () => {
    const handling = handleTelegramSubscriptionUpdate(
      callbackUpdate('subs:all:on', 'cb-all'),
      env(db),
      { waitUntil(promise) { scheduled.push(promise); } },
    );
    await flush();

    const writeIndex = db.events.indexOf('mutation:all-write');
    const refreshIndex = db.events.indexOf('demand:global-start');
    assert.ok(writeIndex >= 0, 'all-title setting must be persisted');
    assert.ok(refreshIndex > writeIndex, 'global demand refresh must start only after durable write');
    assert.ok(scheduled.length >= 2, 'early ack and global demand refresh must both be registered with waitUntil');

    db.globalRefreshGate.resolve({ meta: { changes: 0 } });
    await handling;
    await Promise.all(scheduled);
  });
});
