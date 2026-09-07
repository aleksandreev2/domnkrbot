import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

async function loadScanner() {
  return import('../dist-runtime/ranobelib-fast-scanner.js');
}

test('paid scanner preserves the frozen 1/2/5/10/30 cadence and exponential failure backoff', async () => {
  const scanner = await loadScanner();
  assert.equal(scanner.FAST_SCAN_LIMIT, 24);
  const now = new Date('2026-09-07T09:00:00.000Z');
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: true, consecutiveNoChange: 9, consecutiveFailures: 0, now }), 1);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 1, consecutiveFailures: 0, lastChangeAt: '2026-09-07T08:50:00.000Z', now }), 2);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 2, consecutiveFailures: 0, lastChangeAt: '2026-09-07T07:30:00.000Z', now }), 5);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 1, consecutiveFailures: 0, lastChangeAt: '2026-09-06T20:00:00.000Z', now }), 10);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 2, consecutiveFailures: 0, lastChangeAt: null, now }), 10);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 3, consecutiveFailures: 0, lastChangeAt: null, now }), 30);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 0, consecutiveFailures: 1, failed: true, now }), 5);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 0, consecutiveFailures: 2, failed: true, now }), 10);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 0, consecutiveFailures: 3, failed: true, now }), 20);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 0, consecutiveFailures: 4, failed: true, now }), 30);
  assert.equal(scanner.computeNextCheckDelayMinutes({ changed: false, consecutiveNoChange: 0, consecutiveFailures: 9, failed: true, now }), 30);
});

test('selectDueTitles uses one demand-aware query for HOT titles and uninitialized bootstrap titles with a 24-title cap', async () => {
  const scanner = await loadScanner();
  const calls = [];
  const rows = Array.from({ length: 8 }, (_, index) => ({
    book_ref: `${index + 1}--book-${index + 1}`,
    ranobelib_id: index + 1,
    slug: `book-${index + 1}`,
    url: `https://ranobelib.me/ru/book/${index + 1}--book-${index + 1}`,
    title: `Book ${index + 1}`,
    cover_url: null,
    snapshot_ready: index === 0 ? 0 : 1,
    consecutive_no_change: index,
    consecutive_failures: 0,
    last_change_at: null,
    next_check_at: index === 0 ? null : '2026-09-07 08:00:00',
    scan_priority: 0,
    notification_subscriber_count: index === 0 ? 0 : 1,
  }));
  const env = {
    DB: {
      prepare(query) {
        const state = { query, values: [] };
        calls.push(state);
        return {
          bind(...values) { state.values = values; return this; },
          async all() { return { results: rows.slice(0, Number(state.values.at(-1)) || rows.length) }; },
        };
      },
    },
  };

  const result = await scanner.selectDueTitles(env);
  assert.equal(result.length, 8);
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /is_active\s*=\s*1/i);
  assert.match(calls[0].query, /snapshot_ready\s*=\s*0[\s\S]*notification_subscriber_count\s*>\s*0/i);
  assert.match(calls[0].query, /next_check_at\s+IS\s+NULL[\s\S]*next_check_at\s*<=\s*CURRENT_TIMESTAMP/i);
  assert.match(calls[0].query, /ORDER BY[\s\S]*COALESCE\s*\(\s*next_check_at[\s\S]*notification_subscriber_count\s+DESC[\s\S]*scan_priority\s+DESC/i);
  assert.match(calls[0].query, /LIMIT\s*\?/i);
  assert.equal(calls[0].values.at(-1), 24);
});

class ScanStatement {
  constructor(db, query) { this.db = db; this.query = query.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (/SELECT snapshot_ready, last_release_at, title, summary, cover_url/i.test(this.query)) {
      return { snapshot_ready: 1, last_release_at: '2026-09-06 10:00:00', title: 'Fast Book', summary: null, cover_url: null };
    }
    return null;
  }
  async all() {
    if (/FROM ranobelib_titles/i.test(this.query) && /next_check_at/i.test(this.query)) return { results: [this.db.dueTitle] };
    if (/FROM ranobelib_chapters WHERE book_ref = \?/i.test(this.query)) {
      return { results: [{ id: 101, volume: '1', number: '1', name: 'Old', firstSeenAt: '2026-09-06T10:00:00.000Z' }] };
    }
    return { results: [] };
  }
  async run() {
    if (/INSERT OR IGNORE INTO ranobelib_releases/i.test(this.query)) {
      this.db.releaseInserts.push([...this.values]);
      return { meta: { changes: 1 } };
    }
    if (/UPDATE ranobelib_titles SET/i.test(this.query) && /consecutive_no_change/i.test(this.query)) {
      this.db.schedulerUpdates.push({ query: this.query, values: [...this.values] });
    }
    return { meta: { changes: 1 } };
  }
}

class ScanDB {
  constructor() {
    this.dueTitle = {
      book_ref: '77--fast-book', ranobelib_id: 77, slug: 'fast-book',
      url: 'https://ranobelib.me/ru/book/77--fast-book', title: 'Fast Book', cover_url: null,
      snapshot_ready: 1, consecutive_no_change: 4, consecutive_failures: 2,
      last_change_at: '2026-09-06 10:00:00', next_check_at: '2026-09-07 08:00:00', scan_priority: 1,
      notification_subscriber_count: 1,
    };
    this.releaseInserts = []; this.schedulerUpdates = [];
  }
  prepare(query) { return new ScanStatement(this, query); }
  async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; }
}

function chapter(id, number, teamId, createdAt = '2026-09-07T08:00:00.000Z') {
  return {
    id, volume: '1', number: String(number), name: `Chapter ${number}`,
    branches: [{
      id: id + 1000, branch_id: 9, created_at: createdAt,
      teams: [{ id: teamId, slug: teamId === 11969 ? 'dom-nekromanta' : 'other', slug_url: `${teamId}--team` }],
      user: { id: 1, username: 'uploader' },
    }],
  };
}

test('successful release scan preserves team filtering and resets both scheduler counters', async () => {
  const scanner = await loadScanner();
  const db = new ScanDB();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url) === 'https://api.cdnlibs.org/api/manga/77--fast-book/chapters') {
      return new Response(JSON.stringify({ data: [
        chapter(101, 1, 11969, '2026-09-06T09:00:00.000Z'),
        chapter(102, 2, 11969), chapter(999, 99, 555),
      ] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('unexpected', { status: 500 });
  };
  try {
    const result = await scanner.scanDueRanobeLibTitles(
      { DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' },
      { now: new Date('2026-09-07T08:05:00.000Z') },
    );
    assert.deepEqual(requests, ['https://api.cdnlibs.org/api/manga/77--fast-book/chapters']);
    assert.equal(result.selected, 1);
    assert.equal(result.newReleases, 1);
    assert.equal(db.releaseInserts.length, 1);
    assert.equal(db.releaseInserts[0].includes('99'), false);
    assert.equal(db.schedulerUpdates.length, 1);
    assert.match(db.schedulerUpdates[0].query, /consecutive_failures\s*=\s*0/i);
    assert.ok(db.schedulerUpdates[0].values.includes(0));
    assert.ok(db.schedulerUpdates[0].values.includes(1));
  } finally { globalThis.fetch = originalFetch; }
});

class FailureStatement {
  constructor(db, query) { this.db = db; this.query = query.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return { snapshot_ready: 1, last_release_at: null, title: 'Broken', summary: null, cover_url: null }; }
  async all() {
    if (/FROM ranobelib_titles/i.test(this.query)) return { results: [this.db.row] };
    if (/FROM ranobelib_chapters/i.test(this.query)) return { results: [] };
    return { results: [] };
  }
  async run() {
    if (/sync_error/i.test(this.query)) this.db.failureUpdates.push({ query: this.query, values: [...this.values] });
    return { meta: { changes: 1 } };
  }
}
class FailureDB {
  constructor() {
    this.row = {
      book_ref: '90--broken', ranobelib_id: 90, slug: 'broken', url: 'https://ranobelib.me/ru/book/90--broken',
      title: 'Broken', cover_url: null, snapshot_ready: 1, consecutive_no_change: 7, consecutive_failures: 2,
      last_change_at: '2026-09-06 11:00:00', next_check_at: '2026-09-07 08:00:00', scan_priority: 0,
      notification_subscriber_count: 1,
    };
    this.failureUpdates = [];
  }
  prepare(query) { return new FailureStatement(this, query); }
}

test('scan failure increments only consecutive_failures and backs off 5/10/20/30 without touching no-change state', async () => {
  const scanner = await loadScanner();
  const db = new FailureDB();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('upstream down', { status: 500 });
  try {
    const result = await scanner.scanDueRanobeLibTitles(
      { DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' },
      { now: new Date('2026-09-07T09:00:00.000Z') },
    );
    assert.equal(result.failed, 1);
    assert.equal(db.failureUpdates.length, 1);
    const update = db.failureUpdates[0];
    assert.match(update.query, /consecutive_failures\s*=\s*consecutive_failures\s*\+\s*1/i);
    assert.doesNotMatch(update.query, /consecutive_no_change\s*=/i);
    assert.doesNotMatch(update.query, /last_change_at\s*=/i);
    assert.ok(update.values.includes(20), 'third consecutive failure should back off for 20 minutes');
  } finally { globalThis.fetch = originalFetch; }
});

class BootstrapStatement {
  constructor(db, query) { this.db = db; this.query = query.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (/SELECT snapshot_ready, last_release_at, title, summary, cover_url/i.test(this.query)) {
      return { snapshot_ready: 0, last_release_at: null, title: 'New Book', summary: null, cover_url: null };
    }
    return null;
  }
  async all() {
    if (/FROM ranobelib_titles/i.test(this.query) && /next_check_at/i.test(this.query)) return { results: [this.db.bootstrapTitle] };
    if (/FROM ranobelib_chapters/i.test(this.query)) throw new Error('bootstrap must not read a nonexistent previous snapshot');
    return { results: [] };
  }
  async run() {
    if (/INSERT INTO ranobelib_chapters/i.test(this.query)) { this.db.chapterInserts.push({ query: this.query, values: [...this.values] }); return { meta: { changes: 120 } }; }
    if (/INSERT OR IGNORE INTO ranobelib_releases/i.test(this.query)) { this.db.releaseInserts.push([...this.values]); return { meta: { changes: 1 } }; }
    if (/UPDATE ranobelib_titles SET/i.test(this.query) && /snapshot_ready\s*=\s*1/i.test(this.query)) this.db.schedulerUpdates.push({ query: this.query, values: [...this.values] });
    return { meta: { changes: 1 } };
  }
}
class BootstrapDB {
  constructor() {
    this.bootstrapTitle = {
      book_ref: '88--new-book', ranobelib_id: 88, slug: 'new-book', url: 'https://ranobelib.me/ru/book/88--new-book',
      title: 'New Book', cover_url: null, snapshot_ready: 0, consecutive_no_change: 0, consecutive_failures: 0,
      last_change_at: null, next_check_at: null, scan_priority: 0, notification_subscriber_count: 0,
    };
    this.chapterInserts = []; this.releaseInserts = []; this.schedulerUpdates = [];
  }
  prepare(query) { return new BootstrapStatement(this, query); }
  async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; }
}

test('unified fast scanner bootstraps a newly discovered title without replaying old history or exploding D1 writes', async () => {
  const scanner = await loadScanner();
  const db = new BootstrapDB();
  const originalFetch = globalThis.fetch;
  const oldChapters = Array.from({ length: 120 }, (_, index) => chapter(2000 + index, index + 1, 11969, '2026-09-01T08:00:00.000Z'));
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.cdnlibs.org/api/manga/88--new-book/chapters');
    return new Response(JSON.stringify({ data: oldChapters }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await scanner.scanDueRanobeLibTitles(
      { DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' },
      { now: new Date('2026-09-07T09:00:00.000Z') },
    );
    assert.equal(result.selected, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.newReleases, 0);
    assert.equal(db.releaseInserts.length, 0);
    assert.equal(db.chapterInserts.length, 1);
    assert.match(db.chapterInserts[0].query, /json_each/i);
    assert.equal(db.schedulerUpdates.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('migration 0014 adds frozen scheduler/claim fields, initializes active titles, and stays forward-only', () => {
  const sql = readFileSync(new URL('../migrations/0014_telegram_notifications_v3.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE ranobelib_titles ADD COLUMN next_check_at TEXT/i);
  assert.match(sql, /ALTER TABLE ranobelib_titles ADD COLUMN last_change_at TEXT/i);
  assert.match(sql, /ALTER TABLE ranobelib_titles ADD COLUMN consecutive_no_change INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /ALTER TABLE ranobelib_titles ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /ALTER TABLE ranobelib_titles ADD COLUMN scan_priority INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /ALTER TABLE ranobelib_notification_outbox ADD COLUMN claim_token TEXT/i);
  assert.match(sql, /ALTER TABLE ranobelib_notification_outbox ADD COLUMN claim_expires_at TEXT/i);
  assert.match(sql, /UPDATE ranobelib_titles[\s\S]*next_check_at\s*=\s*CURRENT_TIMESTAMP[\s\S]*is_active\s*=\s*1/i);
  assert.match(sql, /idx_ranobelib_titles_due_scan/i);
  assert.match(sql, /idx_ranobelib_notification_due_v3/i);
  assert.doesNotMatch(sql, /DROP\s+TABLE|ALTER\s+TABLE[^;]+RENAME/i);
});
