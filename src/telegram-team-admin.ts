import { RanobeLibClient } from './integrations/ranobelib/client.js';
import type { D1DatabaseLike } from './ranobelib-runtime.js';
import { discoverOneRegisteredTeam } from './ranobelib-multi-team-discovery.js';
import {
  getRanobeLibTeamById,
  listAllRanobeLibTeams,
  registerRanobeLibTeam,
  setRanobeLibRecommendationChannel,
  setRanobeLibTeamLifecycle,
  type RanobeLibTeamRecord,
} from './ranobelib-team-registry.js';
import { mainMenuButton, type TelegramButton, type TelegramPayload } from './telegram-bot-ui.js';

export type TelegramTeamAdminEnv = {
  DB: D1DatabaseLike;
  TELEGRAM_BOT_TOKEN?: string;
  ADMIN_TELEGRAM_IDS?: string;
};

type TeamAdminUpdate = {
  message?: {
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { id?: number };
    forward_origin?: { type?: string; chat?: TelegramChat };
    forward_from_chat?: TelegramChat;
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
    message?: { message_id?: number; chat?: { id?: number; type?: string } };
  };
};

type TelegramChat = { id: number | string; type?: string; title?: string; username?: string };
type TelegramMember = { status?: string; is_member?: boolean };
type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string };
type AdminInputRow = {
  action: 'add_team' | 'recommendation_channel';
  team_id: number | string | null;
  draft_team_ref: string | null;
  draft_display_name: string | null;
};

export function parseRanobeLibTeamInput(value: string): { ranobelibTeamId: number; ranobelibTeamRef: string } | null {
  const text = String(value ?? '').trim();
  const urlMatch = /^https?:\/\/(?:www\.)?ranobelib\.me\/(?:[a-z]{2}\/)?team\/(\d+--[A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i.exec(text);
  const ref = urlMatch?.[1] ?? (/^\d+--[A-Za-z0-9_-]+$/.test(text) ? text : '');
  if (!ref) return null;
  const id = Number(ref.split('--', 1)[0]);
  return Number.isSafeInteger(id) && id > 0 ? { ranobelibTeamId: id, ranobelibTeamRef: ref } : null;
}

export function normalizeRecommendationChannelInput(value: string): string | null {
  const text = String(value ?? '').trim();
  if (/^@[A-Za-z0-9_]{5,32}$/.test(text)) return text;
  const match = /^https?:\/\/(?:www\.)?t\.me\/([A-Za-z0-9_]{5,32})\/?(?:[?#].*)?$/i.exec(text);
  return match ? `@${match[1]}` : null;
}

export function buildTeamAdminList(teams: Array<Pick<RanobeLibTeamRecord, 'id' | 'displayName' | 'isPrimary' | 'lifecycleState' | 'lastSyncError'>>): TelegramPayload {
  const lines = ['🛠 <b>Команды RanobeLib</b>', ''];
  const rows: TelegramButton[][] = [];
  for (const team of teams) {
    const marker = team.isPrimary ? '⭐' : lifecycleIcon(team.lifecycleState);
    lines.push(`${marker} <b>${escapeHtml(team.displayName)}</b> — ${lifecycleLabel(team.lifecycleState)}${team.lastSyncError ? ' · есть ошибка синхронизации' : ''}`);
    rows.push([{ text: `${marker} ${truncate(team.displayName, 40)}`, callback_data: `teamadmin:view:${team.id}` }]);
  }
  if (!teams.length) lines.push('Команды ещё не настроены.');
  rows.push([{ text: '➕ Добавить команду', callback_data: 'teamadmin:add' }]);
  rows.push([mainMenuButton()]);
  return { text: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
}

export function buildTeamAdminCard(team: RanobeLibTeamRecord): TelegramPayload {
  const rows: TelegramButton[][] = [];
  if (!team.isPrimary) {
    if (team.lifecycleState === 'hidden') rows.push([{ text: '🌐 Опубликовать', callback_data: `teamadmin:publish:${team.id}` }]);
    if (team.lifecycleState === 'published') rows.push([{ text: '⏸ Приостановить', callback_data: `teamadmin:pause:${team.id}` }]);
    if (team.lifecycleState === 'paused') rows.push([{ text: '▶️ Возобновить', callback_data: `teamadmin:resume:${team.id}` }]);
  }
  rows.push([{ text: '🔄 Синхронизировать', callback_data: `teamadmin:sync:${team.id}` }]);
  rows.push([{ text: '📣 Канал рекомендации', callback_data: `teamadmin:channel:${team.id}` }]);
  if (team.recommendationChatId) rows.push([{ text: '❌ Убрать канал рекомендации', callback_data: `teamadmin:channel:clear:${team.id}` }]);
  rows.push([{ text: '↩️ Ко всем командам', callback_data: 'teamadmin:home' }], [mainMenuButton()]);
  return {
    text: [
      `${team.isPrimary ? '⭐ ' : ''}<b>${escapeHtml(team.displayName)}</b>`,
      '',
      `RanobeLib: <code>${escapeHtml(team.ranobelibTeamRef)}</code>`,
      `Состояние: ${lifecycleLabel(team.lifecycleState)}`,
      `Последняя синхронизация: ${escapeHtml(team.lastSyncAt ?? 'ещё не было')}`,
      `Ошибка: ${escapeHtml(team.lastSyncError ?? 'нет')}`,
      `Канал рекомендации: ${escapeHtml(team.recommendationChatUsername ? `@${team.recommendationChatUsername}` : team.recommendationChatTitle ?? 'не привязан')}`,
      `Проверка членства: ${team.recommendationMembershipCapable ? '✅ доступна' : '— недоступна'}`,
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export async function handleTelegramTeamAdmin(
  update: TeamAdminUpdate,
  env: TelegramTeamAdminEnv,
): Promise<boolean> {
  const message = update.message;
  const callback = update.callback_query;
  const userId = Number(callback?.from?.id ?? message?.from?.id);
  const chatId = Number(callback?.message?.chat?.id ?? message?.chat?.id);
  const chatType = callback?.message?.chat?.type ?? message?.chat?.type;
  const command = String(message?.text ?? '').trim();
  const data = String(callback?.data ?? '').trim();
  const route = /^\/teams(?:@[A-Za-z0-9_]+)?$/i.test(command) || data.startsWith('teamadmin:');
  const input = Number.isSafeInteger(userId) && userId > 0 ? await getAdminInput(env, String(userId)) : null;
  if (!route && !input) return false;
  if (!Number.isSafeInteger(userId) || !isAdmin(env, userId)) return route;
  if (!Number.isSafeInteger(chatId) || (chatType && chatType !== 'private')) return true;

  if (callback?.id) await answerCallback(env, callback.id);

  if (/^\/teams(?:@[A-Za-z0-9_]+)?$/i.test(command) || data === 'teamadmin:home') {
    await clearAdminInput(env, String(userId));
    await sendPayload(env, chatId, buildTeamAdminList(await listAllRanobeLibTeams(env)));
    return true;
  }

  if (data === 'teamadmin:add') {
    await setAdminInput(env, String(userId), { action: 'add_team' });
    await sendPayload(env, chatId, {
      text: '➕ <b>Добавление команды</b>\n\nПришлите ссылку вида <code>https://ranobelib.me/ru/team/123--team-name</code> или <code>123--team-name</code>. После проверки бот покажет подтверждение.',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '↩️ Отмена', callback_data: 'teamadmin:home' }], [mainMenuButton()]] },
    });
    return true;
  }

  if (input?.action === 'add_team' && message && !command.startsWith('/')) {
    const parsed = parseRanobeLibTeamInput(command);
    if (!parsed) {
      await sendPayload(env, chatId, simpleAdminMessage('Не удалось распознать ссылку команды. Пришлите URL RanobeLib или ref вида <code>123--team-name</code>.'));
      return true;
    }
    try {
      const books = await new RanobeLibClient().discoverTeamBooks(parsed.ranobelibTeamRef);
      if (!books.length) throw new Error('команда не вернула ни одной новеллы');
      const displayName = humanizeTeamRef(parsed.ranobelibTeamRef);
      await setAdminInput(env, String(userId), {
        action: 'add_team',
        draftTeamRef: parsed.ranobelibTeamRef,
        draftDisplayName: displayName,
      });
      await sendPayload(env, chatId, {
        text: `✅ RanobeLib отвечает.\n\nКоманда: <b>${escapeHtml(displayName)}</b>\nRef: <code>${escapeHtml(parsed.ranobelibTeamRef)}</code>\nНайдено новелл: <b>${books.length}</b>\n\nДобавить её скрытой и выполнить первичную синхронизацию?`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ Добавить', callback_data: 'teamadmin:add:confirm' }], [{ text: '↩️ Отмена', callback_data: 'teamadmin:home' }], [mainMenuButton()]] },
      });
    } catch (error) {
      await sendPayload(env, chatId, simpleAdminMessage(`Проверка RanobeLib не прошла: <code>${escapeHtml(compactError(error))}</code>`));
    }
    return true;
  }

  if (data === 'teamadmin:add:confirm') {
    const state = await getAdminInput(env, String(userId));
    const parsed = state?.draft_team_ref ? parseRanobeLibTeamInput(state.draft_team_ref) : null;
    if (!state || state.action !== 'add_team' || !parsed || !state.draft_display_name) {
      await sendPayload(env, chatId, simpleAdminMessage('Черновик добавления устарел. Начните добавление команды заново.'));
      return true;
    }
    const team = await registerRanobeLibTeam(env, {
      ranobelibTeamId: parsed.ranobelibTeamId,
      ranobelibTeamRef: parsed.ranobelibTeamRef,
      displayName: state.draft_display_name,
      lifecycleState: 'hidden',
    });
    try {
      await discoverOneRegisteredTeam(env, team);
    } catch (error) {
      await env.DB.prepare(`UPDATE ranobelib_teams SET lifecycle_state='error', last_sync_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(compactError(error), team.id).run();
    }
    await clearAdminInput(env, String(userId));
    const refreshed = await getRanobeLibTeamById(env, team.id);
    if (refreshed) await sendPayload(env, chatId, buildTeamAdminCard(refreshed));
    return true;
  }

  let match = /^teamadmin:view:(\d+)$/.exec(data);
  if (match) return showTeam(env, chatId, Number(match[1]));

  match = /^teamadmin:(publish|pause|resume|sync):(\d+)$/.exec(data);
  if (match) {
    const action = match[1];
    const teamId = Number(match[2]);
    const team = await getRanobeLibTeamById(env, teamId);
    if (!team) return true;
    if (action === 'publish' && !team.isPrimary) await setRanobeLibTeamLifecycle(env, teamId, 'published');
    if (action === 'pause' && !team.isPrimary) await setRanobeLibTeamLifecycle(env, teamId, 'paused');
    if (action === 'resume' && !team.isPrimary && team.lifecycleState === 'paused') {
      await setRanobeLibTeamLifecycle(env, teamId, 'hidden');
      const runnable = await getRanobeLibTeamById(env, teamId);
      if (runnable) {
        try {
          await discoverOneRegisteredTeam(env, runnable);
          await setRanobeLibTeamLifecycle(env, teamId, 'published');
        } catch (error) {
          await env.DB.prepare(`UPDATE ranobelib_teams SET lifecycle_state='error', last_sync_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .bind(compactError(error), teamId).run();
        }
      }
    }
    if (action === 'sync') {
      const runnable = await getRanobeLibTeamById(env, teamId);
      if (runnable) {
        try {
          await discoverOneRegisteredTeam(env, runnable);
        } catch (error) {
          await env.DB.prepare(`UPDATE ranobelib_teams SET lifecycle_state='error', last_sync_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .bind(compactError(error), teamId).run();
        }
      }
    }
    return showTeam(env, chatId, teamId);
  }

  match = /^teamadmin:channel:(\d+)$/.exec(data);
  if (match) {
    const teamId = Number(match[1]);
    if (!await getRanobeLibTeamById(env, teamId)) return true;
    await setAdminInput(env, String(userId), { action: 'recommendation_channel', teamId });
    await sendPayload(env, chatId, {
      text: '📣 <b>Канал рекомендации</b>\n\nПришлите <code>@username</code>, ссылку <code>t.me/...</code> или перешлите сообщение из нужного канала. Числовой chat ID вручную вводить не нужно.',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '↩️ Отмена', callback_data: `teamadmin:view:${teamId}` }], [mainMenuButton()]] },
    });
    return true;
  }

  match = /^teamadmin:channel:clear:(\d+)$/.exec(data);
  if (match) {
    const teamId = Number(match[1]);
    await setRanobeLibRecommendationChannel(env, teamId, null);
    return showTeam(env, chatId, teamId);
  }

  if (input?.action === 'recommendation_channel' && message) {
    const teamId = Number(input.team_id);
    const forwarded = channelFromForward(message);
    const normalized = normalizeRecommendationChannelInput(command);
    if (!forwarded && !normalized) {
      await sendPayload(env, chatId, simpleAdminMessage('Нужен <code>@username</code>, ссылка <code>t.me/...</code> или пересланное сообщение из канала.'));
      return true;
    }
    try {
      const chat = await telegramCall<TelegramChat>(env, 'getChat', { chat_id: forwarded?.id ?? normalized });
      if (chat.type !== 'channel') throw new Error('указанный Telegram-объект не является каналом');
      let membershipCapable = false;
      try {
        await telegramCall<TelegramMember>(env, 'getChatMember', { chat_id: chat.id, user_id: userId });
        membershipCapable = true;
      } catch {
        membershipCapable = false;
      }
      await setRanobeLibRecommendationChannel(env, teamId, {
        chatId: String(chat.id),
        title: chat.title?.trim() || null,
        username: chat.username?.trim() || null,
        membershipCapable,
      });
      await clearAdminInput(env, String(userId));
      await sendPayload(env, chatId, simpleAdminMessage(membershipCapable
        ? '✅ Канал привязан. Проверка членства доступна для рекомендаций при первом запуске.'
        : '⚠️ Канал привязан, но проверка членства сейчас недоступна. Он сохранён как метаданные, а onboarding будет работать без персональной рекомендации.'));
      return showTeam(env, chatId, teamId);
    } catch (error) {
      await sendPayload(env, chatId, simpleAdminMessage(`Не удалось проверить канал: <code>${escapeHtml(compactError(error))}</code>`));
      return true;
    }
  }

  return route || Boolean(input);
}

async function showTeam(env: TelegramTeamAdminEnv, chatId: number, teamId: number): Promise<boolean> {
  const team = await getRanobeLibTeamById(env, teamId);
  if (team) await sendPayload(env, chatId, buildTeamAdminCard(team));
  return true;
}

async function getAdminInput(env: TelegramTeamAdminEnv, userId: string): Promise<AdminInputRow | null> {
  return env.DB.prepare(`
    SELECT action, team_id, draft_team_ref, draft_display_name
    FROM telegram_team_admin_input
    WHERE user_telegram_id=? AND expires_at > CURRENT_TIMESTAMP
  `).bind(userId).first<AdminInputRow>();
}

async function setAdminInput(env: TelegramTeamAdminEnv, userId: string, input: {
  action: AdminInputRow['action'];
  teamId?: number;
  draftTeamRef?: string;
  draftDisplayName?: string;
}): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO telegram_team_admin_input
      (user_telegram_id, action, team_id, draft_team_ref, draft_display_name, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now','+20 minutes'), CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET
      action=excluded.action,
      team_id=excluded.team_id,
      draft_team_ref=excluded.draft_team_ref,
      draft_display_name=excluded.draft_display_name,
      expires_at=excluded.expires_at,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    userId,
    input.action,
    input.teamId ?? null,
    input.draftTeamRef ?? null,
    input.draftDisplayName ?? null,
  ).run();
}

async function clearAdminInput(env: TelegramTeamAdminEnv, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM telegram_team_admin_input WHERE user_telegram_id=?').bind(userId).run();
}

function channelFromForward(message: NonNullable<TeamAdminUpdate['message']>): TelegramChat | null {
  if (message.forward_origin?.type === 'channel' && message.forward_origin.chat) return message.forward_origin.chat;
  if (message.forward_from_chat?.type === 'channel') return message.forward_from_chat;
  return null;
}

function simpleAdminMessage(text: string): TelegramPayload {
  return {
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🛠 Команды', callback_data: 'teamadmin:home' }], [mainMenuButton()]] },
  };
}

function isAdmin(env: TelegramTeamAdminEnv, userId: number): boolean {
  return String(env.ADMIN_TELEGRAM_IDS ?? '').split(/[,\s]+/).some((value) => Number(value) === userId);
}

async function answerCallback(env: TelegramTeamAdminEnv, callbackId: string): Promise<void> {
  await telegramCall(env, 'answerCallbackQuery', { callback_query_id: callbackId }).catch(() => undefined);
}

async function sendPayload(env: TelegramTeamAdminEnv, chatId: number, payload: TelegramPayload): Promise<void> {
  await telegramCall(env, 'sendMessage', { chat_id: chatId, ...payload });
}

async function telegramCall<T = unknown>(env: TelegramTeamAdminEnv, method: string, payload: Record<string, unknown>): Promise<T> {
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

function humanizeTeamRef(ref: string): string {
  const slug = ref.split('--').slice(1).join('--');
  return slug.split(/[-_]+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ') || ref;
}

function lifecycleIcon(value: RanobeLibTeamRecord['lifecycleState']): string {
  if (value === 'published') return '🟢';
  if (value === 'paused') return '⏸';
  if (value === 'error') return '⚠️';
  return '🙈';
}

function lifecycleLabel(value: RanobeLibTeamRecord['lifecycleState']): string {
  if (value === 'published') return 'опубликована';
  if (value === 'paused') return 'приостановлена';
  if (value === 'error') return 'ошибка';
  return 'скрыта';
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
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