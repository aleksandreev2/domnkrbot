import {
  handleTelegramSubscriptionUpdate,
  sendTelegramNotificationCenter,
  sendTelegramSubscriptionMenu,
  type TelegramSubscriptionEnv,
  type TelegramSubscriptionUpdate,
} from './telegram-subscriptions.js';
import {
  ensureTelegramSubscriptionCatalog,
  withTelegramSubscriptionCatalogDb,
} from './telegram-subscription-catalog.js';
import type { RanobeLibRuntimeEnv } from './ranobelib-runtime.js';

export type TelegramSubscriptionWebhookEnv = TelegramSubscriptionEnv & RanobeLibRuntimeEnv & {
  TELEGRAM_WEBHOOK_SECRET?: string;
};

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

function isLegacyExplicitCommand(text: string): boolean {
  const command = text.trim().toLowerCase();
  return command.startsWith('/start')
    || command.startsWith('/site')
    || command.startsWith('/propose')
    || command.startsWith('/help');
}

async function prepareCatalog(env: TelegramSubscriptionWebhookEnv): Promise<void> {
  try {
    await ensureTelegramSubscriptionCatalog(env);
  } catch (error) {
    console.error('Telegram subscription catalog bootstrap failed', error);
  }
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

  const subscriptionEnv = withTelegramSubscriptionCatalogDb(env);
  if (update.callback_query?.data?.startsWith('subs:')) await prepareCatalog(env);
  if (await handleTelegramSubscriptionUpdate(update, subscriptionEnv)) return json({ ok: true });

  const message = update.message;
  const text = (message?.text ?? '').trim();
  if (!message?.chat?.id || message.chat.type !== 'private') return null;

  if (message.from && isPlainCommand(text, 'notifications')) {
    await sendTelegramNotificationCenter(subscriptionEnv, message.from, message.chat.id);
    return json({ ok: true });
  }

  if (message.from && (isPlainCommand(text, 'start') || isPlainCommand(text, 'subscriptions'))) {
    await prepareCatalog(env);
    await sendTelegramSubscriptionMenu(subscriptionEnv, message.from, message.chat.id, 0);
    return json({ ok: true });
  }

  // Existing explicit bot flows still belong to the legacy handlers. Everything else in
  // private chat is acknowledged here so the legacy catch-all cannot answer every message
  // with the generic website button.
  if (isLegacyExplicitCommand(text)) return null;
  return json({ ok: true });
}
