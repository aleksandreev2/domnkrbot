import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTelegramTitleProposalWebhookRequest } from '../dist-runtime/telegram-title-proposals.js';

const ACTIVE = new Set(['pending', 'approved', 'planned', 'in_progress']);

class SubmitStatement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    const q = this.query;
    if (q.includes('FROM telegram_proposal_sessions')) return this.db.session;
    if (q.includes('ranobelib_book_ref') && q.includes('FROM chapter_proposals')) return this.db.ranobelibDuplicate;
    if (q.includes('FROM proposal_votes') && !q.includes('COUNT(')) {
      const [proposalId, userId] = this.values.map(String);
      return this.db.votes.has(`${proposalId}:${userId}`) ? { proposal_id: proposalId } : null;
    }
    if (q.includes('COUNT(') && q.includes('proposal_votes')) {
      const proposalId = String(this.values[0] ?? '');
      let count = 0;
      for (const vote of this.db.votes) if (vote.startsWith(`${proposalId}:`)) count += 1;
      return { count };
    }
    if (q.includes('FROM chapter_proposals') && q.includes('WHERE id=?')) {
      const id = String(this.values[0] ?? '');
      return this.db.proposals.get(id) ?? null;
    }
    return null;
  }
  async all() {
    const q = this.query;
    if (q.includes('FROM chapter_proposals') && q.includes("status IN ('pending','approved','planned','in_progress')")) {
      return { results: this.db.externalCandidates };
    }
    if (q.includes('FROM chapter_proposals') && q.includes('user_telegram_id=?')) {
      return { results: this.db.mine };
    }
    return { results: [] };
  }
  async run() {
    this.db.runs.push({ query: this.query, values: this.values });
    if (this.query.startsWith('INSERT INTO proposal_votes')) {
      const [proposalId, userId] = this.values.map(String);
      this.db.votes.add(`${proposalId}:${userId}`);
    }
    if (this.query.startsWith('DELETE FROM proposal_votes')) {
      const [proposalId, userId] = this.values.map(String);
      this.db.votes.delete(`${proposalId}:${userId}`);
    }
    return { meta: { changes: 1 } };
  }
}

class SubmitDb {
  constructor(session) {
    this.session = session;
    this.ranobelibDuplicate = null;
    this.externalCandidates = [];
    this.proposals = new Map();
    this.mine = [];
    this.votes = new Set();
    this.runs = [];
  }
  prepare(query) { return new SubmitStatement(this, query); }
}

class FakeBucket {
  constructor() { this.puts = []; }
  async put(key, value, options = {}) {
    const bytes = value instanceof ArrayBuffer ? value.byteLength : value?.byteLength ?? null;
    this.puts.push({ key, bytes, options });
    return { etag: 'etag-test' };
  }
}

const baseSession = (extra = {}) => ({
  user_telegram_id: '42', chat_id: '42', step: 'review', source_kind: 'external', ranobelib_book_ref: null,
  title: 'Новая новелла', original_title: '', source_url: 'https://example.com/novel', candidates_json: '[]',
  raw_file_id: null, raw_file_unique_id: null, raw_file_name: null, raw_file_size: null, raw_mime_type: null,
  comment: 'Очень хочу перевод', updated_at: '2026-09-07 07:00:00', ...extra,
});

function makeEnv(session = baseSession(), extra = {}) {
  const DB = new SubmitDb(session);
  return { DB, TELEGRAM_BOT_TOKEN: 'unit-test-token', TELEGRAM_WEBHOOK_SECRET: 'secret', ...extra };
}

function callbackRequest(data, userId = 42) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({
      update_id: 31,
      callback_query: {
        id: `cb-${data}`,
        from: { id: userId, first_name: 'Reader', username: 'reader42' },
        data,
        message: { message_id: 19, chat: { id: userId, type: 'private' } },
      },
    }),
  });
}

async function withNetwork(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('/getFile')) {
      calls.push({ kind: 'telegram', method: 'getFile', payload: JSON.parse(String(options.body || '{}')) });
      return Response.json({ ok: true, result: { file_id: 'raw-file', file_path: 'documents/raw.epub' } });
    }
    if (href.startsWith('https://api.telegram.org/file/')) {
      calls.push({ kind: 'download', url: href });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/epub+zip' } });
    }
    calls.push({ kind: 'telegram', method: href.split('/').pop(), payload: JSON.parse(String(options.body || '{}')) });
    return Response.json({ ok: true, result: { message_id: 20 } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

const insertRun = (env, prefix) => env.DB.runs.find((run) => run.query.startsWith(prefix));

test('RanobeLib active duplicate is reused instead of inserting a second proposal', async () => {
  const env = makeEnv(baseSession({
    source_kind: 'ranobelib', ranobelib_book_ref: '100--genius-muggle', title: 'Гениальный магл',
    source_url: 'https://ranobelib.me/ru/book/100--genius-muggle', comment: '',
  }));
  env.DB.ranobelibDuplicate = { id: 'dup-1', user_telegram_id: '99', title: 'Гениальный магл', status: 'pending', vote_count: 7 };

  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:submit'), env);
    assert.equal(response?.status, 200);
    assert.equal(Boolean(insertRun(env, 'INSERT INTO chapter_proposals')), false);
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.ok(edit);
    assert.match(edit.payload.text, /уже предлагали/i);
    assert.match(edit.payload.text, /7/);
    assert.equal(edit.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prop:support:dup-1');
    assert.equal(edit.payload.reply_markup.inline_keyboard[1][0].callback_data, 'prop:view:dup-1');
  });
});

test('external duplicates compare normalized title and normalized source host/path', async () => {
  const env = makeEnv(baseSession({
    title: '  My   Novel  ',
    source_url: 'HTTPS://Example.COM/story/42/?utm_source=telegram#chapter',
  }));
  env.DB.externalCandidates = [
    { id: 'wrong', user_telegram_id: '90', title: 'My Novel', source_url: 'https://other.example/story/42', status: 'pending', vote_count: 1 },
    { id: 'dup-ext', user_telegram_id: '91', title: 'my novel', source_url: 'https://example.com/story/42', status: 'approved', vote_count: 4 },
  ];

  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:submit'), env);
    assert.equal(response?.status, 200);
    assert.equal(Boolean(insertRun(env, 'INSERT INTO chapter_proposals')), false);
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.match(edit.payload.text, /уже предлагали/i);
    assert.match(edit.payload.text, /4/);
    assert.equal(edit.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prop:support:dup-ext');
  });
});

test('new Telegram proposal is created in canonical chapter_proposals and details tables', async () => {
  const env = makeEnv();

  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:submit'), env);
    assert.equal(response?.status, 200);
    const proposal = insertRun(env, 'INSERT INTO chapter_proposals');
    assert.ok(proposal);
    assert.ok(proposal.values.includes('title'));
    assert.ok(proposal.values.includes('external'));
    assert.ok(proposal.values.includes('Новая новелла'));
    const details = insertRun(env, 'INSERT INTO title_proposal_details');
    assert.ok(details);
    assert.ok(env.DB.runs.some((run) => run.query.startsWith('DELETE FROM telegram_proposal_sessions')));
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.match(edit.payload.text, /заявка.*принята|заявка.*создана/i);
    assert.ok(edit.payload.reply_markup.inline_keyboard.flat().some((button) => button.callback_data?.startsWith('prop:view:')));
  });
});

test('attached Telegram RAW is downloaded through getFile, persisted to R2, and linked to the proposal', async () => {
  const bucket = new FakeBucket();
  const env = makeEnv(baseSession({
    raw_file_id: 'raw-file', raw_file_unique_id: 'raw-unique', raw_file_name: 'source.epub',
    raw_file_size: 4, raw_mime_type: 'application/epub+zip',
  }), { FILES: bucket });

  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:submit'), env);
    assert.equal(response?.status, 200);
    assert.ok(calls.some((call) => call.kind === 'telegram' && call.method === 'getFile'));
    assert.ok(calls.some((call) => call.kind === 'download' && call.url.includes('/documents/raw.epub')));
    assert.equal(bucket.puts.length, 1);
    assert.match(bucket.puts[0].key, /^proposal-raw\/42\//);
    assert.match(bucket.puts[0].key, /source\.epub$/);
    const rawInsert = insertRun(env, 'INSERT INTO proposal_raw_uploads');
    assert.ok(rawInsert);
    assert.ok(rawInsert.values.includes('telegram:raw-unique'));
    assert.ok(rawInsert.values.includes('ready'));
    assert.ok(rawInsert.values.includes('source.epub'));
    const details = insertRun(env, 'INSERT INTO title_proposal_details');
    assert.ok(details.values.some((value) => typeof value === 'string' && value.startsWith('tgraw-')));
  });
});

test('RAW is never silently discarded when R2 is unavailable', async () => {
  const env = makeEnv(baseSession({
    raw_file_id: 'raw-file', raw_file_unique_id: 'raw-unique', raw_file_name: 'source.epub',
    raw_file_size: 4, raw_mime_type: 'application/epub+zip',
  }));

  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:submit'), env);
    assert.equal(response?.status, 200);
    assert.equal(Boolean(insertRun(env, 'INSERT INTO chapter_proposals')), false);
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.match(edit.payload.text, /RAW.*не удалось сохранить|не удалось.*RAW/is);
    assert.ok(edit.payload.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'prop:submit:no-raw'));
  });
});

test('support callback inserts one vote but never duplicates an existing vote', async () => {
  const env = makeEnv(null);
  env.DB.proposals.set('dup-1', { id: 'dup-1', user_telegram_id: '99', title: 'Тайтл', source_kind: 'external', source_url: 'https://example.com', status: 'pending', comment: '', admin_note: '', created_at: '2026-09-01 10:00:00' });

  await withNetwork(async (calls) => {
    const first = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:support:dup-1'), env);
    assert.equal(first?.status, 200);
    assert.ok(insertRun(env, 'INSERT INTO proposal_votes'));
    assert.ok(calls.some((call) => call.method === 'answerCallbackQuery' && /поддерж/i.test(call.payload.text || '')));
  });

  env.DB.runs.length = 0;
  await withNetwork(async (calls) => {
    const second = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:support:dup-1'), env);
    assert.equal(second?.status, 200);
    assert.equal(Boolean(insertRun(env, 'INSERT INTO proposal_votes')), false);
    assert.ok(calls.some((call) => call.method === 'answerCallbackQuery' && /уже/i.test(call.payload.text || '')));
  });
});

test('proposal owner cannot add a support vote to their own proposal', async () => {
  const env = makeEnv(null);
  env.DB.proposals.set('own-1', { id: 'own-1', user_telegram_id: '42', title: 'Моя заявка', source_kind: 'external', source_url: '', status: 'pending' });

  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:support:own-1'), env);
    assert.equal(response?.status, 200);
    assert.equal(Boolean(insertRun(env, 'INSERT INTO proposal_votes')), false);
    assert.ok(calls.some((call) => call.method === 'answerCallbackQuery' && /автор|сво/i.test(call.payload.text || '')));
  });
});

test('My proposals lists the ten newest user proposals with localized status and vote count', async () => {
  const env = makeEnv(null);
  env.DB.mine = [
    { id: 'mine-1', title: 'Первый тайтл', status: 'pending', vote_count: 3, created_at: '2026-09-07 06:00:00' },
    { id: 'mine-2', title: 'Второй тайтл', status: 'in_progress', vote_count: 9, created_at: '2026-09-06 06:00:00' },
  ];

  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:mine'), env);
    assert.equal(response?.status, 200);
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.match(edit.payload.text, /Мои заявки/);
    assert.match(edit.payload.text, /Первый тайтл/);
    assert.match(edit.payload.text, /На рассмотрении/);
    assert.match(edit.payload.text, /Второй тайтл/);
    assert.match(edit.payload.text, /Перевод начат/);
    assert.match(edit.payload.text, /9/);
    assert.equal(edit.payload.reply_markup.inline_keyboard[0][0].callback_data, 'prop:view:mine-1');
  });
});

test('view callback hides rejected proposal from unrelated users but shows visible active proposal details', async () => {
  const env = makeEnv(null);
  env.DB.proposals.set('visible', {
    id: 'visible', user_telegram_id: '99', title: 'Видимый тайтл', source_kind: 'ranobelib',
    ranobelib_book_ref: '100--genius-muggle', source_url: 'https://ranobelib.me/ru/book/100--genius-muggle',
    status: 'planned', comment: 'Комментарий', admin_note: 'Берём после текущего релиза', created_at: '2026-09-01 12:00:00', vote_count: 5,
  });
  env.DB.proposals.set('hidden', { id: 'hidden', user_telegram_id: '99', title: 'Скрытый', status: 'rejected' });

  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:view:visible'), env);
    assert.equal(response?.status, 200);
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.match(edit.payload.text, /Видимый тайтл/);
    assert.match(edit.payload.text, /В плане/);
    assert.match(edit.payload.text, /5/);
  });

  await withNetwork(async (calls) => {
    const response = await handleTelegramTitleProposalWebhookRequest(callbackRequest('prop:view:hidden'), env);
    assert.equal(response?.status, 200);
    assert.ok(calls.some((call) => call.method === 'answerCallbackQuery' && /недоступ|не найд/i.test(call.payload.text || '')));
  });
});
