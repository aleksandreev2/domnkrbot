import { requireAdminSession, type WebAuthEnv } from './web-auth.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<unknown>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }

export interface ChannelMembershipEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
  TELEGRAM_WEBHOOK_SECRET?: string;
  PUBLISH_CHANNEL_ID?: string;
}
export interface MembershipExecutionContext { waitUntil(promise: Promise<unknown>): void }

type TelegramUser = { id: number; username?: string; first_name?: string };
type TelegramChat = { id: number | string; type?: string; username?: string };
type ChatMember = { status: string; is_member?: boolean; user?: TelegramUser };
type ChatMemberUpdated = { chat: TelegramChat; from: TelegramUser; date: number; old_chat_member: ChatMember; new_chat_member: ChatMember };
type TelegramMessage = { chat: TelegramChat; from?: TelegramUser; text?: string };
type TelegramUpdate = { message?: TelegramMessage; chat_member?: ChatMemberUpdated };
type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string };
type AccessRow = {
  user_telegram_id: string;
  last_status: string;
  last_checked_at: string | null;
  left_at: string | null;
  rejoined_at: string | null;
  blacklisted_at: string | null;
  blacklist_reason: string | null;
};

const REQUIRED_UPDATES = ['message', 'callback_query', 'chat_member'] as const;
const BLACKLIST_AFTER_MS = 48 * 60 * 60 * 1000;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
let schemaPromise: Promise<void> | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function botName(env: ChannelMembershipEnv): string {
  return (env.BOT_USERNAME || 'domnekromanta_bot').replace(/^@/, '');
}
async function setting(env: ChannelMembershipEnv, key: string): Promise<string> {
  try {
    return (await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>())?.value?.trim() || '';
  } catch {
    return '';
  }
}
async function targetChat(env: ChannelMembershipEnv): Promise<string> {
  return (await setting(env, 'publish_channel_id')) || env.PUBLISH_CHANNEL_ID?.trim() || '';
}
function joinUrl(env: ChannelMembershipEnv, target: string): string | null {
  const publicTarget = env.PUBLISH_CHANNEL_ID?.trim() || target;
  if (!publicTarget.startsWith('@')) return null;
  return `https://t.me/${publicTarget.slice(1)}`;
}
function retryUrl(env: ChannelMembershipEnv, publicationId: number): string {
  return `https://t.me/${botName(env)}?start=dl_${publicationId}`;
}
function isMember(member: ChatMember): boolean {
  if (member.status === 'creator' || member.status === 'administrator' || member.status === 'member') return true;
  return member.status === 'restricted' && member.is_member === true;
}
async function telegramCall<T>(env: ChannelMembershipEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  return body.result as T;
}

export async function ensureChannelMembershipSchema(env: ChannelMembershipEnv): Promise<void> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS channel_access_state (
        user_telegram_id TEXT PRIMARY KEY,
        last_status TEXT NOT NULL DEFAULT 'unknown',
        last_checked_at TEXT,
        left_at TEXT,
        rejoined_at TEXT,
        blacklisted_at TEXT,
        blacklist_reason TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      'CREATE INDEX IF NOT EXISTS idx_channel_access_blacklisted ON channel_access_state(blacklisted_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_channel_access_left ON channel_access_state(left_at, blacklisted_at)',
    ];
    for (const statement of statements) await env.DB.prepare(statement).run();
  })().catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

async function accessRow(env: ChannelMembershipEnv, userId: number | string): Promise<AccessRow | null> {
  await ensureChannelMembershipSchema(env);
  return env.DB.prepare(`SELECT user_telegram_id,last_status,last_checked_at,left_at,rejoined_at,blacklisted_at,blacklist_reason
    FROM channel_access_state WHERE user_telegram_id=?`).bind(String(userId)).first<AccessRow>();
}
async function hasDownloaded(env: ChannelMembershipEnv, userId: number | string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(`SELECT 1 ok FROM publication_deliveries
      WHERE user_telegram_id=? AND first_delivered_at IS NOT NULL LIMIT 1`).bind(String(userId)).first<{ ok: number }>();
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}
async function rememberStatus(env: ChannelMembershipEnv, userId: number | string, status: string, options: { left?: boolean; rejoined?: boolean } = {}): Promise<void> {
  const now = new Date().toISOString();
  const existing = await accessRow(env, userId);
  let leftAt = existing?.left_at || null;
  let rejoinedAt = existing?.rejoined_at || null;
  if (options.left && !leftAt) leftAt = now;
  if (options.rejoined) { leftAt = null; rejoinedAt = now; }
  await env.DB.prepare(`INSERT INTO channel_access_state
      (user_telegram_id,last_status,last_checked_at,left_at,rejoined_at,blacklisted_at,blacklist_reason,updated_at)
      VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(user_telegram_id) DO UPDATE SET
        last_status=excluded.last_status,last_checked_at=excluded.last_checked_at,left_at=excluded.left_at,
        rejoined_at=excluded.rejoined_at,blacklisted_at=channel_access_state.blacklisted_at,
        blacklist_reason=channel_access_state.blacklist_reason,updated_at=CURRENT_TIMESTAMP`)
    .bind(String(userId), status, now, leftAt, rejoinedAt, existing?.blacklisted_at || null, existing?.blacklist_reason || null).run();
}
async function sendSubscriptionRequired(env: ChannelMembershipEnv, userId: number, publicationId: number, target: string): Promise<void> {
  const row: Array<{ text: string; url: string }> = [];
  const join = joinUrl(env, target);
  if (join) row.push({ text: '➕ Подписаться на канал', url: join });
  row.push({ text: '✅ Проверить подписку', url: retryUrl(env, publicationId) });
  await telegramCall(env, 'sendMessage', {
    chat_id: userId,
    text: 'Чтобы скачать перевод, нужно быть подписанным на канал «Дом Некроманта». Подпишитесь и нажмите «Проверить подписку».',
    reply_markup: { inline_keyboard: row.map((button) => [button]) },
  }).catch(() => undefined);
}
async function sendBlacklisted(env: ChannelMembershipEnv, userId: number): Promise<void> {
  await telegramCall(env, 'sendMessage', {
    chat_id: userId,
    text: 'Доступ к скачиваниям ограничен. Если это ошибка, свяжитесь с администрацией «Дома Некроманта».',
  }).catch(() => undefined);
}

export async function checkDownloadMembership(env: ChannelMembershipEnv, user: TelegramUser, publicationId: number): Promise<boolean> {
  const existing = await accessRow(env, user.id);
  if (existing?.blacklisted_at) {
    await sendBlacklisted(env, user.id);
    return false;
  }
  const target = await targetChat(env);
  if (!target) {
    await telegramCall(env, 'sendMessage', { chat_id: user.id, text: 'Скачивание временно недоступно: канал подписки не настроен.' }).catch(() => undefined);
    return false;
  }
  try {
    const member = await telegramCall<ChatMember>(env, 'getChatMember', { chat_id: target, user_id: user.id });
    if (isMember(member)) {
      await rememberStatus(env, user.id, member.status, { rejoined: Boolean(existing?.left_at) });
      return true;
    }
    await rememberStatus(env, user.id, member.status, { left: await hasDownloaded(env, user.id) });
    await sendSubscriptionRequired(env, user.id, publicationId, target);
    return false;
  } catch {
    await telegramCall(env, 'sendMessage', { chat_id: user.id, text: 'Не удалось проверить подписку на канал. Попробуйте скачать ещё раз чуть позже.' }).catch(() => undefined);
    return false;
  }
}

async function targetMatchesUpdate(env: ChannelMembershipEnv, chat: TelegramChat): Promise<boolean> {
  const target = await targetChat(env);
  if (!target) return false;
  if (/^-?\d+$/.test(target)) return String(chat.id) === target;
  if (target.startsWith('@') && chat.username && chat.username.toLowerCase() === target.slice(1).toLowerCase()) return true;
  try {
    const resolved = await telegramCall<TelegramChat>(env, 'getChat', { chat_id: target });
    return String(resolved.id) === String(chat.id);
  } catch {
    return false;
  }
}
async function handleChatMemberUpdate(env: ChannelMembershipEnv, update: ChatMemberUpdated): Promise<void> {
  if (!(await targetMatchesUpdate(env, update.chat))) return;
  const userId = update.new_chat_member.user?.id || update.old_chat_member.user?.id;
  if (!userId) return;
  const memberNow = isMember(update.new_chat_member);
  const existing = await accessRow(env, userId);
  if (existing?.blacklisted_at) {
    await rememberStatus(env, userId, update.new_chat_member.status, { rejoined: false });
    return;
  }
  if (memberNow) {
    await rememberStatus(env, userId, update.new_chat_member.status, { rejoined: Boolean(existing?.left_at) });
    return;
  }
  if (await hasDownloaded(env, userId)) await rememberStatus(env, userId, update.new_chat_member.status, { left: true });
  else await rememberStatus(env, userId, update.new_chat_member.status);
}

export async function handleChannelMembershipWebhook(request: Request, env: ChannelMembershipEnv, _ctx: MembershipExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/webhook' || request.method !== 'POST') return null;
  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (expected && request.headers.get('x-telegram-bot-api-secret-token') !== expected) return new Response('Forbidden', { status: 403 });
  const update = await request.clone().json().catch(() => null) as TelegramUpdate | null;
  if (!update) return null;
  if (update.chat_member) {
    await handleChatMemberUpdate(env, update.chat_member);
    return new Response('ok');
  }
  const message = update.message;
  if (message?.chat?.type === 'private' && message.from && message.text?.startsWith('/start')) {
    const payload = message.text.trim().split(/\s+/, 2)[1] || '';
    const match = /^dl_(\d+)$/.exec(payload);
    if (match) {
      const allowed = await checkDownloadMembership(env, message.from, Number(match[1]));
      if (!allowed) return new Response('ok');
    }
  }
  return null;
}

export async function runChannelMembershipMaintenance(env: ChannelMembershipEnv, limit = 40): Promise<{ checked: number; blacklisted: number; rejoined: number }> {
  await ensureChannelMembershipSchema(env);
  const cutoff = new Date(Date.now() - BLACKLIST_AFTER_MS).toISOString();
  const pending = await env.DB.prepare(`SELECT user_telegram_id,last_status,last_checked_at,left_at,rejoined_at,blacklisted_at,blacklist_reason
    FROM channel_access_state WHERE blacklisted_at IS NULL AND left_at IS NOT NULL AND left_at<=? ORDER BY left_at ASC LIMIT ?`)
    .bind(cutoff, limit).all<AccessRow>();
  const target = await targetChat(env);
  if (!target) return { checked: 0, blacklisted: 0, rejoined: 0 };
  let checked = 0, blacklisted = 0, rejoined = 0;
  for (const row of pending.results) {
    checked += 1;
    try {
      const member = await telegramCall<ChatMember>(env, 'getChatMember', { chat_id: target, user_id: Number(row.user_telegram_id) });
      if (isMember(member)) {
        await rememberStatus(env, row.user_telegram_id, member.status, { rejoined: true });
        rejoined += 1;
        continue;
      }
      await env.DB.prepare(`UPDATE channel_access_state SET last_status=?,last_checked_at=CURRENT_TIMESTAMP,
        blacklisted_at=CURRENT_TIMESTAMP,blacklist_reason='left_after_download_48h',updated_at=CURRENT_TIMESTAMP
        WHERE user_telegram_id=? AND blacklisted_at IS NULL`).bind(member.status, row.user_telegram_id).run();
      blacklisted += 1;
    } catch {
      // Fail open for the scheduled punishment path: a Telegram outage must never blacklist someone.
    }
  }
  return { checked, blacklisted, rejoined };
}

export async function ensureWebhookMembershipUpdates(env: ChannelMembershipEnv): Promise<boolean> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret) return false;
  const info = await telegramCall<{ url?: string; allowed_updates?: string[] }>(env, 'getWebhookInfo', {});
  const webhookUrl = info.url?.trim();
  if (!webhookUrl) return false;
  const current = new Set(info.allowed_updates || []);
  if (REQUIRED_UPDATES.every((item) => current.has(item))) return false;
  await telegramCall(env, 'setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: [...REQUIRED_UPDATES],
    drop_pending_updates: false,
  });
  return true;
}

export async function handleChannelMembershipAdmin(request: Request, env: ChannelMembershipEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/membership-access' && !/^\/api\/admin\/membership-access\/\d+\/unblock$/.test(url.pathname)) return null;
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  await ensureChannelMembershipSchema(env);
  if (request.method === 'GET' && url.pathname === '/api/admin/membership-access') {
    const rows = await env.DB.prepare(`SELECT a.user_telegram_id,a.last_status,a.last_checked_at,a.left_at,a.rejoined_at,a.blacklisted_at,a.blacklist_reason,
      u.username,u.first_name,u.last_name,
      (SELECT COUNT(*) FROM publication_deliveries d WHERE d.user_telegram_id=a.user_telegram_id AND d.first_delivered_at IS NOT NULL) delivered_assets
      FROM channel_access_state a LEFT JOIN users u ON u.telegram_id=a.user_telegram_id
      WHERE a.blacklisted_at IS NOT NULL OR a.left_at IS NOT NULL
      ORDER BY CASE WHEN a.blacklisted_at IS NOT NULL THEN 0 ELSE 1 END,a.blacklisted_at DESC,a.left_at ASC LIMIT 200`).all<Record<string, unknown>>();
    const summary = await env.DB.prepare(`SELECT
      SUM(CASE WHEN blacklisted_at IS NOT NULL THEN 1 ELSE 0 END) blacklisted,
      SUM(CASE WHEN blacklisted_at IS NULL AND left_at IS NOT NULL THEN 1 ELSE 0 END) grace_period
      FROM channel_access_state`).first<Record<string, number | string | null>>();
    return json({ summary: { blacklisted: Number(summary?.blacklisted || 0), grace_period: Number(summary?.grace_period || 0) }, users: rows.results });
  }
  const match = /^\/api\/admin\/membership-access\/(\d+)\/unblock$/.exec(url.pathname);
  if (request.method === 'POST' && match) {
    await env.DB.prepare(`UPDATE channel_access_state SET blacklisted_at=NULL,blacklist_reason=NULL,left_at=NULL,
      last_status='manual_unblock',last_checked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE user_telegram_id=?`).bind(match[1]).run();
    return json({ ok: true, user_telegram_id: match[1], admin_user_id: admin.id });
  }
  return json({ error: 'Method not allowed.' }, 405);
}
