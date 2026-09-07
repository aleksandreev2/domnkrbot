import assert from 'node:assert/strict';
import test from 'node:test';

test('normalizes notification delivery settings and validates custom stack boundaries', async () => {
  const settings = await import('../dist-runtime/telegram-notification-settings.js');

  assert.deepEqual(settings.normalizeDeliverySetting('instant', 10), { mode: 'instant', stackSize: null });
  assert.deepEqual(settings.normalizeDeliverySetting('stack', 5), { mode: 'stack', stackSize: 5 });
  assert.deepEqual(settings.normalizeDeliverySetting('stack', 100), { mode: 'stack', stackSize: 100 });
  assert.deepEqual(settings.normalizeDeliverySetting('stack', 1), { mode: 'instant', stackSize: null });
  assert.deepEqual(settings.normalizeDeliverySetting('stack', 101), { mode: 'instant', stackSize: null });
  assert.deepEqual(settings.normalizeDeliverySetting('unknown', 10), { mode: 'instant', stackSize: null });

  assert.equal(settings.validateCustomStackSize('2'), 2);
  assert.equal(settings.validateCustomStackSize('100'), 100);
  assert.equal(settings.validateCustomStackSize(37), 37);
  assert.equal(settings.validateCustomStackSize('1'), null);
  assert.equal(settings.validateCustomStackSize('101'), null);
  assert.equal(settings.validateCustomStackSize('2.5'), null);
  assert.equal(settings.validateCustomStackSize('abc'), null);
  assert.equal(settings.validateCustomStackSize(''), null);
});

test('delivery setting labels distinguish instant and stacked modes', async () => {
  const settings = await import('../dist-runtime/telegram-notification-settings.js');

  assert.equal(settings.deliverySettingLabel({ mode: 'instant', stackSize: null }), '⚡ Мгновенно');
  assert.equal(settings.deliverySettingLabel({ mode: 'stack', stackSize: 5 }), '📦 По 5');
  assert.equal(settings.deliverySettingLabel({ mode: 'stack', stackSize: 37 }), '📦 По 37');
});
