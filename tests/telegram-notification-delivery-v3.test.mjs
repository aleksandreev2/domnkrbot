import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

async function loadDelivery() {
  return import('../dist-runtime/telegram-notification-delivery.js');
}

function outboxRow(userId, overrides = {}) {
  return {
    release_id: 'release-1',
    user_telegram_id: String(userId),
    status: 'pending',
    attempts: 0,
    book_ref: '77--fast-book',
    ranobelib_id: 77,
    title: 'Fast Book',
    url: 'https://ranobelib.me/ru/book/77--fast-book',
    chapter_count: 1,
    first_number: '2',
    last_number: '2',
    summary: 'Chapter 2',
    eligible: 1,
    ...overrides,
  };
}

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() { return null; }
  async all() {
    if (this.query.includes('FROM ranobelib_notification_outbox o')) {
      this.db.deliverySelects.push({ query: this.query, values: [...this.values] });
      const releaseId = this.values.length > 1 && typeof this.values[0] === 'string' ? this.values[0] : null;
      const limit = Number(this.values.at(-1)) || 20;
      return {
        results: this.db.rows
          .filter((row) => !releaseId || row.release_id === releaseId)
          .filter((row) => row.status === 'pending' || row.status === 'retry')
          .slice(0, limit),
      };
    }
    return { results: [] };
  }
  async run() {
    this.db.mutations.push({ query: this.query, values: [...this.values] });
    if (/UPDATE ranobelib_notification_outbox SET status='sent'/i.test(this.query)) {
      this.db.setStatus(this.values, 'sent');
    } else if (/UPDATE ranobelib_notification_outbox SET status='disabled'/i.test(this.query)) {
      this.db.setStatus(this.values, 'disabled');
    } else if (/UPDATE ranobelib_notification_outbox SET status='retry'/i.test(this.query)) {
      this.db.setStatus(this.values, 'retry');
    } else if (/DELETE FROM ranobelib_notification_outbox/i.test(this.query)) {
      const releaseId = String(this.values.at(-2));
      const userId = String(this.values.at(-1));
      this.db.rows = this.db.rows.filter((row) => !(row.release_id === releaseId && row.user_telegram_id === userId));
    }
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor(rows) {
    this.rows = rows.map((row) => ({ ...row }));
    this.deliverySelects = [];
    this.mutations = [];
    this.allQueries = [];
  }
  prepare(query) {
    this.allQueries.push(query.replace(/\s+/g, ' ').trim());
    return new Statement(this, query);
  }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
  setStatus(values, status) {
    const releaseId = String(values.at(-2));
    const userId = String(values.at(-1));
    const row = this.rows.find((item) => item.release_id === releaseId && item.user_telegram_id === userId);
    if (row) row.status = status;
  }
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

function telegramOk() {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    headers: { 'content-type': 'application/json' },
  });
}

test('delivery uses one SQL eligibility query and no per-user subscription SELECTs', async () => {
  const delivery = await loadDelivery();
  assert.equal(delivery.DELIVERY_BATCH_LIMIT, 20);
  assert.equal(delivery.TELEGRAM_SEND_CONCURRENCY, 5);

  const db = new DB([
    outboxRow('100'),
    outboxRow('200', { eligible: 0 }),
  ]);
  let sends = 0;
  const result = await withFetch(async () => { sends += 1; return telegramOk(); }, () =>
    delivery.drainNotificationOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' }));

  assert.equal(result.claimed, 2);
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, 1);
  assert.equal(sends, 1);
  assert.equal(db.deliverySelects.length, 1);
  const query = db.deliverySelects[0].query;
  assert.match(query, /EXISTS[\s\S]*telegram_subscription_settings/i);
  assert.match(query, /title_subscription_exclusions/i);
  assert.match(query, /title_subscriptions/i);
  assert.match(query, /AS eligible/i);
  assert.equal(db.allQueries.some((sql) => /SELECT all_titles FROM telegram_subscription_settings WHERE user_telegram_id = \?/i.test(sql)), false);
  assert.equal(db.allQueries.some((sql) => /SELECT 1 AS subscribed FROM title_subscriptions WHERE user_telegram_id = \?/i.test(sql)), false);
  assert.ok(db.mutations.some((m) => /status='sent'/i.test(m.query)));
  assert.ok(db.mutations.some((m) => /DELETE FROM ranobelib_notification_outbox/i.test(m.query)));
});

test('a full twenty-recipient batch sends concurrently but never exceeds five active Telegram requests', async () => {
  const { drainNotificationOutbox } = await loadDelivery();
  const db = new DB(Array.from({ length: 20 }, (_, index) => outboxRow(String(1000 + index))));
  let active = 0;
  let maxActive = 0;

  const result = await withFetch(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return telegramOk();
  }, () => drainNotificationOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' }));

  assert.equal(result.claimed, 20);
  assert.equal(result.sent, 20);
  assert.equal(result.retry, 0);
  assert.ok(maxActive > 1, `expected concurrent sends, saw maxActive=${maxActive}`);
  assert.ok(maxActive <= 5, `expected max five active sends, saw ${maxActive}`);
  assert.ok(db.allQueries.length <= 21, `unexpected D1 query explosion: ${db.allQueries.length}`);
});

test('403 disables, 429 respects retry_after seconds, and other temporary errors retry without aborting the batch', async () => {
  const { drainNotificationOutbox } = await loadDelivery();
  const db = new DB([
    outboxRow('403'),
    outboxRow('429'),
    outboxRow('500'),
    outboxRow('200'),
  ]);

  const result = await withFetch(async (_url, init) => {
    const payload = JSON.parse(init.body);
    const userId = String(payload.chat_id);
    if (userId === '403') {
      return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    if (userId === '429') {
      return new Response(JSON.stringify({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 17 },
      }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    if (userId === '500') {
      return new Response(JSON.stringify({ ok: false, error_code: 500, description: 'Temporary error' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
    return telegramOk();
  }, () => drainNotificationOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' }));

  assert.equal(result.sent, 1);
  assert.equal(result.disabled, 1);
  assert.equal(result.retry, 2);
  assert.equal(result.rateLimited, 1);

  const disabled = db.mutations.find((m) => /status='disabled'/i.test(m.query));
  assert.ok(disabled);
  const rateLimited = db.mutations.find((m) => /status='retry'/i.test(m.query) && m.values.includes(17));
  assert.ok(rateLimited, '429 retry mutation should bind retry_after=17 seconds');
  assert.match(rateLimited.query, /seconds/i);
  assert.ok(db.mutations.some((m) => /status='retry'/i.test(m.query) && m.values.includes('Temporary error')));
});

test('delivery schema hot path no longer drops or recreates the release fanout trigger', () => {
  const source = readFileSync(new URL('../src/telegram-subscription-delivery-schema.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /DROP TRIGGER/i);
  assert.doesNotMatch(source, /CREATE TRIGGER/i);
});
