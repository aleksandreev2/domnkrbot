import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildTeamOnboardingScreen,
  shouldOfferTeamOnboardingFromState,
} from '../dist-runtime/telegram-team-onboarding.js';

const source = readFileSync(new URL('../src/telegram-team-onboarding.ts', import.meta.url), 'utf8');

test('onboarding only appears with UI rollout on, no completion and zero configured subscriptions', () => {
  assert.equal(shouldOfferTeamOnboardingFromState({ uiEnabled: true, completed: false, configuredSubscriptions: 0 }), true);
  assert.equal(shouldOfferTeamOnboardingFromState({ uiEnabled: false, completed: false, configuredSubscriptions: 0 }), false);
  assert.equal(shouldOfferTeamOnboardingFromState({ uiEnabled: true, completed: true, configuredSubscriptions: 0 }), false);
  assert.equal(shouldOfferTeamOnboardingFromState({ uiEnabled: true, completed: false, configuredSubscriptions: 1 }), false);
});

test('onboarding exposes explicit team selection and Not now without treating browsing as completion', () => {
  const payload = buildTeamOnboardingScreen([
    { id: 1, displayName: 'Дом Некроманта', isPrimary: true, recommended: true },
    { id: 7, displayName: 'Team Seven', isPrimary: false, recommended: false },
  ]);
  const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes('subs:mt:onboard:team:1'));
  assert.ok(callbacks.includes('subs:mt:onboard:not-now'));
  assert.ok(!callbacks.some((value) => /complete|done/.test(value)));
});

test('onboarding persistence accepts only successful team selection or explicit Not now', () => {
  assert.match(source, /completion_reason/);
  assert.match(source, /team_selected/);
  assert.match(source, /not_now/);
  assert.match(source, /telegram_team_subscriptions/);
});

test('configured-user fast path is checked before recommendation channel membership lookups', () => {
  const configuredIndex = source.indexOf('countConfiguredNotificationSubscriptions');
  const membershipIndex = source.indexOf('getChatMember');
  assert.ok(configuredIndex >= 0 && membershipIndex > configuredIndex);
});
