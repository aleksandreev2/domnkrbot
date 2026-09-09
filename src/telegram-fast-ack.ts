export type TelegramFastAckEnv = {
  TELEGRAM_BOT_TOKEN?: string;
};

export type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

export function startCallbackAck(
  env: TelegramFastAckEnv,
  callbackId: string,
  ctx?: ExecutionContextLike,
  text?: string,
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const id = String(callbackId ?? '').trim();
  if (!token || !id) return Promise.resolve();

  const promise = fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, ...(text ? { text } : {}) }),
  }).then(async (response) => {
    const body = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (!response.ok || !body?.ok) {
      throw new Error(body?.description || `Telegram answerCallbackQuery failed with HTTP ${response.status}`);
    }
  }).catch((error) => {
    console.error('Telegram callback acknowledgement failed', error);
  });

  if (ctx) ctx.waitUntil(promise);
  return promise;
}
