import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTelegramTitleProposalWebhookRequest } from '../dist-runtime/telegram-title-proposals.js';

class SessionStatement {
  constructor(db, query) { this.db = db; this.query = query.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (this.query.includes('FROM telegram_proposal_sessions')) return this.db.session;
    return null;
  }
  async all() { return { results: [] }; }
  async run() {
    this.db.runs.push({ query: this.query, values: this.values });
    if (this.query.includes('DELETE FROM telegram_proposal_sessions')) this.db.session = null;
    return { meta: { changes: 1 } };
  }
}

class SessionDb {
  constructor(session) { this.session = session; this.runs = []; }
  prepare(query) { return new SessionStatement(this, query); }
}

const now = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
const session = (step, extra = {}) => ({
  user_telegram_id: '42',
  chat_id: '42',
  step,
  source_kind: 'external',
  ranobelib_book_ref: null,
  title: 'Тестовая новелла',
  original_title: '',
  source_url: '',
  candidates_json: '[]',
  raw_file_id: null,
  raw_file_unique_id: null,
  raw_file_name: null,
  raw_file_size: null,
  raw_mime_type: null,
  comment: '',
  updated_at: now(),
  ...extra,
});

function makeEnv(step, extra = {}) {
  return {
    DB: new SessionDb(session(step, extra)),
    TELEGRAM_BOT_TOKEN: 'unit-test-token',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
  };
}

function messageRequest({ text, document }) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({
      update_id: 10,
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
      update_id: 11,
      callback_query: {
        id: 'cb-ext',
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
    calls.push({ method: String(url).split('/').pop(), payload: JSON.parse(String(options.body || '{}')) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

function updatedStep(env) {
  const update = env.DB.runs.find((item) => item.query.includes('UPDATE telegram_proposal_sessions'));
  return update?.values?.[0];
}

test('external title text advances to original-source URL step', async () => {
  const env = makeEnv('external_title', { title: '' });
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(messageRequest({ text: 'Моя новая новелла' }), env);
    assert.equal(response?.status, 200);
    assert.equal(updatedStep(env), 'external_url');
    const update = env.DB.runs.find((item) => item.query.includes('UPDATE telegram_proposal_sessions'));
    assert.ok(update.values.includes('Моя новая новелла'));
    assert.match(calls.find((call) => call.method === 'sendMessage').payload.text, /ссылку на страницу оригинала|официальный источник/i);
  });
});

test('external source URL must be HTTP(S) and invalid input keeps the same step', async () => {
  const env = makeEnv('external_url');
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(messageRequest({ text: 'novelpia-title-123' }), env);
    assert.equal(response?.status, 200);
    assert.equal(env.DB.runs.some((item) => item.query.includes('UPDATE telegram_proposal_sessions')), false);
    assert.match(calls.find((call) => call.method === 'sendMessage').payload.text, /http:\/\/|https:\/\//i);
  });
});

test('valid external source URL advances to RAW file step', async () => {
  const env = makeEnv('external_url');
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(messageRequest({ text: 'https://novelpia.com/novel/123' }), env);
    assert.equal(response?.status, 200);
    assert.equal(updatedStep(env), 'raw');
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.match(send.payload.text, /RAW.*отправь файл/is);
    assert.equal(send.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prop:raw:skip');
  });
});

test('RAW step never accepts a URL or ordinary text as a file substitute', async () => {
  const env = makeEnv('raw', { source_url: 'https://novelpia.com/novel/123' });
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(messageRequest({ text: 'https://files.example/raw.epub' }), env);
    assert.equal(response?.status, 200);
    assert.equal(env.DB.runs.some((item) => item.query.includes('UPDATE telegram_proposal_sessions')), false);
    assert.match(calls.find((call) => call.method === 'sendMessage').payload.text, /именно файлом/i);
  });
});

test('supported Telegram RAW document up to 20 MiB stores metadata and advances to comment', async () => {
  const env = makeEnv('raw', { source_url: 'https://novelpia.com/novel/123' });
  const document = {
    file_id: 'file-123',
    file_unique_id: 'uniq-123',
    file_name: 'novel.epub',
    mime_type: 'application/epub+zip',
    file_size: 20 * 1024 * 1024,
  };
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(messageRequest({ document }), env);
    assert.equal(response?.status, 200);
    assert.equal(updatedStep(env), 'comment');
    const update = env.DB.runs.find((item) => item.query.includes('UPDATE telegram_proposal_sessions'));
    for (const expected of ['file-123', 'uniq-123', 'novel.epub', 'application/epub+zip']) assert.ok(update.values.includes(expected));
    assert.match(calls.find((call) => call.method === 'sendMessage').payload.text, /что-нибудь добавить/i);
  });
});

test('Telegram RAW larger than getFile 20 MiB limit is rejected without advancing', async () => {
  const env = makeEnv('raw');
  const document = { file_id: 'big', file_unique_id: 'big-u', file_name: 'raw.zip', file_size: 20 * 1024 * 1024 + 1 };
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(messageRequest({ document }), env);
    assert.equal(response?.status, 200);
    assert.equal(env.DB.runs.some((item) => item.query.includes('UPDATE telegram_proposal_sessions')), false);
    assert.match(calls.find((call) => call.method === 'sendMessage').payload.text, /20 МБ/);
  });
});

test('unsupported Telegram RAW extension is rejected without advancing', async () => {
  const env = makeEnv('raw');
  const document = { file_id: 'bad', file_unique_id: 'bad-u', file_name: 'raw.exe', file_size: 1000 };
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(messageRequest({ document }), env);
    assert.equal(response?.status, 200);
    assert.equal(env.DB.runs.some((item) => item.query.includes('UPDATE telegram_proposal_sessions')), false);
    assert.match(calls.find((call) => call.method === 'sendMessage').payload.text, /формат/i);
  });
});

test('RAW can be skipped explicitly and comment can be skipped into review', async () => {
  const envRaw = makeEnv('raw', { source_url: 'https://novelpia.com/novel/123' });
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:raw:skip'), envRaw);
    assert.equal(response?.status, 200);
    assert.equal(updatedStep(envRaw), 'comment');
    assert.match(calls.find((call) => call.method === 'editMessageText').payload.text, /что-нибудь добавить/i);
  });

  const envComment = makeEnv('comment', { source_url: 'https://novelpia.com/novel/123' });
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:comment:skip'), envComment);
    assert.equal(response?.status, 200);
    assert.equal(updatedStep(envComment), 'review');
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.match(edit.payload.text, /Проверь заявку/);
    assert.match(edit.payload.text, /Тестовая новелла/);
    assert.equal(edit.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prop:submit');
  });
});

test('free-form comment advances to review and appears in summary', async () => {
  const env = makeEnv('comment', { source_url: 'https://novelpia.com/novel/123' });
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(messageRequest({ text: 'Очень хочу увидеть перевод.' }), env);
    assert.equal(response?.status, 200);
    assert.equal(updatedStep(env), 'review');
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.match(send.payload.text, /Очень хочу увидеть перевод/);
    assert.equal(send.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prop:submit');
  });
});
