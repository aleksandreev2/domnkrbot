import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

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

  assert.doesNotMatch(source, /notification_subscriber_count\s*=\s*0/);
  assert.match(source, /selectIdleTitles[\s\S]*return \[\]/);
});
