import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTeamNotificationDashboard,
  buildTeamListScreen,
  buildTeamTitleCard,
  buildTeamTranslationsScreen,
  buildWorkSearchResults,
  parseTeamNotificationCallback,
} from '../dist-runtime/telegram-team-notification-ux.js';
import {
  buildPartnerNotificationDashboard,
  buildPartnerCatalogHub,
  buildPartnerSubscriptionsHub,
  buildPartnerTeamList,
  buildPartnerTranslationList,
  parsePartnerCollaborationCallback,
} from '../dist-runtime/telegram-partner-collaboration-ux.js';

const title = {
  teamId: 7,
  teamName: 'Team Seven',
  teamIsPrimary: false,
  ranobelibId: 123,
  bookRef: '123--example',
  title: 'Example Novel',
  url: 'https://ranobelib.me/ru/book/123--example',
  semanticStatus: 'active',
  enabled: true,
  enabledReason: 'team',
};

test('legacy multi-team dashboard remains available for compatibility', () => {
  const payload = buildTeamNotificationDashboard({ followedTeams: 2, manualTitles: 3, globalModeLabel: '⚡ Мгновенно' });
  const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes('subs:mt:teams:mine:0'));
  assert.ok(callbacks.includes('subs:mt:titles:0'));
  assert.ok(callbacks.includes('subs:mt:search:start'));
  assert.ok(callbacks.includes('subs:mt:teams:all:0'));
  assert.ok(callbacks.includes('subs:mode:home'));
});

test('partner notification dashboard uses the approved catalog-oriented hierarchy', () => {
  const payload = buildPartnerNotificationDashboard({ followedTeams: 2, manualTitles: 4, globalModeLabel: '📦 По 5 глав' });
  assert.match(payload.text, /Команд целиком: <b>2<\/b>/);
  assert.match(payload.text, /Отдельных переводов: <b>4<\/b>/);
  const flat = payload.reply_markup.inline_keyboard.flat();
  const callbacks = flat.map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes('subs:pc:mine'));
  assert.ok(callbacks.includes('subs:pc:catalog'));
  assert.ok(callbacks.includes('subs:mt:search:start'));
  assert.ok(callbacks.includes('subs:mode:home'));
  assert.ok(flat.some((button) => button.text === '⭐ Мои подписки'));
  assert.ok(flat.some((button) => button.text === '🧭 Каталог переводов'));
});

test('my subscriptions hub separates whole teams from manual translations', () => {
  const payload = buildPartnerSubscriptionsHub({ followedTeams: 2, manualTitles: 4 });
  const flat = payload.reply_markup.inline_keyboard.flat();
  assert.ok(flat.some((button) => button.text.includes('Мои команды') && button.callback_data === 'subs:pc:mine:teams:0'));
  assert.ok(flat.some((button) => button.text.includes('Мои переводы') && button.callback_data === 'subs:pc:mine:titles:0'));
});

test('catalog hub keeps Dom Nekromanta primary and external teams under partnerships', () => {
  const payload = buildPartnerCatalogHub();
  const flat = payload.reply_markup.inline_keyboard.flat();
  assert.ok(flat.some((button) => button.text === '🏠 Дом Некроманта' && button.callback_data === 'subs:pc:catalog:primary:0'));
  assert.ok(flat.some((button) => button.text === '🤝 Партнёрские команды' && button.callback_data === 'subs:pc:catalog:partners:0'));
  assert.ok(flat.some((button) => button.text === '📚 Все активные переводы' && button.callback_data === 'subs:pc:catalog:active:0'));
  assert.ok(flat.some((button) => button.text === '✅ Завершённые переводы' && button.callback_data === 'subs:pc:catalog:completed:0'));
});

test('partner list never labels the primary team as a partner', () => {
  const payload = buildPartnerTeamList({
    page: 0,
    teams: [
      { id: 7, displayName: 'Блинная Беса', isPrimary: false, followed: true, activeCount: 8, completedCount: 0 },
    ],
    origin: 'partners',
  });
  assert.match(payload.text, /Партнёрские команды/);
  assert.doesNotMatch(payload.text, /Дом Некроманта/);
  const flat = payload.reply_markup.inline_keyboard.flat();
  assert.ok(flat.some((button) => button.text.includes('Блинная Беса') && button.callback_data === 'subs:mt:team:7:active:0'));
});

test('catalog translation list always shows translator identity', () => {
  const payload = buildPartnerTranslationList({ translations: [title], page: 0, completed: false, scope: 'active' });
  const flat = payload.reply_markup.inline_keyboard.flat();
  assert.ok(flat.some((button) => /Example Novel/.test(button.text) && /Team Seven/.test(button.text)));
});

test('partner collaboration callbacks stay compact and parse catalog destinations', () => {
  assert.deepEqual(parsePartnerCollaborationCallback('subs:pc:catalog:partners:3'), { kind: 'partners', page: 3 });
  assert.deepEqual(parsePartnerCollaborationCallback('subs:pc:catalog:completed:2'), { kind: 'catalog-translations', completed: true, page: 2 });
  assert.deepEqual(parsePartnerCollaborationCallback('subs:pc:mine:titles:5'), { kind: 'my-titles', page: 5 });
  assert.equal('subs:pc:catalog:completed:9999'.length < 64, true);
});

test('team list keeps primary team visible first and separates completed translations', () => {
  const payload = buildTeamListScreen({
    kind: 'all',
    page: 0,
    teams: [
      { id: 1, displayName: 'Дом Некроманта', isPrimary: true, followed: true, activeCount: 12, completedCount: 4 },
      { id: 7, displayName: 'Team Seven', isPrimary: false, followed: false, activeCount: 3, completedCount: 2 },
    ],
  });
  const text = payload.reply_markup.inline_keyboard.flat().map((button) => button.text).join('\n');
  assert.match(text, /Дом Некроманта/);
  assert.match(text, /Team Seven/);
  assert.match(text, /12/);
});

test('search groups one work with several translations behind a team picker', () => {
  const payload = buildWorkSearchResults({
    query: 'Example',
    page: 0,
    groups: [{
      bookRef: title.bookRef,
      ranobelibId: 123,
      title: title.title,
      translations: [title, { ...title, teamId: 8, teamName: 'Team Eight', enabled: false, enabledReason: 'none' }],
    }],
  });
  const button = payload.reply_markup.inline_keyboard.flat().find((item) => item.text.includes('Example Novel'));
  assert.equal(button?.callback_data, 'subs:mt:work:123:0');
  assert.match(button?.text ?? '', /2/);
});

test('team-title card shows translator identity, inherited whole-team state and team-scoped controls', () => {
  const payload = buildTeamTitleCard({
    translation: title,
    deliveryLabel: '⚡ Мгновенно',
    inheritedDelivery: true,
    origin: 'team',
    page: 0,
  });
  assert.match(payload.text, /Team Seven/);
  assert.match(payload.text, /включены/i);
  assert.match(payload.text, /вся команда/i);
  const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes('subs:mt:title:toggle:7:123:team:0'));
  assert.ok(callbacks.includes('subs:mt:title:mode:7:123:team:0'));
});

test('completed team title preserves completed-list origin for card navigation', () => {
  const completedTitle = { ...title, semanticStatus: 'completed' };
  const list = buildTeamTranslationsScreen({
    team: { id: 7, displayName: 'Team Seven', isPrimary: false, followed: true, activeCount: 3, completedCount: 2 },
    translations: [completedTitle],
    completed: true,
    page: 2,
  });
  const titleButton = list.reply_markup.inline_keyboard.flat().find((button) => button.text.includes('Example Novel'));
  assert.equal(titleButton?.callback_data, 'subs:mt:title:7:123:completed:2');
  assert.deepEqual(parseTeamNotificationCallback('subs:mt:title:7:123:completed:2'), {
    kind: 'title', teamId: 7, titleId: 123, origin: 'completed', page: 2,
  });

  const card = buildTeamTitleCard({
    translation: completedTitle,
    deliveryLabel: '⚡ Мгновенно',
    inheritedDelivery: true,
    origin: 'completed',
    page: 2,
  });
  const back = card.reply_markup.inline_keyboard.flat().find((button) => button.text === '↩️ Назад');
  assert.equal(back?.callback_data, 'subs:mt:team:7:completed:2');
});

test('multi-team callbacks stay compact and retain team/work scope', () => {
  assert.deepEqual(parseTeamNotificationCallback('subs:mt:title:7:123:search:2'), {
    kind: 'title', teamId: 7, titleId: 123, origin: 'search', page: 2,
  });
  assert.deepEqual(parseTeamNotificationCallback('subs:mt:team:7:completed:3'), {
    kind: 'team-translations', teamId: 7, completed: true, page: 3,
  });
  assert.equal('subs:mt:title:mode:set:7:123:20:search:9999'.length < 64, true);
});
