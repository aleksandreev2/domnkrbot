import assert from 'node:assert/strict';
import test from 'node:test';

async function loadRuntime() {
  return import('../dist-runtime/telegram-title-proposals-v2.js');
}

const now = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
const proposalSession = (step, extra = {}) => ({
  user_telegram_id: '42',
  chat_id: '42',
  step,
  source_kind: 'external',
  ranobelib_book_ref: null,
  title: 'Тестовая новелла',
  original_title: '',
  source_url: 'https://novelpia.com/novel/123',
  candidates_json: '[]',
  raw_file_id: null,
  raw_file_unique_id: null,
  raw_file_name: null,
  raw_file_size: null,
  raw_mime_type: null,
  comment: '',
  return_to_review: 0,
  input_active: 1,
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
    if (this.query.includes('INSERT INTO telegram_proposal_sessions')) {
      this.db.session = proposalSession('choose_source', {
        source_kind: null,
        title: '',
        original_title: '',
        source_url: '',
        input_active: 1,
      });
    } else if (this.query.includes('DELETE FROM telegram_proposal_sessions')) {
      this.db.session = null;
    } else if (this.query.includes('UPDATE telegram_proposal_sessions') && this.query.includes('SET input_active=?')) {
      if (this.db.session) this.db.session.input_active = Number(this.values[0]);
    } else if (this.query.includes('UPDATE telegram_proposal_sessions') && this.query.includes('SET step=?')) {
      if (this.db.session) {
        this.db.session.step = String(this.values[0]);
        if (this.query.includes('source_kind=?')) this.db.session.source_kind = String(this.values[1]);
        if (this.query.includes('title=?')) this.db.session.title = String(this.values[1]);
        if (this.query.includes('source_url=?')) this.db.session.source_url = String(this.values[1]);
      }
    } else if (this.query.includes('UPDATE telegram_proposal_sessions') && this.query.includes('raw_file_id=?')) {
      if (this.db.session) {
        this.db.session.raw_file_id = String(this.values[0]);
        this.db.session.raw_file_unique_id = String(this.values[1]);
        this.db.session.raw_file_name = String(this.values[2]);
        this.db.session.raw_file_size = this.values[3];
        this.db.session.raw_mime_type = String(this.values[4]);
      }
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

function messageRequest({ text, document } = {}) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 5,
        chat: { id: 42, type: 'private' },
        from: { id: 42, first_name: 'Reader' },
        ...(text === undefined ? {} : { text }),
        ...(document ? { document } : {}),
      },
    }),
  });
}

function callbackRequest(data) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({
      update_id: 2,
      callback_query: {
        id: 'cb-v2',
        from: { id: 42, first_name: 'Reader' },
        data,
        message: { message_id: 9, chat: { id: 42, type: 'private' } },
      },
    }),
  });
}

async function withTelegramCalls(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (!href.includes('api.telegram.org')) throw new Error(`Unexpected network call: ${href}`);
    calls.push({ method: href.split('/').pop(), payload: JSON.parse(String(options.body || '{}')) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

const flatButtons = (call) => call.payload.reply_markup.inline_keyboard.flat();
const latestVisibleCall = (calls) => [...calls].reverse().find((call) => (
  call.method === 'sendMessage' || call.method === 'editMessageText'
));

test('v2 /start renders the neutral root menu without a skull', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env();
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalV2WebhookRequest(messageRequest({ text: '/start' }), state);
    assert.equal(response?.status, 200);
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.ok(send);
    assert.match(send.payload.text, /Дом Некроманта/);
    assert.equal(send.payload.text.includes('☠️'), false);
    const buttons = flatButtons(send);
    assert.ok(buttons.some((button) => button.callback_data === 'prop:notifications'));
    assert.ok(buttons.some((button) => button.callback_data === 'prop:new'));
    assert.ok(buttons.some((button) => button.callback_data === 'prop:mine'));
  });
});

test('/start pauses a stored draft and clears transient notification text capture', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession('external_title'));
  await withTelegramCalls(async () => {
    const response = await handleTelegramTitleProposalV2WebhookRequest(messageRequest({ text: '/start' }), state);
    assert.equal(response?.status, 200);
    assert.equal(state.DB.session.input_active, 0);
    assert.ok(state.DB.runs.some((run) => run.query.includes('DELETE FROM telegram_notification_search_state')));
    assert.ok(state.DB.runs.some((run) => run.query.includes('DELETE FROM telegram_notification_input_state')));
  });
});

test('prop:new offers to resume a meaningful draft instead of resetting it and pauses free-text input', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession('raw'));
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:new'), state);
    assert.equal(response?.status, 200);
    assert.equal(state.DB.runs.some((run) => run.query.includes('INSERT INTO telegram_proposal_sessions')), false);
    assert.equal(state.DB.session.input_active, 0);
    const visible = latestVisibleCall(calls);
    assert.match(visible.payload.text, /незавершённая заявка/i);
    const callbacks = flatButtons(visible).map((button) => button.callback_data);
    assert.ok(callbacks.includes('prop:resume'));
    assert.ok(callbacks.includes('prop:cancel'));
    assert.ok(callbacks.includes('prop:home'));
  });
});

test('Home pauses the current draft so later free text cannot mutate it', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const originalSession = proposalSession('external_title', {
    title: '',
    source_url: '',
    comment: 'Черновик',
  });
  const state = env(originalSession);
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:home'), state);
    assert.equal(response?.status, 200);
    assert.equal(state.DB.runs.some((run) => run.query.includes('DELETE FROM telegram_proposal_sessions')), false);
    assert.equal(state.DB.session, originalSession);
    assert.equal(state.DB.session.input_active, 0);
    const visible = latestVisibleCall(calls);
    assert.match(visible.payload.text, /Дом Некроманта/);
  });

  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalV2WebhookRequest(messageRequest({ text: 'Это не должно стать названием' }), state);
    assert.equal(response?.status, 200, 'paused draft should absorb stray text so legacy proposal routing cannot mutate it');
    assert.equal(state.DB.session.step, 'external_title');
    assert.equal(state.DB.session.title, '');
    assert.equal(calls.length, 0);
  });
});

test('Resume reactivates a paused draft and the next valid input advances it', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession('external_title', {
    title: '',
    source_url: '',
    input_active: 0,
  }));

  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:resume'), state);
    assert.equal(response?.status, 200);
    assert.equal(state.DB.session.input_active, 1);
    const visible = latestVisibleCall(calls);
    assert.match(visible.payload.text, /Шаг 2 из 5/);
  });

  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalV2WebhookRequest(messageRequest({ text: 'Новое название' }), state);
    assert.equal(response?.status, 200);
    assert.equal(state.DB.session.step, 'external_url');
    assert.equal(state.DB.session.title, 'Новое название');
    assert.ok(calls.some((call) => call.method === 'sendMessage'));
  });
});

test('Resume renders the stored phase and Back moves one logical step without deleting entered data', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const original = proposalSession('comment', { title: 'Сохранённый тайтл', comment: 'Черновик' });
  const state = env(original);
  await withTelegramCalls(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:resume'), state);
    const resume = latestVisibleCall(calls);
    assert.match(resume.payload.text, /Шаг 4 из 5/);
    assert.match(resume.payload.text, /Комментарий/);
  });
  await withTelegramCalls(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:back'), state);
    assert.equal(state.DB.session.step, 'raw');
    assert.equal(state.DB.session.title, 'Сохранённый тайтл');
    assert.equal(state.DB.session.comment, 'Черновик');
    assert.equal(state.DB.runs.some((run) => run.query.includes('DELETE FROM telegram_proposal_sessions')), false);
    const visible = latestVisibleCall(calls);
    assert.match(visible.payload.text, /Шаг 3 из 5/);
    assert.match(visible.payload.text, /RAW/);
  });
});

test('meaningful draft cancellation pauses input, requires confirmation and only confirmed cancellation deletes it', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession('raw'));
  await withTelegramCalls(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:cancel'), state);
    assert.ok(state.DB.session);
    assert.equal(state.DB.session.input_active, 0);
    assert.equal(state.DB.runs.some((run) => run.query.includes('DELETE FROM telegram_proposal_sessions')), false);
    const visible = latestVisibleCall(calls);
    assert.match(visible.payload.text, /Удалить черновик заявки/);
    const callbacks = flatButtons(visible).map((button) => button.callback_data);
    assert.ok(callbacks.includes('prop:cancel:confirm'));
    assert.ok(callbacks.includes('prop:cancel:keep'));
  });
  await withTelegramCalls(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:cancel:keep'), state);
    assert.equal(state.DB.session.input_active, 1);
    assert.ok(latestVisibleCall(calls));
  });
  await withTelegramCalls(async () => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:cancel'), state);
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:cancel:confirm'), state);
    assert.equal(state.DB.session, null);
    assert.ok(state.DB.runs.some((run) => run.query.includes('DELETE FROM telegram_proposal_sessions')));
  });
});

test('source choice uses visible phase 2 and safe navigation buttons', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession('choose_source', { source_kind: null, title: '', source_url: '' }));
  await withTelegramCalls(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:source:external'), state);
    assert.equal(state.DB.session.step, 'external_title');
    const visible = latestVisibleCall(calls);
    assert.match(visible.payload.text, /Шаг 2 из 5/);
    assert.match(visible.payload.text, /название новеллы/i);
    const callbacks = flatButtons(visible).map((button) => button.callback_data);
    assert.ok(callbacks.includes('prop:back'));
    assert.ok(callbacks.includes('prop:home'));
    assert.ok(callbacks.includes('prop:cancel'));
  });
});

test('successful RAW upload shows filename and size before continuing', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession('raw'));
  const document = {
    file_id: 'file-1',
    file_unique_id: 'uniq-1',
    file_name: 'novel.epub',
    mime_type: 'application/epub+zip',
    file_size: 14 * 1024 * 1024 + 300 * 1024,
  };
  await withTelegramCalls(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(messageRequest({ document }), state);
    assert.equal(state.DB.session.step, 'raw');
    assert.equal(state.DB.session.raw_file_name, 'novel.epub');
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.match(send.payload.text, /RAW добавлен/);
    assert.match(send.payload.text, /novel\.epub/);
    assert.match(send.payload.text, /14\.3 МБ/);
    const callbacks = flatButtons(send).map((button) => button.callback_data);
    assert.ok(callbacks.includes('prop:raw:continue'));
    assert.ok(callbacks.includes('prop:raw:replace'));
    assert.ok(callbacks.includes('prop:back'));
  });
});

test('skipping comment enters visible review phase 5', async () => {
  const { handleTelegramTitleProposalV2WebhookRequest } = await loadRuntime();
  const state = env(proposalSession('comment'));
  await withTelegramCalls(async (calls) => {
    await handleTelegramTitleProposalV2WebhookRequest(callbackRequest('prop:comment:skip'), state);
    assert.equal(state.DB.session.step, 'review');
    const visible = latestVisibleCall(calls);
    assert.match(visible.payload.text, /Шаг 5 из 5/);
    assert.match(visible.payload.text, /Проверка заявки/);
  });
});
