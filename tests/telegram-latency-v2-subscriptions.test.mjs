import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTelegramSubscriptionUpdate } from '../dist-runtime/telegram-subscriptions.js';

const normalize = (value) => String(value).replace(/\s+/g, ' ').trim();

class LatencyStatement {
  constructor(db, query) {
    this.db = db;
    this.query = normalize(query);
    this.values = [];
    db.events.push(`d1:${this.query}`);
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (this.query.includes('SELECT all_titles FROM telegram_subscription_settings')) return null;
    if (this.query.includes('SELECT delivery_mode FROM telegram_subscription_settings')) return null;
    if (this.query.includes('SELECT COUNT(*) AS count')) return { count: 0 };
    return null;
  }
  async all() { return { results: [] }; }
  async run() {
    if (this.query.includes('WITH demand AS') && this.query.includes('UPDATE ranobelib_titles')) {
      this.db.globalDemandRefreshes += 1;
    }
    return { meta: { changes: 0 } };
  }
}

class LatencyDB {
  constructor() {
    this.events = [];
    this.globalDemandRefreshes = 0;
  }
  prepare(query) { return new LatencyStatement(this, query); }
}

function centerUpdate() {
  return {
    callback_query: {
      id: 'cb-center',
      from: { id: 42, first_name: 'Reader' },
      data: 'subs:center',
      message: { message_id: 7, chat: { id: 42, type: 'private' } },
    },
  };
}

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
  const firstD1Index = db.events.findIndex((event) => event.startsWith('d1:'));
  assert.ok(ackIndex >= 0, 'callback must be acknowledged');
  assert.ok(firstD1Index >= 0, 'center still needs D1 reads');
  assert.ok(ackIndex < firstD1Index, `ack must start before D1; events=${JSON.stringify(db.events.slice(0, 8))}`);
});

test('subs:center performs zero global notification-demand refreshes', async () => {
  const db = new LatencyDB();
  await withTelegram(db.events, async () => {
    assert.equal(await handleTelegramSubscriptionUpdate(centerUpdate(), env(db), { waitUntil() {} }), true);
  });
  assert.equal(db.globalDemandRefreshes, 0, 'read-only navigation must not recompute demand for every active title');
});
