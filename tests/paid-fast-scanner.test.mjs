import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

async function loadScanner() {
  return import('../dist-runtime/ranobelib-fast-scanner.js');
}

const source = readFileSync(new URL('../src/ranobelib-fast-scanner.ts', import.meta.url), 'utf8');

function dueTitle(index, demand = 1, snapshotReady = 1) {
  return {
    book_ref: `${100 + index}--paid-book-${index}`,
    ranobelib_id: 100 + index,
    slug: `paid-book-${index}`,
    url: `https://ranobelib.me/ru/book/${100 + index}--paid-book-${index}`,
    title: `Paid Book ${index}`,
    cover_url: null,
    snapshot_ready: snapshotReady,
    consecutive_no_change: 0,
    consecutive_failures: 0,
    last_change_at: null,
    next_check_at: '2026-09-07 10:00:00',
    scan_priority: 0,
    notification_subscriber_count: demand,
  };
}

test('paid hot scanner raises the bounded batch to 24 and concurrency to 4', async () => {
  const scanner = await loadScanner();
  assert.equal(scanner.FAST_SCAN_LIMIT, 24);
  assert.equal(scanner.FAST_SCAN_CONCURRENCY, 4);
  assert.match(source, /mapWithConcurrency\s*\(\s*selected\s*,\s*FAST_SCAN_CONCURRENCY/i);
});

test('fast selection admits only due HOT titles plus due uninitialized bootstrap titles', async () => {
  const scanner = await loadScanner();
  const calls = [];
  const rows = Array.from({ length: 30 }, (_, index) => dueTitle(index, index === 0 ? 0 : 1, index === 0 ? 0 : 1));
  const env = {
    DB: {
      prepare(query) {
        const call = { query: query.replace(/\s+/g, ' ').trim(), values: [] };
        calls.push(call);
        return {
          bind(...values) { call.values = values; return this; },
          async all() { return { results: rows.slice(0, Number(call.values.at(-1)) || rows.length) }; },
        };
      },
    },
  };

  const result = await scanner.selectDueTitles(env);
  assert.equal(result.length, 24);
  assert.equal(calls[0].values.at(-1), 24);
  assert.match(calls[0].query, /notification_subscriber_count/i);
  assert.match(calls[0].query, /snapshot_ready\s*=\s*0[\s\S]*notification_subscriber_count\s*>\s*0/i);
  assert.match(calls[0].query, /AND\s*\(\s*next_check_at\s+IS\s+NULL\s+OR\s+next_check_at\s*<=\s*CURRENT_TIMESTAMP\s*\)/i);
  assert.doesNotMatch(calls[0].query, /AND\s*\(\s*snapshot_ready\s*=\s*0\s+OR\s+next_check_at/i);
  assert.match(calls[0].query, /ORDER BY[\s\S]*COALESCE\s*\(\s*next_check_at[\s\S]*notification_subscriber_count\s+DESC[\s\S]*scan_priority\s+DESC/i);
});

class ConcurrentStatement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (/SELECT snapshot_ready, last_release_at, title, summary, cover_url/i.test(this.query)) {
      const ref = String(this.values[0] || '');
      return {
        snapshot_ready: 1,
        last_release_at: '2026-09-06 10:00:00',
        title: ref,
        summary: null,
        cover_url: null,
      };
    }
    return null;
  }
  async all() {
    if (/FROM ranobelib_titles/i.test(this.query) && /next_check_at/i.test(this.query)) {
      const limit = Number(this.values.at(-1)) || this.db.rows.length;
      return { results: this.db.rows.slice(0, limit) };
    }
    if (/FROM ranobelib_chapters/i.test(this.query)) return { results: [] };
    return { results: [] };
  }
  async run() { return { meta: { changes: 1 } }; }
}

class ConcurrentDB {
  constructor(rows) { this.rows = rows; }
  prepare(query) { return new ConcurrentStatement(this, query); }
}

test('paid hot scans actually overlap but never exceed four concurrent RanobeLib fetches', async () => {
  const scanner = await loadScanner();
  const rows = Array.from({ length: 8 }, (_, index) => dueTitle(index, 1, 1));
  const db = new ConcurrentDB(rows);
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await scanner.scanDueRanobeLibTitles(
      { DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' },
      { now: new Date('2026-09-07T11:00:00.000Z') },
    );
    assert.equal(result.selected, 8);
    assert.equal(result.succeeded, 8);
    assert.equal(calls, 8);
    assert.ok(maxActive > 1, `expected overlapping fetches, saw maxActive=${maxActive}`);
    assert.ok(maxActive <= 4, `expected at most four concurrent fetches, saw maxActive=${maxActive}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('no selected HOT or bootstrap titles means the minute scanner performs zero RanobeLib fetches', async () => {
  const scanner = await loadScanner();
  const env = {
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
        };
      },
    },
  };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}'); };
  try {
    const result = await scanner.scanDueRanobeLibTitles(env);
    assert.equal(result.selected, 0);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
