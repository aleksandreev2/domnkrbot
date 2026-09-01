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
  await env.DB.prepare('DROP TRIGGER IF EXISTS trg_ranobelib_release_notifications').run();
  await env.DB.prepare(`
    CREATE TRIGGER IF NOT EXISTS trg_ranobelib_release_notifications
    AFTER INSERT ON ranobelib_releases
    BEGIN
      INSERT OR IGNORE INTO ranobelib_notification_outbox (release_id, user_telegram_id)
      SELECT NEW.id, s.user_telegram_id
      FROM telegram_subscription_settings s
      WHERE s.all_titles = 1
        AND NOT EXISTS (
          SELECT 1
          FROM title_subscription_exclusions e
          WHERE e.user_telegram_id = s.user_telegram_id
            AND e.book_ref = NEW.book_ref
        )
      UNION
      SELECT NEW.id, ts.user_telegram_id
      FROM title_subscriptions ts
      WHERE ts.book_ref = NEW.book_ref
        AND NOT EXISTS (
          SELECT 1
          FROM telegram_subscription_settings s
          WHERE s.user_telegram_id = ts.user_telegram_id
            AND s.all_titles = 1
        );
    END
  `).run();
}
