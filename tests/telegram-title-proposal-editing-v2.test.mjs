import assert from 'node:assert/strict';
import test from 'node:test';

async function loadRuntime() {
  return import('../dist-runtime/telegram-title-proposals-v2.js');
}

async function loadUi() {
  return import('../dist-runtime/telegram-title-proposal-ui.js');
}

const now = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
const proposalSession = (step = 'review', extra = {}) => ({
  user_telegram_id: '42',
  chat_id: '42',
  step,
  source_kind: 'external',
  ranobelib_book_ref: null,
  title: 'Старое название',
  original_title: '',
  source_url: 'https://novelpia.com/novel/123',
  candidates_json: '[]',
  raw_file_id: null,
  raw_file_unique_id: null,
  raw_file_name: null,
  raw_file_size: null,
  raw_mime_type: null,
  comment: 'Старый комментарий',
  return_to_review: 0,
  updated_at: now(),
  ...extra,
});

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
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
    const s = this.db.session;
    if (!s) return { meta: { changes: 0 } };

    if (this.query.includes('DELETE FROM telegram_proposal_sessions')) {
      this.db.session = null;
    } else if (this.query.includes('SET step=?,return_to_review=?')) {
      s.step = String(this.values[0]);
      s.return_to_review = Number(this.values[1]);
    } else if (this.query.includes('SET step=?,title=?,return_to_review=?')) {
      s.step = String(this.values[0]);
      s.title = String(this.values[1]);
      s.return_to_review = Number(this.values[2]);
    } else if (this.query.includes('SET step=?,source_url=?,return_to_review=?')) {
      s.step = String(this.values[0]);
      s.source_url = String(this.values[1]);
      s.return_to_review = Number(this.values[2]);
    } else if (this.query.includes('SET step=?,comment=?,return_to_review=?')) {
      s.step = String(this.values[0]);
      s.comment = String(this.values[1]);
      s.return_to_review = Number(this.values[2]);
    } else if (this.query.includes('SET step=?,ranobelib_book_ref=?,title=?,original_title=?,source_url=?')) {
      s.step = String(this.values[0]);
      s.ranobelib_book_ref = String(this.values[1]);
      s.title = String(this.values[2]);
      s.original_title = String(this.values[3]);
      s.source_url = String(this.values[4]);
    } else if (this.query.includes("SET step='review'") && this.query.includes('raw_file_id=NULL')) {
      s.step = 'review';
      s.raw_file_id = null;
      s.raw_file_unique_id = null;
      s.raw_file_name = null;
      s.raw_file_size = null;
      s.raw_mime_type = null;
      s.return_to_review = 0;
    } else if (this.query.includes('SET raw_file_id=?')) {
      s.raw_file_id = String(this.values[0]);
      s.raw_file_unique_id = String(this.values[1]);
      s.raw_file_name = String(this.values[2]);
      s.raw_file_size = this.values[3];
      s.raw_mime_type = String(this.values[4]);
    } else if (this.query.includes('SET ranobelib_book_ref=?')) {
      s.ranobelib_book_ref = String(this.values[0]);
    }
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor(session = null) { this.session = session; this.runs = []; }
  prepare(query) { return new Statement(this, query); }
}

function env(session = null) {
  return {
    DB: new DB(session),
    TELEGRAM_BOT_TOKEN: 'unit-test-token',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
  };
}

function messageRequest(text) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({
      message: {
        message_id: 5,
        chat: { id: 42, type: 'private' },
        from: { id: 42, first_name: 'Reader' },
        text,
      },
    }),
  });
}

function callbackRequest(data) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({
      callback_query: {
        id: 'cb-edit-v2',
        from: { id: 42, first_name: 'Reader' },
        data,
        message: { message_id: 9, chat: { id: 42, type: 'private' } },
      },
    }),
  });
}

async function withNetwork(fn, options = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, requestOptions = {}) => {
    const href = String(url);
    if (href.includes('api.telegram.org')) {
      calls.push({ method: href.split('/').pop(), payload: JSON.parse(String(requestOptions.body || '{}')) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.includes('api.cdnlibs.org')) {
      if (options.ranobelibFailure) {
        return new Response(JSON.stringify({ message: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.includes('/chapters')) {
        return new Response(JSON.stringify({ data: [{ number: '12', name: 'Глава 12', index: 12 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        data: {
          id: 777,
          slug: 'test-title',
          slug_url: '777--test-title',
          rus_name: 'Новый RanobeLib тайтл',
          name: 'New RanobeLib Title',
          scanlateStatus: { label: 'Онгоинг' },
          teams: [{ name: 'Дом Некроманта' }],
          items_count: { uploaded: 12 },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected network call: ${href}`);
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

const flatButtons = (call) => call.payload.reply_markup.inline_keyboard.flat();
const callbacks = (call) => flatButtons(call).map((button) => button.callback_data).filter(Boolean);
const latestVisibleCall = (calls) => [...calls].reverse().find((call) => (
  call.method === 'sendMessage' || call.method === 'editMessageText'
));

test('review exposes four field-level edit buttons instead of a generic edit action', async () => {
  const { buildProposalReview } = await loadUi();
  const payload = buildProposalReview(proposalSession());
  const data = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(data.includes('prop:edit:title'));
  assert.ok(data.includes('prop:edit:source'));
  assert.ok(data.includes('prop:edit:raw'));
  assert.ok(data.includes('prop:edit:comment'));
  assert.equal(data.includes('prop:edit'), false);
});

test('external title edit reuses input step and returns directly to review', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession());
  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:edit:title'), state);
    assert.equal(response?.status, 200);
    assert.equal(state.DB.session.step, 'external_title');
    assert.equal(state.DB.session.return_to_review, 1);
    const visible = latestVisibleCall(calls);
    assert.match(visible.payload.text, /название новеллы/i);
  });
  await withNetwork(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(messageRequest('Новое название'), state);
    assert.equal(state.DB.session.title, 'Новое название');
    assert.equal(state.DB.session.step, 'review');
    assert.equal(state.DB.session.return_to_review, 0);
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.match(send.payload.text, /Проверка заявки/);
    assert.match(send.payload.text, /Новое название/);
  });
});

test('external source and comment edits return to review while Back from an edit cancels only the edit', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession());

  await withNetwork(async () => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:edit:source'), state);
    assert.equal(state.DB.session.step, 'external_url');
    assert.equal(state.DB.session.return_to_review, 1);
  });
  await withNetwork(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:back'), state);
    assert.equal(state.DB.session.step, 'review');
    assert.equal(state.DB.session.return_to_review, 0);
    assert.equal(state.DB.session.source_url, 'https://novelpia.com/novel/123');
    const visible = latestVisibleCall(calls);
    assert.match(visible.payload.text, /Проверка заявки/);
  });

  await withNetwork(async () => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:edit:source'), state);
  });
  await withNetwork(async () => {
    await handleTelegramTitleProposalV2WebhookRequest(messageRequest('https://example.com/new-source'), state);
    assert.equal(state.DB.session.source_url, 'https://example.com/new-source');
    assert.equal(state.DB.session.step, 'review');
    assert.equal(state.DB.session.return_to_review, 0);
  });

  await withNetwork(async () => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:edit:comment'), state);
  });
  await withNetwork(async () => {
    await handleTelegramTitleProposalV2WebhookRequest(messageRequest('Новый комментарий'), state);
    assert.equal(state.DB.session.comment, 'Новый комментарий');
    assert.equal(state.DB.session.step, 'review');
    assert.equal(state.DB.session.return_to_review, 0);
  });
});

test('RAW edit can clear the existing attachment and return to review', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession('review', {
    raw_file_id: 'file-1',
    raw_file_unique_id: 'uniq-1',
    raw_file_name: 'old.epub',
    raw_file_size: 1024,
    raw_mime_type: 'application/epub+zip',
  }));
  await withNetwork(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:edit:raw'), state);
    assert.equal(state.DB.session.step, 'raw');
    assert.equal(state.DB.session.return_to_review, 1);
    const visible = latestVisibleCall(calls);
    assert.ok(callbacks(visible).includes('prop:raw:clear'));
  });
  await withNetwork(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:raw:clear'), state);
    assert.equal(state.DB.session.step, 'review');
    assert.equal(state.DB.session.return_to_review, 0);
    assert.equal(state.DB.session.raw_file_id, null);
    const visible = latestVisibleCall(calls);
    assert.match(visible.payload.text, /RAW: нет/);
  });
});

test('RanobeLib title edit can reselect a title and confirm back into review', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession('review', {
    source_kind: 'ranobelib',
    ranobelib_book_ref: '111--old-title',
    source_url: 'https://ranobelib.me/ru/book/111--old-title',
  }));
  await withNetwork(async () => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:edit:title'), state);
    assert.equal(state.DB.session.step, 'ranobelib_query');
    assert.equal(state.DB.session.return_to_review, 1);
  });
  await withNetwork(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(messageRequest('https://ranobelib.me/ru/book/777--test-title'), state);
    assert.equal(state.DB.session.step, 'ranobelib_confirm');
    assert.equal(state.DB.session.ranobelib_book_ref, '777--test-title');
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.match(send.payload.text, /Новый RanobeLib тайтл/);
  });
  await withNetwork(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:confirm'), state);
    assert.equal(state.DB.session.step, 'review');
    assert.equal(state.DB.session.return_to_review, 0);
    const visible = latestVisibleCall(calls);
    assert.match(visible.payload.text, /Проверка заявки/);
  });
});

test('RanobeLib detail failure renders Retry, Change query, Back and Home while preserving the draft', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession('ranobelib_query', {
    source_kind: 'ranobelib',
    title: '',
    source_url: '',
    candidates_json: JSON.stringify([{ id: 777, slug: 'test-title', slug_url: '777--test-title', rus_name: 'Тестовый тайтл' }]),
  }));
  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:pick:0'), state);
    assert.equal(response?.status, 200);
    assert.equal(state.DB.session.ranobelib_book_ref, '777--test-title');
    assert.equal(state.DB.session.step, 'ranobelib_query');
    const visible = latestVisibleCall(calls);
    assert.ok(visible, 'network failure should replace the screen with recovery actions');
    assert.match(visible.payload.text, /не удалось|не отвечает/i);
    const data = callbacks(visible);
    assert.ok(data.includes('prop:retry:ranobelib'));
    assert.ok(data.includes('prop:query:again'));
    assert.ok(data.includes('prop:back'));
    assert.ok(data.includes('prop:home'));
  }, { ranobelibFailure: true });
});

test('stale proposal callback renders Start again and Home instead of falling through', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(null);
  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:resume'), state);
    assert.equal(response?.status, 200);
    const visible = latestVisibleCall(calls);
    assert.ok(visible);
    assert.match(visible.payload.text, /устарел|не найден/i);
    const data = callbacks(visible);
    assert.ok(data.includes('prop:start:again'));
    assert.ok(data.includes('prop:home'));
  });
});
