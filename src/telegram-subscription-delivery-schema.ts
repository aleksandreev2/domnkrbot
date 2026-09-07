import { ensureRanobeLibSchema, type RanobeLibRuntimeEnv } from './ranobelib-runtime.js';
import {
  ensureTelegramNotificationSettingsSchema,
  type TelegramNotificationSettingsEnv,
} from './telegram-notification-settings.js';
import {
  ensureTelegramSubscriptionSchema,
  type TelegramSubscriptionEnv,
} from './telegram-subscriptions.js';

type Env = RanobeLibRuntimeEnv & TelegramSubscriptionEnv & TelegramNotificationSettingsEnv;

let deliverySchemaPromise: Promise<void> | null = null;

export async function ensureTelegramSubscriptionDeliverySchema(env: Env): Promise<void> {
  if (!deliverySchemaPromise) {
    deliverySchemaPromise = initializeDeliverySchema(env).catch((error) => {
      deliverySchemaPromise = null;
      throw error;
    });
  }
  return deliverySchemaPromise;
}

async function initializeDeliverySchema(env: Env): Promise<void> {
  // Tables/columns can still self-heal for legacy entry points, but the release fan-out
  // trigger is migration-owned in Notifications v3. Ordinary delivery must never mutate it.
  await ensureRanobeLibSchema(env);
  await ensureTelegramSubscriptionSchema(env);
  await ensureTelegramNotificationSettingsSchema(env);
}
