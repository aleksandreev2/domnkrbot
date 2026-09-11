import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function adminModule() {
  return import('../dist-runtime/telegram-team-admin.js');
}

const sampleTeam = {
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
};

test('hidden team admin card exposes an isolated notification test action', async () => {
  const { buildTeamAdminCard } = await adminModule();
  const payload = buildTeamAdminCard(sampleTeam, { total: 8, active: 8, completed: 0, unknown: 0 });
  const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);

  assert.ok(callbacks.includes('teamadmin:test-notification:7'));
});

test('admin test notification uses the same team-aware release renderer shape as production', async () => {
  const admin = await adminModule();
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

test('admin notification test path is direct and never mutates publication, rollout or outbox state', async () => {
  const source = await readFile(new URL('../src/telegram-team-admin.ts', import.meta.url), 'utf8');
  const start = source.indexOf("/^teamadmin:test-notification:(\\d+)$/");
  assert.ok(start >= 0, 'test-notification callback handler must exist');
  const end = source.indexOf("match = /^teamadmin:channel:", start);
  assert.ok(end > start, 'test-notification handler must remain isolated before channel management');
  const block = source.slice(start, end);

  assert.match(block, /sendTeamAdminTestNotification/);
  assert.doesNotMatch(block, /setRanobeLibTeamLifecycle|setMultiTeamRolloutFlag|ranobelib_notification_outbox|telegram_team_subscriptions|telegram_team_title_subscriptions/);
});
