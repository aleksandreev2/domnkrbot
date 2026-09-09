import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('latency timing reports monotonic coarse stage deltas and normalized metadata', async () => {
  const { createTelegramLatencyTiming } = await import('../dist-runtime/telegram-latency-timing.js');
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const timing = createTelegramLatencyTiming();
    now = 1_005;
    timing.mark('ack_started');
    now = 1_004;
    timing.mark('schema_done');
    now = 1_015;
    timing.mark('db_done');
    now = 1_020;
    timing.mark('telegram_done');
    now = 1_025;

    assert.deepEqual(timing.snapshot(' Notifications!! ', ' Callback Query '), {
      route: 'notifications',
      kind: 'callback-query',
      ack_started_ms: 5,
      schema_ms: 5,
      db_ms: 15,
      telegram_ms: 20,
      total_ms: 25,
    });
  } finally {
    Date.now = realNow;
  }
});

test('latency timing omits stages that were never observed', async () => {
  const { createTelegramLatencyTiming } = await import('../dist-runtime/telegram-latency-timing.js');
  const realNow = Date.now;
  let now = 2_000;
  Date.now = () => now;
  try {
    const timing = createTelegramLatencyTiming();
    now = 2_010;
    assert.deepEqual(timing.snapshot('compat'), {
      route: 'compat',
      total_ms: 10,
    });
  } finally {
    Date.now = realNow;
  }
});

test('production webhook latency log is structured and contains no raw update content', async () => {
  const source = await read('src/live-entry-v2.ts');
  assert.match(source, /createTelegramLatencyTiming/);
  assert.match(source, /Telegram webhook latency v2/);
  assert.doesNotMatch(source, /Telegram webhook handled/);

  const logIndex = source.indexOf('Telegram webhook latency v2');
  const logSlice = source.slice(Math.max(0, logIndex - 200), logIndex + 400);
  for (const forbidden of ['callbackData', 'callback_data', 'message.text', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET']) {
    assert.equal(logSlice.includes(forbidden), false, `latency log must not include ${forbidden}`);
  }
});
