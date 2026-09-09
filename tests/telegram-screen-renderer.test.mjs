import assert from 'node:assert/strict';
import test from 'node:test';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const payload = {
  text: '<b>Новый экран</b>',
  parse_mode: 'HTML',
  reply_markup: { inline_keyboard: [] },
};

test('replace sends the new screen before scheduling deletion of the old message', async () => {
  const { renderTelegramScreen } = await import('../dist-runtime/telegram-screen-renderer.js');
  const send = deferred();
  const calls = [];
  const scheduled = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    if (method === 'sendMessage') return send.promise;
    if (method === 'deleteMessage') return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    throw new Error(`unexpected method ${method}`);
  };
  try {
    const renderPromise = renderTelegramScreen(
      { TELEGRAM_BOT_TOKEN: 'token' },
      { chatId: 10, messageId: 20 },
      payload,
      { strategy: 'replace', ctx: { waitUntil(promise) { scheduled.push(promise); } } },
    );

    await Promise.resolve();
    assert.deepEqual(calls.map((call) => call.method), ['sendMessage']);
    assert.equal(scheduled.length, 0, 'old-message deletion must not be scheduled before new send succeeds');

    send.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 }));
    const result = await renderPromise;
    assert.equal(result.messageId, 99);
    assert.deepEqual(calls.map((call) => call.method), ['sendMessage', 'deleteMessage']);
    assert.equal(scheduled.length, 1, 'successful replace must schedule best-effort delete');
    await scheduled[0];
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('replace preserves the old screen when sendMessage fails', async () => {
  const { renderTelegramScreen } = await import('../dist-runtime/telegram-screen-renderer.js');
  const calls = [];
  const scheduled = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const method = String(url).split('/').at(-1);
    calls.push(method);
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({ ok: false, description: 'send failed' }), { status: 500 });
    }
    throw new Error('deleteMessage must not be called after failed send');
  };
  try {
    await assert.rejects(
      renderTelegramScreen(
        { TELEGRAM_BOT_TOKEN: 'token' },
        { chatId: 10, messageId: 20 },
        payload,
        { strategy: 'replace', ctx: { waitUntil(promise) { scheduled.push(promise); } } },
      ),
      /send failed/,
    );
    assert.deepEqual(calls, ['sendMessage']);
    assert.equal(scheduled.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('edit uses one editMessageText request and returns the existing message id', async () => {
  const { renderTelegramScreen } = await import('../dist-runtime/telegram-screen-renderer.js');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split('/').at(-1), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 20 } }), { status: 200 });
  };
  try {
    const result = await renderTelegramScreen(
      { TELEGRAM_BOT_TOKEN: 'token' },
      { chatId: 10, messageId: 20 },
      payload,
      { strategy: 'edit' },
    );
    assert.equal(result.messageId, 20);
    assert.deepEqual(calls.map((call) => call.method), ['editMessageText']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('background delete failure is non-fatal after a successful replacement', async () => {
  const { renderTelegramScreen } = await import('../dist-runtime/telegram-screen-renderer.js');
  const scheduled = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const method = String(url).split('/').at(-1);
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 21 } }), { status: 200 });
    }
    if (method === 'deleteMessage') {
      return new Response(JSON.stringify({ ok: false, description: 'cannot delete' }), { status: 400 });
    }
    throw new Error(`unexpected method ${method}`);
  };
  try {
    const result = await renderTelegramScreen(
      { TELEGRAM_BOT_TOKEN: 'token' },
      { chatId: 10, messageId: 20 },
      payload,
      { strategy: 'replace', ctx: { waitUntil(promise) { scheduled.push(promise); } } },
    );
    assert.equal(result.messageId, 21);
    await assert.doesNotReject(scheduled[0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
