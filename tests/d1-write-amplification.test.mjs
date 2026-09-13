import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { persistBranchSnapshot } from '../dist-runtime/ranobelib-multi-team-persistence.js';
import { refreshWorkNotificationDemand } from '../dist-runtime/multi-team-notification-demand.js';

async function persistenceSource() {
  return readFile(new URL('../src/ranobelib-multi-team-persistence.ts', import.meta.url), 'utf8');
}

async function legacySource() {
  return readFile(new URL('../src/ranobelib-fast-scanner.ts', import.meta.url), 'utf8');
}

test('multi-team snapshot persistence no longer deletes and recreates mappings per branch', async () => {
  const source = await persistenceSource();

  assert.doesNotMatch(
    source,
    /for \(const \{ branch, teamIds \} of values\)[\s\S]*DELETE FROM ranobelib_chapter_branch_teams[\s\S]*INSERT OR IGNORE INTO ranobelib_chapter_branch_teams/,
  );
  assert.match(source, /INSERT OR IGNORE INTO ranobelib_chapter_branch_teams[\s\S]*SELECT \?, chapter_id, branch_key, team_id/i);
  assert.match(source, /DELETE FROM ranobelib_chapter_branch_teams[\s\S]*NOT EXISTS/i);
});

test('multi-team snapshot persistence only updates materially changed branch rows', async () => {
  const source = await persistenceSource();

  assert.match(source, /DO UPDATE SET[\s\S]*WHERE[\s\S]*ranobelib_chapter_branches\./i);
  assert.match(source, /excluded\.identity_confidence IS NOT ranobelib_chapter_branches\.identity_confidence/i);
});

test('mapping reconciliation preserves branches absent from the current upstream payload', async () => {
  const source = await persistenceSource();

  assert.match(source, /EXISTS \([\s\S]*FROM incoming_branches incoming[\s\S]*incoming\.chapter_id = ranobelib_chapter_branch_teams\.chapter_id/i);
});

test('legacy idle scan does not select titles with zero notification subscribers', async () => {
  const source = await legacySource();
  const selectorStart = source.indexOf('export async function selectDueTitles');
  const selectorEnd = source.indexOf('export async function selectIdleTitles', selectorStart);
  const selector = source.slice(selectorStart, selectorEnd);

  assert.match(selector, /notification_subscriber_count\s*>\s*0/);
  assert.match(source, /selectIdleTitles[\s\S]*return \[\]/);
});

class SqliteD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.statement = database.prepare(sql);
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  async first() {
    return this.statement.get(...this.values) ?? null;
  }
}

class SqliteD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function branch(chapterId, branchKey, overrides = {}) {
  return {
    chapterId,
    branchKey,
    nativeBranchId: chapterId * 10,
    identityConfidence: 'native',
    volume: '1',
    number: String(chapterId),
    name: `Chapter ${chapterId}`,
    releasedAt: '2026-09-13T12:00:00.000Z',
    teamIds: [],
    stableBranchRef: null,
    branchOrdinal: 0,
    ...overrides,
  };
}

test('identical snapshots produce zero SQLite row mutations and preserve omitted history', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE ranobelib_chapter_branches (
      book_ref TEXT NOT NULL, chapter_id INTEGER NOT NULL, branch_key TEXT NOT NULL,
      native_branch_id INTEGER, identity_confidence TEXT NOT NULL,
      volume TEXT NOT NULL, number TEXT NOT NULL, name TEXT, released_at TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      PRIMARY KEY (book_ref, chapter_id, branch_key)
    );
    CREATE TABLE ranobelib_chapter_branch_teams (
      book_ref TEXT NOT NULL, chapter_id INTEGER NOT NULL, branch_key TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      PRIMARY KEY (book_ref, chapter_id, branch_key, team_id)
    );
  `);
  const db = new SqliteD1Database(sqlite);
  const snapshot = [
    { branch: branch(1, 'native:10'), teamIds: [10, 20] },
    { branch: branch(2, 'native:20'), teamIds: [20] },
  ];

  await persistBranchSnapshot(db, '1--book', snapshot);
  const afterFirst = Number(sqlite.prepare('SELECT total_changes() AS count').get().count);
  await persistBranchSnapshot(db, '1--book', [
    { branch: branch(1, 'native:10'), teamIds: [20, 10] },
    { branch: branch(2, 'native:20'), teamIds: [20] },
  ]);
  const afterSecond = Number(sqlite.prepare('SELECT total_changes() AS count').get().count);
  assert.equal(afterSecond - afterFirst, 0, 'an identical set with reordered teams must write no rows');

  await persistBranchSnapshot(db, '1--book', [
    { branch: branch(1, 'native:10'), teamIds: [20, 30] },
  ]);
  const afterTeamDelta = Number(sqlite.prepare('SELECT total_changes() AS count').get().count);
  assert.equal(afterTeamDelta - afterSecond, 2, 'team set-diff must insert one and delete one mapping only');
  const mappings = sqlite.prepare(`
    SELECT chapter_id, team_id FROM ranobelib_chapter_branch_teams
    WHERE book_ref = '1--book' ORDER BY chapter_id, team_id
  `).all().map((row) => ({ chapter_id: row.chapter_id, team_id: row.team_id }));
  assert.deepEqual(mappings, [
    { chapter_id: 1, team_id: 20 },
    { chapter_id: 1, team_id: 30 },
    { chapter_id: 2, team_id: 20 },
  ], 'only present branches are reconciled; an omitted historical branch remains intact');

  sqlite.close();
});

test('first subscriber wakes monitoring and removing the last subscriber idles without deleting history', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE ranobelib_titles (
      book_ref TEXT PRIMARY KEY,
      next_check_at TEXT,
      scan_priority INTEGER NOT NULL DEFAULT 0,
      notification_subscriber_count INTEGER NOT NULL DEFAULT 0,
      subscriber_count_updated_at TEXT
    );
    CREATE TABLE ranobelib_teams (
      id INTEGER PRIMARY KEY,
      lifecycle_state TEXT NOT NULL
    );
    CREATE TABLE ranobelib_team_translations (
      team_id INTEGER NOT NULL,
      book_ref TEXT NOT NULL,
      presence_state TEXT NOT NULL,
      semantic_status TEXT NOT NULL,
      history_marker TEXT,
      PRIMARY KEY (team_id, book_ref)
    );
    CREATE TABLE telegram_team_subscriptions (
      user_telegram_id TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      PRIMARY KEY (user_telegram_id, team_id)
    );
    CREATE TABLE telegram_team_title_subscriptions (
      user_telegram_id TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      book_ref TEXT NOT NULL,
      PRIMARY KEY (user_telegram_id, team_id, book_ref)
    );
    CREATE TABLE telegram_team_title_exclusions (
      user_telegram_id TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      book_ref TEXT NOT NULL,
      PRIMARY KEY (user_telegram_id, team_id, book_ref)
    );
    CREATE TABLE telegram_delivery_reachability (
      user_telegram_id TEXT PRIMARY KEY,
      state TEXT NOT NULL
    );
    INSERT INTO ranobelib_titles (
      book_ref, next_check_at, scan_priority, notification_subscriber_count
    ) VALUES ('1--book', '2099-01-01 00:00:00', 4, 0);
    INSERT INTO ranobelib_teams (id, lifecycle_state) VALUES (10, 'published');
    INSERT INTO ranobelib_team_translations (
      team_id, book_ref, presence_state, semantic_status, history_marker
    ) VALUES (10, '1--book', 'active', 'active', 'preserve-me');
    INSERT INTO telegram_team_title_subscriptions (user_telegram_id, team_id, book_ref)
    VALUES ('42', 10, '1--book');
  `);
  const db = new SqliteD1Database(sqlite);

  assert.equal(await refreshWorkNotificationDemand({ DB: db }, '1--book'), 1);
  let title = sqlite.prepare(`
    SELECT notification_subscriber_count, scan_priority,
           next_check_at <= CURRENT_TIMESTAMP AS due_now
    FROM ranobelib_titles WHERE book_ref = '1--book'
  `).get();
  assert.equal(title.notification_subscriber_count, 1);
  assert.equal(title.scan_priority, 14);
  assert.equal(title.due_now, 1, '0→1 must override a far-future schedule immediately');

  sqlite.exec(`DELETE FROM telegram_team_title_subscriptions
               WHERE user_telegram_id = '42' AND team_id = 10 AND book_ref = '1--book'`);
  assert.equal(await refreshWorkNotificationDemand({ DB: db }, '1--book'), 0);
  title = sqlite.prepare(`
    SELECT notification_subscriber_count,
           next_check_at >= datetime(CURRENT_TIMESTAMP, '+179 minutes') AS idled
    FROM ranobelib_titles WHERE book_ref = '1--book'
  `).get();
  assert.equal(title.notification_subscriber_count, 0);
  assert.equal(title.idled, 1, '1→0 must stop near-term scanning');
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT presence_state, semantic_status, history_marker
      FROM ranobelib_team_translations WHERE team_id = 10 AND book_ref = '1--book'
    `).get() },
    { presence_state: 'active', semantic_status: 'active', history_marker: 'preserve-me' },
    'idling must not destroy translation or history state',
  );

  sqlite.exec(`INSERT INTO telegram_team_title_subscriptions (user_telegram_id, team_id, book_ref)
               VALUES ('42', 10, '1--book')`);
  assert.equal(await refreshWorkNotificationDemand({ DB: db }, '1--book'), 1);
  title = sqlite.prepare(`
    SELECT next_check_at <= CURRENT_TIMESTAMP AS due_now
    FROM ranobelib_titles WHERE book_ref = '1--book'
  `).get();
  assert.equal(title.due_now, 1, 'a later first subscriber must reactivate monitoring again');

  sqlite.close();
});
