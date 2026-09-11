import { refreshAllWorkNotificationDemand } from './multi-team-notification-demand.js';
import { setTeamSubscription } from './multi-team-subscriptions.js';
import type { D1DatabaseLike } from './ranobelib-runtime.js';
import { buildMainMenu } from './telegram-bot-ui.js';
import { deliverySettingLabel, getGlobalDeliverySetting } from './telegram-notification-settings.js';
import {
  buildPartnerCatalogHub,
  buildPartnerNotificationDashboard,
  buildPartnerSubscriptionsHub,
  buildPartnerTeamList,
  buildPartnerTranslationList,
  parsePartnerCollaborationCallback,
} from './telegram-partner-collaboration-ux.js';
import { buildPartnerAwareTeamScreen } from './telegram-partner-team-screen.js';
import { renderTelegramScreen, type TelegramScreenExecutionContext } from './telegram-screen-renderer.js';
import {
  countFollowedTeams,
  countManualTeamTitles,
  listMyFollowedTeams,
  listMyManualTeamTitles,
  listTeamTranslations,
  type TeamCatalogTeam,
  type TeamCatalogTranslation,
} from './telegram-team-catalog.js';
import type { TelegramSubscriptionUpdate } from './telegram-subscriptions.js';

export type TelegramPartnerCollaborationEnv = {
  DB: D1DatabaseLike;
  TELEGRAM_BOT_TOKEN?: string;
};

export type PartnerCollaborationExecutionContext = TelegramScreenExecutionContext;

type TeamRow = {
  id: number | string;
  display_name: string;
  is_primary: number | string;
  followed: number | string;
  active_count: number | string | null;
  completed_count: number | string | null;
};

type TranslationRow = {
  team_id: number | string;
  team_name: string;
  team_is_primary: number | string;
  ranobelib_id: number | string | null;
  book_ref: string;
  title: string | null;
  url: string;
  semantic_status: string;
  team_followed: number | string;
  explicit_subscribed: number | string;
  excluded: number | string;
};

export async function handleTelegramPartnerCollaboration(
  update: TelegramSubscriptionUpdate,
  env: TelegramPartnerCollaborationEnv,
  origin: string,
  ctx?: PartnerCollaborationExecutionContext,
): Promise<boolean> {
  const callback = update.callback_query;
  const message = update.message;
  const data = String(callback?.data ?? '').trim();
  const text = String(message?.text ?? '').trim();
  const user = callback?.from ?? message?.from;
  const chatId = callback?.message?.chat.id ?? message?.chat.id;
  const messageId = callback?.message?.message_id;
  if (!user || !chatId) return false;
  const userId = String(user.id);

  const dashboardCommand = /^\/(?:notifications|subscriptions)(?:@[A-Za-z0-9_]+)?$/i.test(text);
  const dashboardCallback = data === 'prop:notifications' || data === 'subs:center' || data === 'subs:mt:home';
  const homeCallback = data === 'prop:home';
  const partnerAlias = /^subs:mt:partners:(\d+)$/.exec(data);
  const legacyMineTeamsAlias = /^subs:mt:teams:mine:(\d+)$/.exec(data);
  const legacyAllTeamsAlias = /^subs:mt:teams:all:(\d+)$/.exec(data);
  const legacyMineTitlesAlias = /^subs:mt:titles:(\d+)$/.exec(data);
  const parsed = parsePartnerCollaborationCallback(data);
  const teamPage = /^subs:mt:team:(\d+):(active|completed):(\d+)$/.exec(data);
  const teamToggle = /^subs:mt:team:toggle:(\d+):(\d+)$/.exec(data);

  if (
    !dashboardCommand
    && !dashboardCallback
    && !homeCallback
    && !partnerAlias
    && !legacyMineTeamsAlias
    && !legacyAllTeamsAlias
    && !legacyMineTitlesAlias
    && !parsed
    && !teamPage
    && !teamToggle
  ) {
    return false;
  }

  if (callback?.id) await answerCallback(env, callback.id);

  if (homeCallback) {
    await render(env, chatId, messageId, buildMainMenu(origin, { collaborations: true }), ctx);
    return true;
  }

  if (dashboardCommand || dashboardCallback || parsed?.kind === 'dashboard') {
    const [followedTeams, manualTitles, global] = await Promise.all([
      countFollowedTeams(env, userId),
      countManualTeamTitles(env, userId),
      getGlobalDeliverySetting(env, userId),
    ]);
    await render(env, chatId, messageId, buildPartnerNotificationDashboard({
      followedTeams,
      manualTitles,
      globalModeLabel: deliverySettingLabel(global),
    }), ctx);
    return true;
  }

  if (partnerAlias) {
    const page = safePage(partnerAlias[1]);
    const teams = await listPartnerTeams(env, userId, page, 8);
    await render(env, chatId, messageId, buildPartnerTeamList({ teams, page, origin: 'partners' }), ctx);
    return true;
  }

  if (parsed?.kind === 'partners') {
    const teams = await listPartnerTeams(env, userId, parsed.page, 8);
    await render(env, chatId, messageId, buildPartnerTeamList({ teams, page: parsed.page, origin: 'partners' }), ctx);
    return true;
  }

  if (legacyAllTeamsAlias) {
    const page = safePage(legacyAllTeamsAlias[1]);
    const teams = await listPartnerTeams(env, userId, page, 8);
    await render(env, chatId, messageId, buildPartnerTeamList({ teams, page, origin: 'partners' }), ctx);
    return true;
  }

  if (parsed?.kind === 'subscriptions') {
    const [followedTeams, manualTitles] = await Promise.all([
      countFollowedTeams(env, userId),
      countManualTeamTitles(env, userId),
    ]);
    await render(env, chatId, messageId, buildPartnerSubscriptionsHub({ followedTeams, manualTitles }), ctx);
    return true;
  }

  if (parsed?.kind === 'catalog') {
    await render(env, chatId, messageId, buildPartnerCatalogHub(), ctx);
    return true;
  }

  if (legacyMineTeamsAlias) {
    const page = safePage(legacyMineTeamsAlias[1]);
    const teams = await listMyFollowedTeams(env, userId, page, 8);
    await render(env, chatId, messageId, buildPartnerTeamList({ teams, page, origin: 'mine' }), ctx);
    return true;
  }

  if (parsed?.kind === 'my-teams') {
    const teams = await listMyFollowedTeams(env, userId, parsed.page, 8);
    await render(env, chatId, messageId, buildPartnerTeamList({ teams, page: parsed.page, origin: 'mine' }), ctx);
    return true;
  }

  if (legacyMineTitlesAlias) {
    const page = safePage(legacyMineTitlesAlias[1]);
    const translations = await listMyManualTeamTitles(env, userId, page, 8);
    await render(env, chatId, messageId, buildPartnerTranslationList({
      translations,
      page,
      completed: false,
      scope: 'mine',
    }), ctx);
    return true;
  }

  if (parsed?.kind === 'my-titles') {
    const translations = await listMyManualTeamTitles(env, userId, parsed.page, 8);
    await render(env, chatId, messageId, buildPartnerTranslationList({
      translations,
      page: parsed.page,
      completed: false,
      scope: 'mine',
    }), ctx);
    return true;
  }

  if (parsed?.kind === 'primary') {
    const primary = await getPrimaryTeam(env, userId);
    if (!primary) {
      await render(env, chatId, messageId, buildPartnerTranslationList({ translations: [], page: parsed.page, completed: false, scope: 'primary' }), ctx);
      return true;
    }
    const translations = await listTeamTranslations(env, userId, primary.id, { completed: false, page: parsed.page, pageSize: 8 });
    await render(env, chatId, messageId, buildPartnerTranslationList({
      translations,
      page: parsed.page,
      completed: false,
      scope: 'primary',
    }), ctx);
    return true;
  }

  if (parsed?.kind === 'catalog-translations') {
    const translations = await listCatalogTranslations(env, userId, parsed.completed, parsed.page, 8);
    await render(env, chatId, messageId, buildPartnerTranslationList({
      translations,
      page: parsed.page,
      completed: parsed.completed,
      scope: parsed.completed ? 'completed' : 'active',
    }), ctx);
    return true;
  }

  if (teamPage) {
    const teamId = positiveInt(teamPage[1]);
    const completed = teamPage[2] === 'completed';
    const page = safePage(teamPage[3]);
    const team = await getTeam(env, userId, teamId);
    if (!team) return true;
    const translations = await listTeamTranslations(env, userId, teamId, { completed, page, pageSize: 8 });
    await render(env, chatId, messageId, buildPartnerAwareTeamScreen({ team, translations, completed, page }), ctx);
    return true;
  }

  if (teamToggle) {
    const teamId = positiveInt(teamToggle[1]);
    const page = safePage(teamToggle[2]);
    const team = await getTeam(env, userId, teamId);
    if (!team) return true;
    await setTeamSubscription(env, userId, teamId, !team.followed);
    const refresh = refreshAllWorkNotificationDemand(env).catch((error) => {
      console.error('Multi-team demand refresh after partner team toggle failed', error);
    });
    if (ctx) ctx.waitUntil(refresh);
    else await refresh;
    const updated = { ...team, followed: !team.followed };
    const translations = await listTeamTranslations(env, userId, teamId, { completed: false, page, pageSize: 8 });
    await render(env, chatId, messageId, buildPartnerAwareTeamScreen({ team: updated, translations, completed: false, page }), ctx);
    return true;
  }

  return false;
}

export async function sendPartnerAwareMainMenu(
  update: TelegramSubscriptionUpdate,
  env: TelegramPartnerCollaborationEnv,
  origin: string,
  ctx?: PartnerCollaborationExecutionContext,
): Promise<boolean> {
  const message = update.message;
  if (!message?.chat?.id || message.chat.type !== 'private') return false;
  await render(env, message.chat.id, undefined, buildMainMenu(origin, { collaborations: true }), ctx, 'send');
  return true;
}

async function listPartnerTeams(
  env: TelegramPartnerCollaborationEnv,
  userId: string,
  page: number,
  pageSize: number,
): Promise<TeamCatalogTeam[]> {
  const limit = clamp(pageSize, 1, 20);
  const offset = safePage(page) * limit;
  const { results } = await env.DB.prepare(`
    SELECT team.id, team.display_name, team.is_primary,
      CASE WHEN sub.team_id IS NULL THEN 0 ELSE 1 END AS followed,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status<>'completed' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status='completed' THEN 1 ELSE 0 END) AS completed_count
    FROM ranobelib_teams team
    LEFT JOIN telegram_team_subscriptions sub
      ON sub.team_id=team.id AND sub.user_telegram_id=?
    LEFT JOIN ranobelib_team_translations tt ON tt.team_id=team.id
    WHERE team.lifecycle_state='published' AND team.is_primary=0
    GROUP BY team.id, team.display_name, team.is_primary, sub.team_id
    ORDER BY team.display_name COLLATE NOCASE ASC, team.id ASC
    LIMIT ? OFFSET ?
  `).bind(userId, limit, offset).all<TeamRow>();
  return results.map(teamFromRow);
}

async function listCatalogTranslations(
  env: TelegramPartnerCollaborationEnv,
  userId: string,
  completed: boolean,
  page: number,
  pageSize: number,
): Promise<TeamCatalogTranslation[]> {
  const limit = clamp(pageSize, 1, 20);
  const offset = safePage(page) * limit;
  const { results } = await env.DB.prepare(`${translationSelect()}
    WHERE team.lifecycle_state='published'
      AND tt.presence_state='active'
      AND ${completed ? "tt.semantic_status='completed'" : "tt.semantic_status<>'completed'"}
    ORDER BY title COLLATE NOCASE ASC, team.is_primary DESC, team.display_name COLLATE NOCASE ASC, team.id ASC
    LIMIT ? OFFSET ?
  `).bind(userId, userId, userId, limit, offset).all<TranslationRow>();
  return results.map(translationFromRow);
}

async function getPrimaryTeam(env: TelegramPartnerCollaborationEnv, userId: string): Promise<TeamCatalogTeam | null> {
  const row = await env.DB.prepare(`
    SELECT team.id, team.display_name, team.is_primary,
      CASE WHEN sub.team_id IS NULL THEN 0 ELSE 1 END AS followed,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status<>'completed' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status='completed' THEN 1 ELSE 0 END) AS completed_count
    FROM ranobelib_teams team
    LEFT JOIN telegram_team_subscriptions sub ON sub.team_id=team.id AND sub.user_telegram_id=?
    LEFT JOIN ranobelib_team_translations tt ON tt.team_id=team.id
    WHERE team.lifecycle_state='published' AND team.is_primary=1
    GROUP BY team.id, team.display_name, team.is_primary, sub.team_id
    ORDER BY team.id ASC LIMIT 1
  `).bind(userId).first<TeamRow>();
  return row ? teamFromRow(row) : null;
}

async function getTeam(env: TelegramPartnerCollaborationEnv, userId: string, teamId: number): Promise<TeamCatalogTeam | null> {
  const row = await env.DB.prepare(`
    SELECT team.id, team.display_name, team.is_primary,
      CASE WHEN sub.team_id IS NULL THEN 0 ELSE 1 END AS followed,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status<>'completed' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status='completed' THEN 1 ELSE 0 END) AS completed_count
    FROM ranobelib_teams team
    LEFT JOIN telegram_team_subscriptions sub ON sub.team_id=team.id AND sub.user_telegram_id=?
    LEFT JOIN ranobelib_team_translations tt ON tt.team_id=team.id
    WHERE team.id=? AND team.lifecycle_state='published'
    GROUP BY team.id, team.display_name, team.is_primary, sub.team_id
  `).bind(userId, teamId).first<TeamRow>();
  return row ? teamFromRow(row) : null;
}

function translationSelect(): string {
  return `
    SELECT team.id AS team_id, team.display_name AS team_name, team.is_primary AS team_is_primary,
      t.ranobelib_id, t.book_ref, COALESCE(t.title,t.book_ref) AS title, t.url, tt.semantic_status,
      CASE WHEN whole.team_id IS NULL THEN 0 ELSE 1 END AS team_followed,
      CASE WHEN explicit.book_ref IS NULL THEN 0 ELSE 1 END AS explicit_subscribed,
      CASE WHEN exclusion.book_ref IS NULL THEN 0 ELSE 1 END AS excluded
    FROM ranobelib_team_translations tt
    JOIN ranobelib_teams team ON team.id=tt.team_id
    JOIN ranobelib_titles t ON t.book_ref=tt.book_ref
    LEFT JOIN telegram_team_subscriptions whole
      ON whole.user_telegram_id=? AND whole.team_id=team.id
    LEFT JOIN telegram_team_title_subscriptions explicit
      ON explicit.user_telegram_id=? AND explicit.team_id=team.id AND explicit.book_ref=t.book_ref
    LEFT JOIN telegram_team_title_exclusions exclusion
      ON exclusion.user_telegram_id=? AND exclusion.team_id=team.id AND exclusion.book_ref=t.book_ref
  `;
}

function teamFromRow(row: TeamRow): TeamCatalogTeam {
  return {
    id: Number(row.id),
    displayName: String(row.display_name),
    isPrimary: Number(row.is_primary) === 1,
    followed: Number(row.followed) === 1,
    activeCount: nonNegative(row.active_count),
    completedCount: nonNegative(row.completed_count),
  };
}

function translationFromRow(row: TranslationRow): TeamCatalogTranslation {
  const excluded = Number(row.excluded) === 1;
  const teamFollowed = Number(row.team_followed) === 1;
  const explicit = Number(row.explicit_subscribed) === 1;
  const enabledReason: TeamCatalogTranslation['enabledReason'] = excluded ? 'excluded' : teamFollowed ? 'team' : explicit ? 'explicit' : 'none';
  const semanticStatus: TeamCatalogTranslation['semanticStatus'] = row.semantic_status === 'active' || row.semantic_status === 'completed'
    ? row.semantic_status
    : 'unknown';
  return {
    teamId: Number(row.team_id),
    teamName: String(row.team_name),
    teamIsPrimary: Number(row.team_is_primary) === 1,
    ranobelibId: row.ranobelib_id == null ? null : Number(row.ranobelib_id),
    bookRef: String(row.book_ref),
    title: String(row.title ?? row.book_ref),
    url: String(row.url),
    semanticStatus,
    enabled: enabledReason === 'team' || enabledReason === 'explicit',
    enabledReason,
  };
}

async function render(
  env: TelegramPartnerCollaborationEnv,
  chatId: number,
  messageId: number | undefined,
  payload: Parameters<typeof renderTelegramScreen>[2],
  ctx?: PartnerCollaborationExecutionContext,
  forceStrategy?: 'edit' | 'send',
): Promise<void> {
  const strategy = forceStrategy ?? (messageId ? 'edit' : 'send');
  await renderTelegramScreen(env, { chatId, ...(messageId ? { messageId } : {}) }, payload, { strategy, ctx });
}

async function answerCallback(env: TelegramPartnerCollaborationEnv, callbackId: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId }),
  }).catch(() => undefined);
}

function positiveInt(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function safePage(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(9999, Math.trunc(number))) : 0;
}

function clamp(value: unknown, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : min;
}

function nonNegative(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}
