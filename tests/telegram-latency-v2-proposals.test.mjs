import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTelegramTitleProposalV2WebhookRequest } from '../dist-runtime/telegram-title-proposals-v2.js';

const normalize = (value) => String(value).replace(/\s+/g, ' ').trim();

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const session = (step = 'raw') => ({
  user_telegram_id: '42',
  chat_id: '42',
  step,
  source_kind: 'external',
  ranobelib_book_ref: null,
  title: 'Тестовая новелла',
  original_title: '',
  source_url: 'https://example.com/source',
  candidates_json: JSON.stringify([{ id: 101, slug: 'test-title', rus_name: 'Тестовый тайтл' }]),
  raw_file_id: null,
  raw_file_unique_id: null,
  raw_file_name: null,
  raw_file_size: null,
  raw_mime_type: null,
  comment: '',
  return_to_review: 0,
  input_active: 1,
  updated_at: '2026-09-09 12:00:00',
});

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = normalize(query);
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async run() {
    if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/.test(this.query)) return { meta: { changes: 0 } };
    if (this.query.startsWith('INSERT INTO users')) {
      this.db.events.push('d1:user-upsert');
      await this.db.preworkGate.promise;
      return { meta: { changes: 1 } };
    }
    if (this.query.includes('DELETE FROM telegram_notification_search_state')) {
      this.db.events.push('d1:cleanup-search');
      await this.db.preworkGate.promise;
      return { meta: { changes: 1 } };
    }
    if (this.query.includes('DELETE FROM telegram_notification_input_state')) {
      this.db.events.push('d1:cleanup-custom');
      return { meta: { changes: 1 } };
    }
    this.db.events.push('d1:business-write');
    return { meta: { changes: 1 } };
  }
  async first() {
    this.db.events.push('d1:first');
    if (this.query.includes('FROM telegram_proposal_sessions')) return this.db.session;
    return null;
  }
  async all() { this.db.events.push('d1:all'); return { results: [] }; }
}

class DB {
  constructor(step) {
    this.session = session(step);
    this.events = [];
    this.preworkGate = deferred();
  }
  prepare(query) { return new Statement(this, query); }
}

function callbackRequest(data) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'secret',
    },
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

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function runClaimedCallback(data, step = 'raw') {
  const db = new DB(step);
  const waits = [];
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = String(url).split('/').pop();
    calls.push({ method, payload: JSON.parse(String(options.body || '{}')) });
    db.events.push(`telegram:${method}`);
    return Response.json({ ok: true, result: { message_id: 10 } });
  };
  try {
    let settled = false;
    const handling = handleTelegramTitleProposalV2WebhookRequest(
      callbackRequest(data),
      { DB: db, TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_WEBHOOK_SECRET: 'secret' },
      { waitUntil(promise) { waits.push(promise); } },
    ).then((response) => { settled = true; return response; });

    await flush();
    return { db, waits, calls, handling, settled, restore: () => { globalThis.fetch = originalFetch; } };
  } catch (error) {
    globalThis.fetch = originalFetch;
    throw error;
  }
}

for (const [data, step] of [
  ['prop:home', 'raw'],
  ['prop:new', 'raw'],
  ['prop:resume', 'raw'],
  ['prop:back', 'comment'],
  ['prop:results:0', 'ranobelib_query'],
]) {
  test(`${data} starts exactly one callback ack before proposal D1 prework`, async () => {
    const state = await runClaimedCallback(data, step);
    try {
      assert.equal(state.calls.filter((call) => call.method === 'answerCallbackQuery').length, 1,
        `expected one early ack; events=${JSON.stringify(state.db.events)}`);
      const ackIndex = state.db.events.indexOf('telegram:answerCallbackQuery');
      const d1Index = state.db.events.findIndex((event) => event.startsWith('d1:'));
      assert.ok(ackIndex >= 0 && (d1Index < 0 || ackIndex < d1Index),
        `ack must begin before first D1; events=${JSON.stringify(state.db.events)}`);
      assert.equal(state.settled, false);

      state.db.preworkGate.resolve();
      const response = await state.handling;
      await Promise.all(state.waits);
      assert.equal(response?.status, 200);
      assert.equal(state.calls.filter((call) => call.method === 'answerCallbackQuery').length, 1,
        `handled callback must never double-ack; events=${JSON.stringify(state.db.events)}`);
    } finally {
      state.db.preworkGate.resolve();
      await state.handling.catch(() => undefined);
      state.restore();
    }
  });
}

test('proposal callback starts user upsert and transient cleanup concurrently after schema readiness', async () => {
  const state = await runClaimedCallback('prop:home', 'raw');
  try {
    assert.ok(state.db.events.includes('d1:user-upsert'), `user touch must start; events=${JSON.stringify(state.db.events)}`);
    assert.ok(state.db.events.includes('d1:cleanup-search'), `cleanup must start without waiting for user upsert; events=${JSON.stringify(state.db.events)}`);
    assert.equal(state.settled, false);
    state.db.preworkGate.resolve();
    assert.equal((await state.handling)?.status, 200);
    await Promise.all(state.waits);
  } finally {
    state.db.preworkGate.resolve();
    await state.handling.catch(() => undefined);
    state.restore();
  }
});
