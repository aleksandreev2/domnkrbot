import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const constantsUrl = 'https://api.cdnlibs.org/api/constants?fields[]=scanlateStatus';
const teamCatalogUrl = 'https://api.cdnlibs.org/api/manga?site_id[]=3&target_id=11969&target_model=team&fields[]=status_id&page=1';

function constantsResponse() {
  return Response.json({ data: { scanlateStatus: [
    { id: 1, label: 'Продолжается', site_ids: [3] },
    { id: 7, label: 'Завершён', site_ids: [3] },
  ] } });
}

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

function discoveryFetch(titles) {
  return (url) => {
    if (url === constantsUrl) return constantsResponse();
    if (url === teamCatalogUrl) return catalogResponse(titles);
    return new Response('unexpected', { status: 500 });
  };
}

test('team discovery uses one bounded JSON upsert, refreshes effective demand, makes new active titles immediately scannable, and never fetches chapters', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const db = new DB(['999--old-book']);
  const titles = Array.from({ length: 60 }, (_, index) => ({
    id: 62387 + index,
    slug: `book-${index}`,
    slug_url: `${62387 + index}--book-${index}`,
    rus_name: `Книга ${index}`,
    scanlateStatus: { id: 1, label: 'Продолжается' },
    cover: { default: `https://cover.cdnlibs.org/uploads/cover/book-${index}/default.jpg` },
  }));

  await withFetch(
    discoveryFetch(titles),
    async (requests) => {
      const result = await discoverRanobeLibTeam({ DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' });
      assert.deepEqual(requests, [constantsUrl, teamCatalogUrl]);
      assert.equal(requests.some((url) => url.includes('/chapters')), false);
      assert.equal(result.discovered, 60);
      assert.equal(result.activated, 60);
      assert.equal(result.deactivated, 1);
      assert.equal(db.upserts.length, 1, '60 titles must not become 60 D1 queries');
      const upsert = db.upserts[0].query;
      assert.match(upsert, /json_each/i);
      assert.match(upsert, /next_check_at/i);
      assert.match(upsert, /CURRENT_TIMESTAMP/i);
      assert.match(upsert, /notification_subscriber_count/i);
      assert.match(upsert, /subscriber_count_updated_at/i);
      assert.match(upsert, /translation_status_id/i);
      assert.match(upsert, /translation_is_completed/i);
      assert.match(upsert, /telegram_delivery_reachability/i);
      assert.match(upsert, /title_subscription_exclusions/i);
      assert.match(upsert, /title_subscriptions/i);
      assert.ok(db.upserts[0].values.some((value) => typeof value === 'string' && value.includes('62387--book-0')));
      assert.equal(db.deactivateCalls, 1);
      assert.ok(db.runs.length <= 2, `discovery write budget exploded: ${db.runs.length}`);
    },
  );
});

test('accentless completed label is still classified as completed', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const db = new DB();
  const titles = [{
    id: 70007,
    slug: 'finished-book',
    slug_url: '70007--finished-book',
    rus_name: 'Готовая книга',
    scanlateStatus: { id: 7, label: 'Завершен' },
  }];

  await withFetch(discoveryFetch(titles), async () => {
    const result = await discoverRanobeLibTeam({ DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' });
    assert.equal(result.discovered, 1);
    assert.equal(result.activated, 0, 'completed translation must not enter the active scan set');
    const payload = JSON.parse(String(db.upserts[0].values[0]));
    assert.equal(payload[0].translationCompleted, true);
  });
});

test('unknown scalar status id fails open instead of treating legacy id 2 as completed', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const db = new DB();
  const titles = [{
    id: 70008,
    slug: 'unknown-status-book',
    slug_url: '70008--unknown-status-book',
    rus_name: 'Книга с неизвестным статусом',
    status_id: 2,
  }];

  await withFetch((url) => {
    if (url === constantsUrl) return new Response('unavailable', { status: 503 });
    if (url === teamCatalogUrl) return catalogResponse(titles);
    return new Response('unexpected', { status: 500 });
  }, async () => {
    const result = await discoverRanobeLibTeam({ DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' });
    assert.equal(result.discovered, 1);
    assert.equal(result.activated, 1, 'unknown status must remain active/fail-open');
    const payload = JSON.parse(String(db.upserts[0].values[0]));
    assert.equal(payload[0].translationCompleted, null);
  });
});

test('completion semantics never fall back to the legacy numeric status id', () => {
  const scheduler = readFileSync(new URL('../src/ranobelib-discovery-scheduler.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/0021_translation_completion_semantics.sql', import.meta.url), 'utf8');
  const uxRuntime = readFileSync(new URL('../src/telegram-notification-ux-runtime.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(scheduler, /LEGACY_COMPLETED_TRANSLATION_STATUS|translationStatusId\s*===\s*2/);
  assert.doesNotMatch(migration, /translation_status_id\s*=\s*2/i);
  assert.doesNotMatch(uxRuntime, /translation_status_id\s*=\s*2/i);
});

test('empty team discovery fails before existing active titles can be mass-deactivated', async () => {
  const { discoverRanobeLibTeam } = await import('../dist-runtime/ranobelib-discovery-scheduler.js');
  const db = new DB(['62387--pokemon-master-of-tactics']);
  await withFetch(
    discoveryFetch([]),
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
