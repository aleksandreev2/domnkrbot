import assert from 'node:assert/strict';
import test from 'node:test';

async function loadControls() {
  return import('../dist-runtime/telegram-notification-controls.js');
}

test('parses compact global and per-title delivery-mode callbacks', async () => {
  const { parseNotificationModeCallback } = await loadControls();

  assert.deepEqual(parseNotificationModeCallback('subs:mode:g:i'), { scope: 'global', action: 'instant' });
  assert.deepEqual(parseNotificationModeCallback('subs:mode:g:5'), { scope: 'global', action: 'stack', stackSize: 5 });
  assert.deepEqual(parseNotificationModeCallback('subs:mode:g:10'), { scope: 'global', action: 'stack', stackSize: 10 });
  assert.deepEqual(parseNotificationModeCallback('subs:mode:g:20'), { scope: 'global', action: 'stack', stackSize: 20 });
  assert.deepEqual(parseNotificationModeCallback('subs:mode:g:c'), { scope: 'global', action: 'custom' });

  assert.deepEqual(parseNotificationModeCallback('subs:mode:t:271368:i'), { scope: 'title', titleId: 271368, action: 'instant' });
  assert.deepEqual(parseNotificationModeCallback('subs:mode:t:271368:5'), { scope: 'title', titleId: 271368, action: 'stack', stackSize: 5 });
  assert.deepEqual(parseNotificationModeCallback('subs:mode:t:271368:c'), { scope: 'title', titleId: 271368, action: 'custom' });
  assert.deepEqual(parseNotificationModeCallback('subs:mode:t:271368:inherit'), { scope: 'title', titleId: 271368, action: 'inherit' });

  assert.equal(parseNotificationModeCallback('subs:mode:g:1'), null);
  assert.equal(parseNotificationModeCallback('subs:mode:t:nope:5'), null);
  assert.equal(parseNotificationModeCallback('subs:mode:t:0:5'), null);
  assert.equal(parseNotificationModeCallback('subs:center'), null);
});

test('global notification center exposes instant, stack presets and custom mode', async () => {
  const { buildDeliveryModeNotificationCenter } = await loadControls();
  const payload = buildDeliveryModeNotificationCenter({
    setting: { mode: 'stack', stackSize: 10 },
    allTitles: false,
    explicitCount: 23,
    exclusionCount: 0,
    overrideCount: 3,
  });

  assert.match(payload.text, /Режим по умолчанию: 📦 По 10/);
  assert.match(payload.text, /Подписки: 23 тайтла/);
  assert.match(payload.text, /Индивидуальные настройки: 3/);

  const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.includes('subs:mode:g:i'));
  assert.ok(callbacks.includes('subs:mode:g:5'));
  assert.ok(callbacks.includes('subs:mode:g:10'));
  assert.ok(callbacks.includes('subs:mode:g:20'));
  assert.ok(callbacks.includes('subs:mode:g:c'));
  assert.ok(callbacks.includes('subs:list:0'));
});

test('title delivery panel shows effective and global modes plus inheritance reset for overrides', async () => {
  const { buildTitleDeliveryModePanel } = await loadControls();
  const title = {
    ranobelib_id: 271368,
    book_ref: '271368--book',
    title: 'Тестовый тайтл',
    url: 'https://ranobelib.me/ru/book/271368--book',
  };

  const overridden = buildTitleDeliveryModePanel({
    title,
    enabled: true,
    effectiveSetting: { mode: 'stack', stackSize: 5 },
    globalSetting: { mode: 'stack', stackSize: 10 },
    inherited: false,
  });
  assert.match(overridden.text, /Режим: 📦 По 5/);
  assert.match(overridden.text, /Общий режим: 📦 По 10/);
  const buttons = overridden.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((button) => button.callback_data === 'subs:mode:t:271368:inherit' && /Использовать общий режим/.test(button.text)));
  assert.ok(buttons.some((button) => button.callback_data === 'subs:mode:t:271368:c'));

  const inherited = buildTitleDeliveryModePanel({
    title,
    enabled: true,
    effectiveSetting: { mode: 'instant', stackSize: null },
    globalSetting: { mode: 'instant', stackSize: null },
    inherited: true,
  });
  assert.match(inherited.text, /используется общий режим/i);
  assert.equal(inherited.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'subs:mode:t:271368:inherit'), false);
});
