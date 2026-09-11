import previous from './live-entry-v2.js';
import { runChannelMembershipMaintenance } from './channel-membership-access.js';
import { getMultiTeamRollout } from './multi-team-rollout.js';
import { checkRanobeLibAuthAdminAlert } from './ranobelib-auth-alerts.js';
import { DELIVERY_BATCH_LIMIT } from './telegram-notification-delivery.js';
import { drainMultiTeamNotificationOutbox } from './telegram-multi-team-delivery.js';
import { handleTelegramMultiTeamGateway, type TelegramMultiTeamGatewayEnv } from './telegram-multi-team-gateway.js';

type PreviousEnv = Parameters<typeof previous.fetch>[1];
type Env = PreviousEnv & TelegramMultiTeamGatewayEnv;
type FetchContext = Parameters<typeof previous.fetch>[2];
type ScheduledController = Parameters<typeof previous.scheduled>[0];
type QueueBatch = Parameters<typeof previous.queue>[0];

const FAST_SCAN_CRON = '* * * * *';
const FALLBACK_DELIVERY_CRON = '*/5 * * * *';

type NotificationWakeup = { kind: 'drain' };

export default {
  async fetch(request: Request, env: Env, ctx: FetchContext): Promise<Response> {
    const intercepted = await handleTelegramMultiTeamGateway(request, env, ctx);
    if (intercepted) return intercepted;
    return previous.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: FetchContext): Promise<void> {
    if (controller.cron === FAST_SCAN_CRON) {
      try {
        const authAlert = await checkRanobeLibAuthAdminAlert(env);
        if (authAlert.alerted) console.warn('RanobeLib auth admin alert sent', authAlert.reason);
      } catch (error) {
        console.error('RanobeLib auth health check failed', error);
      }
    }

    if (controller.cron !== FALLBACK_DELIVERY_CRON) {
      return previous.scheduled(controller, env, ctx);
    }

    const rollout = await getMultiTeamRollout(env);
    if (!rollout.delivery) {
      return previous.scheduled(controller, env, ctx);
    }

    try {
      const membership = await runChannelMembershipMaintenance(env, 40);
      console.log('Channel membership fast backfill complete', membership);
    } catch (error) {
      console.error('Channel membership fast backfill failed', error);
    }

    const delivery = await drainMultiTeamNotificationOutbox(env, { limit: DELIVERY_BATCH_LIMIT });
    console.log('Telegram multi-team notification fallback delivery complete', delivery);
  },

  async queue(batch: QueueBatch, env: Env, ctx: FetchContext): Promise<void> {
    const rollout = await getMultiTeamRollout(env);
    if (!rollout.delivery) {
      return previous.queue(batch, env, ctx);
    }

    const message = batch.messages[0];
    if (!isDrainWakeup(message?.body)) return;

    const delivery = await drainMultiTeamNotificationOutbox(env, { limit: DELIVERY_BATCH_LIMIT });
    console.log('Telegram multi-team notification Queue delivery complete', delivery);
    if (delivery.hasMoreDue) await queueNotificationWakeup(env);
  },
};

function isDrainWakeup(body: unknown): body is NotificationWakeup {
  return Boolean(body && typeof body === 'object' && (body as { kind?: unknown }).kind === 'drain');
}

async function queueNotificationWakeup(env: Env): Promise<void> {
  try {
    const pending = env.NOTIFICATION_QUEUE?.send({ kind: 'drain' });
    if (pending) await pending;
  } catch (error) {
    console.error('Notification Queue wake-up failed', error);
  }
}
