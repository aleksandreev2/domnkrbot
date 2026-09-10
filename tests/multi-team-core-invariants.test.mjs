import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function subscriptions() {
  return import('../dist-runtime/multi-team-subscriptions.js');
}

async function scanner() {
  return import('../dist-runtime/ranobelib-multi-team-scanner.js');
}

async function discovery() {
  return import('../dist-runtime/ranobelib-multi-team-discovery.js');
}

test('team-title subscription precedence is exclusion > team > explicit > none', async () => {
  const { resolveTeamTitleSubscription } = await subscriptions();

  assert.deepEqual(
    resolveTeamTitleSubscription({ teamFollowed: true, explicit: true, excluded: true }),
    { enabled: false, reason: 'excluded' },
  );
  assert.deepEqual(
    resolveTeamTitleSubscription({ teamFollowed: true, explicit: true, excluded: false }),
    { enabled: true, reason: 'team' },
  );
  assert.deepEqual(
    resolveTeamTitleSubscription({ teamFollowed: false, explicit: true, excluded: false }),
    { enabled: true, reason: 'explicit' },
  );
  assert.deepEqual(
    resolveTeamTitleSubscription({ teamFollowed: false, explicit: false, excluded: false }),
    { enabled: false, reason: 'none' },
  );
});

test('branch release identity is deterministic and branch-sensitive', async () => {
  const { multiTeamReleaseIdentity } = await scanner();

  const a = multiTeamReleaseIdentity('10--book', 'native:500', [12, 10, 12, 11]);
  const b = multiTeamReleaseIdentity('10--book', 'native:500', [10, 11, 12]);
  const otherBranch = multiTeamReleaseIdentity('10--book', 'native:501', [10, 11, 12]);

  assert.equal(a, b);
  assert.notEqual(a, otherBranch);
  assert.match(a, /^branch-release:v1:/);
});

test('team discovery reconciliation only changes relationships in the team being reconciled', async () => {
  const { computeTeamDiscoveryReconciliation } = await discovery();

  const result = computeTeamDiscoveryReconciliation(
    [
      { book_ref: '10--shared', presence_state: 'active' },
      { book_ref: '11--old', presence_state: 'active' },
      { book_ref: '12--returning', presence_state: 'dormant' },
    ],
    ['10--shared', '12--returning', '13--new'],
  );

  assert.deepEqual(result.unchangedActive, ['10--shared']);
  assert.deepEqual(result.makeDormant, ['11--old']);
  assert.deepEqual(result.activate, ['12--returning', '13--new']);
});

test('scanner keeps baseline and shadow non-delivering and uses branch-aware team mappings', async () => {
  const source = await readFile(new URL('../src/ranobelib-multi-team-scanner.ts', import.meta.url), 'utf8');

  assert.match(source, /mode === 'live' && !baselineNeeded/);
  assert.match(source, /getChapterBranches\(work\.book_ref\)/);
  assert.match(source, /INSERT OR IGNORE INTO ranobelib_release_teams/);
  assert.match(source, /reconcileReleaseOutboxRecipients\(env, releaseId\)/);
  assert.match(source, /baseline and shadow modes intentionally advance/i);
});

test('team-aware demand unions eligible users and preserves delivered history during reconciliation', async () => {
  const source = await readFile(new URL('../src/multi-team-notification-demand.ts', import.meta.url), 'utf8');

  assert.match(source, /COUNT\(DISTINCT user_telegram_id\)/i);
  assert.match(source, /ranobelib_release_teams/);
  assert.match(source, /INSERT OR IGNORE INTO ranobelib_notification_outbox/i);
  assert.match(source, /status IN \('pending','retry'\)/i);
  assert.doesNotMatch(source, /DELETE FROM ranobelib_notification_outbox[\s\S]*status\s*=\s*'sent'/i);
});
