import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTelegramTitleProposalV2WebhookRequest } from '../dist-runtime/telegram-title-proposals-v2.js';

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = String(query).replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (this.query.includes('FROM telegram_proposal_sessions')) return this.db.session;
    return null;
  }
  async all() { return { results: [] }; }
  async run() {
    this.db.runs.push({ query: this.query, values: this.values });
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor(session) {
    this.session = session;
    this.runs = [];
  }
  prepare(query) { return new Statement(this, query); }
}

const candidates = Array.from({ length: 8 }, (_, index) => ({
  id: 100 + index,
  name: `Book ${index + 1}`,
  rus_name: `Книга ${index + 1}`,
  slug: `book-${index + 1}`,
  slug_url: `${100 + index}--book-${index + 1}`,
}));

function session(extra = {}) {
  return {
    user_telegram_id: '42',
    chat_id: '42',
    step: 'ranobelib_query',
    source_kind: 'ranobelib',
    ranobelib_book_ref: null,
    title: '',
    original_title: '',
    source_url: '',
    candidates_json: JSON.stringify(candidates),
    raw_file_id: null,
    raw_file_unique_id: null,
    raw_file_name: null,
    raw_file_size: null,
    raw_mime_type: null,
    comment: '',
    return_to_review: 0,
    input_active: 1,
    updated_at: new Date().toISOString(),
    ...extra,
  };
}

function env(db) {
  return {
    DB: db,
    TELEGRAM_BOT_TOKEN: 'unit-test-token',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
  };
}

function callbackRequest(data, text) {
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
        message: {
          message_id: 9,
          chat: { id: 42, type: 'private' },
          text,
        },
      },
    }),
  });
}

function telegramCallbacks(call) {
  return (call?.payload?.reply_markup?.inline_keyboard ?? [])
    .flat()
    .map((button) => button.callback_data)
    .filter(Boolean);
}

async function withFetch(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('api.telegram.org')) {
      const method = href.split('/').pop();
      const payload = JSON.parse(String(options.body || '{}'));
      calls.push({ kind: 'telegram', method, payload });
      return Response.json({ ok: true, result: { message_id: 50 } });
    }
    throw new Error(`unexpected upstream: ${href}`);
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

test('proposal semantic transitions replace while candidate pagination edits in place', async () => {
  await withFetch(async (calls) => {
    const db = new DB(session({ step: 'choose_source', source_kind: null }));
    const response = await handleTelegramTitleProposalV2WebhookRequest(
      callbackRequest('prop:source:ranobelib', '📚 Предложить новеллу\nШаг 1 из 5'),
      env(db),
    );
    assert.equal(response?.status, 200);
    assert.ok(calls.some((call) => call.kind === 'telegram' && call.method === 'sendMessage'));
    assert.ok(calls.some((call) => call.kind === 'telegram' && call.method === 'deleteMessage'));
    assert.equal(calls.some((call) => call.kind === 'telegram' && call.method === 'editMessageText'), false);
  });

  await withFetch(async (calls) => {
    const db = new DB(session());
    const response = await handleTelegramTitleProposalV2WebhookRequest(
      callbackRequest('prop:results:1', '<b>🔎 Найдено несколько вариантов</b>\n\nВыберите нужный тайтл:'),
      env(db),
    );
    assert.equal(response?.status, 200);
    assert.ok(calls.some((call) => call.kind === 'telegram' && call.method === 'editMessageText'));
    assert.equal(calls.some((call) => call.kind === 'telegram' && call.method === 'sendMessage'), false);
  });
});

test('candidate pick renders a button-free loading screen before RanobeLib starts, then edits that loading message', async () => {
  const original = globalThis.fetch;
  const calls = [];
  let releaseUpstream;
  const upstreamGate = new Promise((resolve) => { releaseUpstream = resolve; });

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('api.telegram.org')) {
      const method = href.split('/').pop();
      const payload = JSON.parse(String(options.body || '{}'));
      calls.push({ kind: 'telegram', method, payload });
      return Response.json({ ok: true, result: { message_id: 50 } });
    }
    if (href.startsWith('https://api.cdnlibs.org/')) {
      calls.push({ kind: 'ranobelib', url: href });
      await upstreamGate;
      if (href.includes('/chapters')) {
        return Response.json({ data: [{ number: '7', name: 'Глава 7', index: 7 }] });
      }
      return Response.json({
        data: {
          id: 100,
          name: 'Book 1',
          rus_name: 'Книга 1',
          slug: 'book-1',
          slug_url: '100--book-1',
          status: { label: 'Онгоинг' },
          items_count: { uploaded: 7 },
          teams: [],
        },
      });
    }
    throw new Error(`unexpected upstream: ${href}`);
  };

  try {
    const db = new DB(session());
    const pending = handleTelegramTitleProposalV2WebhookRequest(
      callbackRequest('prop:pick:0', '<b>🔎 Найдено несколько вариантов</b>\n\nВыберите нужный тайтл:'),
      env(db),
    );

    for (let i = 0; i < 20 && !calls.some((call) => call.kind === 'ranobelib'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const upstreamIndex = calls.findIndex((call) => call.kind === 'ranobelib');
    assert.ok(upstreamIndex >= 0, 'RanobeLib request should start');
    const loadingIndex = calls.findIndex((call) => (
      call.kind === 'telegram'
      && call.method === 'sendMessage'
      && /загружа|проверя|получа.*ranobelib/i.test(String(call.payload.text ?? ''))
    ));
    assert.ok(loadingIndex >= 0, 'loading screen must be visible');
    assert.ok(loadingIndex < upstreamIndex, 'loading must be sent before upstream fetch starts');
    const loading = calls[loadingIndex];
    assert.deepEqual(telegramCallbacks(loading), [], 'loading screen must not keep stale actions');

    releaseUpstream();
    const response = await pending;
    assert.equal(response?.status, 200);

    const finalEdit = calls.find((call) => (
      call.kind === 'telegram'
      && call.method === 'editMessageText'
      && call.payload.message_id === 50
      && /Книга 1/.test(String(call.payload.text ?? ''))
    ));
    assert.ok(finalEdit, 'final confirmation must edit the loading message, not the stale candidate message');
  } finally {
    releaseUpstream?.();
    globalThis.fetch = original;
  }
});
