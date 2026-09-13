import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { persistBranchSnapshot } from '../dist-runtime/ranobelib-multi-team-persistence.js';
import {
  refreshAllWorkNotificationDemand,
  refreshWorkNotificationDemand,
} from '../dist-runtime/multi-team-notification-demand.js';
import { discoverOneRegisteredTeam } from '../dist-runtime/ranobelib-multi-team-discovery.js';
import { discoverRanobeLibTeam } from '../dist-runtime/ranobelib-discovery-scheduler.js';
import { selectDueTitles } from '../dist-runtime/ranobelib-fast-scanner.js';
import {
  scanDueMultiTeamWorks,
  selectDueMultiTeamWorks,
} from '../dist-runtime/ranobelib-multi-team-scanner.js';
import { getPrimaryRanobeLibTeam } from '../dist-runtime/ranobelib-team-registry.js';

const MUTATION = /^\s*(WITH[\s\S]*?\)\s*)?(INSERT|UPDATE|DELETE|REPLACE)\b/i;

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

  record() {
    this.owner.log.push({ sql: this.sql, values: this.values });
    return this.owner.sqlite.prepare(this.sql);
  }

  async run() {
    const result = this.record().run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  async first() {
    return this.record().get(...this.values) ?? null;
  }

  async all() {
    return { results: this.record().all(...this.values) };
  }
}

class SqliteD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.log = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  mutations() {
    return this.log.filter((entry) => MUTATION.test(entry.sql));
  }
}

function migratedDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  return { sqlite, db: new SqliteD1(sqlite) };
}

function totalChanges(sqlite) {
  return Number(sqlite.prepare('SELECT total_changes() AS count').get().count);
}

async function measure(sqlite, db, operation) {
  const before = totalChanges(sqlite);
  const logStart = db.log.length;
  const value = await operation();
  const statements = db.log.slice(logStart);
  return {
    value,
    changes: totalChanges(sqlite) - before,
    mutations: statements.filter((entry) => MUTATION.test(entry.sql)),
  };
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

function seedBook(sqlite, bookRef, overrides = {}) {
  const row = {
    notification_subscriber_count: 0,
    is_active: 1,
    translation_completion_pending: 0,
    next_check_at: '2000-01-01 00:00:00',
    ...overrides,
  };
  sqlite.prepare(`
    INSERT INTO ranobelib_titles (
      book_ref, ranobelib_id, slug, url, title, is_active, snapshot_ready,
      notification_subscriber_count, translation_completion_pending, next_check_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    bookRef,
    Number.parseInt(bookRef, 10),
    bookRef.split('--')[1] ?? bookRef,
    `https://ranobelib.me/ru/book/${bookRef}`,
    `Title ${bookRef}`,
    row.is_active,
    row.notification_subscriber_count,
    row.translation_completion_pending,
    row.next_check_at,
  );
}

function seedTeams(sqlite) {
  sqlite.exec(`UPDATE ranobelib_teams SET lifecycle_state = 'published' WHERE is_primary = 1`);
  return Number(sqlite.prepare('SELECT id FROM ranobelib_teams WHERE is_primary = 1').get().id);
}

function snapshotOf(count, teamIds) {
  return Array.from({ length: count }, (_, index) => ({
    branch: branch(index + 1, `native:${(index + 1) * 10}`),
    teamIds,
  }));
}

test('identical multi-team snapshot executes no mutation statements at all', async () => {
  const { sqlite, db } = migratedDatabase();
  const teamId = seedTeams(sqlite);
  seedBook(sqlite, '1--book');
  const snapshot = snapshotOf(300, [teamId]);

  await persistBranchSnapshot(db, '1--book', snapshot);
  const second = await measure(sqlite, db, () => persistBranchSnapshot(db, '1--book', snapshot));

  assert.equal(second.changes, 0);
  assert.deepEqual(second.mutations.map((entry) => entry.sql.trim().slice(0, 80)), [],
    'a no-op snapshot must not send stale-mapping DELETE or idempotent INSERT/UPSERT statements to D1');
  assert.deepEqual(second.value, { branchWrites: 0, mappingInserts: 0, mappingDeletes: 0 });
  sqlite.close();
});

test('snapshot deltas write only the changed branch and mapping tuples', async () => {
  const { sqlite, db } = migratedDatabase();
  const teamId = seedTeams(sqlite);
  const partnerId = Number(sqlite.prepare(`
    INSERT INTO ranobelib_teams (ranobelib_team_id, ranobelib_team_ref, display_name, is_primary, lifecycle_state)
    VALUES (777, '777--partner', 'Partner', 0, 'published') RETURNING id
  `).get().id);
  seedBook(sqlite, '1--book');
  const snapshot = snapshotOf(50, [teamId]);
  await persistBranchSnapshot(db, '1--book', snapshot);

  const next = snapshot.slice(1).map((value) => (value.branch.chapterId === 2
    ? { branch: value.branch, teamIds: [partnerId] }
    : value.branch.chapterId === 3
      ? { branch: { ...value.branch, name: 'Renamed chapter' }, teamIds: value.teamIds }
      : value));
  next.push({ branch: branch(51, 'native:510'), teamIds: [teamId, partnerId] });

  const delta = await measure(sqlite, db, () => persistBranchSnapshot(db, '1--book', next));
  assert.deepEqual(delta.value, { branchWrites: 2, mappingInserts: 3, mappingDeletes: 1 });
  assert.equal(delta.changes, 2 + 3 + 1);

  const deleteStatement = delta.mutations.find((entry) => /DELETE FROM ranobelib_chapter_branch_teams/i.test(entry.sql));
  assert.ok(deleteStatement, 'a real stale mapping still has to be deleted');
  assert.doesNotMatch(deleteStatement.sql, /NOT EXISTS/i, 'stale mappings must be deleted by explicit tuples');

  const mappings = sqlite.prepare(`
    SELECT chapter_id, team_id FROM ranobelib_chapter_branch_teams
    WHERE book_ref = '1--book' AND chapter_id IN (1, 2, 51) ORDER BY chapter_id, team_id
  `).all().map((row) => [row.chapter_id, row.team_id]);
  assert.deepEqual(mappings, [[1, teamId], [2, partnerId], [51, teamId], [51, partnerId]],
    'chapter 1 was omitted upstream and must keep its historical mapping');
  assert.equal(
    sqlite.prepare(`SELECT name FROM ranobelib_chapter_branches WHERE book_ref = '1--book' AND chapter_id = 3`).get().name,
    'Renamed chapter',
  );
  sqlite.close();
});

test('unchanged work demand writes nothing but still reports the authoritative count', async () => {
  const { sqlite, db } = migratedDatabase();
  const teamId = seedTeams(sqlite);
  seedBook(sqlite, '1--book');
  seedBook(sqlite, '2--book');
  sqlite.exec(`
    INSERT INTO users (telegram_id) VALUES ('42'), ('43');
    INSERT INTO ranobelib_team_translations (team_id, book_ref, presence_state, semantic_status)
    VALUES (${teamId}, '1--book', 'active', 'active'), (${teamId}, '2--book', 'active', 'active');
    INSERT INTO telegram_team_title_subscriptions (user_telegram_id, team_id, book_ref)
    VALUES ('42', ${teamId}, '1--book');
  `);

  assert.equal(await refreshWorkNotificationDemand({ DB: db }, '1--book'), 1);
  const again = await measure(sqlite, db, () => refreshWorkNotificationDemand({ DB: db }, '1--book'));
  assert.equal(again.value, 1, 'a no-op refresh must still return the current demand');
  assert.equal(again.changes, 0);

  const all = await measure(sqlite, db, () => refreshAllWorkNotificationDemand({ DB: db }));
  assert.equal(all.changes, 0, 'global reconciliation must not rewrite rows whose demand did not change');

  sqlite.exec(`INSERT INTO telegram_team_title_subscriptions (user_telegram_id, team_id, book_ref)
               VALUES ('43', ${teamId}, '2--book')`);
  const changed = await measure(sqlite, db, () => refreshAllWorkNotificationDemand({ DB: db }));
  assert.equal(changed.changes, 1, 'only the work whose demand changed is written');
  const woken = sqlite.prepare(`
    SELECT notification_subscriber_count, next_check_at <= CURRENT_TIMESTAMP AS due
    FROM ranobelib_titles WHERE book_ref = '2--book'
  `).get();
  assert.equal(woken.notification_subscriber_count, 1);
  assert.equal(woken.due, 1);
  sqlite.close();
});

function teamBook(index, statusLabel = 'Продолжается') {
  const id = 5000 + index;
  return {
    id,
    slug: `book-${index}`,
    ref: `${id}--book-${index}`,
    url: `https://ranobelib.me/ru/book/${id}--book-${index}`,
    title: `Книга ${index}`,
    coverUrl: `https://cover.imglib.info/uploads/cover/book-${index}.jpg`,
    translationStatusLabel: statusLabel,
  };
}

test('identical multi-team discovery writes only the team heartbeat and keeps completion transitions', async () => {
  const { sqlite, db } = migratedDatabase();
  seedTeams(sqlite);
  const env = { DB: db };
  let books = Array.from({ length: 25 }, (_, index) => teamBook(index));
  const client = { discoverTeamBooks: async () => books.map((book) => ({ ...book })) };

  await discoverOneRegisteredTeam(env, await getPrimaryRanobeLibTeam(env), client);
  const second = await measure(sqlite, db, async () => discoverOneRegisteredTeam(env, await getPrimaryRanobeLibTeam(env), client));
  assert.equal(second.changes, 1, 'an unchanged catalog may only refresh the team-level sync heartbeat');

  books = books.map((book, index) => (index === 0 ? { ...book, translationStatusLabel: 'Завершён' } : book));
  const completed = await measure(sqlite, db, async () => discoverOneRegisteredTeam(env, await getPrimaryRanobeLibTeam(env), client));
  assert.ok(completed.changes >= 3, 'the completion transition must still be persisted');
  const pending = sqlite.prepare(`
    SELECT tt.completion_pending, t.next_check_at <= CURRENT_TIMESTAMP AS due
    FROM ranobelib_team_translations tt JOIN ranobelib_titles t ON t.book_ref = tt.book_ref
    WHERE tt.book_ref = ?
  `).get(books[0].ref);
  assert.deepEqual({ ...pending }, { completion_pending: 1, due: 1 });

  const repeated = await measure(sqlite, db, async () => discoverOneRegisteredTeam(env, await getPrimaryRanobeLibTeam(env), client));
  assert.equal(repeated.changes, 1, 'an already-pending completion must not be re-woken on every discovery');
  sqlite.close();
});

const legacyCatalogUrl = 'https://api.cdnlibs.org/api/manga?site_id[]=3&target_id=11969&target_model=team&page=1';

async function withLegacyCatalog(books, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target === legacyCatalogUrl) {
      return Response.json({ data: books, meta: { current_page: 1, has_next_page: false } });
    }
    if (target.includes('/api/manga/') && target.endsWith('?fields[]=status_id')) {
      return Response.json({ data: { scanlateStatus: { id: 1, label: 'Продолжается' } } });
    }
    return new Response('unexpected', { status: 500 });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('identical legacy discovery catalog writes zero title rows', async () => {
  const { sqlite, db } = migratedDatabase();
  const env = { DB: db, RANOBELIB_TEAM_REF: '11969--dom-nekromanta' };
  const books = Array.from({ length: 12 }, (_, index) => ({
    id: 7000 + index,
    slug: `legacy-${index}`,
    slug_url: `${7000 + index}--legacy-${index}`,
    rus_name: `Легаси ${index}`,
    cover: { default: `https://cover.cdnlibs.org/uploads/cover/legacy-${index}/default.jpg` },
  }));

  await withLegacyCatalog(books, () => discoverRanobeLibTeam(env));
  const second = await measure(sqlite, db, () => withLegacyCatalog(books, () => discoverRanobeLibTeam(env)));
  assert.equal(second.value.discovered, 12);
  assert.equal(second.changes, 0, 'unchanged legacy titles must not be rewritten every 30 minutes');
  sqlite.close();
});

test('zero-demand completion final scans remain selectable while ordinary zero-demand titles stay idle', async () => {
  const { sqlite, db } = migratedDatabase();
  const teamId = seedTeams(sqlite);
  seedBook(sqlite, '1--pending', { is_active: 0, translation_completion_pending: 1 });
  seedBook(sqlite, '2--idle');
  seedBook(sqlite, '3--watched', { notification_subscriber_count: 2 });

  const legacy = await selectDueTitles({ DB: db }, 24);
  assert.deepEqual(legacy.map((row) => row.book_ref), ['1--pending', '3--watched']);

  sqlite.exec(`
    INSERT INTO ranobelib_team_translations (
      team_id, book_ref, presence_state, semantic_status, baseline_ready, completion_pending
    ) VALUES
      (${teamId}, '1--pending', 'active', 'active', 1, 1),
      (${teamId}, '2--idle', 'active', 'active', 1, 0),
      (${teamId}, '3--watched', 'active', 'active', 1, 0);
  `);
  const multiTeam = await selectDueMultiTeamWorks({ DB: db }, 24, 'hot');
  assert.deepEqual(multiTeam.map((row) => row.book_ref).sort(), ['1--pending', '3--watched']);
  sqlite.close();
});

test('shadow scans reuse a due set captured before the legacy scanner reschedules titles', async () => {
  const source = readFileSync(new URL('../src/live-entry-v2.ts', import.meta.url), 'utf8');
  const fastStart = source.indexOf("if (mode === 'shadow')");
  const fastEnd = source.indexOf('return;', fastStart);
  const shadowBranch = source.slice(fastStart, fastEnd);
  const preselect = shadowBranch.indexOf('selectDueMultiTeamWorks');
  const legacyScan = shadowBranch.indexOf('scanDueRanobeLibTitles');
  assert.ok(preselect >= 0, 'shadow must capture the multi-team due set');
  assert.ok(preselect < legacyScan, 'the due set must be captured before legacy scanning mutates next_check_at');
  assert.match(shadowBranch, /scanDueMultiTeamWorks\([\s\S]*works:/);

  const { sqlite, db } = migratedDatabase();
  const log = db.log;
  const result = await scanDueMultiTeamWorks({ DB: db }, { mode: 'shadow', scanClass: 'hot', works: [] });
  assert.equal(result.selectedWorks, 0);
  assert.equal(log.some((entry) => /FROM ranobelib_titles t/i.test(entry.sql)), false,
    'a preselected due set must not be re-selected after legacy rescheduling');
  sqlite.close();
});
