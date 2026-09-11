import type { D1DatabaseLike } from './ranobelib-runtime.js';
import { refreshAllWorkNotificationDemand } from './multi-team-notification-demand.js';
import { mainMenuButton, type TelegramPayload } from './telegram-bot-ui.js';
import type { TelegramSubscriptionUpdate } from './telegram-subscriptions.js';

export type TeamOnboardingEnv = {
  DB: D1DatabaseLike;
  TELEGRAM_BOT_TOKEN?: string;
};

export type OnboardingTeam = {
  id: number;
  displayName: string;
  isPrimary: boolean;
  recommended: boolean;
};

type TelegramMember = { status?: string; is_member?: boolean };
type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string };

export function shouldOfferTeamOnboardingFromState(state: {
  uiEnabled: boolean;
  completed: boolean;
  configuredSubscriptions: number;
}): boolean {
  return state.uiEnabled && !state.completed && Math.max(0, Number(state.configuredSubscriptions) || 0) === 0;
}

export function buildTeamOnboardingScreen(teams: OnboardingTeam[]): TelegramPayload {
  const ordered = [...teams].sort((a, b) =>
    Number(b.recommended) - Number(a.recommended)
      || Number(b.isPrimary) - Number(a.isPrimary)
      || a.displayName.localeCompare(b.displayName, 'ru'));
  const rows = ordered.slice(0, 8).map((team) => [{
    text: `${team.recommended ? '✨ ' : team.isPrimary ? '⭐ ' : ''}${truncate(team.displayName, 44)}`,
    callback_data: `subs:mt:onboard:team:${team.id}`,
  }]);
  rows.push([{ text: 'Не сейчас', callback_data: 'subs:mt:onboard:not-now' }]);
  rows.push([mainMenuButton()]);
  return {
    text: [
      '🔔 <b>Настроим уведомления?</b>',
      '',
      'Можно следить за целой командой переводчиков: новые и будущие новеллы этой команды будут подключаться автоматически.',
      'Выберите команду или нажмите «Не сейчас». Настройку всегда можно изменить в разделе уведомлений.',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export async function countConfiguredNotificationSubscriptions(env: TeamOnboardingEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT
      CASE WHEN
        EXISTS (SELECT 1 FROM telegram_team_subscriptions WHERE user_telegram_id=? LIMIT 1)
        OR EXISTS (
          SELECT 1 FROM telegram_team_title_subscriptions explicit
          WHERE explicit.user_telegram_id=?
            AND NOT EXISTS (
              SELECT 1 FROM telegram_team_title_exclusions exclusion
              WHERE exclusion.user_telegram_id=explicit.user_telegram_id
                AND exclusion.team_id=explicit.team_id
                AND exclusion.book_ref=explicit.book_ref
            )
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1 FROM telegram_subscription_settings legacy
          WHERE legacy.user_telegram_id=? AND legacy.all_titles=1
          LIMIT 1
        )
        OR EXISTS (SELECT 1 FROM title_subscriptions WHERE user_telegram_id=? LIMIT 1)
      THEN 1 ELSE 0 END AS configured
  `).bind(userId, userId, userId, userId).first<{ configured: number | string }>();
  return Number(row?.configured ?? 0) === 1 ? 1 : 0;
}

export async function shouldOfferTeamOnboarding(
  env: TeamOnboardingEnv,
  userId: string,
  uiEnabled: boolean,
): Promise<boolean> {
  if (!uiEnabled) return false;
  const configuredSubscriptions = await countConfiguredNotificationSubscriptions(env, userId);
  if (configuredSubscriptions > 0) return false;
  const completion = await env.DB.prepare(`
    SELECT completed_at, completion_reason
    FROM telegram_notification_onboarding
    WHERE user_telegram_id=?
  `).bind(userId).first<{ completed_at: string | null; completion_reason: string | null }>();
  return shouldOfferTeamOnboardingFromState({
    uiEnabled,
    completed: Boolean(completion?.completed_at && completion.completion_reason),
    configuredSubscriptions,
  });
}

export async function listOnboardingTeams(env: TeamOnboardingEnv, userId: string): Promise<OnboardingTeam[]> {
  const { results } = await env.DB.prepare(`
    SELECT id, display_name, is_primary, recommendation_chat_id, recommendation_membership_capable
    FROM ranobelib_teams
    WHERE lifecycle_state='published'
    ORDER BY is_primary DESC, display_name COLLATE NOCASE ASC, id ASC
    LIMIT 20
  `).all<{
    id: number | string;
    display_name: string;
    is_primary: number | string;
    recommendation_chat_id: string | null;
    recommendation_membership_capable: number | string;
  }>();

  const teams: OnboardingTeam[] = [];
  for (const row of results) {
    let recommended = false;
    if (row.recommendation_chat_id && Number(row.recommendation_membership_capable) === 1) {
      try {
        const member = await telegramCall<TelegramMember>(env, 'getChatMember', {
          chat_id: row.recommendation_chat_id,
          user_id: Number(userId),
        });
        recommended = isMember(member);
      } catch {
        // Recommendation channels are best-effort onboarding hints only. A Telegram lookup failure
        // must never block normal onboarding or mutate subscriptions.
      }
    }
    teams.push({
      id: Number(row.id),
      displayName: String(row.display_name),
      isPrimary: Number(row.is_primary) === 1,
      recommended,
    });
  }
  return teams;
}

export async function maybeSendTeamOnboarding(
  env: TeamOnboardingEnv,
  user: { id: number; first_name?: string },
  chatId: number,
  uiEnabled: boolean,
): Promise<boolean> {
  const userId = String(user.id);
  if (!await shouldOfferTeamOnboarding(env, userId, uiEnabled)) return false;
  const teams = await listOnboardingTeams(env, userId);
  if (!teams.length) return false;
  await sendPayload(env, chatId, buildTeamOnboardingScreen(teams));
  return true;
}

export async function handleTelegramTeamOnboarding(
  update: TelegramSubscriptionUpdate,
  env: TeamOnboardingEnv,
): Promise<boolean> {
  const callback = update.callback_query;
  const data = callback?.data ?? '';
  const chatId = callback?.message?.chat.id;
  if (!callback || !chatId) return false;

  const teamMatch = /^subs:mt:onboard:team:(\d+)$/.exec(data);
  if (!teamMatch && data !== 'subs:mt:onboard:not-now') return false;
  await answerCallback(env, callback.id);
  const userId = String(callback.from.id);

  if (teamMatch) {
    const teamId = Number(teamMatch[1]);
    const team = await env.DB.prepare(`
      SELECT id, display_name
      FROM ranobelib_teams
      WHERE id=? AND lifecycle_state='published'
    `).bind(teamId).first<{ id: number | string; display_name: string }>();
    if (!team) {
      await sendPayload(env, chatId, {
        text: 'Эта команда сейчас недоступна. Выберите другую команду в разделе уведомлений.',
        reply_markup: { inline_keyboard: [[{ text: '🔔 Уведомления', callback_data: 'subs:mt:home' }], [mainMenuButton()]] },
      });
      return true;
    }
    await env.DB.prepare(`
      INSERT OR IGNORE INTO telegram_team_subscriptions (user_telegram_id, team_id)
      VALUES (?, ?)
    `).bind(userId, teamId).run();
    await refreshAllWorkNotificationDemand(env);
    await persistOnboardingCompletion(env, userId, 'team_selected');
    await sendPayload(env, chatId, {
      text: `✅ Уведомления команды <b>${escapeHtml(team.display_name)}</b> включены.`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔔 Настроить уведомления', callback_data: 'subs:mt:home' }], [mainMenuButton()]] },
    });
    return true;
  }

  await persistOnboardingCompletion(env, userId, 'not_now');
  await sendPayload(env, chatId, {
    text: 'Хорошо. Настроить уведомления можно в любой момент из главного меню.',
    reply_markup: { inline_keyboard: [[{ text: '🔔 Уведомления', callback_data: 'subs:mt:home' }], [mainMenuButton()]] },
  });
  return true;
}

async function persistOnboardingCompletion(
  env: TeamOnboardingEnv,
  userId: string,
  completion_reason: 'team_selected' | 'not_now',
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO telegram_notification_onboarding
      (user_telegram_id, completed_at, completion_reason, updated_at)
    VALUES (?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET
      completed_at=COALESCE(telegram_notification_onboarding.completed_at, CURRENT_TIMESTAMP),
      completion_reason=COALESCE(telegram_notification_onboarding.completion_reason, excluded.completion_reason),
      updated_at=CURRENT_TIMESTAMP
  `).bind(userId, completion_reason).run();
}

function isMember(member: TelegramMember): boolean {
  return member.status === 'creator'
    || member.status === 'administrator'
    || member.status === 'member'
    || (member.status === 'restricted' && member.is_member === true);
}

async function answerCallback(env: TeamOnboardingEnv, callbackId: string): Promise<void> {
  await telegramCall(env, 'answerCallbackQuery', { callback_query_id: callbackId }).catch(() => undefined);
}

async function sendPayload(env: TeamOnboardingEnv, chatId: number, payload: TelegramPayload): Promise<void> {
  await telegramCall(env, 'sendMessage', { chat_id: chatId, ...payload });
}

async function telegramCall<T = unknown>(env: TeamOnboardingEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  return body.result as T;
}

function truncate(value: string, max: number): string {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}
