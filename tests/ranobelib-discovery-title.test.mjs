import assert from 'node:assert/strict';
import test from 'node:test';
import { RanobeLibClient } from '../dist/index.js';
import { ensureTelegramSubscriptionCatalog } from '../dist-runtime/telegram-subscription-catalog.js';

const teamCatalogUrl = 'https://api.cdnlibs.org/api/manga?site_id[]=3&target_id=11969&target_model=team&page=1';

function catalogResponse() {
  return new Response(JSON.stringify({
    data: [{
      id: 62387,
      slug: 'pokemon-master-of-tactics',
      slug_url: '62387--pokemon-master-of-tactics',
      rus_name: 'Покемон: Мастер тактики',
      name: 'Pokemon: Master of Tactics',
      cover: {
        default: 'https://cover.cdnlibs.org/uploads/cover/pokemon-master-of-tactics/cover/default.jpg',
        thumbnail: 'https://cover.cdnlibs.org/uploads/cover/pokemon-master-of-tactics/cover/thumb.jpg',
      },
    }],
    meta: { current_page: 1, has_next_page: false, per_page: 60 },
  }), { headers: { 'content-type': 'application/json' } });
}

test('team discovery preserves title and cover metadata needed by one-request-per-title sync', async () => {
  const client = new RanobeLibClient({
    fetchImpl: async (url) => String(url) === teamCatalogUrl
      ? catalogResponse()
      : new Response('not found', { status: 404 }),
  });

  const books = await client.discoverTeamBooks('11969--dom-nekromanta');
  assert.equal(books.length, 1);
  assert.equal(books[0].title, 'Покемон: Мастер тактики');
  assert.equal(
    books[0].coverUrl,
    'https://cover.cdnlibs.org/uploads/cover/pokemon-master-of-tactics/cover/default.jpg',
  );
});

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (this.query.includes('SELECT COUNT(*) AS count FROM ranobelib_titles')) {
      return { count: this.db.activeCount, missing_titles: this.db.missingTitles };
    }
    return null;
  }
  async all() { return { results: [] }; }
  async run() {
    if (this.query.startsWith('INSERT INTO ranobelib_titles')) {
      this.db.titleInserts.push({ query: this.query, values: [...this.values] });
    }
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor({ activeCount = 0, missingTitles = 0 } = {}) {
    this.activeCount = activeCount;
    this.missingTitles = missingTitles;
    this.titleInserts = [];
  }
  prepare(query) { return new Statement(this, query); }
  async batch(statements) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

async function withCatalogFetch(fn) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return String(url) === teamCatalogUrl
      ? catalogResponse()
      : new Response('not found', { status: 404 });
  };
  try { return await fn(requests); } finally { globalThis.fetch = originalFetch; }
}

test('Telegram catalog bootstrap stores the discovered title before chapter snapshots exist', async () => {
  const db = new DB();
  await withCatalogFetch(async () => {
    const count = await ensureTelegramSubscriptionCatalog({
      DB: db,
      RANOBELIB_TEAM_REF: '11969--dom-nekromanta',
    });
    assert.equal(count, 1);
    assert.equal(db.titleInserts.length, 1);
    assert.match(db.titleInserts[0].query, /\btitle\b/);
    assert.ok(db.titleInserts[0].values.includes('Покемон: Мастер тактики'));
  });
});

test('Telegram catalog refreshes existing active rows when some titles are still missing', async () => {
  const db = new DB({ activeCount: 35, missingTitles: 12 });
  await withCatalogFetch(async (requests) => {
    const count = await ensureTelegramSubscriptionCatalog({
      DB: db,
      RANOBELIB_TEAM_REF: '11969--dom-nekromanta',
    });
    assert.equal(count, 1);
    assert.deepEqual(requests, [teamCatalogUrl]);
    assert.equal(db.titleInserts.length, 1);
    assert.ok(db.titleInserts[0].values.includes('Покемон: Мастер тактики'));
  });
});
