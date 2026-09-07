import assert from 'node:assert/strict';
import test from 'node:test';

const teamCatalogUrl = 'https://api.cdnlibs.org/api/manga?site_id[]=3&target_id=11969&target_model=team&page=1';

function catalogResponse(data) {
  return new Response(JSON.stringify({ data, meta: { current_page: 1, has_next_page: false } }), {
    headers: { 'content-type': 'application/json' },
  });
}

class Statement {
  constructor(db, query) { this.db = db; this.query = query.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return null; }
  async all() {
    if (/SELECT book_ref FROM ranobelib_titles WHERE is_active = 1/i.test(this.query)) {
      return { results: this.db.activeRefs.map((book_ref) => ({ book_ref })) };
    }
    return { results: [] };
  }
  async run() {
    this.db.runs.push({ query: this.query, values: [...this.values] });
    if (/INSERT INTO ranobelib_titles/i.test(this.query)) this.db.upserts.push({ query: this.query, values: [...this.values] });
    if (/UPDATE ranobelib_titles SET is_active = 0/i.test(this.query)) this.db.deactivateCalls += 1;
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor(activeRefs = []) { this.activeRefs = activeRefs; this.deactivateCalls = 0; this.upserts = []; this.runs = []; }
  prepare(query) { return new Statement(this, query); }
  async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; }
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => { requests.push(String(url)); return handler(String(url), init); };
  try { return await fn(requests); } finally { globalThis.fetch = original; }
}

test('team discovery uses one bounded JSON upsert, makes new titles immediately scannable, and never fetches chapters', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const db = new DB(['999--old-book']);
  const titles = Array.from({ length: 60 }, (_, index) => ({
    id: 62387 + index,
    slug: `book-${index}`,
    slug_url: `${62387 + index}--book-${index}`,
    rus_name: `Книга ${index}`,
    cover: { default: `https://cover.cdnlibs.org/uploads/cover/book-${index}/default.jpg` },
  }));

  await withFetch(
    (url) => url === teamCatalogUrl ? catalogResponse(titles) : new Response('unexpected', { status: 500 }),
    async (requests) => {
      const result = await discoverRanobeLibTeam({ DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' });
      assert.deepEqual(requests, [teamCatalogUrl]);
      assert.equal(requests.some((url) => url.includes('/chapters')), false);
      assert.equal(result.discovered, 60);
      assert.equal(result.activated, 60);
      assert.equal(result.deactivated, 1);
      assert.equal(db.upserts.length, 1, '60 titles must not become 60 D1 queries');
      assert.match(db.upserts[0].query, /json_each/i);
      assert.match(db.upserts[0].query, /next_check_at/i);
      assert.match(db.upserts[0].query, /CURRENT_TIMESTAMP/i);
      assert.ok(db.upserts[0].values.some((value) => typeof value === 'string' && value.includes('62387--book-0')));
      assert.equal(db.deactivateCalls, 1);
      assert.ok(db.runs.length <= 2, `discovery write budget exploded: ${db.runs.length}`);
    },
  );
});

test('empty team discovery fails before existing active titles can be mass-deactivated', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const db = new DB(['62387--pokemon-master-of-tactics']);
  await withFetch(
    (url) => url === teamCatalogUrl ? catalogResponse([]) : new Response('unexpected', { status: 500 }),
    async () => {
      await assert.rejects(
        () => discoverRanobeLibTeam({ DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' }),
        /returned no book links/i,
      );
      assert.equal(db.deactivateCalls, 0);
      assert.equal(db.upserts.length, 0);
    },
  );
});
