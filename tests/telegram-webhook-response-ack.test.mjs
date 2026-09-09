import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function directCallbackAckResponse(callbackId) {
  return new Response(JSON.stringify({
    method: 'answerCallbackQuery',
    callback_query_id: callbackId,
  }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

test('Telegram direct webhook callback acknowledgement shape is understood by the spike', async () => {
  const response = directCallbackAckResponse('cb-1');
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/i);
  assert.deepEqual(await response.json(), {
    method: 'answerCallbackQuery',
    callback_query_id: 'cb-1',
  });
});

test('v2 intentionally keeps concurrent outbound callback ack instead of direct webhook response ownership', async () => {
  const [liveEntry, fastAck] = await Promise.all([
    read('src/live-entry-v2.ts'),
    read('src/telegram-fast-ack.ts'),
  ]);

  assert.match(fastAck, /answerCallbackQuery/);
  assert.match(fastAck, /ctx\.waitUntil\(promise\)/);
  assert.match(liveEntry, /return await dispatchTelegramWebhook/);
  assert.doesNotMatch(liveEntry, /method:\s*['"]answerCallbackQuery['"]/);

  // Direct webhook ACK would require returning before routed render/mutation completion and
  // moving that remaining work under waitUntil. The v2 design deliberately avoids changing
  // handler ownership/error semantics: outbound ACK starts immediately while the routed
  // business/user-visible work remains awaited by its current owner.
});
