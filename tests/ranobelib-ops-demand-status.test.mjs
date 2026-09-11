import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const statusSource = readFileSync(new URL('../src/ranobelib-ops-status.ts', import.meta.url), 'utf8');
const scannerSource = readFileSync(new URL('../src/ranobelib-multi-team-scanner.ts', import.meta.url), 'utf8');

test('RanobeLib operational status reports the same work-level demand cache used by the hot scanner', () => {
  assert.match(
    scannerSource,
    /COALESCE\(t\.notification_subscriber_count,\s*0\)\s*>\s*0/,
    'hot scanner must continue using the work-level demand cache',
  );
  assert.match(
    statusSource,
    /t\.notification_subscriber_count\s+AS\s+work_notification_demand/i,
    'status title query must load the authoritative work-level demand cache',
  );
  assert.match(
    statusSource,
    /Work demand \(hot-scan\):[^\n]*work_notification_demand/,
    'status output must show the authoritative hot-scan demand',
  );
});

test('RanobeLib operational status does not label the stale per-translation cache as current demand', () => {
  assert.doesNotMatch(
    statusSource,
    /tt\.notification_subscriber_count/,
    'team rows must not expose the obsolete per-translation demand cache',
  );
  assert.doesNotMatch(
    statusSource,
    /team\.notification_subscriber_count/,
    'team renderer must not present obsolete cached demand as live demand',
  );
});
