import assert from 'node:assert/strict';
import test from 'node:test';

import { startCallbackAck } from '../dist-runtime/telegram-fast-ack.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('startCallbackAck starts Telegram acknowledgement immediately and registers it with waitUntil', async () => {
  const responseGate = deferred();
  const calls = [];
  const scheduled = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responseGate.promise;
  };

  try {
    const ctx = { waitUntil(promise) { scheduled.push(promise); } };
    const ack = startCallbackAck({ TELEGRAM_BOT_TOKEN: 'token' }, 'cb-1', ctx);

    assert.equal(calls.length, 1, 'Telegram request must start synchronously when helper is called');
    assert.match(calls[0].url, /\/answerCallbackQuery$/);
    assert.equal(scheduled.length, 1, 'ack promise must be registered with waitUntil');
    assert.equal(scheduled[0], ack, 'helper must return the same promise it schedules');

    const payload = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(payload, { callback_query_id: 'cb-1' });

    responseGate.resolve(Response.json({ ok: true, result: true }));
    await ack;
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('startCallbackAck treats Telegram acknowledgement failure as non-fatal', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: false, description: 'temporary Telegram failure' }, { status: 502 });

  try {
    const scheduled = [];
    const ack = startCallbackAck(
      { TELEGRAM_BOT_TOKEN: 'token' },
      'cb-2',
      { waitUntil(promise) { scheduled.push(promise); } },
      'Принято',
    );
    assert.equal(scheduled.length, 1);
    await assert.doesNotReject(() => ack);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
