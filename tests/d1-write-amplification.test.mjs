import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

async function scannerSource() {
  return readFile(new URL('../src/ranobelib-multi-team-scanner.ts', import.meta.url), 'utf8');
}

async function legacySource() {
  return readFile(new URL('../src/ranobelib-fast-scanner.ts', import.meta.url), 'utf8');
}

test('multi-team snapshot persistence does not delete and recreate every branch-team mapping on each scan', async () => {
  const source = await scannerSource();

  assert.doesNotMatch(
    source,
    /for \(const \{ branch, teamIds \} of values\)[\s\S]*DELETE FROM ranobelib_chapter_branch_teams[\s\S]*INSERT OR IGNORE INTO ranobelib_chapter_branch_teams/,
  );
});

test('multi-team snapshot persistence only updates materially changed branch rows', async () => {
  const source = await scannerSource();

  assert.match(source, /DO UPDATE SET[\s\S]*WHERE[\s\S]*ranobelib_chapter_branches\./i);
});

test('legacy idle scan does not select titles with zero notification subscribers', async () => {
  const source = await legacySource();

  assert.doesNotMatch(source, /notification_subscriber_count\s*=\s*0/);
  assert.match(source, /selectIdleTitles[\s\S]*return \[\]/);
});
