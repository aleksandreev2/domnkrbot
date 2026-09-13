import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { scanDueMultiTeamWorks } from '../dist-runtime/ranobelib-multi-team-scanner.js';

class Statement {
  constructor(owner, sql) {
    this.owner = owner;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  statement() {
    return this.owner.sqlite.prepare(this.sql);
  }

  async run() {
    const result = this.statement().run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  async first() {
    return this.statement().get(...this.values) ?? null;
  }

  async all() {
    return { results: this.statement().all(...this.values) };
  }
}

class SqliteD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function migratedDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  return { sqlite, db: new SqliteD1(sqlite) };
}

function seedBook(sqlite, bookRef) {
  sqlite.prepare(`
    INSERT INTO ranobelib_titles (
      book_ref, ranobelib_id, slug, url, title, is_active, snapshot_ready,
      notification_subscriber_count, translation_completion_pending, next_check_at,
      consecutive_no_change, consecutive_failures, scan_priority, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, 1, 1, 1, 0, ?, 7, 2, 9, ?)
  `).run(
    bookRef,
    Number.parseInt(bookRef, 10),
    bookRef.split('--')[1] ?? bookRef,
    `https://ranobelib.me/ru/book/${bookRef}`,
    `Title ${bookRef}`,
    '2099-01-01 00:00:00',
    '2001-01-01 00:00:00',
  );
}

function primaryTeam(sqlite) {
  sqlite.exec(`UPDATE ranobelib_teams SET lifecycle_state='published' WHERE is_primary=1`);
  return sqlite.prepare(`
    SELECT id, ranobelib_team_id FROM ranobelib_teams WHERE is_primary=1
  `).get();
}

function seedTranslation(sqlite, teamId, bookRef, { baselineReady = 1 } = {}) {
  sqlite.prepare(`
    INSERT INTO ranobelib_team_translations (
      team_id, book_ref, presence_state, semantic_status, baseline_ready, completion_pending
    ) VALUES (?, ?, 'active', 'active', ?, 0)
  `).run(teamId, bookRef, baselineReady);
}

function dueWork(sqlite, bookRef) {
  return sqlite.prepare(`
    SELECT book_ref, ranobelib_id, slug, url, title, cover_url,
           notification_subscriber_count, consecutive_no_change,
           consecutive_failures, next_check_at
    FROM ranobelib_titles WHERE book_ref=?
  `).get(bookRef);
}

function schedulerState(sqlite, bookRef) {
  const row = sqlite.prepare(`
    SELECT next_check_at, consecutive_no_change, consecutive_failures,
           scan_priority, last_synced_at, sync_error
    FROM ranobelib_titles WHERE book_ref=?
  `).get(bookRef);
  return { ...row };
}

function chapterBranch(upstreamTeamId, overrides = {}) {
  return {
    chapterId: 101,
    branchKey: 'native:501',
    nativeBranchId: 501,
    identityConfidence: 'native',
    volume: '1',
    number: '1',
    name: 'Chapter 1',
    releasedAt: '2026-09-14T00:00:00.000Z',
    teamIds: [Number(upstreamTeamId)],
    stableBranchRef: null,
    branchOrdinal: 0,
    ...overrides,
  };
}

async function shadowScan(db, work, client) {
  return scanDueMultiTeamWorks({ DB: db }, {
    mode: 'shadow',
    scanClass: 'hot',
    works: [work],
    client,
    now: new Date('2026-09-14T00:30:00.000Z'),
  });
}

test('successful shadow scan preserves the legacy production scheduler while still persisting parity state', async () => {
  const { sqlite, db } = migratedDatabase();
  const team = primaryTeam(sqlite);
  seedBook(sqlite, '1--shadow-success');
  seedTranslation(sqlite, team.id, '1--shadow-success');
  const before = schedulerState(sqlite, '1--shadow-success');

  const result = await shadowScan(db, dueWork(sqlite, '1--shadow-success'), {
    getChapterBranches: async () => [chapterBranch(team.ranobelib_team_id)],
  });

  assert.equal(result.fetchedWorks, 1);
  assert.deepEqual(schedulerState(sqlite, '1--shadow-success'), before,
    'shadow must not overwrite next_check_at, counters, priority, heartbeat or failure state owned by legacy');
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS count FROM ranobelib_chapter_branches WHERE book_ref=?`).get('1--shadow-success').count,
    1,
    'shadow still needs to persist its multi-team parity snapshot',
  );
  sqlite.close();
});

test('shadow scan failures do not reschedule or increment production failure counters', async () => {
  const { sqlite, db } = migratedDatabase();
  const team = primaryTeam(sqlite);
  seedBook(sqlite, '2--shadow-failure');
  seedTranslation(sqlite, team.id, '2--shadow-failure');
  const before = schedulerState(sqlite, '2--shadow-failure');

  const result = await shadowScan(db, dueWork(sqlite, '2--shadow-failure'), {
    getChapterBranches: async () => { throw new Error('synthetic upstream failure'); },
  });

  assert.equal(result.errors.length, 1);
  assert.deepEqual(schedulerState(sqlite, '2--shadow-failure'), before,
    'a shadow-only upstream failure must not penalize or move the legacy production schedule');
  sqlite.close();
});

test('shadow no-actionable and awaiting-attribution paths also leave the production scheduler untouched', async () => {
  {
    const { sqlite, db } = migratedDatabase();
    primaryTeam(sqlite);
    seedBook(sqlite, '3--no-actionable');
    const before = schedulerState(sqlite, '3--no-actionable');
    let fetched = false;

    await shadowScan(db, dueWork(sqlite, '3--no-actionable'), {
      getChapterBranches: async () => { fetched = true; return []; },
    });

    assert.equal(fetched, false, 'no-actionable work should still exit before fetching upstream chapters');
    assert.deepEqual(schedulerState(sqlite, '3--no-actionable'), before);
    sqlite.close();
  }

  {
    const { sqlite, db } = migratedDatabase();
    const team = primaryTeam(sqlite);
    seedBook(sqlite, '4--awaiting-attribution');
    seedTranslation(sqlite, team.id, '4--awaiting-attribution', { baselineReady: 0 });
    const before = schedulerState(sqlite, '4--awaiting-attribution');

    const result = await shadowScan(db, dueWork(sqlite, '4--awaiting-attribution'), {
      getChapterBranches: async () => [chapterBranch(999999)],
    });

    assert.equal(result.fetchedWorks, 1);
    assert.deepEqual(schedulerState(sqlite, '4--awaiting-attribution'), before,
      'shadow bootstrap observation must not re-arm the shared production scheduler');
    sqlite.close();
  }
});

test('live scan keeps ownership of multi-team production scheduling', async () => {
  const { sqlite, db } = migratedDatabase();
  const team = primaryTeam(sqlite);
  seedBook(sqlite, '5--live');
  seedTranslation(sqlite, team.id, '5--live');
  const before = schedulerState(sqlite, '5--live');

  await scanDueMultiTeamWorks({ DB: db }, {
    mode: 'live',
    scanClass: 'hot',
    works: [dueWork(sqlite, '5--live')],
    client: { getChapterBranches: async () => [chapterBranch(team.ranobelib_team_id)] },
    now: new Date('2026-09-14T00:30:00.000Z'),
  });

  assert.notDeepEqual(schedulerState(sqlite, '5--live'), before,
    'live mode must continue advancing the multi-team production scheduler');
  sqlite.close();
});
