import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildTeamAdminList,
  parseRanobeLibTeamInput,
  normalizeRecommendationChannelInput,
} from '../dist-runtime/telegram-team-admin.js';

const source = readFileSync(new URL('../src/telegram-team-admin.ts', import.meta.url), 'utf8');

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

test('recommendation channel code is isolated from publication, download and blacklist settings', () => {
  assert.match(source, /recommendation_chat_id/);
  assert.doesNotMatch(source, /publish_channel_id|publications|channel_access_state|channel_telegram_bans|blacklist/i);
});

test('Telegram channel capability is resolved through getChat and probed through getChatMember', () => {
  assert.match(source, /getChat/);
  assert.match(source, /getChatMember/);
});
