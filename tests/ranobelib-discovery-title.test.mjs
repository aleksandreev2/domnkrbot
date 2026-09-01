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
    }],
    meta: { current_page: 1, has_next_page: false, per_page: 60 },
  }), { headers: { 'content-type': 'application/json' } });
}

test('team discovery preserves the human-readable RanobeLib title from catalog data', async () => {
  const client = new RanobeLibClient({
    fetchImpl: async (url) => String(url) === teamCatalogUrl
      ? catalogResponse()
      : new Response('not found', { status: 404 }),
  });

  const books = await client.discoverTeamBooks('11969--dom-nekromanta');
  assert.equal(books.length, 1);
  assert.equal(books[0].title, 'Покемон: Мастер тактики');
});

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (this.query.includes('SELECT COUNT(*) AS count FROM ranobelib_titles')) return { count: 0 };
    return null;
  }
  async all() { return { results: [] }; }
  async run() {
    if (this.query.startsWith('INSERT INTO ranobelib_titles')) {
      this.db.titleInsert = { query: this.query, values: [...this.values] };
    }
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor() { this.titleInsert = null; }
  prepare(query) { return new Statement(this, query); }
  async batch(statements) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

test('Telegram catalog bootstrap stores the discovered title before chapter snapshots exist', async () => {
  const originalFetch = globalThis.fetch;
  const db = new DB();
  globalThis.fetch = async (url) => String(url) === teamCatalogUrl
    ? catalogResponse()
    : new Response('not found', { status: 404 });

  try {
    const count = await ensureTelegramSubscriptionCatalog({
      DB: db,
      RANOBELIB_TEAM_REF: '11969--dom-nekromanta',
    });
    assert.equal(count, 1);
    assert.ok(db.titleInsert);
    assert.match(db.titleInsert.query, /\btitle\b/);
    assert.ok(db.titleInsert.values.includes('Покемон: Мастер тактики'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
