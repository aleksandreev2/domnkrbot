import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

async function loadScanner() {
  return import('../dist-runtime/ranobelib-fast-scanner.js');
}

const source = readFileSync(new URL('../src/ranobelib-fast-scanner.ts', import.meta.url), 'utf8');

test('idle scanner exposes paid batch and three-hour cadence', async () => {
  const scanner = await loadScanner();
  assert.equal(scanner.IDLE_SCAN_LIMIT, 24);
  assert.equal(scanner.IDLE_SCAN_DELAY_MINUTES, 180);
  assert.equal(typeof scanner.scanIdleRanobeLibTitles, 'function');
});

test('idle selection requires active initialized zero-demand titles that are due', () => {
  assert.match(source, /notification_subscriber_count\s*=\s*0/i);
  assert.match(source, /snapshot_ready\s*=\s*1/i);
  assert.match(source, /is_active\s*=\s*1/i);
  assert.match(source, /next_check_at\s+IS\s+NULL|next_check_at\s*<=\s*CURRENT_TIMESTAMP/i);
});

class IdleStatement {
  constructor(db, query) {
    this.db = db;
    this.query = query.replace(/\s+/g, ' ').trim();
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (/SELECT snapshot_ready, last_release_at, title, summary, cover_url/i.test(this.query)) {
      return { snapshot_ready: 1, last_release_at: '2026-09-06 10:00:00', title: 'Idle Book', summary: null, cover_url: null };
    }
    return null;
  }
  async all() {
    if (/FROM ranobelib_titles/i.test(this.query) && /notification_subscriber_count\s*=\s*0/i.test(this.query)) {
      return { results: [this.db.row] };
    }
    if (/FROM ranobelib_chapters WHERE book_ref = \?/i.test(this.query)) {
      return { results: [{ id: 101, volume: '1', number: '1', name: 'Old', firstSeenAt: '2026-09-06T10:00:00.000Z' }] };
    }
    return { results: [] };
  }
  async run() {
    if (/UPDATE ranobelib_titles SET/i.test(this.query) && /next_check_at/i.test(this.query)) {
      this.db.updates.push({ query: this.query, values: [...this.values] });
    }
    return { meta: { changes: 1 } };
  }
}

class IdleDB {
  constructor() {
    this.row = {
      book_ref: '77--idle-book', ranobelib_id: 77, slug: 'idle-book',
      url: 'https://ranobelib.me/ru/book/77--idle-book', title: 'Idle Book', cover_url: null,
      snapshot_ready: 1, consecutive_no_change: 7, consecutive_failures: 0,
      last_change_at: '2026-09-06 10:00:00', next_check_at: '2026-09-07 08:00:00',
      scan_priority: 0, notification_subscriber_count: 0,
    };
    this.updates = [];
  }
  prepare(query) { return new IdleStatement(this, query); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function chapter(id, number) {
  return {
    id, volume: '1', number: String(number), name: `Chapter ${number}`,
    branches: [{
      id: id + 1000, branch_id: 9, created_at: '2026-09-06T10:00:00.000Z',
      teams: [{ id: 11969, slug: 'dom-nekromanta', slug_url: '11969--dom-nekromanta' }],
      user: { id: 1, username: 'uploader' },
    }],
  };
}

test('successful idle scan schedules the next check 180 minutes later', async () => {
  const scanner = await loadScanner();
  const db = new IdleDB();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.cdnlibs.org/api/manga/77--idle-book/chapters');
    return new Response(JSON.stringify({ data: [chapter(101, 1)] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await scanner.scanIdleRanobeLibTitles(
      { DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' },
      { now: new Date('2026-09-07T09:00:00.000Z') },
    );
    assert.equal(result.selected, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.newReleases, 0);
    assert.equal(db.updates.length, 1);
    assert.ok(db.updates[0].values.includes(180), 'idle success must use the fixed 180-minute cadence');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
