import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { discoverOneRegisteredTeam } from '../dist-runtime/ranobelib-multi-team-discovery.js';
import {
  computePendingCompletionRetryDelayMinutes,
  scanDueMultiTeamWorks,
  selectDueMultiTeamWorks,
} from '../dist-runtime/ranobelib-multi-team-scanner.js';
import { getPrimaryRanobeLibTeam } from '../dist-runtime/ranobelib-team-registry.js';

class Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  statement() { return this.owner.sqlite.prepare(this.sql); }
  async run() { const result = this.statement().run(...this.values); return { meta: { changes: Number(result.changes) } }; }
  async first() { return this.statement().get(...this.values) ?? null; }
  async all() { return { results: this.statement().all(...this.values) }; }
}

class SqliteD1 {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) { return new Statement(this, sql); }
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

function seedPending(sqlite, nextCheckAt) {
  sqlite.prepare(`
    INSERT INTO ranobelib_titles (
      book_ref, ranobelib_id, slug, url, title, is_active, snapshot_ready,
      notification_subscriber_count, next_check_at
    ) VALUES ('900--pending', 900, 'pending', 'https://ranobelib.me/ru/book/900--pending',
      'Pending', 0, 1, 0, ?)
  `).run(nextCheckAt);
  const team = sqlite.prepare(`
    SELECT id, ranobelib_team_id FROM ranobelib_teams WHERE is_primary=1
  `).get();
  sqlite.prepare(`
    UPDATE ranobelib_teams SET lifecycle_state='published' WHERE id=?
  `).run(team.id);
  sqlite.prepare(`
    INSERT INTO ranobelib_team_translations (
      team_id, book_ref, presence_state, semantic_status, completion_evidence,
      baseline_ready, completion_pending, completion_revision
    ) VALUES (?, '900--pending', 'active', 'active', 'team-catalog:completed:pending', 1, 1, 1)
  `).run(team.id);
  return team;
}

function dueWork(sqlite) {
  return sqlite.prepare(`
    SELECT book_ref, ranobelib_id, slug, url, title, cover_url,
           notification_subscriber_count, consecutive_no_change,
           consecutive_failures, next_check_at
    FROM ranobelib_titles WHERE book_ref='900--pending'
  `).get();
}

function ambiguousBranch(upstreamTeamId) {
  return {
    chapterId: 101,
    branchKey: 'fallback:ambiguous-latest',
    nativeBranchId: null,
    identityConfidence: 'ambiguous',
    volume: '1',
    number: '101',
    name: 'Final chapter?',
    releasedAt: '2026-09-14T00:00:00.000Z',
    teamIds: [Number(upstreamTeamId)],
    stableBranchRef: null,
    branchOrdinal: 0,
  };
}

function seedStoredBranch(sqlite, teamId, branch) {
  sqlite.prepare(`
    INSERT INTO ranobelib_chapter_branches (
      book_ref, chapter_id, branch_key, native_branch_id, identity_confidence,
      volume, number, name, released_at
    ) VALUES ('900--pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    branch.chapterId,
    branch.branchKey,
    branch.nativeBranchId,
    branch.identityConfidence,
    branch.volume,
    branch.number,
    branch.name,
    branch.releasedAt,
  );
  sqlite.prepare(`
    INSERT INTO ranobelib_chapter_branch_teams (book_ref, chapter_id, branch_key, team_id)
    VALUES ('900--pending', ?, ?, ?)
  `).run(branch.chapterId, branch.branchKey, teamId);
}

function retryState(sqlite) {
  const row = sqlite.prepare(`
    SELECT consecutive_failures, sync_error,
           CAST((unixepoch(next_check_at) - unixepoch(last_synced_at)) / 60 AS INTEGER) AS delay_minutes
    FROM ranobelib_titles WHERE book_ref='900--pending'
  `).get();
  return { ...row };
}

test('pending completion has a bounded retry cadence that settles at hourly', () => {
  assert.equal(typeof computePendingCompletionRetryDelayMinutes, 'function');
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 20].map(computePendingCompletionRetryDelayMinutes),
    [1, 2, 5, 10, 30, 60, 60],
  );
});

test('zero-demand pending completion bypasses demand but respects next_check_at backoff', async () => {
  {
    const { sqlite, db } = migratedDatabase();
    seedPending(sqlite, '2099-01-01 00:00:00');
    const rows = await selectDueMultiTeamWorks({ DB: db }, 24, 'hot');
    assert.deepEqual(rows, [], 'a stuck pending completion must not bypass its future retry schedule');
    sqlite.close();
  }

  {
    const { sqlite, db } = migratedDatabase();
    seedPending(sqlite, '2000-01-01 00:00:00');
    const rows = await selectDueMultiTeamWorks({ DB: db }, 24, 'hot');
    assert.equal(rows.length, 1, 'pending completion must still run without subscribers once its retry is due');
    assert.equal(rows[0].book_ref, '900--pending');
    sqlite.close();
  }
});

test('an unresolved but successful final scan backs off instead of polling every minute forever', async () => {
  const { sqlite, db } = migratedDatabase();
  const team = seedPending(sqlite, '2000-01-01 00:00:00');
  const branch = ambiguousBranch(team.ranobelib_team_id);
  seedStoredBranch(sqlite, team.id, branch);
  const client = { getChapterBranches: async () => [branch] };

  await scanDueMultiTeamWorks({ DB: db }, {
    mode: 'live',
    scanClass: 'hot',
    works: [dueWork(sqlite)],
    client,
  });
  assert.deepEqual(retryState(sqlite), {
    consecutive_failures: 1,
    sync_error: 'completion_pending: unresolved final branch (attempt 1)',
    delay_minutes: 1,
  });

  sqlite.exec(`UPDATE ranobelib_titles SET next_check_at='2000-01-01 00:00:00' WHERE book_ref='900--pending'`);
  await scanDueMultiTeamWorks({ DB: db }, {
    mode: 'live',
    scanClass: 'hot',
    works: [dueWork(sqlite)],
    client,
  });
  assert.deepEqual(retryState(sqlite), {
    consecutive_failures: 2,
    sync_error: 'completion_pending: unresolved final branch (attempt 2)',
    delay_minutes: 2,
  });
  assert.equal(
    sqlite.prepare(`SELECT completion_pending FROM ranobelib_team_translations WHERE book_ref='900--pending'`).get().completion_pending,
    1,
    'backoff must not silently clear the pending completion',
  );
  sqlite.close();
});

test('unchanged discovery does not cancel a future retry for an already-pending completion', async () => {
  const { sqlite, db } = migratedDatabase();
  seedPending(sqlite, '2099-01-01 00:00:00');
  sqlite.exec(`UPDATE ranobelib_titles SET scan_priority=20 WHERE book_ref='900--pending'`);
  const before = sqlite.prepare(`SELECT next_check_at FROM ranobelib_titles WHERE book_ref='900--pending'`).get().next_check_at;
  const team = await getPrimaryRanobeLibTeam({ DB: db });
  const client = {
    discoverTeamBooks: async () => [{
      id: 900,
      slug: 'pending',
      ref: '900--pending',
      url: 'https://ranobelib.me/ru/book/900--pending',
      title: 'Pending',
      translationStatusLabel: 'Завершён',
    }],
  };

  await discoverOneRegisteredTeam({ DB: db }, team, client);

  const after = sqlite.prepare(`SELECT next_check_at FROM ranobelib_titles WHERE book_ref='900--pending'`).get().next_check_at;
  assert.equal(after, before,
    'the 30-minute discovery heartbeat must not undo completion retry backoff for a transition already pending');
  sqlite.close();
});
