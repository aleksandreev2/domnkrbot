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

test('admin list exposes lifecycle and rollout controls while keeping the primary identity visible', () => {
  const payload = buildTeamAdminList([
    { id: 1, displayName: 'Дом Некроманта', isPrimary: true, lifecycleState: 'published', lastSyncError: null },
    { id: 7, displayName: 'Team Seven', isPrimary: false, lifecycleState: 'hidden', lastSyncError: 'upstream failed' },
  ]);
  assert.match(payload.text, /Дом Некроманта/);
  assert.match(payload.text, /Team Seven/);
  const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes('teamadmin:view:7'));
  assert.ok(callbacks.includes('teamadmin:add'));
  assert.ok(callbacks.includes('teamadmin:rollout'));
});

test('rollout planner enforces Shadow -> Delivery -> UI and cascades safe rollback', async () => {
  const admin = await import('../dist-runtime/telegram-team-admin.js');
  assert.equal(typeof admin.planMultiTeamRolloutTransition, 'function');

  const off = { shadow: false, delivery: false, ui: false };
  assert.deepEqual(admin.planMultiTeamRolloutTransition(off, 'delivery', true), {
    allowed: false,
    next: off,
    reason: 'Сначала включите Shadow.',
  });
  assert.deepEqual(admin.planMultiTeamRolloutTransition(off, 'ui', true), {
    allowed: false,
    next: off,
    reason: 'Сначала включите Delivery.',
  });

  const shadow = admin.planMultiTeamRolloutTransition(off, 'shadow', true);
  assert.deepEqual(shadow, {
    allowed: true,
    next: { shadow: true, delivery: false, ui: false },
    reason: null,
  });

  const live = { shadow: true, delivery: true, ui: true };
  assert.deepEqual(admin.planMultiTeamRolloutTransition(live, 'delivery', false), {
    allowed: true,
    next: { shadow: true, delivery: false, ui: false },
    reason: null,
  });
  assert.deepEqual(admin.planMultiTeamRolloutTransition(live, 'shadow', false), {
    allowed: true,
    next: { shadow: false, delivery: false, ui: false },
    reason: null,
  });
});

test('rollout admin card only offers the next safe activation stage', async () => {
  const admin = await import('../dist-runtime/telegram-team-admin.js');
  assert.equal(typeof admin.buildMultiTeamRolloutAdmin, 'function');

  const off = admin.buildMultiTeamRolloutAdmin({ shadow: false, delivery: false, ui: false });
  const offCallbacks = off.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.match(off.text, /Shadow:.*выключен/s);
  assert.ok(offCallbacks.includes('teamadmin:rollout:shadow:on'));
  assert.ok(!offCallbacks.includes('teamadmin:rollout:delivery:confirm:on'));
  assert.ok(!offCallbacks.includes('teamadmin:rollout:ui:confirm:on'));

  const shadow = admin.buildMultiTeamRolloutAdmin({ shadow: true, delivery: false, ui: false });
  const shadowCallbacks = shadow.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(shadowCallbacks.includes('teamadmin:rollout:delivery:on'));
  assert.ok(!shadowCallbacks.includes('teamadmin:rollout:ui:on'));

  const delivery = admin.buildMultiTeamRolloutAdmin({ shadow: true, delivery: true, ui: false });
  const deliveryCallbacks = delivery.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(deliveryCallbacks.includes('teamadmin:rollout:ui:on'));
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

test('hidden team card exposes an admin-only notification test action', () => {
  const payload = buildTeamAdminCard({
    id: 7,
    ranobelibTeamId: 64306,
    ranobelibTeamRef: '64306--blinnaia-besa',
    displayName: 'Блинная Беса',
    isPrimary: false,
    lifecycleState: 'hidden',
    recommendationChatId: null,
    recommendationChatTitle: null,
    recommendationChatUsername: null,
    recommendationMembershipCapable: false,
    lastSyncAt: '2026-09-11 05:17:37',
    lastSyncError: null,
  }, { total: 8, active: 8, completed: 0, unknown: 0 });
  const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes('teamadmin:test-notification:7'));
});

test('admin notification preview is rendered by the same team-aware release renderer', async () => {
  const admin = await import('../dist-runtime/telegram-team-admin.js');
  assert.equal(typeof admin.buildTeamAdminTestNotificationPayload, 'function');
  const payload = admin.buildTeamAdminTestNotificationPayload({
    titleId: 123,
    title: 'Тестовая новелла',
    readUrl: 'https://ranobelib.me/ru/123--test/read/v1/c42',
    volume: '1',
    number: '42',
    chapterName: 'Проверочная глава',
    teamNames: ['Блинная Беса'],
  });
  assert.match(payload.text, /Тестовая новелла/);
  assert.match(payload.text, /42/);
  assert.match(payload.text, /Блинная Беса/);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].url, 'https://ranobelib.me/ru/123--test/read/v1/c42');
});

test('admin notification test handler is direct and does not mutate rollout, publication or outbox state', () => {
  const start = source.indexOf("/^teamadmin:test-notification:(\\d+)$/");
  assert.ok(start >= 0, 'test-notification callback handler must exist');
  const end = source.indexOf("match = /^teamadmin:channel:", start);
  assert.ok(end > start, 'test-notification handler must remain isolated before channel management');
  const block = source.slice(start, end);
  assert.match(block, /sendTeamAdminTestNotification/);
  assert.doesNotMatch(block, /setRanobeLibTeamLifecycle|setMultiTeamRolloutFlag|ranobelib_notification_outbox|telegram_team_subscriptions|telegram_team_title_subscriptions/);
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
