import assert from 'node:assert/strict';
import test from 'node:test';

const teamCatalogUrl = 'https://api.cdnlibs.org/api/manga?site_id[]=3&target_id=11969&target_model=team&page=1';

function catalogResponse(data) {
  return new Response(JSON.stringify({ data, meta: { current_page: 1, has_next_page: false } }), {
    headers: { 'content-type': 'application/json' },
  });
}

class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() { return null; }
  async all() {
    if (/SELECT book_ref FROM ranobelib_titles WHERE is_active = 1/i.test(this.query)) {
      return { results: this.db.activeRefs.map((book_ref) => ({ book_ref })) };
    }
    return { results: [] };
  }
  async run() {
    if (/UPDATE ranobelib_titles SET is_active = 0/i.test(this.query)) this.db.deactivateCalls += 1;
    if (/INSERT INTO ranobelib_titles/i.test(this.query)) this.db.upserts.push([...this.values]);
    return { meta: { changes: 1 } };
  }
}

class DB {
  constructor(activeRefs = []) {
    this.activeRefs = activeRefs;
    this.deactivateCalls = 0;
    this.upserts = [];
  }
  prepare(query) { return new Statement(this, query); }
  async batch(statements) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push(String(url));
    return handler(String(url), init);
  };
  try { return await fn(requests); } finally { globalThis.fetch = original; }
}

test('team discovery refreshes only the team catalog and never fetches chapter lists', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const db = new DB(['999--old-book']);
  const title = {
    id: 62387,
    slug: 'pokemon-master-of-tactics',
    slug_url: '62387--pokemon-master-of-tactics',
    rus_name: 'Покемон: Мастер тактики',
    cover: { default: 'https://cover.cdnlibs.org/uploads/cover/pokemon/default.jpg' },
  };

  await withFetch(
    (url) => url === teamCatalogUrl ? catalogResponse([title]) : new Response('unexpected', { status: 500 }),
    async (requests) => {
      const result = await discoverRanobeLibTeam({ DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' });
      assert.deepEqual(requests, [teamCatalogUrl]);
      assert.equal(requests.some((url) => url.includes('/chapters')), false);
      assert.equal(result.discovered, 1);
      assert.equal(result.deactivated, 1);
      assert.equal(db.deactivateCalls, 1);
      assert.equal(db.upserts.length, 1);
      assert.ok(db.upserts[0].includes('62387--pokemon-master-of-tactics'));
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
