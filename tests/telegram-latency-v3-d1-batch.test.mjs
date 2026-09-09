import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTelegramNotificationUxUpdate } from '../dist-runtime/telegram-notification-ux-runtime.js';

const normalize = (query) => String(query).replace(/\s+/g, ' ').trim();

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = normalize(query);
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    this.db.directFirstQueries.push(this.query);
    return this.db.executeFirst(this);
  }

  async all() {
    return { results: [] };
  }

  async run() {
    return { meta: { changes: 0 } };
  }
}

class DB {
  constructor({ allTitles = false } = {}) {
    this.allTitles = allTitles;
    this.batchCalls = 0;
    this.batchQueries = [];
    this.directFirstQueries = [];
  }

  prepare(query) {
    return new Statement(this, query);
  }

  async batch(statements) {
    this.batchCalls += 1;
    this.batchQueries.push(statements.map((statement) => statement.query));
    return statements.map((statement) => {
      const row = this.executeFirst(statement);
      return { results: row ? [row] : [] };
    });
  }

  executeFirst(statement) {
    const query = statement.query;
    if (query.includes('FROM ranobelib_titles') && query.includes('WHERE ranobelib_id = ?')) {
      return {
        ranobelib_id: 1000,
        book_ref: '1000--one',
        title: 'Книга 1',
        url: 'https://ranobelib.me/ru/book/1000--one',
      };
    }
    if (query.includes('SELECT all_titles FROM telegram_subscription_settings')) {
      return { all_titles: this.allTitles ? 1 : 0 };
    }
    if (query.includes('SELECT delivery_mode, stack_size FROM telegram_subscription_settings')) {
      return { delivery_mode: 'stack', stack_size: 10 };
    }
    if (query.includes('FROM telegram_title_delivery_settings') && query.includes('SELECT delivery_mode')) {
      return null;
    }
    if (query.includes('COUNT(*) AS count FROM telegram_title_delivery_settings')) return { count: 2 };
    if (query.includes('COUNT(*) AS count FROM ranobelib_titles')) return { count: 12 };
    if (query.includes('COUNT(*) AS count FROM title_subscription_exclusions')) return { count: 1 };
    if (query.includes('COUNT(*) AS count FROM title_subscriptions')) return { count: 3 };
    if (query.includes('SELECT 1 AS subscribed FROM title_subscriptions')) return { subscribed: 1 };
    if (query.includes('SELECT 1 AS excluded FROM title_subscription_exclusions')) return null;
    if (query.includes('SUM(r.chapter_count)')) return { count: 4 };
    return null;
  }
}

function callback(data, text) {
  return {
    callback_query: {
      id: `cb-${data}`,
      from: { id: 42, first_name: 'Reader' },
      data,
      message: {
        message_id: 9,
        chat: { id: 42, type: 'private' },
        text,
      },
    },
  };
}

async function withTelegram(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (!href.includes('api.telegram.org')) throw new Error(`unexpected upstream: ${href}`);
    const method = href.split('/').pop();
    const payload = JSON.parse(String(options.body || '{}'));
    calls.push({ method, payload });
    return Response.json({ ok: true, result: { message_id: 10 } });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function env(db) {
  return { DB: db, TELEGRAM_BOT_TOKEN: 'unit-test-token' };
}

test('notification dashboard batches independent D1 reads into one network operation', async () => {
  const db = new DB();
  await withTelegram(async () => {
    const handled = await handleTelegramNotificationUxUpdate(
      callback('subs:center', '🏠 Главное меню'),
      env(db),
    );
    assert.equal(handled, true);
  });

  assert.equal(db.batchCalls, 1);
  assert.equal(db.directFirstQueries.length, 0);
  const queries = db.batchQueries.flat().join('\n');
  assert.match(queries, /SELECT all_titles FROM telegram_subscription_settings/);
  assert.match(queries, /COUNT\(\*\) AS count FROM telegram_title_delivery_settings/);
  assert.match(queries, /COUNT\(\*\) AS count FROM title_subscriptions/);
});

test('notification title card batches subscription and delivery reads before conditional stack progress', async () => {
  const db = new DB();
  await withTelegram(async (calls) => {
    const handled = await handleTelegramNotificationUxUpdate(
      callback('subs:title:1000:a:0', '📚 Все переводы\n\nНажмите на тайтл'),
      env(db),
    );
    assert.equal(handled, true);
    const visible = calls.find((call) => call.method === 'sendMessage');
    assert.ok(visible);
    assert.match(visible.payload.text, /Накоплено: 4 \/ 10/);
  });

  assert.equal(db.batchCalls, 1);
  assert.equal(db.directFirstQueries.length, 2, 'title lookup and stack-only progress may remain outside the payload batch');
  assert.match(db.directFirstQueries[0], /FROM ranobelib_titles/);
  assert.match(db.directFirstQueries[1], /SUM\(r.chapter_count\)/);
  const queries = db.batchQueries.flat().join('\n');
  assert.match(queries, /SELECT 1 AS subscribed FROM title_subscriptions/);
  assert.match(queries, /SELECT delivery_mode, stack_size FROM telegram_subscription_settings/);
  assert.match(queries, /FROM telegram_title_delivery_settings/);
  assert.doesNotMatch(queries, /SUM\(r.chapter_count\)/);
});
