import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { aggregateClaimedDeliveryRows } from '../dist-runtime/telegram-notification-delivery-groups.js';
import { multiTeamDeliveryScopeKey } from '../dist-runtime/ranobelib-multi-team-scanner.js';

const deliverySource = readFileSync(new URL('../src/telegram-multi-team-delivery.ts', import.meta.url), 'utf8');
const entrySource = readFileSync(new URL('../src/live-entry-v3.ts', import.meta.url), 'utf8');
const scannerSource = readFileSync(new URL('../src/ranobelib-multi-team-scanner.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/0026_multi_team_delivery_scope.sql', import.meta.url), 'utf8');

function row(releaseId, scope, teams = ['Team A'], number = releaseId === 'a' ? '1' : '2') {
  return {
    release_id: releaseId,
    user_telegram_id: '42',
    book_ref: '1--book',
    ranobelib_id: 1,
    title: 'Book',
    url: 'https://ranobelib.me/ru/book/1--book',
    release_kind: 'chapters',
    chapter_count: 1,
    first_volume: '1',
    first_number: number,
    last_volume: '1',
    last_number: number,
    summary: '',
    delivery_scope_key: scope,
    team_names_json: JSON.stringify(teams),
  };
}

test('independent branches of the same work remain separate notification groups', () => {
  const groups = aggregateClaimedDeliveryRows([row('a', 'branch-a'), row('b', 'branch-b', ['Team B'])]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.deliveryScopeKey).sort(), ['branch-a', 'branch-b']);
});

test('successive releases from one branch can stack while joint translator names stay deduplicated', () => {
  const groups = aggregateClaimedDeliveryRows([
    row('a', 'joint-branch', ['Дом Некроманта', 'Team B']),
    row('b', 'joint-branch', ['Team B', 'Дом Некроманта']),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].teamNames, ['Дом Некроманта', 'Team B']);
  assert.equal(groups[0].chapterCount, 2);
});

test('fallback releases from the same translator slot share a stable delivery scope across chapters', () => {
  const common = {
    volume: '1', name: null, nativeBranchId: null, identityConfidence: 'fallback',
    teamIds: [11969], releasedAt: null, stableBranchRef: null, branchOrdinal: 0,
  };
  const first = multiTeamDeliveryScopeKey({ ...common, chapterId: 541, number: '541', branchKey: 'fp:v1:chapter-541' }, [1]);
  const second = multiTeamDeliveryScopeKey({ ...common, chapterId: 542, number: '542', branchKey: 'fp:v1:chapter-542' }, [1]);
  assert.equal(first, second);
});

test('fallback delivery scope stays separate for different translator slots or team sets', () => {
  const base = {
    chapterId: 541, volume: '1', number: '541', name: null, nativeBranchId: null,
    identityConfidence: 'fallback', teamIds: [11969], releasedAt: null,
    stableBranchRef: null, branchOrdinal: 0, branchKey: 'fp:v1:a',
  };
  const sameTeamOtherSlot = multiTeamDeliveryScopeKey({ ...base, branchOrdinal: 1, branchKey: 'fp:v1:b' }, [1]);
  const original = multiTeamDeliveryScopeKey(base, [1]);
  const otherTeam = multiTeamDeliveryScopeKey({ ...base, branchKey: 'fp:v1:c' }, [2]);
  assert.notEqual(original, sameTeamOtherSlot);
  assert.notEqual(original, otherTeam);
});

test('native delivery scope preserves independent native branches', () => {
  const first = multiTeamDeliveryScopeKey({
    chapterId: 541, volume: '1', number: '541', name: null,
    branchKey: 'native:700', nativeBranchId: 700, identityConfidence: 'native',
    teamIds: [11969], releasedAt: null, stableBranchRef: null, branchOrdinal: 0,
  }, [1]);
  const second = multiTeamDeliveryScopeKey({
    chapterId: 542, volume: '1', number: '542', name: null,
    branchKey: 'native:701', nativeBranchId: 701, identityConfidence: 'native',
    teamIds: [11969], releasedAt: null, stableBranchRef: null, branchOrdinal: 0,
  }, [1]);
  assert.notEqual(first, second);
});

test('same delivery scope never merges non-contiguous or duplicate chapter ranges', () => {
  const gap = aggregateClaimedDeliveryRows([
    row('a', 'same', ['Team A'], '541'),
    row('b', 'same', ['Team A'], '543'),
  ]);
  assert.equal(gap.length, 2);

  const duplicate = aggregateClaimedDeliveryRows([
    row('a', 'same', ['Team A'], '541'),
    row('b', 'same', ['Team A'], '541'),
  ]);
  assert.equal(duplicate.length, 2);
});

test('live multi-team drain derives eligibility and delivery mode from release teams plus team-title overrides', () => {
  assert.match(deliverySource, /ranobelib_release_teams/);
  assert.match(deliverySource, /telegram_team_title_delivery_settings/);
  assert.match(deliverySource, /telegram_team_title_exclusions/);
  assert.match(deliverySource, /delivery_scope_key/);
  assert.match(deliverySource, /teamNames/);
});

test('user-facing translator copy only loads published release teams', () => {
  assert.match(
    deliverySource,
    /FROM ranobelib_release_teams rt[\s\S]*JOIN ranobelib_teams team ON team\.id=rt\.team_id[\s\S]*team\.lifecycle_state='published'/,
  );
});

test('instant chapter groups use a short bounded coalescing window while completion still flushes immediately', () => {
  assert.match(deliverySource, /const\s+INSTANT_COALESCE_SECONDS\s*=\s*30\s*;/);
  assert.match(deliverySource, /translation_completed=1[\s\S]*delivery_mode<>'stack'[\s\S]*oldest_pending_at<=datetime\('now','-30 seconds'\)/);
  assert.doesNotMatch(deliverySource, /OR\s+delivery_mode<>'stack'\s+OR/);
});

test('v3 entry switches queue and fallback cron to the multi-team drain only when delivery rollout is enabled', () => {
  assert.match(entrySource, /getMultiTeamRollout/);
  assert.match(entrySource, /drainMultiTeamNotificationOutbox/);
  assert.match(entrySource, /ranobelib_multi_team_delivery|rollout\.delivery/);
  assert.match(entrySource, /\*\/5 \* \* \* \*/);
  assert.match(entrySource, /previous\.queue/);
  assert.match(entrySource, /previous\.scheduled/);
});

test('stable branch release identity feeds additive delivery-scope migration', () => {
  assert.match(scannerSource, /branch-release:v1:/);
  assert.match(scannerSource, /delivery_scope_key/);
  assert.match(migration, /ALTER TABLE ranobelib_releases\s+ADD COLUMN delivery_scope_key TEXT/i);
  assert.match(migration, /trg_ranobelib_release_delivery_scope/);
  assert.match(migration, /branch-release:v1:/);
  assert.doesNotMatch(migration, /DROP\s+TABLE|DROP\s+COLUMN/i);
});