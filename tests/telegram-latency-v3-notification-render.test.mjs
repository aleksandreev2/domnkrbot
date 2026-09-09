import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { notificationRenderStrategy } from '../dist-runtime/telegram-notification-render-strategy.js';

test('notification screen transitions replace while local pagination and toggles edit', () => {
  const cases = [
    ['subs:center', '📚 Мои подписки\n\nНажмите на тайтл', 'replace'],
    ['subs:mine:0', '🔔 Уведомления\n\nПодписки: 4 тайтла', 'replace'],
    ['subs:mine:1', '📚 Мои подписки\n\nНажмите на тайтл', 'edit'],
    ['subs:all:2', '📚 Все переводы\n\nНажмите на тайтл', 'edit'],
    ['subs:all:2', '📚 Книга 1\n\nУведомления: ✅ включены', 'replace'],
    ['subs:title:1000:a:2', '📚 Все переводы\n\nНажмите на тайтл', 'replace'],
    ['subs:title:toggle:1000:a:2', '📚 Книга 1\n\nУведомления: ✅ включены', 'edit'],
    ['subs:search:page:2', '🔎 Результаты поиска\n\nЗапрос: тест', 'edit'],
    ['subs:title:mode:1000:a:2', '📚 Книга 1\n\nУведомления: ✅ включены', 'replace'],
    ['subs:mode:home', '🔔 Уведомления\n\nПодписки: 4 тайтла', 'replace'],
  ];

  for (const [callbackData, currentText, expected] of cases) {
    assert.equal(notificationRenderStrategy(callbackData, currentText), expected, callbackData);
  }
});

test('notification runtime routes visible callback screens through the shared renderer', async () => {
  const source = await readFile(new URL('../src/telegram-notification-ux-runtime.ts', import.meta.url), 'utf8');
  assert.match(source, /renderTelegramScreen/);
  assert.match(source, /notificationRenderStrategy/);
  assert.match(source, /telegramLatencyTiming/);
  assert.match(source, /strategy:\s*notificationRenderStrategy/);
});
