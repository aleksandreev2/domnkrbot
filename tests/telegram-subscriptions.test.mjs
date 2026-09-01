import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSubscriptionMenu,
  formatReleaseNotification,
  parseSubscriptionCallback,
} from '../dist-runtime/telegram-subscriptions.js';

test('builds a paginated Telegram title list directly from synchronized RanobeLib titles', () => {
  const titles = Array.from({ length: 10 }, (_, index) => ({
    ranobelib_id: 1000 + index,
    book_ref: `${1000 + index}--book-${index + 1}`,
    title: `Книга ${index + 1}`,
  }));

  const menu = buildSubscriptionMenu(titles, {
    page: 0,
    pageSize: 8,
    subscribedIds: new Set([1001]),
    allTitles: false,
  });

  assert.match(menu.text, /Выберите тайтл/);
  assert.equal(menu.reply_markup.inline_keyboard.length, 11);
  assert.deepEqual(menu.reply_markup.inline_keyboard[0], [
    { text: '📖 Книга 1', callback_data: 'subs:title:1000:0' },
  ]);
  assert.deepEqual(menu.reply_markup.inline_keyboard[1], [
    { text: '✅ Книга 2', callback_data: 'subs:title:1001:0' },
  ]);
  assert.deepEqual(menu.reply_markup.inline_keyboard[8], [
    { text: '1 / 2', callback_data: 'subs:noop' },
    { text: '▶️', callback_data: 'subs:list:1' },
  ]);
  assert.deepEqual(menu.reply_markup.inline_keyboard[9], [
    { text: '☠️ Подписаться на все', callback_data: 'subs:all:on' },
  ]);
  assert.deepEqual(menu.reply_markup.inline_keyboard[10], [
    { text: '✅ Мои подписки', callback_data: 'subs:mine:0' },
    { text: '🔕 Отключить все', callback_data: 'subs:all:clear' },
  ]);
});

test('parses compact callback data without putting long RanobeLib refs into Telegram callbacks', () => {
  assert.deepEqual(parseSubscriptionCallback('subs:title:271368:4'), {
    kind: 'title',
    titleId: 271368,
    page: 4,
  });
  assert.deepEqual(parseSubscriptionCallback('subs:list:2'), { kind: 'list', page: 2 });
  assert.deepEqual(parseSubscriptionCallback('subs:all:on'), { kind: 'all', mode: 'on' });
  assert.equal(parseSubscriptionCallback('subs:title:not-a-number:0'), null);
});

test('formats one direct-message notification for a detected team release', () => {
  const notification = formatReleaseNotification({
    title: 'Хулиганки захватили мой дом',
    url: 'https://ranobelib.me/ru/book/123--bully-house',
    chapterCount: 2,
    firstNumber: '51',
    lastNumber: '52',
    summary: 'Chapters 51–52',
  });

  assert.match(notification.text, /Новые главы!/);
  assert.match(notification.text, /Хулиганки захватили мой дом/);
  assert.match(notification.text, /51–52/);
  assert.deepEqual(notification.reply_markup.inline_keyboard, [[
    { text: '📖 Читать на RanobeLib', url: 'https://ranobelib.me/ru/book/123--bully-house' },
  ]]);
});
