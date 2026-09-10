import previous from './live-entry-v2.js';
import { handleTelegramMultiTeamGateway, type TelegramMultiTeamGatewayEnv } from './telegram-multi-team-gateway.js';

type PreviousEnv = Parameters<typeof previous.fetch>[1];
type Env = PreviousEnv & TelegramMultiTeamGatewayEnv;
type FetchContext = Parameters<typeof previous.fetch>[2];
type ScheduledController = Parameters<typeof previous.scheduled>[0];
type QueueBatch = Parameters<typeof previous.queue>[0];

export default {
  async fetch(request: Request, env: Env, ctx: FetchContext): Promise<Response> {
    const intercepted = await handleTelegramMultiTeamGateway(request, env, ctx);
    if (intercepted) return intercepted;
    return previous.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: FetchContext): Promise<void> {
    return previous.scheduled(controller, env, ctx);
  },

  async queue(batch: QueueBatch, env: Env, ctx: FetchContext): Promise<void> {
    return previous.queue(batch, env, ctx);
  },
};
