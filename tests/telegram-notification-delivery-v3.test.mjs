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
    available_at: '2026-09-07 08:00:00',
    claim_token: null,
    claim_expires_at: null,
    book_ref: '77--fast-book',
    ranobelib_id: 77,
    title: 'Fast Book',
    url: 'https://ranobelib.me/ru/book/77--fast-book',
    chapter_count: 1,
    first_volume: '1',
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
      if (/o\.claim_token\s*=\s*\?/i.test(this.query)) {
        const claimToken = String(this.values[0]);
        return { results: this.db.rows.filter((row) => row.claim_token === claimToken) };
      }
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
    if (/UPDATE ranobelib_notification_outbox SET claim_token\s*=\s*\?/i.test(this.query)) {
      const claimToken = String(this.values[0]);
      const limit = Number(this.values.at(-1)) || 20;
      const releaseId = this.values.length >= 3 && typeof this.values[1] === 'string' ? String(this.values[1]) : null;
      const claimed = this.db.rows
        .filter((row) => !releaseId || row.release_id === releaseId)
        .filter((row) => row.status === 'pending' || row.status === 'retry')
        .filter((row) => !row.claim_token)
        .slice(0, limit);
      for (const row of claimed) {
        row.claim_token = claimToken;
        row.claim_expires_at = '2026-09-07 08:10:00';
      }
      return {
        success: true,
        results: claimed.map((row) => ({ release_id: row.release_id, user_telegram_id: row.user_telegram_id })),
        meta: { changes: claimed.length },
      };
    }
    if (/UPDATE ranobelib_notification_outbox SET status='sent'/i.test(this.query)) {
      this.db.setStatus(this.values, 'sent');
    } else if (/UPDATE ranobelib_notification_outbox SET status='disabled'/i.test(this.query)) {
      this.db.setStatus(this.values, 'disabled');
    } else if (/UPDATE ranobelib_notification_outbox SET status='retry'/i.test(this.query)) {
      this.db.setStatus(this.values, 'retry');
    } else if (/DELETE FROM ranobelib_notification_outbox/i.test(this.query)) {
      const releaseId = String(this.values.at(-3));
      const userId = String(this.values.at(-2));
      const claimToken = String(this.values.at(-1));
      this.db.rows = this.db.rows.filter((row) => !(
        row.release_id === releaseId
        && row.user_telegram_id === userId
        && row.claim_token === claimToken
      ));
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
    const releaseId = String(values.at(-3));
    const userId = String(values.at(-2));
    const claimToken = String(values.at(-1));
    const row = this.rows.find((item) =>
      item.release_id === releaseId
      && item.user_telegram_id === userId
      && item.claim_token === claimToken);
    if (row) {
      row.status = status;
      row.claim_token = null;
      row.claim_expires_at = null;
    }
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

test('delivery uses grouped readiness plus claimed-row eligibility without per-user subscription SELECTs', async () => {
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
  assert.equal(db.deliverySelects.length, 2);
  const readinessQuery = db.deliverySelects.find((item) => /WITH ready_groups AS/i.test(item.query))?.query;
  const claimedRowsQuery = db.deliverySelects.find((item) => /r\.first_volume/i.test(item.query))?.query;
  assert.ok(readinessQuery, 'delivery must select bounded ready user-title groups first');
  assert.ok(claimedRowsQuery, 'delivery must load claimed release metadata after group claim');
  assert.match(readinessQuery, /SUM\s*\(\s*r\.chapter_count\s*\)/i);
  assert.match(readinessQuery, /telegram_title_delivery_settings/i);
  assert.match(readinessQuery, /title_subscription_exclusions/i);
  assert.match(readinessQuery, /title_subscriptions/i);
  assert.match(readinessQuery, /telegram_delivery_reachability/i);
  assert.match(readinessQuery, /AS eligible/i);
  assert.match(claimedRowsQuery, /r\.first_volume/i);
  assert.match(claimedRowsQuery, /AS eligible/i);
  assert.equal(db.allQueries.some((sql) => /SELECT all_titles FROM telegram_subscription_settings WHERE user_telegram_id = \?/i.test(sql)), false);
  assert.equal(db.allQueries.some((sql) => /SELECT 1 AS subscribed FROM title_subscriptions WHERE user_telegram_id = \?/i.test(sql)), false);
  assert.ok(db.mutations.some((m) => /SET claim_token\s*=\s*\?/i.test(m.query)));
  assert.ok(db.mutations.some((m) => /status='sent'/i.test(m.query)));
  assert.ok(db.mutations.some((m) => /DELETE FROM ranobelib_notification_outbox/i.test(m.query)));
});

test('single chapter notification opens that chapter while batches and incomplete metadata keep the title page', async () => {
  const { drainNotificationOutbox } = await loadDelivery();

  async function sentReadUrl(row) {
    const db = new DB([row]);
    let payload = null;
    await withFetch(async (_url, init) => {
      payload = JSON.parse(init.body);
      return telegramOk();
    }, () => drainNotificationOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' }));
    return payload.reply_markup.inline_keyboard[0][0].url;
  }

  assert.equal(
    await sentReadUrl(outboxRow('100')),
    'https://ranobelib.me/ru/77--fast-book/read/v1/c2',
  );
  assert.equal(
    await sentReadUrl(outboxRow('200', { chapter_count: 2, first_number: '2', last_number: '3', summary: 'Chapters 2–3' })),
    'https://ranobelib.me/ru/book/77--fast-book',
  );
  assert.equal(
    await sentReadUrl(outboxRow('300', { first_volume: null })),
    'https://ranobelib.me/ru/book/77--fast-book',
  );
});

test('two concurrent drains atomically claim outbox rows so Telegram is called only once per recipient', async () => {
  const { drainNotificationOutbox } = await loadDelivery();
  const db = new DB([outboxRow('100'), outboxRow('200')]);
  const sentTo = [];

  const results = await withFetch(async (_url, init) => {
    const payload = JSON.parse(init.body);
    sentTo.push(String(payload.chat_id));
    await new Promise((resolve) => setTimeout(resolve, 8));
    return telegramOk();
  }, () => Promise.all([
    drainNotificationOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' }),
    drainNotificationOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' }),
  ]));

  assert.deepEqual([...sentTo].sort(), ['100', '200']);
  assert.equal(results[0].claimed + results[1].claimed, 2);
  const claim = db.mutations.find((m) => /SET claim_token\s*=\s*\?/i.test(m.query));
  assert.ok(claim, 'delivery must atomically claim before sending');
  assert.match(claim.query, /claim_expires_at/i);
  assert.match(claim.query, /RETURNING release_id, user_telegram_id/i);
  assert.ok(db.mutations.some((m) => /AND claim_token = \?/i.test(m.query)), 'final mutation must require claim ownership');
});

test('a full twenty-recipient batch sends concurrently, bounds D1 work, and writes reachability once', async () => {
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
  assert.ok(db.allQueries.length <= 24, `unexpected D1 query explosion: ${db.allQueries.length}`);
  const reachabilityMutations = db.mutations.filter((m) => /INSERT INTO telegram_delivery_reachability/i.test(m.query));
  assert.equal(reachabilityMutations.length, 1, 'twenty successful sends must share one reachability D1 write');
});

test('403 disables, 429 respects retry_after, transient errors stay retryable, and only terminal outcomes update reachability', async () => {
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

  const reachability = db.mutations.find((m) => /INSERT INTO telegram_delivery_reachability/i.test(m.query));
  assert.ok(reachability, 'delivery outcomes should persist one reachability batch');
  const reachabilityPayload = JSON.parse(reachability.values[0]);
  assert.deepEqual(reachabilityPayload, [
    { userTelegramId: '403', state: 'blocked' },
    { userTelegramId: '200', state: 'active' },
  ]);
  assert.equal(reachabilityPayload.some((item) => item.userTelegramId === '429'), false);
  assert.equal(reachabilityPayload.some((item) => item.userTelegramId === '500'), false);
  assert.equal(db.mutations.filter((m) => /UPDATE ranobelib_titles/i.test(m.query)).length, 1, '403 batch should refresh demand once');
});

test('delivery schema hot path no longer drops or recreates the release fanout trigger', () => {
  const source = readFileSync(new URL('../src/telegram-subscription-delivery-schema.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /DROP TRIGGER/i);
  assert.doesNotMatch(source, /CREATE TRIGGER/i);
});
