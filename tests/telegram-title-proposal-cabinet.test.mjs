import assert from 'node:assert/strict';
import test from 'node:test';

async function loadCabinet() {
  return import('../dist-runtime/telegram-title-proposal-cabinet.js');
}

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    this.db.queries.push({ kind: 'first', query: this.query, values: this.values });
    if (this.query.includes('SUM(CASE WHEN')) return this.db.counts;
    if (this.query.includes('FROM chapter_proposals') && this.query.includes('WHERE id=?')) {
      return this.db.proposals.get(String(this.values[0])) ?? null;
    }
    return null;
  }
  async all() {
    this.db.queries.push({ kind: 'all', query: this.query, values: this.values });
    if (!this.query.includes('FROM chapter_proposals')) return { results: [] };
    const filter = this.query.includes("status IN ('pending','approved','planned','in_progress')")
      ? 'a'
      : this.query.includes("status IN ('done','rejected')") ? 'd' : 'x';
    const rows = this.db.lists[filter] ?? [];
    const limit = Number(this.values.at(-2) ?? 8);
    const offset = Number(this.values.at(-1) ?? 0);
    return { results: rows.slice(offset, offset + limit) };
  }
  async run() {
    this.db.queries.push({ kind: 'run', query: this.query, values: this.values });
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor() {
    this.counts = { active_count: 4, completed_count: 2, all_count: 6 };
    this.lists = { a: [], d: [], x: [] };
    this.proposals = new Map();
    this.queries = [];
  }
  prepare(query) { return new Statement(this, query); }
}

function env() {
  return { DB: new DB(), TELEGRAM_BOT_TOKEN: 'unit-test-token', TELEGRAM_WEBHOOK_SECRET: 'secret' };
}

function callbackRequest(data, userId = 42) {
  return new Request('https://bot.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({
      callback_query: {
        id: `cb-${data}`,
        from: { id: userId, first_name: 'Reader' },
        data,
        message: { message_id: 17, chat: { id: userId, type: 'private' } },
      },
    }),
  });
}

async function withTelegram(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (!href.includes('api.telegram.org')) throw new Error(`Unexpected network: ${href}`);
    calls.push({ method: href.split('/').pop(), payload: JSON.parse(String(options.body || '{}')) });
    return Response.json({ ok: true, result: { message_id: 18 } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

const editCall = (calls) => calls.find((call) => call.method === 'editMessageText');
const buttons = (call) => call.payload.reply_markup.inline_keyboard.flat();
const callbackData = (call) => buttons(call).map((button) => button.callback_data).filter(Boolean);

test('My proposals landing uses one aggregate count query and offers active/completed/all plus Home', async () => {
  const { handleTelegramTitleProposalCabinetWebhookRequest } = await loadCabinet();
  const state = env();
  await withTelegram(async (calls) => {
    const response = await handleTelegramTitleProposalCabinetWebhookRequest(callbackRequest('prop:mine'), state);
    assert.equal(response?.status, 200);
    const edit = editCall(calls);
    assert.match(edit.payload.text, /Мои заявки/);
    assert.match(edit.payload.text, /Активн.*4/i);
    assert.match(edit.payload.text, /Заверш.*2/i);
    assert.match(edit.payload.text, /Всего.*6/i);
    const data = callbackData(edit);
    assert.ok(data.includes('prop:mine:a:0'));
    assert.ok(data.includes('prop:mine:d:0'));
    assert.ok(data.includes('prop:mine:x:0'));
    assert.ok(data.includes('prop:home'));
    const aggregates = state.DB.queries.filter((query) => query.query.includes('SUM(CASE WHEN'));
    assert.equal(aggregates.length, 1);
  });
});

test('active list filters server-side, uses LIMIT 8 OFFSET and preserves filter/page in card callbacks', async () => {
  const { handleTelegramTitleProposalCabinetWebhookRequest } = await loadCabinet();
  const state = env();
  state.DB.lists.a = Array.from({ length: 12 }, (_, index) => ({
    id: `a-${index + 1}`,
    user_telegram_id: '42',
    title: `Активный ${index + 1}`,
    status: index % 2 ? 'in_progress' : 'pending',
    vote_count: index,
    created_at: `2026-09-${String(8 - Math.min(index, 7)).padStart(2, '0')} 10:00:00`,
  }));
  await withTelegram(async (calls) => {
    await handleTelegramTitleProposalCabinetWebhookRequest(callbackRequest('prop:mine:a:0'), state);
    const edit = editCall(calls);
    assert.match(edit.payload.text, /Активные заявки/);
    assert.match(edit.payload.text, /На рассмотрении|Перевод начат/);
    const data = callbackData(edit);
    assert.ok(data.includes('prop:view:a-1:a:0'));
    assert.ok(data.includes('prop:mine:a:1'));
    assert.ok(data.includes('prop:mine'));
    assert.ok(data.includes('prop:home'));
    const listQuery = state.DB.queries.find((query) => query.kind === 'all');
    assert.match(listQuery.query, /status IN \('pending','approved','planned','in_progress'\)/);
    assert.match(listQuery.query, /LIMIT \? OFFSET \?/);
    assert.equal(listQuery.values.at(-2), 8);
    assert.equal(listQuery.values.at(-1), 0);
  });
});

test('completed and all lists use their own compact callbacks and pagination offsets', async () => {
  const { handleTelegramTitleProposalCabinetWebhookRequest } = await loadCabinet();
  const state = env();
  state.DB.lists.d = Array.from({ length: 10 }, (_, index) => ({
    id: `d-${index + 1}`, user_telegram_id: '42', title: `Готовый ${index + 1}`,
    status: index % 2 ? 'rejected' : 'done', vote_count: 0,
  }));
  state.DB.lists.x = Array.from({ length: 10 }, (_, index) => ({
    id: `x-${index + 1}`, user_telegram_id: '42', title: `Любой ${index + 1}`,
    status: 'approved', vote_count: 1,
  }));

  await withTelegram(async (calls) => {
    await handleTelegramTitleProposalCabinetWebhookRequest(callbackRequest('prop:mine:d:1'), state);
    const edit = editCall(calls);
    assert.match(edit.payload.text, /Завершённые заявки/);
    const query = state.DB.queries.find((item) => item.kind === 'all');
    assert.match(query.query, /status IN \('done','rejected'\)/);
    assert.equal(query.values.at(-1), 8);
    assert.ok(callbackData(edit).some((data) => data.startsWith('prop:view:d-9:d:1')));
  });

  state.DB.queries.length = 0;
  await withTelegram(async (calls) => {
    await handleTelegramTitleProposalCabinetWebhookRequest(callbackRequest('prop:mine:x:0'), state);
    const edit = editCall(calls);
    assert.match(edit.payload.text, /Все заявки/);
    const query = state.DB.queries.find((item) => item.kind === 'all');
    assert.equal(query.query.includes("status IN ('done','rejected')"), false);
    assert.equal(query.query.includes("status IN ('pending','approved','planned','in_progress')"), false);
  });
});

test('proposal card preserves filter/page Back context, shows owner note and Home', async () => {
  const { handleTelegramTitleProposalCabinetWebhookRequest } = await loadCabinet();
  const state = env();
  state.DB.proposals.set('p-1', {
    id: 'p-1', user_telegram_id: '42', title: 'Карточка тайтла', source_kind: 'external',
    source_url: 'https://example.com/source', status: 'planned', vote_count: 11,
    comment: 'Мой комментарий', admin_note: 'Принято в план',
    created_at: '2026-09-01 10:00:00', updated_at: '2026-09-07 18:00:00',
  });
  await withTelegram(async (calls) => {
    await handleTelegramTitleProposalCabinetWebhookRequest(callbackRequest('prop:view:p-1:a:2'), state);
    const edit = editCall(calls);
    assert.match(edit.payload.text, /Карточка тайтла/);
    assert.match(edit.payload.text, /В плане/);
    assert.match(edit.payload.text, /11/);
    assert.match(edit.payload.text, /Мой комментарий/);
    assert.match(edit.payload.text, /Принято в план/);
    assert.match(edit.payload.text, /2026-09-01/);
    assert.match(edit.payload.text, /2026-09-07/);
    const data = callbackData(edit);
    assert.ok(data.includes('prop:mine:a:2'));
    assert.ok(data.includes('prop:home'));
    assert.ok(state.DB.queries.some(({ query, values }) => query.includes('UPDATE telegram_proposal_sessions SET input_active=?') && values[0] === 0));
    assert.ok(state.DB.queries.some(({ query }) => query.includes('DELETE FROM telegram_notification_search_state')));
    assert.ok(state.DB.queries.some(({ query }) => query.includes('DELETE FROM telegram_notification_input_state')));
  });
});

test('historical prop:view:<id> remains accepted and Back returns to cabinet landing', async () => {
  const { handleTelegramTitleProposalCabinetWebhookRequest } = await loadCabinet();
  const state = env();
  state.DB.proposals.set('old-1', {
    id: 'old-1', user_telegram_id: '42', title: 'Старая ссылка', source_kind: 'ranobelib',
    source_url: 'https://ranobelib.me/ru/book/1--old', status: 'pending', vote_count: 2,
  });
  await withTelegram(async (calls) => {
    const response = await handleTelegramTitleProposalCabinetWebhookRequest(callbackRequest('prop:view:old-1'), state);
    assert.equal(response?.status, 200);
    const edit = editCall(calls);
    assert.ok(callbackData(edit).includes('prop:mine'));
    assert.ok(callbackData(edit).includes('prop:home'));
  });
});

test('unrelated rejected proposal is hidden but active duplicate can still expose support action', async () => {
  const { handleTelegramTitleProposalCabinetWebhookRequest } = await loadCabinet();
  const state = env();
  state.DB.proposals.set('rejected-1', {
    id: 'rejected-1', user_telegram_id: '99', title: 'Чужая отклонённая', status: 'rejected', vote_count: 0,
  });
  state.DB.proposals.set('active-1', {
    id: 'active-1', user_telegram_id: '99', title: 'Чужая активная', status: 'pending', vote_count: 5,
    source_url: 'https://example.com', source_kind: 'external',
  });
  await withTelegram(async (calls) => {
    await handleTelegramTitleProposalCabinetWebhookRequest(callbackRequest('prop:view:rejected-1'), state);
    assert.equal(Boolean(editCall(calls)), false);
    assert.ok(calls.some((call) => call.method === 'answerCallbackQuery' && /недоступ/i.test(call.payload.text || '')));
  });
  await withTelegram(async (calls) => {
    await handleTelegramTitleProposalCabinetWebhookRequest(callbackRequest('prop:view:active-1'), state);
    const edit = editCall(calls);
    assert.ok(callbackData(edit).includes('prop:support:active-1'));
  });
});

test('cabinet callbacks contain no skull emoji and stay under Telegram callback limit', async () => {
  const { handleTelegramTitleProposalCabinetWebhookRequest } = await loadCabinet();
  const state = env();
  state.DB.lists.a = [{ id: '12345678-1234-1234-1234-123456789abc', user_telegram_id: '42', title: 'Тайтл', status: 'pending', vote_count: 0 }];
  await withTelegram(async (calls) => {
    await handleTelegramTitleProposalCabinetWebhookRequest(callbackRequest('prop:mine:a:0'), state);
    const edit = editCall(calls);
    assert.equal(JSON.stringify(edit.payload).includes('☠'), false);
    for (const data of callbackData(edit)) assert.ok(Buffer.byteLength(data, 'utf8') < 64, data);
  });
});
