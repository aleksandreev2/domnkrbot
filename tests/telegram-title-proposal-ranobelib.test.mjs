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
  async run() { this.db.runs.push({ query: this.query, values: this.values }); return { meta: { changes: 1 } }; }
}
class SessionDb {
  constructor(session) { this.session = session; this.runs = []; }
  prepare(query) { return new SessionStatement(this, query); }
}

const now = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
const baseSession = (step = 'ranobelib_query', extra = {}) => ({
  user_telegram_id: '42', chat_id: '42', step, source_kind: 'ranobelib', ranobelib_book_ref: null,
  title: '', original_title: '', source_url: '', candidates_json: '[]', raw_file_id: null,
  raw_file_unique_id: null, raw_file_name: null, raw_file_size: null, raw_mime_type: null,
  comment: '', updated_at: now(), ...extra,
});
const makeEnv = (session = baseSession()) => ({
  DB: new SessionDb(session), TELEGRAM_BOT_TOKEN: 'unit-test-token', TELEGRAM_WEBHOOK_SECRET: 'secret',
});

function messageRequest(text) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({ update_id: 20, message: { message_id: 5, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Reader' }, text } }),
  });
}
function callbackRequest(data) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({ update_id: 21, callback_query: { id: 'cb-ranobe', from: { id: 42, first_name: 'Reader' }, data, message: { message_id: 9, chat: { id: 42, type: 'private' } } } }),
  });
}

const searchItems = [
  { id: 100, name: 'Genius Muggle', rus_name: 'Гениальный магл', eng_name: 'Genius Muggle', slug: 'genius-muggle', slug_url: '100--genius-muggle', cover: {}, ageRestriction: { id: 1, label: '16+' }, status: { id: 1, label: 'Онгоинг' } },
  { id: 101, name: 'Another Mage', rus_name: 'Другой маг', eng_name: 'Another Mage', slug: 'another-mage', slug_url: '101--another-mage', cover: {}, ageRestriction: { id: 1, label: '16+' }, status: { id: 1, label: 'Онгоинг' } },
];
const detail = {
  id: 100, name: 'Genius Muggle', rus_name: 'Гениальный магл', eng_name: 'Genius Muggle', slug: 'genius-muggle', slug_url: '100--genius-muggle',
  cover: {}, ageRestriction: { id: 1, label: '16+' }, status: { id: 1, label: 'Онгоинг' },
  scanlateStatus: { id: 1, label: 'Продолжается' }, items_count: { uploaded: 267, total: 300 },
  teams: [{ id: 7, name: 'Команда А', slug: 'team-a', slug_url: '7--team-a' }],
};
const chapters = [
  { id: 1, volume: '1', number: '1', name: 'Начало', index: 1, branches_count: 1, branches: [] },
  { id: 267, volume: '12', number: '267', name: 'Финал арки', index: 267, branches_count: 1, branches: [] },
];

async function withApiCalls(fn, overrides = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith('https://api.cdnlibs.org/')) {
      calls.push({ kind: 'ranobelib', url: href, headers: options.headers || {} });
      if (href.includes('/chapters')) return Response.json({ data: overrides.chapters ?? chapters });
      if (/\/api\/manga\/100--genius-muggle\?/.test(href)) return Response.json({ data: overrides.detail ?? detail });
      if (href.includes('/api/manga?')) return Response.json({ data: overrides.searchItems ?? searchItems, meta: { current_page: 1, has_next_page: false } });
      return Response.json({ data: { toast: { message: 'Not Found' } } }, { status: 404 });
    }
    calls.push({ kind: 'telegram', method: href.split('/').pop(), payload: JSON.parse(String(options.body || '{}')) });
    return Response.json({ ok: true, result: { message_id: 10 } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

function firstUpdate(env) { return env.DB.runs.find((item) => item.query.includes('UPDATE telegram_proposal_sessions')); }

test('plain title search queries the global RanobeLib catalog, not the local team snapshot', async () => {
  const env = makeEnv();
  await withApiCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(messageRequest('магл'), env);
    assert.equal(response?.status, 200);
    const api = calls.find((call) => call.kind === 'ranobelib');
    assert.ok(api);
    const parsed = new URL(api.url);
    assert.equal(parsed.hostname, 'api.cdnlibs.org');
    assert.equal(parsed.pathname, '/api/manga');
    assert.equal(parsed.searchParams.get('q'), 'магл');
    assert.deepEqual(parsed.searchParams.getAll('site_id[]'), ['3']);
    assert.equal(parsed.searchParams.get('limit'), '10');
    const update = firstUpdate(env);
    assert.ok(update.values.some((value) => typeof value === 'string' && value.includes('100--genius-muggle')));
    const send = calls.find((call) => call.kind === 'telegram' && call.method === 'sendMessage');
    assert.match(send.payload.text, /Нашла несколько вариантов|Нашёл несколько вариантов|Выбери тайтл/i);
    assert.equal(send.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prop:pick:0');
    assert.match(send.payload.reply_markup.inline_keyboard[0][0].text, /Гениальный магл/);
  });
});

test('RanobeLib URL bypasses search and opens exact title confirmation', async () => {
  const env = makeEnv();
  await withApiCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(messageRequest('https://ranobelib.me/ru/book/100--genius-muggle'), env);
    assert.equal(response?.status, 200);
    assert.equal(calls.some((call) => call.kind === 'ranobelib' && call.url.includes('/api/manga?')), false);
    assert.ok(calls.some((call) => call.kind === 'ranobelib' && call.url.includes('/api/manga/100--genius-muggle?')));
    assert.ok(calls.some((call) => call.kind === 'ranobelib' && call.url.includes('/api/manga/100--genius-muggle/chapters')));
    const send = calls.find((call) => call.kind === 'telegram' && call.method === 'sendMessage');
    assert.match(send.payload.text, /Гениальный магл/);
    assert.match(send.payload.text, /267/);
    assert.match(send.payload.text, /Глава 267|267.*Финал арки/i);
    assert.match(send.payload.text, /Команда А/);
    assert.match(send.payload.text, /Продолжается/);
    assert.match(send.payload.text, /Иммунитет: не удалось определить автоматически/);
    assert.equal(send.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prop:confirm');
    const update = firstUpdate(env);
    assert.equal(update.values[0], 'ranobelib_confirm');
    assert.ok(update.values.includes('100--genius-muggle'));
  });
});

test('candidate pick uses compact index callback, fetches details and produces confirmation', async () => {
  const env = makeEnv(baseSession('ranobelib_query', { candidates_json: JSON.stringify(searchItems) }));
  await withApiCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:pick:0'), env);
    assert.equal(response?.status, 200);
    const edit = calls.find((call) => call.kind === 'telegram' && call.method === 'editMessageText');
    assert.match(edit.payload.text, /Гениальный магл/);
    assert.match(edit.payload.text, /267/);
    assert.match(edit.payload.text, /Команда А/);
    assert.match(edit.payload.text, /Иммунитет: не удалось определить автоматически/);
    assert.equal(edit.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prop:confirm');
    assert.ok(calls.some((call) => call.kind === 'telegram' && call.method === 'answerCallbackQuery'));
  });
});

test('confirming RanobeLib title advances to the same RAW file step as external proposals', async () => {
  const env = makeEnv(baseSession('ranobelib_confirm', {
    ranobelib_book_ref: '100--genius-muggle', title: 'Гениальный магл', source_url: 'https://ranobelib.me/ru/book/100--genius-muggle',
  }));
  await withApiCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:confirm'), env);
    assert.equal(response?.status, 200);
    assert.equal(firstUpdate(env).values[0], 'raw');
    const edit = calls.find((call) => call.kind === 'telegram' && call.method === 'editMessageText');
    assert.match(edit.payload.text, /RAW.*отправь файл/is);
    assert.equal(edit.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prop:raw:skip');
  });
});

test('empty global search keeps the user in RanobeLib query step with a retry prompt', async () => {
  const env = makeEnv();
  await withApiCalls(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(messageRequest('совсем нет такого тайтла'), env);
    assert.equal(response?.status, 200);
    assert.equal(env.DB.runs.some((item) => item.query.includes('UPDATE telegram_proposal_sessions')), false);
    const send = calls.find((call) => call.kind === 'telegram' && call.method === 'sendMessage');
    assert.match(send.payload.text, /ничего не найдено|не нашлось/i);
  }, { searchItems: [] });
});
