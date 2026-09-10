import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { aggregateClaimedDeliveryRows } from '../dist-runtime/telegram-notification-delivery-groups.js';

const deliverySource = readFileSync(new URL('../src/telegram-notification-delivery.ts', import.meta.url), 'utf8');
const scannerSource = readFileSync(new URL('../src/ranobelib-multi-team-scanner.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/0026_multi_team_delivery_scope.sql', import.meta.url), 'utf8');

function row(releaseId, scope, teams = ['Team A']) {
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
    first_number: releaseId === 'a' ? '1' : '2',
    last_volume: '1',
    last_number: releaseId === 'a' ? '1' : '2',
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

test('live delivery derives eligibility and delivery mode from release teams plus team-title overrides', () => {
  assert.match(deliverySource, /getMultiTeamRollout/);
  assert.match(deliverySource, /ranobelib_release_teams/);
  assert.match(deliverySource, /telegram_team_title_delivery_settings/);
  assert.match(deliverySource, /telegram_team_title_exclusions/);
  assert.match(deliverySource, /delivery_scope_key/);
  assert.match(deliverySource, /teamNames/);
});

test('scanner persists a stable branch delivery scope and migration is additive', () => {
  assert.match(scannerSource, /delivery_scope_key/);
  assert.match(migration, /ALTER TABLE ranobelib_releases\s+ADD COLUMN delivery_scope_key TEXT/i);
  assert.doesNotMatch(migration, /DROP\s+TABLE|DROP\s+COLUMN/i);
});
