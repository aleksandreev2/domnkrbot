import { refreshAllWorkNotificationDemand, refreshWorkNotificationDemand } from './multi-team-notification-demand.js';
import {
  clearTeamTitleDeliverySetting,
  getEffectiveTeamTitleDeliverySetting,
  setEffectiveTeamTitleSubscription,
  setTeamSubscription,
  setTeamTitleDeliverySetting,
} from './multi-team-subscriptions.js';
import type { D1DatabaseLike } from './ranobelib-runtime.js';
import { deliverySettingLabel, getGlobalDeliverySetting, type DeliverySetting } from './telegram-notification-settings.js';
import { renderTelegramScreen, type TelegramScreenExecutionContext } from './telegram-screen-renderer.js';
import {
  countFollowedTeams,
  countManualTeamTitles,
  listMyFollowedTeams,
  listMyManualTeamTitles,
  listPublishedTeams,
  listTeamTranslations,
  searchPublishedTeamTranslations,
  type TeamCatalogTeam,
  type TeamCatalogTranslation,
  type WorkSearchGroup,
} from './telegram-team-catalog.js';
import {
  buildManualTeamTitlesScreen,
  buildTeamListScreen,
  buildTeamNotificationDashboard,
  buildTeamSearchPrompt,
  buildTeamTitleCard,
  buildTeamTitleModeScreen,
  buildTeamTranslationsScreen,
  buildWorkSearchResults,
  buildWorkTranslationPicker,
  parseTeamNotificationCallback,
  type TeamNotificationOrigin,
} from './telegram-team-notification-ux.js';
import type { TelegramSubscriptionUpdate } from './telegram-subscriptions.js';

export type TelegramTeamNotificationEnv = {
  DB: D1DatabaseLike;
  TELEGRAM_BOT_TOKEN?: string;
};

export type TeamNotificationExecutionContext = TelegramScreenExecutionContext;

type SearchState = { query: string; page: number | string };
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

type TelegramUser = NonNullable<NonNullable<TelegramSubscriptionUpdate['message']>['from']>;

export async function handleTelegramTeamNotification(
  update: TelegramSubscriptionUpdate,
  env: TelegramTeamNotificationEnv,
  ctx?: TeamNotificationExecutionContext,
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

  const isDashboardCommand = /^\/(?:notifications|subscriptions)(?:@[A-Za-z0-9_]+)?$/i.test(text);
  const isDashboardCallback = data === 'prop:notifications' || data === 'subs:center' || data === 'subs:mt:home';
  const parsed = parseTeamNotificationCallback(data);
  const titleModeSet = /^subs:mt:title:mode:set:(\d+):(\d+):(i|5|10|20|x):(team|mine|search|work|alt):(\d+)$/.exec(data);

  if (!isDashboardCommand && !isDashboardCallback && !parsed && !titleModeSet) {
    if (!text || text.startsWith('/')) return false;
    const state = await getSearchState(env, userId);
    if (!state) return false;
    await upsertMultiTeamTelegramUser(env, user);
    await setSearchState(env, userId, text, 0);
    await render(env, chatId, undefined, buildWorkSearchResults({
      query: text,
      groups: await searchPublishedTeamTranslations(env, userId, text, 0, 8),
      page: 0,
    }), ctx, 'send');
    return true;
  }

  await upsertMultiTeamTelegramUser(env, user);
  if (callback?.id) await answerCallback(env, callback.id);

  if (isDashboardCommand || isDashboardCallback || parsed?.kind === 'dashboard') {
    await clearSearchState(env, userId);
    await renderDashboard(env, userId, chatId, messageId, ctx);
    return true;
  }

  if (titleModeSet) {
    const teamId = positiveInt(titleModeSet[1]);
    const titleId = positiveInt(titleModeSet[2]);
    const choice = titleModeSet[3] ?? 'i';
    const origin = titleModeSet[4] as TeamNotificationOrigin;
    const page = safePage(titleModeSet[5]);
    const translation = await getTranslation(env, userId, teamId, titleId);
    if (!translation) return true;
    if (choice === 'x') await clearTeamTitleDeliverySetting(env, userId, teamId, translation.bookRef);
    else await setTeamTitleDeliverySetting(env, userId, teamId, translation.bookRef, settingFromChoice(choice));
    await renderTitleMode(env, userId, translation, origin, page, chatId, messageId, ctx);
    return true;
  }

  if (!parsed) return false;
  if (parsed.kind === 'teams') {
    const teams = parsed.scope === 'mine'
      ? await listMyFollowedTeams(env, userId, parsed.page, 8)
      : await listPublishedTeams(env, userId, parsed.page, 8);
    await render(env, chatId, messageId, buildTeamListScreen({ kind: parsed.scope, teams, page: parsed.page }), ctx);
    return true;
  }

  if (parsed.kind === 'titles') {
    const translations = await listMyManualTeamTitles(env, userId, parsed.page, 8);
    await render(env, chatId, messageId, buildManualTeamTitlesScreen({ translations, page: parsed.page }), ctx);
    return true;
  }

  if (parsed.kind === 'team-translations') {
    const team = await getTeam(env, userId, parsed.teamId);
    if (!team) return true;
    const translations = await listTeamTranslations(env, userId, parsed.teamId, { completed: parsed.completed, page: parsed.page, pageSize: 8 });
    await render(env, chatId, messageId, buildTeamTranslationsScreen({ team, translations, completed: parsed.completed, page: parsed.page }), ctx);
    return true;
  }

  if (parsed.kind === 'team-toggle') {
    const team = await getTeam(env, userId, parsed.teamId);
    if (!team) return true;
    await setTeamSubscription(env, userId, parsed.teamId, !team.followed);
    defer(ctx, refreshAllWorkNotificationDemand(env), 'multi-team demand refresh after team toggle');
    const updated = { ...team, followed: !team.followed };
    const translations = await listTeamTranslations(env, userId, parsed.teamId, { completed: false, page: parsed.page, pageSize: 8 });
    await render(env, chatId, messageId, buildTeamTranslationsScreen({ team: updated, translations, completed: false, page: parsed.page }), ctx);
    return true;
  }

  if (parsed.kind === 'search-start' || parsed.kind === 'search-again') {
    await setSearchState(env, userId, '', 0);
    await render(env, chatId, messageId, buildTeamSearchPrompt(), ctx);
    return true;
  }

  if (parsed.kind === 'search-page') {
    const state = await getSearchState(env, userId);
    if (!state?.query) {
      await setSearchState(env, userId, '', 0);
      await render(env, chatId, messageId, buildTeamSearchPrompt(), ctx);
      return true;
    }
    await setSearchState(env, userId, state.query, parsed.page);
    await render(env, chatId, messageId, buildWorkSearchResults({
      query: state.query,
      groups: await searchPublishedTeamTranslations(env, userId, state.query, parsed.page, 8),
      page: parsed.page,
    }), ctx);
    return true;
  }

  if (parsed.kind === 'work') {
    const group = await getWorkGroup(env, userId, parsed.titleId);
    if (group) await render(env, chatId, messageId, buildWorkTranslationPicker({ group, page: parsed.page }), ctx);
    return true;
  }

  if (parsed.kind === 'alternates') {
    const group = await getWorkGroup(env, userId, parsed.titleId);
    if (group) await render(env, chatId, messageId, buildWorkTranslationPicker({ group, page: parsed.page, origin: 'alt' }), ctx);
    return true;
  }

  if (parsed.kind === 'title' || parsed.kind === 'title-toggle' || parsed.kind === 'title-mode') {
    const translation = await getTranslation(env, userId, parsed.teamId, parsed.titleId);
    if (!translation) return true;
    if (parsed.kind === 'title-toggle') {
      await setEffectiveTeamTitleSubscription(env, userId, parsed.teamId, translation.bookRef, !translation.enabled);
      defer(ctx, refreshWorkNotificationDemand(env, translation.bookRef), 'multi-team demand refresh after title toggle');
      const refreshed = await getTranslation(env, userId, parsed.teamId, parsed.titleId);
      if (refreshed) await renderTitleCard(env, userId, refreshed, parsed.origin, parsed.page, chatId, messageId, ctx);
      return true;
    }
    if (parsed.kind === 'title-mode') {
      await renderTitleMode(env, userId, translation, parsed.origin, parsed.page, chatId, messageId, ctx);
      return true;
    }
    await renderTitleCard(env, userId, translation, parsed.origin, parsed.page, chatId, messageId, ctx);
    return true;
  }

  return false;
}

export async function upsertMultiTeamTelegramUser(env: TelegramTeamNotificationEnv, user: TelegramUser): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, language_code, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name,
      last_name=excluded.last_name,
      language_code=excluded.language_code,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    String(user.id),
    user.username ?? null,
    user.first_name || 'Telegram',
    user.last_name ?? '',
    user.language_code ?? null,
  ).run();
}

async function renderDashboard(env: TelegramTeamNotificationEnv, userId: string, chatId: number, messageId: number | undefined, ctx?: TeamNotificationExecutionContext): Promise<void> {
  const [followedTeams, manualTitles, global] = await Promise.all([
    countFollowedTeams(env, userId),
    countManualTeamTitles(env, userId),
    getGlobalDeliverySetting(env, userId),
  ]);
  await render(env, chatId, messageId, buildTeamNotificationDashboard({
    followedTeams,
    manualTitles,
    globalModeLabel: deliverySettingLabel(global),
  }), ctx);
}

async function renderTitleCard(
  env: TelegramTeamNotificationEnv,
  userId: string,
  translation: TeamCatalogTranslation,
  origin: TeamNotificationOrigin,
  page: number,
  chatId: number,
  messageId?: number,
  ctx?: TeamNotificationExecutionContext,
): Promise<void> {
  const [delivery, group] = await Promise.all([
    getEffectiveTeamTitleDeliverySetting(env, userId, translation.teamId, translation.bookRef),
    translation.ranobelibId ? getWorkGroup(env, userId, translation.ranobelibId) : Promise.resolve(null),
  ]);
  await render(env, chatId, messageId, buildTeamTitleCard({
    translation,
    deliveryLabel: deliverySettingLabel(delivery.setting),
    inheritedDelivery: delivery.inherited,
    origin,
    page,
    hasAlternatives: (group?.translations.length ?? 0) > 1,
  }), ctx);
}

async function renderTitleMode(
  env: TelegramTeamNotificationEnv,
  userId: string,
  translation: TeamCatalogTranslation,
  origin: TeamNotificationOrigin,
  page: number,
  chatId: number,
  messageId?: number,
  ctx?: TeamNotificationExecutionContext,
): Promise<void> {
  const [delivery, global] = await Promise.all([
    getEffectiveTeamTitleDeliverySetting(env, userId, translation.teamId, translation.bookRef),
    getGlobalDeliverySetting(env, userId),
  ]);
  await render(env, chatId, messageId, buildTeamTitleModeScreen({
    translation,
    globalLabel: deliverySettingLabel(global),
    effectiveLabel: deliverySettingLabel(delivery.setting),
    inherited: delivery.inherited,
    origin,
    page,
  }), ctx);
}

async function getTeam(env: TelegramTeamNotificationEnv, userId: string, teamId: number): Promise<TeamCatalogTeam | null> {
  const row = await env.DB.prepare(`
    SELECT team.id, team.display_name, team.is_primary,
      EXISTS(SELECT 1 FROM telegram_team_subscriptions s WHERE s.user_telegram_id=? AND s.team_id=team.id) AS followed,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status<>'completed' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN tt.presence_state='active' AND tt.semantic_status='completed' THEN 1 ELSE 0 END) AS completed_count
    FROM ranobelib_teams team
    LEFT JOIN ranobelib_team_translations tt ON tt.team_id=team.id
    WHERE team.id=? AND team.lifecycle_state='published'
    GROUP BY team.id, team.display_name, team.is_primary
  `).bind(userId, teamId).first<{
    id: number | string; display_name: string; is_primary: number | string; followed: number | string;
    active_count: number | string | null; completed_count: number | string | null;
  }>();
  if (!row) return null;
  return {
    id: Number(row.id),
    displayName: String(row.display_name),
    isPrimary: Number(row.is_primary) === 1,
    followed: Number(row.followed) === 1,
    activeCount: count(row.active_count),
    completedCount: count(row.completed_count),
  };
}

async function getTranslation(env: TelegramTeamNotificationEnv, userId: string, teamId: number, titleId: number): Promise<TeamCatalogTranslation | null> {
  const row = await env.DB.prepare(`${translationSelect()}
    WHERE team.id=? AND t.ranobelib_id=? AND team.lifecycle_state='published' AND tt.presence_state='active'
    LIMIT 1
  `).bind(userId, userId, userId, teamId, titleId).first<TranslationRow>();
  return row ? translationFromRow(row) : null;
}

async function getWorkGroup(env: TelegramTeamNotificationEnv, userId: string, titleId: number): Promise<WorkSearchGroup | null> {
  const { results } = await env.DB.prepare(`${translationSelect()}
    WHERE t.ranobelib_id=? AND team.lifecycle_state='published' AND tt.presence_state='active'
    ORDER BY team.is_primary DESC, team.display_name COLLATE NOCASE ASC, team.id ASC
  `).bind(userId, userId, userId, titleId).all<TranslationRow>();
  if (!results.length) return null;
  const translations = results.map(translationFromRow);
  return { bookRef: translations[0]!.bookRef, ranobelibId: translations[0]!.ranobelibId, title: translations[0]!.title, translations };
}

function translationSelect(): string {
  return `
    SELECT team.id AS team_id, team.display_name AS team_name, team.is_primary AS team_is_primary,
      t.ranobelib_id, t.book_ref, COALESCE(t.title,t.book_ref) AS title, t.url, tt.semantic_status,
      EXISTS(SELECT 1 FROM telegram_team_subscriptions whole WHERE whole.user_telegram_id=? AND whole.team_id=team.id) AS team_followed,
      EXISTS(SELECT 1 FROM telegram_team_title_subscriptions explicit WHERE explicit.user_telegram_id=? AND explicit.team_id=team.id AND explicit.book_ref=t.book_ref) AS explicit_subscribed,
      EXISTS(SELECT 1 FROM telegram_team_title_exclusions exclusion WHERE exclusion.user_telegram_id=? AND exclusion.team_id=team.id AND exclusion.book_ref=t.book_ref) AS excluded
    FROM ranobelib_team_translations tt
    JOIN ranobelib_teams team ON team.id=tt.team_id
    JOIN ranobelib_titles t ON t.book_ref=tt.book_ref
  `;
}

function translationFromRow(row: TranslationRow): TeamCatalogTranslation {
  const excluded = Number(row.excluded) === 1;
  const teamFollowed = Number(row.team_followed) === 1;
  const explicit = Number(row.explicit_subscribed) === 1;
  const enabledReason: TeamCatalogTranslation['enabledReason'] = excluded ? 'excluded' : teamFollowed ? 'team' : explicit ? 'explicit' : 'none';
  const status: TeamCatalogTranslation['semanticStatus'] = row.semantic_status === 'active' || row.semantic_status === 'completed' ? row.semantic_status : 'unknown';
  return {
    teamId: Number(row.team_id),
    teamName: String(row.team_name),
    teamIsPrimary: Number(row.team_is_primary) === 1,
    ranobelibId: row.ranobelib_id == null ? null : Number(row.ranobelib_id),
    bookRef: String(row.book_ref),
    title: String(row.title ?? row.book_ref),
    url: String(row.url),
    semanticStatus: status,
    enabled: enabledReason === 'team' || enabledReason === 'explicit',
    enabledReason,
  };
}

async function getSearchState(env: TelegramTeamNotificationEnv, userId: string): Promise<SearchState | null> {
  return env.DB.prepare(`
    SELECT query, page FROM telegram_notification_search_state
    WHERE user_telegram_id=? AND expires_at > CURRENT_TIMESTAMP
  `).bind(userId).first<SearchState>();
}

async function setSearchState(env: TelegramTeamNotificationEnv, userId: string, query: string, page: number): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO telegram_notification_search_state (user_telegram_id, query, page, return_scope, expires_at, created_at)
    VALUES (?, ?, ?, 'home', datetime('now','+10 minutes'), CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET
      query=excluded.query, page=excluded.page, return_scope='home', expires_at=excluded.expires_at, created_at=CURRENT_TIMESTAMP
  `).bind(userId, query, safePage(page)).run();
}

async function clearSearchState(env: TelegramTeamNotificationEnv, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM telegram_notification_search_state WHERE user_telegram_id=?').bind(userId).run();
}

async function render(
  env: TelegramTeamNotificationEnv,
  chatId: number,
  messageId: number | undefined,
  payload: Parameters<typeof renderTelegramScreen>[2],
  ctx?: TeamNotificationExecutionContext,
  strategy?: 'send' | 'edit' | 'replace',
): Promise<void> {
  await renderTelegramScreen(env, { chatId, ...(messageId ? { messageId } : {}) }, payload, {
    strategy: strategy ?? (messageId ? 'edit' : 'send'),
    ctx,
  });
}

async function answerCallback(env: TelegramTeamNotificationEnv, callbackId: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackId }),
  }).catch(() => undefined);
}

function settingFromChoice(choice: string): DeliverySetting {
  if (choice === 'i') return { mode: 'instant', stackSize: null };
  const size = Number(choice);
  return { mode: 'stack', stackSize: Number.isInteger(size) && size >= 2 && size <= 100 ? size : 5 };
}

function defer(ctx: TeamNotificationExecutionContext | undefined, promise: Promise<unknown>, label: string): void {
  const task = promise.catch((error) => console.error(label, error));
  if (ctx) ctx.waitUntil(task);
  else void task;
}

function positiveInt(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function safePage(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(9999, Math.trunc(number))) : 0;
}

function count(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}
