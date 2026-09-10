import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildTeamAdminCard,
  buildTeamAdminList,
  parseRanobeLibTeamInput,
  normalizeRecommendationChannelInput,
} from '../dist-runtime/telegram-team-admin.js';

const source = readFileSync(new URL('../src/telegram-team-admin.ts', import.meta.url), 'utf8');
const registrySource = readFileSync(new URL('../src/ranobelib-team-registry.ts', import.meta.url), 'utf8');

test('admin team parser accepts RanobeLib team URL or canonical ref', () => {
  assert.deepEqual(parseRanobeLibTeamInput('https://ranobelib.me/ru/team/123--some-team'), {
    ranobelibTeamId: 123,
    ranobelibTeamRef: '123--some-team',
  });
  assert.deepEqual(parseRanobeLibTeamInput('123--some-team'), {
    ranobelibTeamId: 123,
    ranobelibTeamRef: '123--some-team',
  });
  assert.equal(parseRanobeLibTeamInput('nope'), null);
});

test('recommendation channel parser accepts username and t.me without numeric-id UX', () => {
  assert.equal(normalizeRecommendationChannelInput('@team_channel'), '@team_channel');
  assert.equal(normalizeRecommendationChannelInput('https://t.me/team_channel'), '@team_channel');
  assert.equal(normalizeRecommendationChannelInput('-1001234567890'), null);
});

test('admin list exposes lifecycle controls while keeping the primary identity visible', () => {
  const payload = buildTeamAdminList([
    { id: 1, displayName: 'Дом Некроманта', isPrimary: true, lifecycleState: 'published', lastSyncError: null },
    { id: 7, displayName: 'Team Seven', isPrimary: false, lifecycleState: 'hidden', lastSyncError: 'upstream failed' },
  ]);
  assert.match(payload.text, /Дом Некроманта/);
  assert.match(payload.text, /Team Seven/);
  const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes('teamadmin:view:7'));
  assert.ok(callbacks.includes('teamadmin:add'));
});

test('admin team card exposes team-scoped translation diagnostics', () => {
  const payload = buildTeamAdminCard({
    id: 7,
    ranobelibTeamId: 77,
    ranobelibTeamRef: '77--team-seven',
    displayName: 'Team Seven',
    isPrimary: false,
    lifecycleState: 'published',
    recommendationChatId: null,
    recommendationChatTitle: null,
    recommendationChatUsername: null,
    recommendationMembershipCapable: false,
    lastSyncAt: '2026-09-10 12:00:00',
    lastSyncError: null,
  }, { total: 12, active: 8, completed: 3, unknown: 1 });
  assert.match(payload.text, /Переводы:.*12/);
  assert.match(payload.text, /активных.*8/);
  assert.match(payload.text, /завершённых.*3/);
  assert.match(payload.text, /unknown.*1/);
  assert.match(source, /FROM ranobelib_team_translations/);
});

test('recommendation channel code is isolated from publication, download and blacklist settings', () => {
  assert.match(source, /setRanobeLibRecommendationChannel/);
  assert.match(registrySource, /recommendation_chat_id/);
  assert.doesNotMatch(source, /publish_channel_id|publications|channel_access_state|channel_telegram_bans|blacklist/i);
});

test('Telegram channel capability is resolved through getChat and probed through getChatMember', () => {
  assert.match(source, /getChat/);
  assert.match(source, /getChatMember/);
});

test('resume is idempotent and republishes only after a successful hidden sync', () => {
  const guard = source.indexOf("action === 'resume' && !team.isPrimary && team.lifecycleState === 'paused'");
  const hidden = source.indexOf("setRanobeLibTeamLifecycle(env, teamId, 'hidden')", guard);
  const sync = source.indexOf('await discoverOneRegisteredTeam(env, runnable)', hidden);
  const republish = source.indexOf("setRanobeLibTeamLifecycle(env, teamId, 'published')", sync);
  assert.ok(guard >= 0, 'resume must only transition an actually paused non-primary team');
  assert.ok(hidden > guard, 'resume must become hidden while refreshing its baseline');
  assert.ok(sync > hidden, 'resume must sync before becoming user-visible again');
  assert.ok(republish > sync, 'resume must restore published only after successful sync');
});