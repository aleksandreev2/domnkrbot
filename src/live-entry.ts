import appEntry from './entry';
import {
  ensureRanobeLibSchema,
  getRanobeLibHome,
  shouldKickRanobeLibSync,
  syncRanobeLib,
  type D1DatabaseLike,
} from './ranobelib-runtime.js';

interface AssetFetcher { fetch(request: Request): Promise<Response> }
interface Env {
  DB: D1DatabaseLike;
  ASSETS: AssetFetcher;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_TELEGRAM_IDS?: string;
  BOT_USERNAME?: string;
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);

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
