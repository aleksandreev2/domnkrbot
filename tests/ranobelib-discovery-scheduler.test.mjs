import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const teamCatalogUrl = 'https://api.cdnlibs.org/api/manga?site_id[]=3&target_id=11969&target_model=team&page=1';

function catalogResponse(data) {
  return new Response(JSON.stringify({ data, meta: { current_page: 1, has_next_page: false } }), {
    headers: { 'content-type': 'application/json' },
  });
}

function statusResponse(id = 1, label = 'Продолжается') {
  return Response.json({ data: { scanlateStatus: { id, label } } });
}

class Statement {
  constructor(db, query) { this.db = db; this.query = query.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return null; }
  async all() {
    if (/SELECT book_ref FROM ranobelib_titles WHERE is_active = 1/i.test(this.query)) {
      return { results: this.db.activeRefs.map((book_ref) => ({ book_ref })) };
    }
    if (/translation_status_checked_at/i.test(this.query) && /FROM ranobelib_titles/i.test(this.query)) {
      return { results: this.db.statusRows };
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
  constructor(activeRefs = [], statusRows = []) {
    this.activeRefs = activeRefs;
    this.statusRows = statusRows;
    this.deactivateCalls = 0;
    this.upserts = [];
    this.runs = [];
  }
  prepare(query) { return new Statement(this, query); }
  async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; }
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => { requests.push(String(url)); return handler(String(url), init); };
  try { return await fn(requests); } finally { globalThis.fetch = original; }
}

function book(index, baseId = 62387) {
  const id = baseId + index;
  return {
    id,
    slug: `book-${index}`,
    slug_url: `${id}--book-${index}`,
    rus_name: `Книга ${index}`,
    status: { id: 2, label: 'Завершён' },
    cover: { default: `https://cover.cdnlibs.org/uploads/cover/book-${index}/default.jpg` },
  };
}

function detailRequest(url) {
  return url.includes('/api/manga/') && url.endsWith('?fields[]=status_id');
}

test('team discovery keeps D1 writes bounded and caps one-time unknown-status backfill at 48 detail requests', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const db = new DB(['999--old-book']);
  const titles = Array.from({ length: 60 }, (_, index) => book(index));

  await withFetch((url) => {
    if (url === teamCatalogUrl) return catalogResponse(titles);
    if (detailRequest(url)) return statusResponse();
    return new Response('unexpected', { status: 500 });
  }, async (requests) => {
    const result = await discoverRanobeLibTeam({ DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' });
    assert.equal(requests[0], teamCatalogUrl);
    assert.equal(requests.filter(detailRequest).length, 48);
    assert.equal(requests.some((url) => url.includes('/chapters')), false);
    assert.equal(result.discovered, 60);
    assert.equal(result.activated, 60);
    assert.equal(result.deactivated, 1);
    assert.equal(db.upserts.length, 1, '60 titles must still be one D1 JSON upsert');
    const upsert = db.upserts[0].query;
    assert.match(upsert, /json_each/i);
    assert.match(upsert, /translation_status_checked_at/i);
    assert.match(upsert, /translation_is_completed/i);
    assert.match(upsert, /telegram_delivery_reachability/i);
    assert.match(upsert, /title_subscription_exclusions/i);
    assert.match(upsert, /title_subscriptions/i);
    const payload = JSON.parse(String(db.upserts[0].values[0]));
    assert.equal(payload.filter((row) => row.translationStatusChecked === 1).length, 48);
    assert.equal(db.deactivateCalls, 1);
    assert.ok(db.runs.length <= 2, `discovery write budget exploded: ${db.runs.length}`);
  });
});

test('historical completed translation is classified from detail scanlateStatus without trusting generic work status', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const db = new DB();
  const titles = [book(0, 70007)];

  await withFetch((url) => {
    if (url === teamCatalogUrl) return catalogResponse(titles);
    if (detailRequest(url)) return statusResponse(2, 'Завершен');
    return new Response('unexpected', { status: 500 });
  }, async () => {
    const result = await discoverRanobeLibTeam({ DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' });
    assert.equal(result.discovered, 1);
    assert.equal(result.activated, 0, 'completed translation must not enter the active scan set');
    const payload = JSON.parse(String(db.upserts[0].values[0]));
    assert.equal(payload[0].translationStatusLabel, 'Завершен');
    assert.equal(payload[0].translationCompleted, true);
    assert.equal(payload[0].translationStatusChecked, 1);
  });
});

test('fresh stored translation status is reused without another upstream detail request', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const ref = '71000--book-0';
  const db = new DB([ref], [{
    book_ref: ref,
    translation_status_id: 2,
    translation_status_label: 'Завершён',
    translation_is_completed: 1,
    translation_status_checked_at: new Date().toISOString(),
  }]);

  await withFetch((url) => {
    if (url === teamCatalogUrl) return catalogResponse([book(0, 71000)]);
    return new Response('unexpected detail request', { status: 500 });
  }, async (requests) => {
    const result = await discoverRanobeLibTeam({ DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' });
    assert.deepEqual(requests, [teamCatalogUrl]);
    assert.equal(result.deactivated, 1);
    const payload = JSON.parse(String(db.upserts[0].values[0]));
    assert.equal(payload[0].translationCompleted, true);
    assert.equal(payload[0].translationStatusChecked, 0);
  });
});

test('periodic status refresh checks at most eight stale known titles per discovery run', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const titles = Array.from({ length: 12 }, (_, index) => book(index, 72000));
  const stale = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const statusRows = titles.map((title) => ({
    book_ref: title.slug_url,
    translation_status_id: 1,
    translation_status_label: 'Продолжается',
    translation_is_completed: 0,
    translation_status_checked_at: stale,
  }));
  const db = new DB([], statusRows);

  await withFetch((url) => {
    if (url === teamCatalogUrl) return catalogResponse(titles);
    if (detailRequest(url)) return statusResponse();
    return new Response('unexpected', { status: 500 });
  }, async (requests) => {
    await discoverRanobeLibTeam({ DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' });
    assert.equal(requests.filter(detailRequest).length, 8);
    const payload = JSON.parse(String(db.upserts[0].values[0]));
    assert.equal(payload.filter((row) => row.translationStatusChecked === 1).length, 8);
  });
});

test('failed detail status refresh fails open and remains eligible for a later retry', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const db = new DB();

  await withFetch((url) => {
    if (url === teamCatalogUrl) return catalogResponse([book(0, 73000)]);
    if (detailRequest(url)) return new Response('temporary upstream error', { status: 503 });
    return new Response('unexpected', { status: 500 });
  }, async () => {
    const result = await discoverRanobeLibTeam({ DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' });
    assert.equal(result.activated, 1);
    const payload = JSON.parse(String(db.upserts[0].values[0]));
    assert.equal(payload[0].translationCompleted, null);
    assert.equal(payload[0].translationStatusChecked, 0);
  });
});

test('completion semantics and refresh cadence stay semantic rather than legacy-id based', () => {
  const scheduler = readFileSync(new URL('../src/ranobelib-discovery-scheduler.ts', import.meta.url), 'utf8');
  const semanticMigration = readFileSync(new URL('../migrations/0021_translation_completion_semantics.sql', import.meta.url), 'utf8');
  const refreshMigration = readFileSync(new URL('../migrations/0022_translation_status_refresh.sql', import.meta.url), 'utf8');
  const uxRuntime = readFileSync(new URL('../src/telegram-notification-ux-runtime.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(scheduler, /LEGACY_COMPLETED_TRANSLATION_STATUS|translationStatusId\s*===\s*2/);
  assert.doesNotMatch(semanticMigration, /translation_status_id\s*=\s*2/i);
  assert.doesNotMatch(uxRuntime, /translation_status_id\s*=\s*2/i);
  assert.match(refreshMigration, /translation_status_checked_at/i);
  assert.match(scheduler, /PERIODIC_STATUS_REFRESH_LIMIT\s*=\s*8/);
  assert.match(scheduler, /STATUS_REFRESH_CONCURRENCY\s*=\s*4/);
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
