import { requireAdminSession, type WebAuthEnv } from './web-auth.js';

type D1Row = Record<string, unknown>;
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }

interface SettingsEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
  FILES?: unknown;
}

type TelegramUser = { id: number; username?: string };
type TelegramChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  linked_chat_id?: number;
};
type TelegramChatMember = {
  status: string;
  can_post_messages?: boolean;
};

type TelegramResponse<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function normalizeChatInput(value: unknown): string {
  const raw = String(value ?? '').trim().slice(0, 128);
  if (!raw) return '';
  if (/^-?\d+$/.test(raw)) return raw;
  return raw.startsWith('@') ? raw : `@${raw}`;
}

async function ensureSettingsSchema(env: SettingsEnv): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function setSetting(env: SettingsEnv, key: string, value: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP
  `).bind(key, value).run();
}

async function telegramCall<T>(env: SettingsEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok || body.result === undefined) {
    throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return body.result;
}

function isAdmin(member: TelegramChatMember): boolean {
  return member.status === 'creator' || member.status === 'administrator';
}

function chatLabel(chat: TelegramChat): string {
  return chat.title || (chat.username ? `@${chat.username}` : String(chat.id));
}

export async function handlePublishingSettingsGuard(request: Request, env: SettingsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/api/admin/publishing/settings') return null;

  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Invalid JSON body.' }, 400);

  const channelInput = normalizeChatInput(body.publishChannelId);
  const discussionInput = normalizeChatInput(body.discussionChatId);
  await ensureSettingsSchema(env);

  if (!channelInput) {
    await setSetting(env, 'publish_channel_id', '');
    await setSetting(env, 'discussion_chat_id', '');
    return json({
      ok: true,
      settings: { publishChannelId: '', discussionChatId: '', storageReady: Boolean(env.FILES) },
      telegram: null,
    });
  }

  try {
    const bot = await telegramCall<TelegramUser>(env, 'getMe', {});
    const channel = await telegramCall<TelegramChat>(env, 'getChat', { chat_id: channelInput });
    if (channel.type !== 'channel') {
      return json({ error: `Публикация должна идти в Telegram-канал. Получен тип: ${channel.type}.` }, 409);
    }

    const channelMember = await telegramCall<TelegramChatMember>(env, 'getChatMember', {
      chat_id: channel.id,
      user_id: bot.id,
    });
    if (!isAdmin(channelMember) || (channelMember.status === 'administrator' && channelMember.can_post_messages !== true)) {
      return json({ error: `Бот не может публиковать в канале «${chatLabel(channel)}». Выдайте ему права администратора с правом публикации сообщений.` }, 409);
    }

    let discussion: TelegramChat | null = null;
    const discussionTarget: string | number | null = discussionInput || channel.linked_chat_id || null;
    if (discussionTarget !== null) {
      discussion = await telegramCall<TelegramChat>(env, 'getChat', { chat_id: discussionTarget });
      if (discussion.type !== 'group' && discussion.type !== 'supergroup') {
        return json({ error: `Discussion chat должен быть группой или супергруппой. Получен тип: ${discussion.type}.` }, 409);
      }
      const discussionMember = await telegramCall<TelegramChatMember>(env, 'getChatMember', {
        chat_id: discussion.id,
        user_id: bot.id,
      });
      if (!isAdmin(discussionMember)) {
        return json({ error: `Бот должен быть администратором discussion group «${chatLabel(discussion)}», чтобы гарантированно получать automatic forwards и отправлять файлы в комментарии.` }, 409);
      }
    }

    const publishChannelId = String(channel.id);
    const discussionChatId = discussion ? String(discussion.id) : '';
    await setSetting(env, 'publish_channel_id', publishChannelId);
    await setSetting(env, 'discussion_chat_id', discussionChatId);

    return json({
      ok: true,
      settings: { publishChannelId, discussionChatId, storageReady: Boolean(env.FILES) },
      telegram: {
        bot: { id: bot.id, username: bot.username || null },
        channel: { id: channel.id, title: channel.title || null, username: channel.username || null, botStatus: channelMember.status },
        discussion: discussion ? { id: discussion.id, title: discussion.title || null, username: discussion.username || null } : null,
        discussionAutoDetected: !discussionInput && Boolean(channel.linked_chat_id),
      },
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Telegram validation failed' }, 502);
  }
}
