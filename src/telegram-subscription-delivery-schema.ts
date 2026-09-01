import { ensureRanobeLibSchema, type RanobeLibRuntimeEnv } from './ranobelib-runtime.js';
import {
  ensureTelegramSubscriptionSchema,
  type TelegramSubscriptionEnv,
} from './telegram-subscriptions.js';

type Env = RanobeLibRuntimeEnv & TelegramSubscriptionEnv;

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
  await ensureRanobeLibSchema(env);
  await ensureTelegramSubscriptionSchema(env);
  await env.DB.prepare(`
    CREATE TRIGGER IF NOT EXISTS trg_ranobelib_release_notifications
    AFTER INSERT ON ranobelib_releases
    BEGIN
      INSERT OR IGNORE INTO ranobelib_notification_outbox (release_id, user_telegram_id)
      SELECT NEW.id, user_telegram_id
      FROM telegram_subscription_settings
      WHERE all_titles = 1
      UNION
      SELECT NEW.id, user_telegram_id
      FROM title_subscriptions
      WHERE book_ref = NEW.book_ref;
    END
  `).run();
}
