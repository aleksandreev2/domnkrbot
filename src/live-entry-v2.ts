import baseWorker from './live-entry.js';
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
import { runRanobeLibDiagnostic } from './ranobelib-diagnostic.js';
import { ensureTelegramSubscriptionDeliverySchema } from './telegram-subscription-delivery-schema.js';
import {
  deliverPendingReleaseNotifications,
  type TelegramSubscriptionEnv,
} from './telegram-subscriptions.js';

interface ScheduledControllerLike { scheduledTime: number; cron: string }

type Env = PublicationCommentGateEnv
  & PublishingAnalyticsV2Env
  & PublicationReaderDeliveryEnv
  & PublicationFileCachePrewarmEnv
  & PublicationReleaseAnalyticsEnv
  & TelegramSubscriptionEnv;

export default {
  async fetch(request: Request, env: Env, ctx: CommentGateExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/diag/ranobelib') {
      return Response.json(await runRanobeLibDiagnostic(env), {
        headers: { 'cache-control': 'no-store' },
      });
    }

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

  async scheduled(controller: ScheduledControllerLike, env: Env, ctx: CommentGateExecutionContext): Promise<void> {
    let baseError: unknown = null;
    try {
      // The release fan-out trigger must exist before RanobeLib sync inserts a release.
      await ensureTelegramSubscriptionDeliverySchema(env);
      await baseWorker.scheduled(controller as never, env as never, ctx as never);
    } catch (error) {
      baseError = error;
    }

    try {
      const delivery = await deliverPendingReleaseNotifications(env, 40);
      console.log('RanobeLib Telegram notification delivery complete', delivery);
    } catch (error) {
      console.error('RanobeLib Telegram notification delivery failed', error);
    }

    if (baseError) throw baseError;
  },
};
