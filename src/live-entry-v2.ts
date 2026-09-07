import baseWorker from './live-entry.js';
import {
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
import { FAST_SCAN_LIMIT, scanDueRanobeLibTitles } from './ranobelib-fast-scanner.js';
import {
  DELIVERY_BATCH_LIMIT,
  drainNotificationOutbox,
  type NotificationDeliveryEnv,
} from './telegram-notification-delivery.js';
import { type TelegramSubscriptionEnv } from './telegram-subscriptions.js';

interface ScheduledControllerLike { scheduledTime: number; cron: string }

type NotificationWakeup = { kind: 'drain'; releaseId?: string };
type QueueProducerLike = { send(message: NotificationWakeup): Promise<void> };
type QueueMessageLike = { body: unknown };
type QueueBatchLike = { messages: QueueMessageLike[] };

const FAST_SCAN_CRON = '* * * * *';
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

async function queueNotificationWakeup(env: Env, releaseId?: string): Promise<boolean> {
  const send = env.NOTIFICATION_QUEUE?.send({
    kind: 'drain',
    ...(releaseId ? { releaseId } : {}),
  });
  if (!send) return false;
  try {
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
  const releaseId = typeof value.releaseId === 'string' ? value.releaseId.trim() : '';
  return { kind: 'drain', ...(releaseId ? { releaseId } : {}) };
}

export default {
  async fetch(request: Request, env: Env, ctx: CommentGateExecutionContext): Promise<Response> {
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

    return baseWorker.fetch(request, env as never, ctx as never);
  },

  async scheduled(controller: ScheduledControllerLike, env: Env, _ctx: CommentGateExecutionContext): Promise<void> {
    if (controller.cron === FAST_SCAN_CRON) {
      const scan = await scanDueRanobeLibTitles(env, {
        limit: FAST_SCAN_LIMIT,
        onRelease: async (releaseId) => {
          await queueNotificationWakeup(env, releaseId);
        },
      });
      console.log('RanobeLib fast scan complete', { cron: controller.cron, ...scan });
      return;
    }

    if (controller.cron === DISCOVERY_CRON) {
      const discovery = await discoverRanobeLibTeam(env);
      console.log('RanobeLib team discovery complete', { cron: controller.cron, ...discovery });
      return;
    }

    if (controller.cron === FALLBACK_DELIVERY_CRON) {
      const delivery = await drainNotificationOutbox(env, { limit: DELIVERY_BATCH_LIMIT });
      console.log('Telegram notification fallback delivery complete', delivery);
      return;
    }

    if (controller.cron === MEMBERSHIP_CRON) {
      const membership = await runChannelMembershipMaintenance(env, 20);
      console.log('Channel membership maintenance complete', membership);
      return;
    }

    console.warn('Unknown scheduled cron ignored', controller.cron);
  },

  async queue(batch: QueueBatchLike, env: Env, _ctx: CommentGateExecutionContext): Promise<void> {
    const message = batch.messages[0];
    const wakeup = parseWakeup(message?.body);
    if (!wakeup) return;

    if (wakeup.kind === 'drain') {
      const releaseId = wakeup.releaseId;
      const delivery = await drainNotificationOutbox(env, {
        limit: DELIVERY_BATCH_LIMIT,
        ...(releaseId ? { releaseId } : {}),
      });
      console.log('Telegram notification Queue delivery complete', { releaseId, ...delivery });
      if (delivery.claimed >= DELIVERY_BATCH_LIMIT) {
        await queueNotificationWakeup(env);
      }
    }
  },
};