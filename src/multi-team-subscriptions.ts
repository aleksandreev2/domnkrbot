import type { D1DatabaseLike } from './ranobelib-runtime.js';
import {
  getGlobalDeliverySetting,
  normalizeDeliverySetting,
  type DeliverySetting,
} from './telegram-notification-settings.js';

export type MultiTeamSubscriptionEnv = { DB: D1DatabaseLike };

export type EffectiveTeamTitleSubscription = {
  enabled: boolean;
  reason: 'excluded' | 'team' | 'explicit' | 'none';
};

export type EffectiveTeamTitleDeliverySetting = {
  setting: DeliverySetting;
  inherited: boolean;
};

type SubscriptionStateRow = {
  team_followed: number | string | null;
  explicit: number | string | null;
  excluded: number | string | null;
};

type DeliveryRow = {
  delivery_mode: unknown;
  stack_size: unknown;
};

export function resolveTeamTitleSubscription(state: {
  teamFollowed: boolean;
  explicit: boolean;
  excluded: boolean;
}): EffectiveTeamTitleSubscription {
  if (state.excluded) return { enabled: false, reason: 'excluded' };
  if (state.teamFollowed) return { enabled: true, reason: 'team' };
  if (state.explicit) return { enabled: true, reason: 'explicit' };
  return { enabled: false, reason: 'none' };
}

export async function getEffectiveTeamTitleSubscription(
  env: MultiTeamSubscriptionEnv,
  userId: string,
  teamId: number,
  bookRef: string,
): Promise<EffectiveTeamTitleSubscription> {
  const row = await env.DB.prepare(`
    SELECT
      EXISTS(
        SELECT 1 FROM telegram_team_subscriptions
        WHERE user_telegram_id = ? AND team_id = ?
      ) AS team_followed,
      EXISTS(
        SELECT 1 FROM telegram_team_title_subscriptions
        WHERE user_telegram_id = ? AND team_id = ? AND book_ref = ?
      ) AS explicit,
      EXISTS(
        SELECT 1 FROM telegram_team_title_exclusions
        WHERE user_telegram_id = ? AND team_id = ? AND book_ref = ?
      ) AS excluded
  `).bind(userId, teamId, userId, teamId, bookRef, userId, teamId, bookRef)
    .first<SubscriptionStateRow>();
  return resolveTeamTitleSubscription({
    teamFollowed: Number(row?.team_followed ?? 0) === 1,
    explicit: Number(row?.explicit ?? 0) === 1,
    excluded: Number(row?.excluded ?? 0) === 1,
  });
}

export async function isEffectivelySubscribedToTeamTitle(
  env: MultiTeamSubscriptionEnv,
  userId: string,
  teamId: number,
  bookRef: string,
): Promise<boolean> {
  return (await getEffectiveTeamTitleSubscription(env, userId, teamId, bookRef)).enabled;
}

export async function setTeamSubscription(
  env: MultiTeamSubscriptionEnv,
  userId: string,
  teamId: number,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO telegram_team_subscriptions (user_telegram_id, team_id)
      VALUES (?, ?)
    `).bind(userId, teamId).run();
    return;
  }
  await env.DB.prepare(`
    DELETE FROM telegram_team_subscriptions
    WHERE user_telegram_id = ? AND team_id = ?
  `).bind(userId, teamId).run();
}

export async function setTeamTitleSubscription(
  env: MultiTeamSubscriptionEnv,
  userId: string,
  teamId: number,
  bookRef: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO telegram_team_title_subscriptions (
        user_telegram_id, team_id, book_ref
      ) VALUES (?, ?, ?)
    `).bind(userId, teamId, bookRef).run();
    return;
  }
  await env.DB.prepare(`
    DELETE FROM telegram_team_title_subscriptions
    WHERE user_telegram_id = ? AND team_id = ? AND book_ref = ?
  `).bind(userId, teamId, bookRef).run();
}

export async function setTeamTitleExclusion(
  env: MultiTeamSubscriptionEnv,
  userId: string,
  teamId: number,
  bookRef: string,
  excluded: boolean,
): Promise<void> {
  if (excluded) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO telegram_team_title_exclusions (
        user_telegram_id, team_id, book_ref
      ) VALUES (?, ?, ?)
    `).bind(userId, teamId, bookRef).run();
    return;
  }
  await env.DB.prepare(`
    DELETE FROM telegram_team_title_exclusions
    WHERE user_telegram_id = ? AND team_id = ? AND book_ref = ?
  `).bind(userId, teamId, bookRef).run();
}

/**
 * UI-friendly mutation. Whole-team follows toggle an exclusion; non-team follows toggle the
 * explicit team-title row. This prevents duplicate state machines in Telegram callback handlers.
 */
export async function setEffectiveTeamTitleSubscription(
  env: MultiTeamSubscriptionEnv,
  userId: string,
  teamId: number,
  bookRef: string,
  enabled: boolean,
): Promise<void> {
  const current = await getEffectiveTeamTitleSubscription(env, userId, teamId, bookRef);
  const teamFollowed = current.reason === 'team' || current.reason === 'excluded';

  if (teamFollowed) {
    await setTeamTitleExclusion(env, userId, teamId, bookRef, !enabled);
    return;
  }

  if (enabled) {
    await setTeamTitleExclusion(env, userId, teamId, bookRef, false);
    await setTeamTitleSubscription(env, userId, teamId, bookRef, true);
  } else {
    await setTeamTitleSubscription(env, userId, teamId, bookRef, false);
    await setTeamTitleExclusion(env, userId, teamId, bookRef, false);
  }
}

export async function getEffectiveTeamTitleDeliverySetting(
  env: MultiTeamSubscriptionEnv,
  userId: string,
  teamId: number,
  bookRef: string,
): Promise<EffectiveTeamTitleDeliverySetting> {
  const row = await env.DB.prepare(`
    SELECT delivery_mode, stack_size
    FROM telegram_team_title_delivery_settings
    WHERE user_telegram_id = ? AND team_id = ? AND book_ref = ?
    LIMIT 1
  `).bind(userId, teamId, bookRef).first<DeliveryRow>();
  if (row) {
    return {
      setting: normalizeDeliverySetting(row.delivery_mode, row.stack_size),
      inherited: false,
    };
  }
  return {
    setting: await getGlobalDeliverySetting(env, userId),
    inherited: true,
  };
}

export async function setTeamTitleDeliverySetting(
  env: MultiTeamSubscriptionEnv,
  userId: string,
  teamId: number,
  bookRef: string,
  setting: DeliverySetting,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO telegram_team_title_delivery_settings (
      user_telegram_id, team_id, book_ref, delivery_mode, stack_size, updated_at
    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id, team_id, book_ref) DO UPDATE SET
      delivery_mode = excluded.delivery_mode,
      stack_size = excluded.stack_size,
      updated_at = CURRENT_TIMESTAMP
  `).bind(userId, teamId, bookRef, setting.mode, setting.stackSize).run();
}

export async function clearTeamTitleDeliverySetting(
  env: MultiTeamSubscriptionEnv,
  userId: string,
  teamId: number,
  bookRef: string,
): Promise<void> {
  await env.DB.prepare(`
    DELETE FROM telegram_team_title_delivery_settings
    WHERE user_telegram_id = ? AND team_id = ? AND book_ref = ?
  `).bind(userId, teamId, bookRef).run();
}

export async function countConfiguredNotificationSubscriptions(
  env: MultiTeamSubscriptionEnv,
  userId: string,
): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT (
      (SELECT COUNT(*) FROM telegram_team_subscriptions WHERE user_telegram_id = ?)
      + (SELECT COUNT(*) FROM telegram_team_title_subscriptions WHERE user_telegram_id = ?)
    ) AS count
  `).bind(userId, userId).first<{ count: number | string | null }>();
  const value = Number(row?.count ?? 0);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
