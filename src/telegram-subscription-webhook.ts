import {
  handleTelegramSubscriptionUpdate,
  sendTelegramSubscriptionMenu,
  type TelegramSubscriptionEnv,
  type TelegramSubscriptionUpdate,
} from './telegram-subscriptions.js';
import {
  handleNotificationCustomInput,
  handleTelegramNotificationModeUpdate,
} from './telegram-notification-mode-runtime.js';
import {
  handleNotificationSearchInput,
  handleTelegramNotificationUxUpdate,
  sendTelegramNotificationDashboard,
} from './telegram-notification-ux-runtime.js';
import {
  ensureTelegramSubscriptionCatalog,
  withTelegramSubscriptionCatalogDb,
} from './telegram-subscription-catalog.js';
import type { RanobeLibRuntimeEnv } from './ranobelib-runtime.js';
import type { ExecutionContextLike } from './telegram-fast-ack.js';

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

function normalizeSubscriptionCallback(update: TelegramSubscriptionUpdate): TelegramSubscriptionUpdate {
  if (update.callback_query?.data !== 'prop:notifications') return update;
  return {
    ...update,
    callback_query: {
      ...update.callback_query,
      data: 'subs:center',
    },
  };
}

async function prepareCatalog(env: TelegramSubscriptionWebhookEnv): Promise<void> {
  try {
    await ensureTelegramSubscriptionCatalog(env);
  } catch (error) {
    console.error('Telegram subscription catalog bootstrap failed', error);
  }
}

export async function handleTelegramNotificationTextInputRequest(
  request: Request,
  env: TelegramSubscriptionWebhookEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;

  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
  if (!expected || request.headers.get('x-telegram-bot-api-secret-token') !== expected) return null;

  const update = await request.clone().json().catch(() => null) as TelegramSubscriptionUpdate | null;
  if (!update) return null;
  const message = update.message;
  const text = (message?.text ?? '').trim();
  if (!message?.from || !message.chat?.id || message.chat.type !== 'private' || !text) return null;

  if (text.startsWith('/')) return null;

  const subscriptionEnv = withTelegramSubscriptionCatalogDb(env);
  if (await handleNotificationCustomInput(update, subscriptionEnv)) return json({ ok: true });
  if (await handleNotificationSearchInput(update, env)) return json({ ok: true });
  return null;
}

export async function handleTelegramSubscriptionWebhookRequest(
  request: Request,
  env: TelegramSubscriptionWebhookEnv,
  ctx?: ExecutionContextLike,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;

  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
  if (!expected || request.headers.get('x-telegram-bot-api-secret-token') !== expected) return null;

  const update = await request.clone().json().catch(() => null) as TelegramSubscriptionUpdate | null;
  if (!update) return null;

  const subscriptionEnv = withTelegramSubscriptionCatalogDb(env);
  // Telegram callbacks must stay responsive even when RanobeLib is slow or unavailable.
  // The v2 dashboard/title-card/search routes use the raw D1 binding so their
  // snapshot_ready filters are preserved; only legacy subscription routes keep
  // the compatibility DB wrapper that exposes discovered pre-snapshot titles.
  const subscriptionUpdate = normalizeSubscriptionCallback(update);
  if (await handleTelegramNotificationUxUpdate(subscriptionUpdate, env, ctx)) return json({ ok: true });
  if (await handleTelegramNotificationModeUpdate(subscriptionUpdate, subscriptionEnv)) return json({ ok: true });
  if (await handleTelegramSubscriptionUpdate(subscriptionUpdate, subscriptionEnv, ctx)) return json({ ok: true });

  const message = update.message;
  const text = (message?.text ?? '').trim();
  if (!message?.chat?.id || message.chat.type !== 'private') return null;

  // Text-input priority is intentional: custom stack size first, then notification search.
  // Slash commands pass through both handlers so commands keep their normal routing.
  if (await handleNotificationCustomInput(update, subscriptionEnv)) return json({ ok: true });
  if (await handleNotificationSearchInput(update, env)) return json({ ok: true });

  if (message.from && isPlainCommand(text, 'notifications')) {
    await sendTelegramNotificationDashboard(env, message.from, message.chat.id);
    return json({ ok: true });
  }

  if (message.from && isPlainCommand(text, 'subscriptions')) {
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
