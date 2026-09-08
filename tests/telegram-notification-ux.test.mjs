import assert from 'node:assert/strict';
import test from 'node:test';

async function loadUx() {
  return import('../dist-runtime/telegram-notification-ux.js');
}

const title = {
  ranobelib_id: 1000,
  book_ref: '1000--one',
  title: 'Культивация Онлайн',
  url: 'https://ranobelib.me/ru/book/1000--one',
};

const callbacks = (payload) => payload.reply_markup.inline_keyboard.flat()
  .map((button) => button.callback_data).filter(Boolean);

test('notification dashboard is compact and does not expose mode presets inline', async () => {
  const { buildNotificationDashboard } = await loadUx();
  const payload = buildNotificationDashboard({
    effectiveCount: 12,
    allTitles: false,
    globalSetting: { mode: 'stack', stackSize: 10 },
    overrideCount: 2,
  });
  assert.match(payload.text, /Уведомления/);
  assert.match(payload.text, /Подписки: 12 тайтлов/);
  assert.match(payload.text, /Режим по умолчанию: 📦 По 10/);
  assert.match(payload.text, /Индивидуальные настройки: 2/);
  const data = callbacks(payload);
  assert.ok(data.includes('subs:mine:0'));
  assert.ok(data.includes('subs:search:h'));
  assert.ok(data.includes('subs:all:0'));
  assert.ok(data.includes('subs:mode:home'));
  assert.ok(data.includes('prop:home'));
  assert.equal(data.some((value) => /^subs:mode:g:/.test(value)), false);
  assert.equal(JSON.stringify(payload).includes('☠'), false);
});

test('My subscriptions and All translations render title-card callbacks and pagination without toggles', async () => {
  const { buildNotificationTitleList } = await loadUx();
  const rows = Array.from({ length: 8 }, (_, index) => ({
    ...title,
    ranobelib_id: 1000 + index,
    book_ref: `${1000 + index}--book`,
    title: `Тайтл ${index + 1}`,
  }));
  const mine = buildNotificationTitleList({ kind: 'mine', rows, page: 0 });
  assert.match(mine.text, /Мои подписки/);
  assert.ok(callbacks(mine).includes('subs:title:1000:m:0'));
  assert.ok(callbacks(mine).includes('subs:mine:1'));
  assert.ok(callbacks(mine).includes('subs:search:m'));
  assert.ok(callbacks(mine).includes('subs:all:clear:confirm'));
  assert.ok(callbacks(mine).includes('subs:center'));

  const all = buildNotificationTitleList({ kind: 'all', rows: rows.slice(0, 3), page: 2 });
  assert.match(all.text, /Все переводы/);
  assert.ok(callbacks(all).includes('subs:title:1000:a:2'));
  assert.ok(callbacks(all).includes('subs:all:1'));
  assert.ok(callbacks(all).includes('subs:search:a'));
  assert.ok(callbacks(all).includes('subs:center'));
  assert.equal(callbacks(all).some((value) => value.startsWith('subs:title:toggle:')), false);
});

test('title card separates opening from toggling and shows stack progress only for stack mode', async () => {
  const { buildNotificationTitleCard } = await loadUx();
  const stack = buildNotificationTitleCard({
    title,
    enabled: true,
    inherited: true,
    effectiveSetting: { mode: 'stack', stackSize: 10 },
    globalSetting: { mode: 'stack', stackSize: 10 },
    pendingChapterCount: 4,
    returnContext: { origin: 'm', page: 3 },
  });
  assert.match(stack.text, /Уведомления: ✅ включены/);
  assert.match(stack.text, /Режим: ↩️ Как для всех/);
  assert.match(stack.text, /Общий режим: 📦 По 10/);
  assert.match(stack.text, /Накоплено: 4 \/ 10/);
  const stackData = callbacks(stack);
  assert.ok(stackData.includes('subs:title:toggle:1000:m:3'));
  assert.ok(stackData.includes('subs:title:mode:1000:m:3'));
  assert.ok(stackData.includes('subs:mine:3'));
  assert.ok(stackData.includes('prop:home'));
  assert.ok(stack.reply_markup.inline_keyboard.flat().some((button) => button.url === title.url));

  const instant = buildNotificationTitleCard({
    title,
    enabled: false,
    inherited: false,
    effectiveSetting: { mode: 'instant', stackSize: null },
    globalSetting: { mode: 'stack', stackSize: 10 },
    pendingChapterCount: null,
    returnContext: { origin: 'a', page: 0 },
  });
  assert.match(instant.text, /Уведомления: 🔕 отключены/);
  assert.match(instant.text, /Режим: ⚡ Мгновенно/);
  assert.doesNotMatch(instant.text, /Накоплено:/);
  assert.ok(callbacks(instant).includes('subs:all:0'));
});

test('disable-all confirmation is explicit and offers safe Back', async () => {
  const { buildNotificationDisableAllConfirmation } = await loadUx();
  const payload = buildNotificationDisableAllConfirmation();
  assert.match(payload.text, /Отключить все уведомления/i);
  assert.ok(callbacks(payload).includes('subs:all:clear:yes'));
  assert.ok(callbacks(payload).includes('subs:mine:0'));
  assert.ok(callbacks(payload).includes('prop:home'));
});

test('global delivery mode is a dedicated screen with presets and Back to dashboard', async () => {
  const { buildNotificationGlobalModeScreen } = await loadUx();
  const payload = buildNotificationGlobalModeScreen({ mode: 'stack', stackSize: 10 });
  assert.match(payload.text, /Режим доставки/);
  assert.match(payload.text, /📦 По 10/);
  assert.match(payload.text, /7 дней/);
  const data = callbacks(payload);
  assert.ok(data.includes('subs:mode:g:i'));
  assert.ok(data.includes('subs:mode:g:5'));
  assert.ok(data.includes('subs:mode:g:10'));
  assert.ok(data.includes('subs:mode:g:20'));
  assert.ok(data.includes('subs:mode:g:c'));
  assert.ok(data.includes('subs:center'));
  assert.equal(JSON.stringify(payload).includes('☠'), false);
});

test('per-title mode screen keeps true Back-to-card context and supports inheritance reset', async () => {
  const { buildNotificationTitleModeScreen } = await loadUx();
  const payload = buildNotificationTitleModeScreen({
    title,
    enabled: true,
    inherited: false,
    effectiveSetting: { mode: 'stack', stackSize: 5 },
    globalSetting: { mode: 'stack', stackSize: 10 },
    returnContext: { origin: 'a', page: 4 },
  });
  assert.match(payload.text, /Культивация Онлайн/);
  assert.match(payload.text, /Режим: 📦 По 5/);
  const data = callbacks(payload);
  assert.ok(data.includes('subs:mode:t:1000:i:a:4'));
  assert.ok(data.includes('subs:mode:t:1000:5:a:4'));
  assert.ok(data.includes('subs:mode:t:1000:c:a:4'));
  assert.ok(data.includes('subs:mode:t:1000:inherit:a:4'));
  assert.ok(data.includes('subs:title:1000:a:4'));
  assert.ok(data.includes('prop:home'));
  for (const value of data) assert.ok(Buffer.byteLength(value, 'utf8') < 64, value);
});

test('new notification callback parser accepts compact v2 routes and historical title callback', async () => {
  const { parseNotificationUxCallback } = await loadUx();
  assert.deepEqual(parseNotificationUxCallback('subs:mine:3'), { kind: 'mine', page: 3 });
  assert.deepEqual(parseNotificationUxCallback('subs:all:2'), { kind: 'all-list', page: 2 });
  assert.deepEqual(parseNotificationUxCallback('subs:title:1000:m:3'), { kind: 'title', titleId: 1000, origin: 'm', page: 3 });
  assert.deepEqual(parseNotificationUxCallback('subs:title:1000:3'), { kind: 'title', titleId: 1000, origin: 'a', page: 3 });
  assert.deepEqual(parseNotificationUxCallback('subs:title:toggle:1000:a:1'), { kind: 'toggle', titleId: 1000, origin: 'a', page: 1 });
  assert.deepEqual(parseNotificationUxCallback('subs:title:mode:1000:s:6'), { kind: 'title-mode', titleId: 1000, origin: 's', page: 6 });
  assert.deepEqual(parseNotificationUxCallback('subs:all:clear:confirm'), { kind: 'clear-confirm' });
  assert.deepEqual(parseNotificationUxCallback('subs:all:clear:yes'), { kind: 'clear-yes' });
  assert.deepEqual(parseNotificationUxCallback('subs:mode:home'), { kind: 'mode-home' });
  assert.equal(parseNotificationUxCallback('subs:title:0:m:0'), null);
});
