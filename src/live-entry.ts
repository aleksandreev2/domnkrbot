import appEntry from './entry';
import {
  ensureRanobeLibSchema,
  getRanobeLibHome,
  shouldKickRanobeLibSync,
  syncRanobeLib,
  type D1DatabaseLike,
} from './ranobelib-runtime.js';
import { handlePublicationArchiveGuard } from './publication-archive-guard.js';
import { handlePublicationLifecycleApi } from './publication-lifecycle.js';
import { handlePublishingDiagnostics } from './publishing-diagnostics.js';
import {
  ensurePublishingDefaults,
  getPublishingReadiness,
  handlePublishingDefaultBootstrap,
  handlePublishingSettingsGuard,
} from './publishing-settings-guard.js';
import { requireAdminSession } from './web-auth.js';

interface AssetFetcher { fetch(request: Request): Promise<Response> }
interface R2ObjectLike { size?: number; httpMetadata?: { contentType?: string }; arrayBuffer(): Promise<ArrayBuffer> }
interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}
interface Env {
  DB: D1DatabaseLike;
  ASSETS: AssetFetcher;
  FILES?: R2BucketLike;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_TELEGRAM_IDS?: string;
  BOT_USERNAME?: string;
  PUBLISH_CHANNEL_ID?: string;
  WEBHOOK_URL?: string;
  RANOBELIB_TEAM_REF?: string;
  RANOBELIB_SYNC_BATCH_SIZE?: string;
}
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
interface ScheduledControllerLike {
  scheduledTime: number;
  cron: string;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
let publishingDefaultsPromise: Promise<void> | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function kickPublishingDefaults(env: Env, ctx: ExecutionContextLike): void {
  if (!env.PUBLISH_CHANNEL_ID || publishingDefaultsPromise) return;
  publishingDefaultsPromise = ensurePublishingDefaults(env)
    .then(() => undefined)
    .catch((error) => {
      publishingDefaultsPromise = null;
      console.error('Publishing target bootstrap failed', error);
    });
  ctx.waitUntil(publishingDefaultsPromise);
}

async function handleManualRanobeSync(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;

  try {
    await ensureRanobeLibSchema(env);
    const result = await syncRanobeLib(env);
    const home = await getRanobeLibHome(env);
    return json({ ok: true, result, sync: home.sync, stats: home.stats });
  } catch (error) {
    console.error('Manual RanobeLib sync failed', error);
    return json({ error: error instanceof Error ? error.message : 'RanobeLib sync failed' }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      try {
        await ensurePublishingDefaults(env);
        publishingDefaultsPromise = Promise.resolve();
      } catch (error) {
        console.error('Publishing readiness check failed', error);
      }
      const publishing = await getPublishingReadiness(env).catch((error) => {
        console.error('Publishing readiness state failed', error);
        return { channelReady: false, discussionReady: false };
      });
      return json({
        ok: true,
        service: 'domnkrbot',
        storageReady: Boolean(env.FILES),
        publishingChannelReady: publishing.channelReady,
        publishingDiscussionReady: publishing.discussionReady,
        time: new Date().toISOString(),
      });
    }

    kickPublishingDefaults(env, ctx);

    const publishingDiagnosticsResponse = await handlePublishingDiagnostics(request, env);
    if (publishingDiagnosticsResponse) return publishingDiagnosticsResponse;

    const publishingSettingsResponse = await handlePublishingSettingsGuard(request, env);
    if (publishingSettingsResponse) return publishingSettingsResponse;

    const publishingBootstrapResponse = await handlePublishingDefaultBootstrap(request, env);
    if (publishingBootstrapResponse) return publishingBootstrapResponse;

    const publicationArchiveResponse = await handlePublicationArchiveGuard(request, env);
    if (publicationArchiveResponse) return publicationArchiveResponse;

    const publicationLifecycleResponse = await handlePublicationLifecycleApi(request, env);
    if (publicationLifecycleResponse) return publicationLifecycleResponse;

    if (url.pathname === '/api/admin/ranobelib/sync') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      return handleManualRanobeSync(request, env);
    }

    if (url.pathname === '/api/ranobelib') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      try {
        await ensureRanobeLibSchema(env);
        if (await shouldKickRanobeLibSync(env)) {
          ctx.waitUntil(syncRanobeLib(env).catch((error) => {
            console.error('RanobeLib background sync failed', error);
          }));
        }
        return json(await getRanobeLibHome(env));
      } catch (error) {
        console.error('RanobeLib API failed', error);
        return json({ error: error instanceof Error ? error.message : 'RanobeLib sync failed' }, 500);
      }
    }

    return appEntry.fetch(request, env);
  },

  async scheduled(controller: ScheduledControllerLike, env: Env, _ctx: ExecutionContextLike): Promise<void> {
    try {
      await ensurePublishingDefaults(env);
    } catch (error) {
      console.error('Publishing target cron bootstrap failed', error);
    }

    try {
      await ensureRanobeLibSchema(env);
      const result = await syncRanobeLib(env);
      console.log('RanobeLib cron sync complete', {
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        discovered: result.discovered,
        processed: result.processed,
        succeeded: result.succeeded,
        failed: result.failed,
        newReleases: result.newReleases,
        nextCursor: result.nextCursor,
      });
    } catch (error) {
      console.error('RanobeLib cron sync failed', error);
      throw error;
    }
  },
};
