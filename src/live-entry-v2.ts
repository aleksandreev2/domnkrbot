import appEntry from './entry.js';
import baseWorker from './live-entry.js';
import {
  handleChannelMembershipAppealAdmin,
  handleChannelMembershipAppealWebhook,
} from './channel-membership-appeals.js';
import {
  ensureWebhookMembershipUpdates,
  handleChannelMembershipWebhook,
  runChannelMembershipMaintenance,
  type ChannelMembershipEnv,
} from './channel-membership-access.js';
import {
  handlePublicationCommentGateRequest,
  handlePublicationCommentGateWebhook,
  type CommentGateExecutionContext,
  type PublicationCommentGateEnv,
} from './publication-comment-gate.js';
import {
  handlePublicationReaderDeliveryWebhook,
  type PublicationReaderDeliveryEnv,
} from './publication-reader-delivery.js';
import {
  handlePublicationFileCachePrewarm,
  type PublicationFileCachePrewarmEnv,
} from './publication-file-cache-prewarm.js';
import {
  handlePublicationReleaseAnalytics,
  type PublicationReleaseAnalyticsEnv,
} from './publication-release-analytics.js';
import { handlePublishingAnalyticsV2, type PublishingAnalyticsV2Env } from './publishing-analytics-v2.js';
import { discoverRanobeLibTeam } from './ranobelib-discovery-scheduler.js';
import {
  FAST_SCAN_LIMIT,
  IDLE_SCAN_LIMIT,
  scanDueRanobeLibTitles,
  scanIdleRanobeLibTitles,
} from './ranobelib-fast-scanner.js';
import { getRanobeLibHome } from './ranobelib-runtime.js';
import { notifyAdminsForProposalId } from './telegram-title-proposal-admin-alert.js';
import {
  DELIVERY_BATCH_LIMIT,
  drainNotificationOutbox,
  type NotificationDeliveryEnv,
} from './telegram-notification-delivery.js';
import { handleTelegramSubscriptionWebhookRequest } from './telegram-subscription-webhook.js';
import { type TelegramSubscriptionEnv } from './telegram-subscriptions.js';
import {
  classifyTelegramWebhookUpdate,
  type TelegramWebhookRoute,
} from './telegram-webhook-routing.js';

interface ScheduledControllerLike { scheduledTime: number; cron: string }

type NotificationWakeup = { kind: 'drain' };
type QueueProducerLike = { send(message: NotificationWakeup): Promise<void> };
type QueueMessageLike = { body: unknown };
type QueueBatchLike = { messages: QueueMessageLike[] };
type TelegramWebhookUpdate = Parameters<typeof classifyTelegramWebhookUpdate>[0];

const FAST_SCAN_CRON = '* * * * *';
const IDLE_SCAN_CRON = '17 */3 * * *';
const DISCOVERY_CRON = '*/30 * * * *';
const FALLBACK_DELIVERY_CRON = '*/5 * * * *';
const MEMBERSHIP_CRON = '0 * * * *';

type Env = PublicationCommentGateEnv
  & PublishingAnalyticsV2Env
  & PublicationReaderDeliveryEnv
  & PublicationFileCachePrewarmEnv
  & PublicationReleaseAnalyticsEnv
  & TelegramSubscriptionEnv
  & ChannelMembershipEnv
  & NotificationDeliveryEnv
  & {
    RANOBELIB_TEAM_REF?: string;
    NOTIFICATION_QUEUE?: QueueProducerLike;
  };

async function queueNotificationWakeup(env: Env): Promise<boolean> {
  try {
    const send = env.NOTIFICATION_QUEUE?.send({ kind: 'drain' });
    if (!send) return false;
    await send;
    return true;
  } catch (error) {
    console.error('Notification Queue wake-up failed', error);
    return false;
  }
}

function parseWakeup(body: unknown): NotificationWakeup | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if (value.kind !== 'drain') return null;
  return { kind: 'drain' };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: CommentGateExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
      const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
      const suppliedSecret = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
      if (!expectedSecret || suppliedSecret !== expectedSecret) {
        return new Response('Forbidden', { status: 403 });
      }

      const startedAt = Date.now();
      const update = await request.clone().json().catch(() => null) as TelegramWebhookUpdate | null;
      if (!update) return new Response('Bad Request', { status: 400 });

      const route = classifyTelegramWebhookUpdate(update);
      const response = await dispatchTelegramWebhook(route, request, env, ctx);
      console.log('Telegram webhook handled', { route, durationMs: Date.now() - startedAt });
      return response;
    }

    // Catalog reads must never start upstream crawling. HOT/IDLE scheduled jobs are the sole
    // automatic chapter-polling owners; this route only exposes the latest D1 snapshot.
    if (request.method === 'GET' && url.pathname === '/api/ranobelib') {
      return json(await getRanobeLibHome(env));
    }

    // Appeals must run before private reader delivery: an already-blacklisted user must see the
    // appeal action instead of reaching a download handler first.
    const membershipAppealWebhook = await handleChannelMembershipAppealWebhook(request, env, ctx);
    if (membershipAppealWebhook) return membershipAppealWebhook;

    const membershipAppealAdmin = await handleChannelMembershipAppealAdmin(request, env);
    if (membershipAppealAdmin) return membershipAppealAdmin;

    const readerDelivery = await handlePublicationReaderDeliveryWebhook(request, env, ctx);
    if (readerDelivery) return readerDelivery;

    const gateWebhook = await handlePublicationCommentGateWebhook(request, env, ctx);
    if (gateWebhook) return gateWebhook;

    const gateRequest = await handlePublicationCommentGateRequest(request, env);
    if (gateRequest) return gateRequest;

    const fileCachePrewarm = await handlePublicationFileCachePrewarm(request, env);
    if (fileCachePrewarm) return fileCachePrewarm;

    const releaseAnalytics = await handlePublicationReleaseAnalytics(request, env);
    if (releaseAnalytics) return releaseAnalytics;

    const analytics = await handlePublishingAnalyticsV2(request, env);
    if (analytics) return analytics;

    // Website proposals are created by the base worker. Alert admins only after a confirmed 201;
    // alert delivery is best-effort and never changes the proposal response itself.
    if (request.method === 'POST' && url.pathname === '/api/proposals') {
      const response = await baseWorker.fetch(request, env as never, ctx as never);
      if (response.status === 201) {
        const created = await response.clone().json().catch(() => null) as { id?: string } | null;
        const proposalId = created?.id;
        if (proposalId) {
          await notifyAdminsForProposalId(env, proposalId).catch((error) => {
            console.error('Web proposal admin alert failed', { proposalId, error });
          });
        }
      }
      return response;
    }

    return baseWorker.fetch(request, env as never, ctx as never);
  },

  async scheduled(controller: ScheduledControllerLike, env: Env, _ctx: CommentGateExecutionContext): Promise<void> {
    if (controller.cron === FAST_SCAN_CRON) {
      const scan = await scanDueRanobeLibTitles(env, { limit: FAST_SCAN_LIMIT });
      if (scan.newReleases > 0) await queueNotificationWakeup(env);
      console.log('RanobeLib fast scan complete', { cron: controller.cron, ...scan });
      return;
    }

    if (controller.cron === IDLE_SCAN_CRON) {
      const idleScan = await scanIdleRanobeLibTitles(env, { limit: IDLE_SCAN_LIMIT });
      if (idleScan.newReleases > 0) await queueNotificationWakeup(env);
      console.log('RanobeLib idle scan complete', { cron: controller.cron, ...idleScan });
      return;
    }

    if (controller.cron === DISCOVERY_CRON) {
      const discovery = await discoverRanobeLibTeam(env);
      console.log('RanobeLib team discovery complete', { cron: controller.cron, ...discovery });
      return;
    }

    if (controller.cron === FALLBACK_DELIVERY_CRON) {
      try {
        const membership = await runChannelMembershipMaintenance(env, 40);
        console.log('Channel membership fast backfill complete', membership);
      } catch (error) {
        console.error('Channel membership fast backfill failed', error);
      }
      const delivery = await drainNotificationOutbox(env, { limit: DELIVERY_BATCH_LIMIT });
      console.log('Telegram notification fallback delivery complete', delivery);
      return;
    }

    if (controller.cron === MEMBERSHIP_CRON) {
      let webhookUpdated = false;
      try {
        webhookUpdated = await ensureWebhookMembershipUpdates(env);
      } catch (error) {
        console.error('Channel membership webhook self-heal failed', error);
      }
      const membership = await runChannelMembershipMaintenance(env, 40);
      console.log('Channel membership maintenance complete', { webhookUpdated, ...membership });
      return;
    }

    console.warn('Unknown scheduled cron ignored', controller.cron);
  },

  async queue(batch: QueueBatchLike, env: Env, _ctx: CommentGateExecutionContext): Promise<void> {
    const message = batch.messages[0];
    const wakeup = parseWakeup(message?.body);
    if (!wakeup) return;

    if (wakeup.kind === 'drain') {
      const delivery = await drainNotificationOutbox(env, { limit: DELIVERY_BATCH_LIMIT });
      console.log('Telegram notification Queue delivery complete', delivery);
      if (delivery.hasMoreDue) await queueNotificationWakeup(env);
    }
  },
};

async function dispatchTelegramWebhook(
  route: TelegramWebhookRoute,
  request: Request,
  env: Env,
  ctx: CommentGateExecutionContext,
): Promise<Response> {
  switch (route) {
    case 'chat-member':
      return (await handleChannelMembershipWebhook(request, env, ctx)) ?? new Response('ok');

    case 'download-start': {
      const appeal = await handleChannelMembershipAppealWebhook(request, env, ctx);
      if (appeal) return appeal;
      return (await handlePublicationReaderDeliveryWebhook(request, env, ctx)) ?? new Response('ok');
    }

    case 'reader-gate':
    case 'reader-forward':
      return (await handlePublicationReaderDeliveryWebhook(request, env, ctx)) ?? new Response('ok');

    case 'membership-appeal':
      return (await handleChannelMembershipAppealWebhook(request, env, ctx)) ?? new Response('ok');

    case 'notifications':
      return (await handleTelegramSubscriptionWebhookRequest(request, env as never)) ?? new Response('ok');

    case 'proposal':
      return appEntry.fetch(request, env as never, ctx);

    case 'generic-private-text': {
      const appeal = await handleChannelMembershipAppealWebhook(request, env, ctx);
      if (appeal) return appeal;
      return appEntry.fetch(request, env as never, ctx);
    }

    case 'compat':
    default:
      return baseWorker.fetch(request, env as never, ctx as never);
  }
}
