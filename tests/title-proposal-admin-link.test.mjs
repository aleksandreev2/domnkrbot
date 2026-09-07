import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { handleTitleProposalAdminApi } from '../dist-runtime/title-proposal-admin.js';
import { handleWebAuth } from '../dist-runtime/web-auth.js';

const TOKEN = '123456:title-admin-link-test-token';
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
  async first() {
    this.db.queries.push({ query: this.query, values: this.values });
    if (this.query.includes('FROM chapter_proposals') && this.query.includes('WHERE id=?')) {
      return this.db.proposal && this.db.proposal.id === String(this.values[0]) ? { ...this.db.proposal } : null;
    }
    if (this.query.includes('FROM ranobelib_titles') && this.query.includes('WHERE book_ref=?')) {
      return this.db.ranobelib && this.db.ranobelib.book_ref === String(this.values[0]) ? { ...this.db.ranobelib } : null;
    }
    if (this.query.includes('FROM chapter_proposals') && this.query.includes('ranobelib_book_ref=?') && this.query.includes('id<>?')) {
      const [bookRef, excludedId] = this.values.map(String);
      return this.db.conflict && this.db.conflict.ranobelib_book_ref === bookRef && this.db.conflict.id !== excludedId
        ? { ...this.db.conflict }
        : null;
    }
    return null;
  }
  async all() { this.db.queries.push({ query: this.query, values: this.values }); return { results: [] }; }
  async run() {
    this.db.queries.push({ query: this.query, values: this.values });
    this.db.runs.push({ query: this.query, values: this.values });
    if (this.query.startsWith("UPDATE chapter_proposals SET source_kind='ranobelib'")) {
      const [bookRef, id] = this.values.map(String);
      if (this.db.proposal?.id === id) {
        this.db.proposal.source_kind = 'ranobelib';
        this.db.proposal.ranobelib_book_ref = bookRef;
      }
    }
    if (this.query.startsWith('INSERT INTO ranobelib_titles')) {
      const [bookRef, ranobelibId, slug, url, title, chapterCount] = this.values;
      this.db.cachedRanobeLib.push({ bookRef, ranobelibId, slug, url, title, chapterCount });
      if (!this.db.ranobelib) {
        this.db.ranobelib = {
          book_ref: String(bookRef), ranobelib_id: Number(ranobelibId), title: String(title), url: String(url), is_active: 0,
        };
      }
    }
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor() {
    this.queries = [];
    this.runs = [];
    this.proposal = null;
    this.ranobelib = null;
    this.conflict = null;
    this.cachedRanobeLib = [];
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

async function adminRequest(path, { method = 'POST', body, origin = ORIGIN } = {}) {
  const headers = { cookie: await adminCookie(), origin };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function withFetch(fn, responder) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = responder;
  try { return await fn(); }
  finally { globalThis.fetch = originalFetch; }
}

test('admin RanobeLib search queries the global catalog and caches candidates as inactive support rows', async () => {
  const db = new DB();
  await withFetch(async () => {
    const response = await handleTitleProposalAdminApi(await adminRequest('/api/admin/title-proposals/ranobelib-search', {
      body: { query: 'Found title' },
    }), env(db));
    assert.equal(response?.status, 200);
    const body = await response.json();
    assert.equal(body.candidates.length, 1);
    assert.deepEqual(body.candidates[0], {
      bookRef: '555--found-title',
      ranobelibId: 555,
      title: 'Найденный тайтл',
      url: 'https://ranobelib.me/ru/book/555--found-title',
      chapterCount: 42,
    });
    assert.equal(db.cachedRanobeLib.length, 1);
    assert.equal(db.cachedRanobeLib[0].bookRef, '555--found-title');
    const insert = db.runs.find((run) => run.query.startsWith('INSERT INTO ranobelib_titles'));
    assert.ok(insert);
    assert.match(insert.query, /is_active,snapshot_ready/);
    assert.match(insert.query, /VALUES \(\?,\?,\?,\?,\?,\?,0,0,CURRENT_TIMESTAMP\)/);
  }, async (url, options = {}) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, 'https://api.cdnlibs.org');
    assert.equal(parsed.pathname, '/api/manga');
    assert.equal(parsed.searchParams.get('q'), 'Found title');
    assert.equal(options.headers['site-id'], '3');
    return Response.json({
      data: [{
        id: 555,
        slug_url: '555--found-title',
        slug: 'found-title',
        rus_name: 'Найденный тайтл',
        name: 'Found title',
        items_count: { uploaded: 42 },
      }],
    });
  });
});

test('admin RanobeLib search validates query before external requests', async () => {
  const db = new DB();
  let fetchCalled = false;
  await withFetch(async () => {
    const response = await handleTitleProposalAdminApi(await adminRequest('/api/admin/title-proposals/ranobelib-search', {
      body: { query: 'x' },
    }), env(db));
    assert.equal(response?.status, 400);
    assert.equal(fetchCalled, false);
    assert.equal(db.runs.length, 0);
  }, async () => { fetchCalled = true; throw new Error('must not fetch'); });
});

test('admin links an external proposal to an existing RanobeLib row in place', async () => {
  const db = new DB();
  db.proposal = {
    id: 'p-ext', proposal_type: 'title', source_kind: 'external', ranobelib_book_ref: null,
    title: 'User title', status: 'planned', user_telegram_id: '100',
  };
  db.ranobelib = {
    book_ref: '555--found-title', ranobelib_id: 555, title: 'Found title',
    url: 'https://ranobelib.me/ru/book/555--found-title',
  };

  const response = await handleTitleProposalAdminApi(await adminRequest('/api/admin/title-proposals/p-ext/link-ranobelib', {
    body: { bookRef: '555--found-title' },
  }), env(db));

  assert.equal(response?.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.id, 'p-ext');
  assert.equal(body.bookRef, '555--found-title');
  assert.equal(db.proposal.id, 'p-ext');
  assert.equal(db.proposal.status, 'planned');
  assert.equal(db.proposal.source_kind, 'ranobelib');
  assert.equal(db.proposal.ranobelib_book_ref, '555--found-title');
  assert.equal(db.runs.length, 1);
  assert.match(db.runs[0].query, /SET source_kind='ranobelib',ranobelib_book_ref=\?/);
});

test('admin link rejects an unknown RanobeLib book_ref without mutating the proposal', async () => {
  const db = new DB();
  db.proposal = { id: 'p-ext', proposal_type: 'title', source_kind: 'external', ranobelib_book_ref: null, title: 'User title', status: 'pending' };

  const response = await handleTitleProposalAdminApi(await adminRequest('/api/admin/title-proposals/p-ext/link-ranobelib', {
    body: { bookRef: '999--missing' },
  }), env(db));

  assert.equal(response?.status, 404);
  assert.equal(db.runs.length, 0);
  assert.equal(db.proposal.source_kind, 'external');
});

test('admin link returns 409 when another active proposal already owns the RanobeLib title', async () => {
  const db = new DB();
  db.proposal = { id: 'p-ext', proposal_type: 'title', source_kind: 'external', ranobelib_book_ref: null, title: 'User title', status: 'pending' };
  db.ranobelib = { book_ref: '555--found-title', ranobelib_id: 555, title: 'Found title' };
  db.conflict = { id: 'p-other', ranobelib_book_ref: '555--found-title', status: 'in_progress' };

  const response = await handleTitleProposalAdminApi(await adminRequest('/api/admin/title-proposals/p-ext/link-ranobelib', {
    body: { bookRef: '555--found-title' },
  }), env(db));

  assert.equal(response?.status, 409);
  const body = await response.json();
  assert.equal(body.conflictId, 'p-other');
  assert.equal(db.runs.length, 0);
});

test('admin RanobeLib link rejects cross-origin mutations before D1 writes', async () => {
  const db = new DB();
  db.proposal = { id: 'p-ext', proposal_type: 'title', source_kind: 'external', ranobelib_book_ref: null, title: 'User title', status: 'pending' };
  db.ranobelib = { book_ref: '555--found-title', ranobelib_id: 555, title: 'Found title' };

  const response = await handleTitleProposalAdminApi(await adminRequest('/api/admin/title-proposals/p-ext/link-ranobelib', {
    body: { bookRef: '555--found-title' }, origin: 'https://evil.example',
  }), env(db));

  assert.equal(response?.status, 403);
  assert.equal(db.runs.length, 0);
});
