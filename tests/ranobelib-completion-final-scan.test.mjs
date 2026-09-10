import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('completion lifecycle has an explicit pending-final-scan state', () => {
  const migration = read('migrations/0021_translation_completion_semantics.sql');
  assert.match(migration, /translation_completion_pending/i);
  assert.match(migration, /OLD\.translation_completion_pending\s*=\s*1/i);
  assert.match(migration, /NEW\.translation_completion_pending\s*=\s*0/i);
  assert.match(migration, /NEW\.translation_is_completed\s*=\s*1/i);
});

test('discovery defers a known active-to-completed transition instead of immediately disabling the title', () => {
  const scheduler = read('src/ranobelib-discovery-scheduler.ts');
  assert.match(scheduler, /translation_completion_pending/i);
  assert.match(scheduler, /ranobelib_titles\.translation_is_completed\s*=\s*0[\s\S]*excluded\.translation_is_completed\s*=\s*1/i);
  assert.match(scheduler, /next_check_at[\s\S]*CURRENT_TIMESTAMP/i);
});

test('fast scanner prioritizes pending completions and finalizes only after chapter polling succeeds', () => {
  const scanner = read('src/ranobelib-fast-scanner.ts');
  const fetchIndex = scanner.indexOf('await client.getChapters');
  const finalizeIndex = scanner.indexOf('translation_completion_pending', fetchIndex);
  assert.ok(fetchIndex >= 0, 'scanner must poll chapters');
  assert.ok(finalizeIndex > fetchIndex, 'completion must finalize only after chapter polling');
  assert.match(scanner, /translation_completion_pending\s*=\s*1[\s\S]*snapshot_ready\s*=\s*0[\s\S]*notification_subscriber_count\s*>\s*0/i);
  assert.match(scanner, /ORDER BY[\s\S]*translation_completion_pending\s+DESC/i);
  assert.match(scanner, /translation_completion_pending\s*=\s*CASE[\s\S]*THEN\s+0/i);
  assert.match(scanner, /is_active\s*=\s*CASE[\s\S]*THEN\s+0/i);
});
