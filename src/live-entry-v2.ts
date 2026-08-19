import baseWorker from './live-entry.js';
import {
  handlePublicationCommentGateRequest,
  handlePublicationCommentGateWebhook,
  type CommentGateExecutionContext,
  type PublicationCommentGateEnv,
} from './publication-comment-gate.js';
import { handlePublishingAnalyticsV2, type PublishingAnalyticsV2Env } from './publishing-analytics-v2.js';

interface ScheduledControllerLike { scheduledTime: number; cron: string }

type Env = PublicationCommentGateEnv & PublishingAnalyticsV2Env;

export default {
  async fetch(request: Request, env: Env, ctx: CommentGateExecutionContext): Promise<Response> {
    const gateWebhook = await handlePublicationCommentGateWebhook(request, env, ctx);
    if (gateWebhook) return gateWebhook;

    const gateRequest = await handlePublicationCommentGateRequest(request, env);
    if (gateRequest) return gateRequest;

    const analytics = await handlePublishingAnalyticsV2(request, env);
    if (analytics) return analytics;

    return baseWorker.fetch(request, env as never, ctx as never);
  },

  async scheduled(controller: ScheduledControllerLike, env: Env, ctx: CommentGateExecutionContext): Promise<void> {
    await baseWorker.scheduled(controller as never, env as never, ctx as never);
  },
};
