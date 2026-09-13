import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  computePendingCompletionRetryDelayMinutes,
  selectDueMultiTeamWorks,
} from '../dist-runtime/ranobelib-multi-team-scanner.js';

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
  const team = sqlite.prepare(`SELECT id FROM ranobelib_teams WHERE is_primary=1`).get();
  sqlite.prepare(`
    UPDATE ranobelib_teams SET lifecycle_state='published' WHERE id=?
  `).run(team.id);
  sqlite.prepare(`
    INSERT INTO ranobelib_team_translations (
      team_id, book_ref, presence_state, semantic_status, baseline_ready,
      completion_pending, completion_revision
    ) VALUES (?, '900--pending', 'active', 'active', 1, 1, 1)
  `).run(team.id);
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
