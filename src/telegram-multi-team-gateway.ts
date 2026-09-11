import { getMultiTeamRollout } from './multi-team-rollout.js';
import type { D1DatabaseLike } from './ranobelib-runtime.js';
import {
  handleTelegramPartnerCollaboration,
  sendPartnerAwareMainMenu,
} from './telegram-partner-collaboration-runtime.js';
import { handleTelegramTeamAdmin, type TelegramTeamAdminEnv } from './telegram-team-admin.js';
import {
  handleTelegramTeamNotification,
  upsertMultiTeamTelegramUser,
  type TeamNotificationExecutionContext,
} from './telegram-team-notification-runtime.js';
import {
  handleTelegramTeamOnboarding,
  maybeSendTeamOnboarding,
  shouldOfferTeamOnboarding,
} from './telegram-team-onboarding.js';
import type { TelegramSubscriptionUpdate } from './telegram-subscriptions.js';

export type TelegramMultiTeamGatewayEnv = TelegramTeamAdminEnv & {
  DB: D1DatabaseLike;
  TELEGRAM_WEBHOOK_SECRET?: string;
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export async function handleTelegramMultiTeamGateway(
  request: Request,
  env: TelegramMultiTeamGatewayEnv,
  ctx?: TeamNotificationExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;
  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
  if (!expected || request.headers.get('x-telegram-bot-api-secret-token') !== expected) return null;

  const update = await request.clone().json().catch(() => null) as TelegramSubscriptionUpdate | null;
  if (!update) return null;
  const userId = Number(update.callback_query?.from?.id ?? update.message?.from?.id);

  // Team administration is an operator surface, not a public-rollout feature. Keeping it outside
  // the UI flag lets admins prepare hidden teams and recommendation metadata before users see them.
  if (isAdmin(env, userId) && await handleTelegramTeamAdmin(update, env)) return ok();

  const rollout = await getMultiTeamRollout(env);
  if (!rollout.ui) return null;

  if (await handleTelegramTeamOnboarding(update, env)) return ok();

  const message = update.message;
  const text = String(message?.text ?? '').trim();
  if (message?.from && message.chat?.type === 'private' && /^\/start(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
    const configuredUserId = String(message.from.id);
    if (await shouldOfferTeamOnboarding(env, configuredUserId, rollout.ui)) {
      // Do not write user state or touch recommendation channels for configured users. New/empty
      // users take this branch only after the cheap configured-subscription check succeeds.
      await upsertMultiTeamTelegramUser(env, message.from);
      if (await maybeSendTeamOnboarding(env, message.from, message.chat.id, rollout.ui)) return ok();
    }
    // Once multi-team UI is enabled, /start must visibly keep Дом Некроманта as the owner while
    // exposing partner collaborations. The legacy main menu remains the fallback while UI is off.
    if (await sendPartnerAwareMainMenu(update, env, url.origin, ctx)) return ok();
  }

  // Collaboration navigation owns the high-level notification/catalog/team screens. Deep title
  // search/settings flows continue through the established multi-team runtime below.
  if (await handleTelegramPartnerCollaboration(update, env, url.origin, ctx)) return ok();
  if (await handleTelegramTeamNotification(update, env, ctx)) return ok();
  return null;
}

function isAdmin(env: TelegramMultiTeamGatewayEnv, userId: number): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  return String(env.ADMIN_TELEGRAM_IDS ?? '').split(/[,\s]+/).some((value) => Number(value) === userId);
}

function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
}
