import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { handleTelegramTitleProposalWebhookRequest } from '../dist-runtime/telegram-title-proposals.js';

class RecordingStatement {
  constructor(db, query) { this.db = db; this.query = query.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() { this.db.runs.push({ query: this.query, values: this.values }); return { meta: { changes: 1 } }; }
  async first() { return null; }
  async all() { return { results: [] }; }
}

class RecordingDb {
  constructor() { this.runs = []; }
  prepare(query) { return new RecordingStatement(this, query); }
}

function makeEnv() {
  return {
    DB: new RecordingDb(),
    TELEGRAM_BOT_TOKEN: 'unit-test-token',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
  };
}

function telegramRequest(text, secret = 'secret') {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify({
      update_id: 1,
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
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'secret',
    },
    body: JSON.stringify({
      update_id: 2,
      callback_query: {
        id: 'cb-1',
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
    calls.push({ method: href.split('/').pop(), payload: JSON.parse(String(options.body || '{}')) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

test('plain /start opens the Dom Nekromanta main menu', async () => {
  const env = makeEnv();
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(telegramRequest('/start'), env);
    assert.equal(response?.status, 200);
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.ok(send);
    assert.equal(send.payload.chat_id, 42);
    assert.match(send.payload.text, /Дом Некроманта/);
    const rows = send.payload.reply_markup.inline_keyboard;
    assert.equal(rows[0][0].callback_data, 'prop:new');
    assert.equal(rows[1][0].callback_data, 'prop:notifications');
    assert.equal(rows[1][1].callback_data, 'prop:mine');
    assert.equal(rows[2][0].url, 'https://bot.example/');
  });
});

test('invalid Telegram webhook secret is not claimed by the proposal handler', async () => {
  const env = makeEnv();
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(telegramRequest('/start', 'wrong'), env);
    assert.equal(response, null);
    assert.equal(calls.length, 0);
  });
});

test('/propose starts a resumable source-choice session', async () => {
  const env = makeEnv();
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(telegramRequest('/propose'), env);
    assert.equal(response?.status, 200);
    assert.ok(env.DB.runs.some((item) => item.query.includes('INSERT INTO users')));
    const session = env.DB.runs.find((item) => item.query.includes('INSERT INTO telegram_proposal_sessions'));
    assert.ok(session);
    assert.ok(session.values.includes('choose_source'));
    const send = calls.find((call) => call.method === 'sendMessage');
    assert.match(send.payload.text, /Есть ли эта новелла на RanobeLib/);
    const rows = send.payload.reply_markup.inline_keyboard;
    assert.equal(rows[0][0].callback_data, 'prop:source:ranobelib');
    assert.equal(rows[1][0].callback_data, 'prop:source:external');
  });
});

test('prop:new starts the same source-choice flow from the main menu', async () => {
  const env = makeEnv();
  await withTelegramCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:new'), env);
    assert.equal(response?.status, 200);
    const session = env.DB.runs.find((item) => item.query.includes('INSERT INTO telegram_proposal_sessions'));
    assert.ok(session);
    assert.ok(session.values.includes('choose_source'));
    assert.ok(calls.some((call) => call.method === 'editMessageText'));
    assert.ok(calls.some((call) => call.method === 'answerCallbackQuery'));
  });
});

test('source callbacks advance the server-side session to the correct text step', async () => {
  for (const [callback, expectedStep, expectedText] of [
    ['prop:source:ranobelib', 'ranobelib_query', /ссылку на карточку RanobeLib или напиши название/],
    ['prop:source:external', 'external_title', /Напиши название новеллы/],
  ]) {
    const env = makeEnv();
    await withTelegramCalls(async (calls) => {
      const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest(callback), env);
      assert.equal(response?.status, 200);
      const update = env.DB.runs.find((item) => item.query.includes('UPDATE telegram_proposal_sessions'));
      assert.ok(update);
      assert.ok(update.values.includes(expectedStep));
      const edit = calls.find((call) => call.method === 'editMessageText');
      assert.match(edit.payload.text, expectedText);
    });
  }
});

test('proposal migration extends existing proposals and creates resumable Telegram sessions', async () => {
  const sql = await readFile(new URL('../migrations/0013_telegram_title_proposals.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE chapter_proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy'/);
  assert.match(sql, /ALTER TABLE chapter_proposals ADD COLUMN ranobelib_book_ref TEXT/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS telegram_proposal_sessions/);
  assert.match(sql, /candidates_json TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(sql, /raw_file_id TEXT/);
  assert.match(sql, /raw_file_unique_id TEXT/);
  assert.match(sql, /updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  assert.doesNotMatch(sql, /FOREIGN KEY \(ranobelib_book_ref\)/, 'global RanobeLib proposals must not depend on the team-only local catalog');
});
