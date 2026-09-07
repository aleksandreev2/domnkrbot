import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { handleTitleProposalAdminApi } from '../dist-runtime/title-proposal-admin.js';
import { handleWebAuth } from '../dist-runtime/web-auth.js';

const TOKEN = '123456:title-admin-v2-test-token';
const ORIGIN = 'https://domnkr.test';
const ADMIN_ID = '424242';

function loginUrl() {
  const fields = {
    id: ADMIN_ID,
    first_name: 'Admin',
    username: 'dom_admin',
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHash('sha256').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const url = new URL('/auth/telegram/callback', ORIGIN);
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  url.searchParams.set('hash', hash);
  return url;
}

async function adminCookie() {
  const response = await handleWebAuth(new Request(loginUrl()), {
    TELEGRAM_BOT_TOKEN: TOKEN,
    BOT_USERNAME: 'domnekromanta_bot',
    ADMIN_TELEGRAM_IDS: ADMIN_ID,
  });
  return response.headers.get('set-cookie').split(';', 1)[0];
}

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async all() {
    this.db.queries.push(this.query);
    if (this.query.includes('FROM chapter_proposals p')) return { results: this.db.detailRows };
    return { results: [] };
  }
  async first() {
    this.db.queries.push(this.query);
    if (this.query.includes('FROM chapter_proposals') && this.query.includes('WHERE id=?')) {
      return this.db.proposal;
    }
    return null;
  }
  async run() {
    this.db.queries.push(this.query);
    this.db.runs.push({ query: this.query, values: this.values });
    if (this.query.startsWith('UPDATE chapter_proposals SET status=')) {
      this.db.sequence.push('db:update');
      if (this.db.proposal) {
        this.db.proposal.status = String(this.values[0]);
        this.db.proposal.admin_note = String(this.values[1] ?? '');
      }
    }
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor() {
    this.queries = [];
    this.runs = [];
    this.sequence = [];
    this.proposal = null;
    this.detailRows = [];
  }
  prepare(query) { return new Statement(this, query); }
}

function env(db = new DB()) {
  return {
    DB: db,
    TELEGRAM_BOT_TOKEN: TOKEN,
    BOT_USERNAME: 'domnekromanta_bot',
    ADMIN_TELEGRAM_IDS: ADMIN_ID,
  };
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = { cookie: await adminCookie(), origin: ORIGIN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function withTelegram(db, fn, { fail = false } = {}) {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const calls = [];
  const errors = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, payload: JSON.parse(String(options.body || '{}')) });
    db.sequence.push('telegram:sendMessage');
    if (fail) return Response.json({ ok: false, description: 'Telegram unavailable' }, { status: 500 });
    return Response.json({ ok: true, result: { message_id: 77 } });
  };
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try { return await fn({ calls, errors }); }
  finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
}

test('admin title proposal details query returns exact source, RanobeLib metadata, RAW, votes and user identity', async () => {
  const db = new DB();
  db.detailRows = [{
    id: 'p-1', title: 'Гениальный магл', source_kind: 'ranobelib', ranobelib_book_ref: '100--genius-muggle',
    ranobelib_title: 'Гениальный магл', ranobelib_url: 'https://ranobelib.me/ru/book/100--genius-muggle',
    ranobelib_chapter_count: 123, ranobelib_latest_number: '123', ranobelib_latest_name: 'Финал арки',
    raw_upload_id: 'raw-1', raw_original_name: 'source.epub', raw_size: 1024, raw_status: 'ready', vote_count: 12,
    user_telegram_id: '42', username: 'reader', first_name: 'Reader', last_name: 'One', status: 'pending',
  }];
  const testEnv = env(db);

  const response = await handleTitleProposalAdminApi(await request('/api/admin/title-proposal-details'), testEnv);
  assert.equal(response?.status, 200);
  const body = await response.json();
  assert.equal(body.proposals[0].source_kind, 'ranobelib');
  assert.equal(body.proposals[0].ranobelib_book_ref, '100--genius-muggle');
  assert.equal(body.proposals[0].vote_count, 12);

  const sql = db.queries.find((query) => query.includes('FROM chapter_proposals p')) || '';
  assert.match(sql, /p\.source_kind/);
  assert.match(sql, /p\.ranobelib_book_ref/);
  assert.match(sql, /LEFT JOIN ranobelib_titles/);
  assert.match(sql, /proposal_votes/);
  assert.match(sql, /raw_original_name/);
  assert.match(sql, /u\.last_name/);
});

test('planned status is committed before Telegram owner notification and includes admin note', async () => {
  const db = new DB();
  db.proposal = { id: 'p-1', user_telegram_id: '777', title: 'Новая новелла', status: 'pending', admin_note: '' };
  const testEnv = env(db);

  await withTelegram(db, async ({ calls }) => {
    const response = await handleTitleProposalAdminApi(await request('/api/admin/proposals/p-1/status', {
      method: 'POST', body: { status: 'planned', adminNote: 'Берём после текущего релиза.' },
    }), testEnv);
    assert.equal(response?.status, 200);
    assert.deepEqual(db.sequence.slice(-2), ['db:update', 'telegram:sendMessage']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.chat_id, 777);
    assert.match(calls[0].payload.text, /📚 Статус заявки изменился/);
    assert.match(calls[0].payload.text, /«Новая новелла» → .*В плане/);
    assert.match(calls[0].payload.text, /Берём после текущего релиза/);
  });
});

test('Telegram delivery failure is logged but never rolls back a successful admin status update', async () => {
  const db = new DB();
  db.proposal = { id: 'p-2', user_telegram_id: '778', title: 'Другой тайтл', status: 'planned', admin_note: '' };
  const testEnv = env(db);

  await withTelegram(db, async ({ errors }) => {
    const response = await handleTitleProposalAdminApi(await request('/api/admin/proposals/p-2/status', {
      method: 'POST', body: { status: 'in_progress', adminNote: 'Перевод начали.' },
    }), testEnv);
    assert.equal(response?.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'in_progress');
    assert.ok(db.runs.some((run) => run.query.startsWith('UPDATE chapter_proposals SET status=')));
    assert.ok(errors.some((line) => /proposal.*notification|telegram/i.test(line)));
  }, { fail: true });
});

test('pending or approved moderation updates do not send workflow status notifications', async () => {
  const db = new DB();
  db.proposal = { id: 'p-3', user_telegram_id: '779', title: 'Тайтл', status: 'pending', admin_note: '' };
  const testEnv = env(db);

  await withTelegram(db, async ({ calls }) => {
    const response = await handleTitleProposalAdminApi(await request('/api/admin/proposals/p-3/status', {
      method: 'POST', body: { status: 'approved', adminNote: 'Проверено.' },
    }), testEnv);
    assert.equal(response?.status, 200);
    assert.equal(calls.length, 0);
  });
});
