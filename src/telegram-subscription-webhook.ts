import {
  handleTelegramSubscriptionUpdate,
  sendTelegramSubscriptionMenu,
  type TelegramSubscriptionEnv,
  type TelegramSubscriptionUpdate,
} from './telegram-subscriptions.js';

export interface TelegramSubscriptionWebhookEnv extends TelegramSubscriptionEnv {
  TELEGRAM_WEBHOOK_SECRET?: string;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function isPlainCommand(text: string, command: string): boolean {
  return new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?$`, 'i').test(text.trim());
}

export async function handleTelegramSubscriptionWebhookRequest(
  request: Request,
  env: TelegramSubscriptionWebhookEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;

  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
  if (!expected || request.headers.get('x-telegram-bot-api-secret-token') !== expected) return null;

  const update = await request.clone().json().catch(() => null) as TelegramSubscriptionUpdate | null;
  if (!update) return null;

  if (await handleTelegramSubscriptionUpdate(update, env)) return json({ ok: true });

  const message = update.message;
  const text = (message?.text ?? '').trim();
  if (!message?.chat?.id || message.chat.type !== 'private' || !message.from) return null;
  if (!isPlainCommand(text, 'start') && !isPlainCommand(text, 'subscriptions')) return null;

  await sendTelegramSubscriptionMenu(env, message.from, message.chat.id, 0);
  return json({ ok: true });
}
