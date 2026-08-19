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
  PUBLISH_CHANNEL_ID?: string;
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

type PublishingSettingsResult = {
  settings: { publishChannelId: string; discussionChatId: string; storageReady: boolean };
  telegram: {
    bot: { id: number; username: string | null };
    channel: { id: number; title: string | null; username: string | null; botStatus: string };
    discussion: { id: number; title: string | null; username: string | null } | null;
    discussionAutoDetected: boolean;
  } | null;
};

class PublishingSettingsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

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

async function getSetting(env: SettingsEnv, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>();
  return row ? String(row.value ?? '') : null;
}

async function setSetting(env: SettingsEnv, key: string, value: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP
  `).bind(key, value).run();
}

async function telegramCall<T>(env: SettingsEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new PublishingSettingsError('TELEGRAM_BOT_TOKEN is not configured', 502);
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok || body.result === undefined) {
    throw new PublishingSettingsError(body?.description || `Telegram ${method} failed with HTTP ${response.status}`, 502);
  }
  return body.result;
}

function isAdmin(member: TelegramChatMember): boolean {
  return member.status === 'creator' || member.status === 'administrator';
}

function chatLabel(chat: TelegramChat): string {
  return chat.title || (chat.username ? `@${chat.username}` : String(chat.id));
}

async function configurePublishingSettings(
  env: SettingsEnv,
  rawChannel: unknown,
  rawDiscussion: unknown,
): Promise<PublishingSettingsResult> {
  const channelInput = normalizeChatInput(rawChannel);
  const discussionInput = normalizeChatInput(rawDiscussion);
  await ensureSettingsSchema(env);

  if (!channelInput) {
    await setSetting(env, 'publish_channel_id', '');
    await setSetting(env, 'discussion_chat_id', '');
    return {
      settings: { publishChannelId: '', discussionChatId: '', storageReady: Boolean(env.FILES) },
      telegram: null,
    };
  }

  const bot = await telegramCall<TelegramUser>(env, 'getMe', {});
  const channel = await telegramCall<TelegramChat>(env, 'getChat', { chat_id: channelInput });
  if (channel.type !== 'channel') {
    throw new PublishingSettingsError(`Публикация должна идти в Telegram-канал. Получен тип: ${channel.type}.`, 409);
  }

  const channelMember = await telegramCall<TelegramChatMember>(env, 'getChatMember', {
    chat_id: channel.id,
    user_id: bot.id,
  });
  if (!isAdmin(channelMember) || (channelMember.status === 'administrator' && channelMember.can_post_messages !== true)) {
    throw new PublishingSettingsError(
      `Бот не может публиковать в канале «${chatLabel(channel)}». Выдайте ему права администратора с правом публикации сообщений.`,
      409,
    );
  }

  let discussion: TelegramChat | null = null;
  const discussionTarget: string | number | null = discussionInput || channel.linked_chat_id || null;
  if (discussionTarget !== null) {
    discussion = await telegramCall<TelegramChat>(env, 'getChat', { chat_id: discussionTarget });
    if (discussion.type !== 'group' && discussion.type !== 'supergroup') {
      throw new PublishingSettingsError(`Discussion chat должен быть группой или супергруппой. Получен тип: ${discussion.type}.`, 409);
    }
    const discussionMember = await telegramCall<TelegramChatMember>(env, 'getChatMember', {
      chat_id: discussion.id,
      user_id: bot.id,
    });
    if (!isAdmin(discussionMember)) {
      throw new PublishingSettingsError(
        `Бот должен быть администратором discussion group «${chatLabel(discussion)}», чтобы гарантированно получать automatic forwards и отправлять файлы в комментарии.`,
        409,
      );
    }
  }

  const publishChannelId = String(channel.id);
  const discussionChatId = discussion ? String(discussion.id) : '';
  await setSetting(env, 'publish_channel_id', publishChannelId);
  await setSetting(env, 'discussion_chat_id', discussionChatId);

  return {
    settings: { publishChannelId, discussionChatId, storageReady: Boolean(env.FILES) },
    telegram: {
      bot: { id: bot.id, username: bot.username || null },
      channel: { id: channel.id, title: channel.title || null, username: channel.username || null, botStatus: channelMember.status },
      discussion: discussion ? { id: discussion.id, title: discussion.title || null, username: discussion.username || null } : null,
      discussionAutoDetected: !discussionInput && Boolean(channel.linked_chat_id),
    },
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof PublishingSettingsError) return json({ error: error.message }, error.status);
  return json({ error: error instanceof Error ? error.message : 'Telegram validation failed' }, 502);
}

export async function handlePublishingSettingsGuard(request: Request, env: SettingsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/api/admin/publishing/settings') return null;

  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Invalid JSON body.' }, 400);

  try {
    const result = await configurePublishingSettings(env, body.publishChannelId, body.discussionChatId);
    return json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePublishingDefaultBootstrap(request: Request, env: SettingsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const publishingPath = url.pathname.startsWith('/api/admin/publishing')
    || url.pathname.startsWith('/api/admin/publications')
    || url.pathname.startsWith('/api/admin/files');
  if (!publishingPath || (request.method === 'POST' && url.pathname === '/api/admin/publishing/settings')) return null;

  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;

  const defaultChannel = normalizeChatInput(env.PUBLISH_CHANNEL_ID);
  if (!defaultChannel) return null;

  await ensureSettingsSchema(env);
  const configured = await getSetting(env, 'publish_channel_id');
  if (configured?.trim()) return null;

  try {
    await configurePublishingSettings(env, defaultChannel, '');
    return null;
  } catch (error) {
    return errorResponse(error);
  }
}
