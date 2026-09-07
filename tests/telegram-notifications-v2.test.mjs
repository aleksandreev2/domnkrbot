import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migrationUrl = new URL('../migrations/0012_telegram_notifications_v2.sql', import.meta.url);
const notifications = await import('../dist-runtime/telegram-subscriptions.js');

test('notifications v2 migration rebuilds settings safely, adds exclusions, and recreates the release trigger', () => {
  assert.equal(fs.existsSync(migrationUrl), true, 'migrations/0012_telegram_notifications_v2.sql must exist');
  const sql = fs.readFileSync(migrationUrl, 'utf8');
  assert.match(sql, /CREATE\s+TABLE\s+telegram_subscription_settings_v2/i);
  assert.match(sql, /delivery_mode\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'instant'/i);
  assert.match(sql, /INSERT\s+INTO\s+telegram_subscription_settings_v2[\s\S]*SELECT\s+user_telegram_id\s*,\s*all_titles/i);
  assert.match(sql, /DROP\s+TABLE\s+telegram_subscription_settings/i);
  assert.match(sql, /ALTER\s+TABLE\s+telegram_subscription_settings_v2\s+RENAME\s+TO\s+telegram_subscription_settings/i);
  assert.doesNotMatch(sql, /ADD\s+COLUMN/i);
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+title_subscription_exclusions/i);
  assert.match(sql, /DROP\s+TRIGGER\s+IF\s+EXISTS\s+trg_ranobelib_release_notifications/i);
  assert.match(sql, /NOT\s+EXISTS[\s\S]*title_subscription_exclusions[\s\S]*NEW\.book_ref/i);
});

test('notification callbacks stay compact and use numeric RanobeLib ids', () => {
  assert.equal(typeof notifications.parseSubscriptionCallback, 'function');
  assert.deepEqual(notifications.parseSubscriptionCallback('subs:center'), { kind: 'center' });
  assert.deepEqual(notifications.parseSubscriptionCallback('subs:notify:toggle:62387'), { kind: 'notify-toggle', titleId: 62387 });
  assert.deepEqual(notifications.parseSubscriptionCallback('subs:notify:settings:62387'), { kind: 'notify-settings', titleId: 62387 });
  assert.deepEqual(notifications.parseSubscriptionCallback('subs:notify:panel-toggle:62387'), { kind: 'notify-panel-toggle', titleId: 62387 });
  for (const value of ['subs:center', 'subs:notify:toggle:62387', 'subs:notify:settings:62387', 'subs:notify:panel-toggle:62387']) {
    assert.ok(Buffer.byteLength(value, 'utf8') <= 64);
  }
});

test('release notification v2 has reading and direct subscription controls', () => {
  assert.equal(typeof notifications.formatReleaseNotification, 'function');
  const payload = notifications.formatReleaseNotification({
    titleId: 62387,
    title: 'Покемон: Мастер тактики',
    url: 'https://ranobelib.me/ru/book/62387--pokemon-master-of-tactics',
    chapterCount: 2,
    firstNumber: '51',
    lastNumber: '52',
    summary: 'Chapters 51–52',
    subscribed: true,
  });
  assert.match(payload.text, /Покемон: Мастер тактики/);
  assert.match(payload.text, /51–52/);
  assert.match(payload.text, /уже доступны/i);
  assert.deepEqual(payload.reply_markup.inline_keyboard, [
    [{ text: '📖 Читать', url: 'https://ranobelib.me/ru/book/62387--pokemon-master-of-tactics' }],
    [
      { text: '🔕 Отписаться', callback_data: 'subs:notify:toggle:62387' },
      { text: '⚙️ Настройки тайтла', callback_data: 'subs:notify:settings:62387' },
    ],
  ]);

  const off = notifications.formatReleaseNotification({
    titleId: 62387,
    title: 'Покемон: Мастер тактики',
    url: 'https://ranobelib.me/ru/book/62387--pokemon-master-of-tactics',
    chapterCount: 1,
    firstNumber: '53',
    lastNumber: '53',
    summary: 'Chapter 53',
    subscribed: false,
  });
  assert.equal(off.reply_markup.inline_keyboard[1][0].text, '🔔 Подписаться');
});

test('notification center shows instant delivery as status, not a fake interactive mode control', () => {
  assert.equal(typeof notifications.buildNotificationCenter, 'function');
  const all = notifications.buildNotificationCenter({
    deliveryMode: 'instant',
    allTitles: true,
    explicitCount: 0,
    exclusionCount: 2,
  });
  assert.match(all.text, /🔔 <b>Уведомления<\/b>/);
  assert.match(all.text, /Режим доставки: ⚡ Сразу/);
  assert.match(all.text, /Все переводы, кроме 2/);
  assert.deepEqual(all.reply_markup.inline_keyboard, [
    [{ text: '📚 Управлять тайтлами', callback_data: 'subs:list:0' }],
    [{ text: '🔕 Отключить все', callback_data: 'subs:all:clear' }],
  ]);
  assert.equal(
    all.reply_markup.inline_keyboard.flat().some((button) => button.text.includes('Режим')),
    false,
    'instant-only delivery status must not look like a toggleable button',
  );

  const selected = notifications.buildNotificationCenter({
    deliveryMode: 'instant',
    allTitles: false,
    explicitCount: 3,
    exclusionCount: 0,
  });
  assert.match(selected.text, /3 тайтла/);
});

test('effective subscription model supports exact opt-outs while all translations are enabled', () => {
  assert.equal(typeof notifications.resolveEffectiveSubscription, 'function');
  assert.equal(notifications.resolveEffectiveSubscription({ allTitles: true, explicit: false, excluded: false }), true);
  assert.equal(notifications.resolveEffectiveSubscription({ allTitles: true, explicit: true, excluded: true }), false);
  assert.equal(notifications.resolveEffectiveSubscription({ allTitles: false, explicit: true, excluded: false }), true);
  assert.equal(notifications.resolveEffectiveSubscription({ allTitles: false, explicit: false, excluded: false }), false);
});
