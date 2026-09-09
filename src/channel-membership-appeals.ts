import { ensureChannelMembershipSchema, unblockChannelMember, type ChannelMembershipEnv } from './channel-membership-access.js';
import { isAdminUser, requireAdminSession, type WebAuthEnv } from './web-auth.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<unknown>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }

export interface ChannelMembershipAppealEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
  TELEGRAM_WEBHOOK_SECRET?: string;
  PUBLISH_CHANNEL_ID?: string;
}
export interface AppealExecutionContext { waitUntil(promise: Promise<unknown>): void }

type TelegramUser = { id: number; username?: string; first_name?: string; last_name?: string };
type TelegramChat = { id: number | string; type?: string };
type TelegramMessage = { message_id?: number; chat: TelegramChat; from?: TelegramUser; text?: string };
type TelegramCallbackQuery = { id: string; from: TelegramUser; data?: string; message?: TelegramMessage };
type TelegramUpdate = { message?: TelegramMessage; callback_query?: TelegramCallbackQuery };
type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string };

type AccessRow = {
  user_telegram_id: string;
  blacklisted_at: string | null;
  blacklist_reason: string | null;
  left_at?: string | null;
  last_status?: string | null;
};
type AppealRow = {
  id: string;
  user_telegram_id: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'cancelled';
  user_comment: string;
  admin_comment: string | null;
  submitted_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
};

type AppealAdminRow = AppealRow & {
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  blacklisted_at?: string | null;
  blacklist_reason?: string | null;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const APPEAL_COMMENT_MAX = 1500;
const appealSchemaPromises = new WeakMap<object, Promise<void>>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function adminTelegramIds(env: WebAuthEnv): number[] {
  const values = String(env.ADMIN_TELEGRAM_IDS ?? '')
    .split(/[,\s]+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return [...new Set(values)];
}

async function telegramCall<T>(env: ChannelMembershipAppealEnv, method: string, payload: Record<string, unknown>): Promise<T> {
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

async function initializeAppealSchema(env: ChannelMembershipAppealEnv): Promise<void> {
  await ensureChannelMembershipSchema(env as ChannelMembershipEnv);
  const statements = [
    `CREATE TABLE IF NOT EXISTS channel_membership_appeals (
      id TEXT PRIMARY KEY,
      user_telegram_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      user_comment TEXT NOT NULL DEFAULT '',
      admin_comment TEXT,
      submitted_at TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX IF NOT EXISTS idx_channel_membership_appeals_user ON channel_membership_appeals(user_telegram_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_channel_membership_appeals_status ON channel_membership_appeals(status, submitted_at DESC, created_at DESC)',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_membership_appeals_one_open
      ON channel_membership_appeals(user_telegram_id) WHERE status IN ('draft','pending')`,
  ];
  for (const statement of statements) await env.DB.prepare(statement).run();
}

async function ensureAppealSchema(env: ChannelMembershipAppealEnv): Promise<void> {
  const key = env.DB as object;
  const existing = appealSchemaPromises.get(key);
  if (existing) return existing;

  const promise = initializeAppealSchema(env).catch((error) => {
    appealSchemaPromises.delete(key);
    throw error;
  });
  appealSchemaPromises.set(key, promise);
  return promise;
}

async function setting(env: ChannelMembershipAppealEnv, key: string): Promise<string> {
  try {
    return (await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>())?.value?.trim() || '';
  } catch {
    return '';
  }
}

async function targetChat(env: ChannelMembershipAppealEnv): Promise<string> {
  return (await setting(env, 'publish_channel_id')) || env.PUBLISH_CHANNEL_ID?.trim() || '';
}

async function accessRow(env: ChannelMembershipAppealEnv, userId: number | string): Promise<AccessRow | null> {
  await ensureAppealSchema(env);
  return env.DB.prepare(`SELECT user_telegram_id,blacklisted_at,blacklist_reason,left_at,last_status
    FROM channel_access_state WHERE user_telegram_id=?`).bind(String(userId)).first<AccessRow>();
}

async function openAppeal(env: ChannelMembershipAppealEnv, userId: number | string): Promise<AppealRow | null> {
  await ensureAppealSchema(env);
  return env.DB.prepare(`SELECT id,user_telegram_id,status,user_comment,admin_comment,submitted_at,resolved_at,resolved_by,created_at
    FROM channel_membership_appeals
    WHERE user_telegram_id=? AND status IN ('draft','pending')
    ORDER BY created_at DESC LIMIT 1`).bind(String(userId)).first<AppealRow>();
}

async function appealById(env: ChannelMembershipAppealEnv, appealIdValue: string): Promise<AppealRow | null> {
  await ensureAppealSchema(env);
  return env.DB.prepare(`SELECT id,user_telegram_id,status,user_comment,admin_comment,submitted_at,resolved_at,resolved_by,created_at
    FROM channel_membership_appeals WHERE id=?`).bind(appealIdValue).first<AppealRow>();
}

function appealId(): string {
  return `ap-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

async function ensurePhysicalBan(env: ChannelMembershipAppealEnv, userId: number): Promise<void> {
  const target = await targetChat(env);
  if (!target) return;
  try {
    await telegramCall<boolean>(env, 'banChatMember', { chat_id: target, user_id: userId });
    await env.DB.prepare(`INSERT INTO channel_telegram_bans
      (user_telegram_id,banned_at,last_attempt_at,last_error,updated_at)
      VALUES (?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL,CURRENT_TIMESTAMP)
      ON CONFLICT(user_telegram_id) DO UPDATE SET
        banned_at=COALESCE(channel_telegram_bans.banned_at,CURRENT_TIMESTAMP),last_attempt_at=CURRENT_TIMESTAMP,
        last_error=NULL,updated_at=CURRENT_TIMESTAMP`).bind(String(userId)).run();
  } catch (error) {
    await env.DB.prepare(`INSERT INTO channel_telegram_bans
      (user_telegram_id,banned_at,last_attempt_at,last_error,updated_at)
      VALUES (?,NULL,CURRENT_TIMESTAMP,?,CURRENT_TIMESTAMP)
      ON CONFLICT(user_telegram_id) DO UPDATE SET
        last_attempt_at=CURRENT_TIMESTAMP,last_error=excluded.last_error,updated_at=CURRENT_TIMESTAMP`)
      .bind(String(userId), errorText(error)).run().catch(() => undefined);
  }
}

async function sendBlacklistedWithAppeal(env: ChannelMembershipAppealEnv, userId: number): Promise<void> {
  await telegramCall(env, 'sendMessage', {
    chat_id: userId,
    text: 'Доступ к скачиваниям ограничен: после зафиксированной подписки был зарегистрирован выход из канала «Дом Некроманта». Если блокировка произошла по ошибке, подайте апелляцию — администратор проверит ситуацию вручную.',
    reply_markup: {
      inline_keyboard: [[{ text: '📝 Подать апелляцию', callback_data: 'membership:appeal' }]],
    },
  }).catch(() => undefined);
}

async function answerCallback(env: ChannelMembershipAppealEnv, callbackId: string, text: string): Promise<void> {
  await telegramCall(env, 'answerCallbackQuery', { callback_query_id: callbackId, text }).catch(() => undefined);
}

async function sendAppealPrompt(env: ChannelMembershipAppealEnv, userId: number, appeal: AppealRow): Promise<void> {
  const pending = appeal.status === 'pending';
  await telegramCall(env, 'sendMessage', {
    chat_id: userId,
    text: pending
      ? 'Ваша апелляция уже отправлена и находится на рассмотрении. Новую заявку можно будет подать после решения по текущей.'
      : `Опишите, почему блокировка могла произойти по ошибке.\n\nОтправьте одним сообщением комментарий до ${APPEAL_COMMENT_MAX} символов.`,
    ...(pending ? {} : {
      reply_markup: { inline_keyboard: [[{ text: 'Отмена', callback_data: 'membership:appeal:cancel' }]] },
    }),
  }).catch(() => undefined);
}

async function startAppeal(env: ChannelMembershipAppealEnv, user: TelegramUser): Promise<void> {
  const access = await accessRow(env, user.id);
  if (!access?.blacklisted_at) {
    await telegramCall(env, 'sendMessage', { chat_id: user.id, text: 'Сейчас на вашем аккаунте нет блокировки, которую можно обжаловать.' }).catch(() => undefined);
    return;
  }
  const current = await openAppeal(env, user.id);
  if (current) {
    await sendAppealPrompt(env, user.id, current);
    return;
  }
  const id = appealId();
  try {
    await env.DB.prepare(`INSERT INTO channel_membership_appeals
      (id,user_telegram_id,status,user_comment,created_at,updated_at)
      VALUES (?,?,'draft','',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(id, String(user.id)).run();
  } catch {
    const raced = await openAppeal(env, user.id);
    if (raced) {
      await sendAppealPrompt(env, user.id, raced);
      return;
    }
    throw new Error('Не удалось создать апелляцию.');
  }
  await sendAppealPrompt(env, user.id, {
    id,
    user_telegram_id: String(user.id),
    status: 'draft',
    user_comment: '',
    admin_comment: null,
    submitted_at: null,
    resolved_at: null,
    resolved_by: null,
    created_at: new Date().toISOString(),
  });
}

function userLabel(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || `ID ${user.id}`;
}

async function notifyAppealAdmins(
  env: ChannelMembershipAppealEnv,
  user: TelegramUser,
  appeal: AppealRow,
  access: AccessRow | null,
): Promise<void> {
  const text = [
    '🛡 Новая апелляция на блокировку',
    '',
    `Пользователь: ${userLabel(user)} (${user.id})`,
    `Причина блокировки: ${access?.blacklist_reason || 'не указана'}`,
    `Дата блокировки: ${access?.blacklisted_at || '—'}`,
    '',
    'Комментарий пользователя:',
    appeal.user_comment,
  ].join('\n');
  const replyMarkup = {
    inline_keyboard: [[
      { text: '✅ Разблокировать', callback_data: `membership:appeal:approve:${appeal.id}` },
      { text: '❌ Отклонить', callback_data: `membership:appeal:reject:${appeal.id}` },
    ]],
  };
  for (const adminId of adminTelegramIds(env)) {
    await telegramCall(env, 'sendMessage', { chat_id: adminId, text, reply_markup: replyMarkup }).catch((error) => {
      console.error('Membership appeal admin notification failed', { adminId, error: errorText(error) });
    });
  }
}

async function submitAppealComment(env: ChannelMembershipAppealEnv, message: TelegramMessage): Promise<boolean> {
  const user = message.from;
  if (!user || message.chat.type !== 'private' || typeof message.text !== 'string') return false;
  const appeal = await openAppeal(env, user.id);
  if (!appeal || appeal.status !== 'draft') return false;
  const comment = message.text.trim();
  if (comment === '/cancel') {
    await env.DB.prepare(`UPDATE channel_membership_appeals SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'`)
      .bind(appeal.id).run();
    await telegramCall(env, 'sendMessage', { chat_id: user.id, text: 'Апелляция отменена.' }).catch(() => undefined);
    return true;
  }
  if (comment.startsWith('/')) return false;
  if (comment.length < 5) {
    await telegramCall(env, 'sendMessage', { chat_id: user.id, text: 'Комментарий слишком короткий. Опишите ситуацию чуть подробнее.' }).catch(() => undefined);
    return true;
  }
  if (comment.length > APPEAL_COMMENT_MAX) {
    await telegramCall(env, 'sendMessage', { chat_id: user.id, text: `Комментарий слишком длинный. Максимум — ${APPEAL_COMMENT_MAX} символов.` }).catch(() => undefined);
    return true;
  }
  await env.DB.prepare(`UPDATE channel_membership_appeals SET status='pending',user_comment=?,submitted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='draft'`).bind(comment, appeal.id).run();
  const submitted: AppealRow = { ...appeal, status: 'pending', user_comment: comment, submitted_at: new Date().toISOString() };
  const access = await accessRow(env, user.id);
  await notifyAppealAdmins(env, user, submitted, access);
  await telegramCall(env, 'sendMessage', {
    chat_id: user.id,
    text: 'Апелляция отправлена. Администратор проверит блокировку вручную, а решение придёт сюда в бот.',
  }).catch(() => undefined);
  return true;
}

async function resolveAppeal(
  env: ChannelMembershipAppealEnv,
  appeal: AppealRow,
  decision: 'approved' | 'rejected',
  adminId: number | string,
  adminComment = '',
): Promise<{ ok: boolean; error?: string }> {
  if (appeal.status !== 'pending') return { ok: false, error: 'Апелляция уже обработана.' };
  const comment = adminComment.trim().slice(0, APPEAL_COMMENT_MAX);
  if (decision === 'approved') {
    const unblocked = await unblockChannelMember(env as ChannelMembershipEnv, appeal.user_telegram_id);
    if (!unblocked) return { ok: false, error: 'Telegram не подтвердил снятие блокировки. Апелляция оставлена на рассмотрении.' };
    await env.DB.prepare(`UPDATE channel_membership_appeals SET status='approved',admin_comment=?,resolved_by=?,resolved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='pending'`).bind(comment, String(adminId), appeal.id).run();
  } else {
    await env.DB.prepare(`UPDATE channel_membership_appeals SET status='rejected',admin_comment=?,resolved_by=?,resolved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='pending'`).bind(comment, String(adminId), appeal.id).run();
  }
  const suffix = comment ? `\n\nКомментарий администратора:\n${comment}` : '';
  await telegramCall(env, 'sendMessage', {
    chat_id: Number(appeal.user_telegram_id),
    text: decision === 'approved'
      ? `✅ Апелляция одобрена. Блокировка снята.${suffix}`
      : `❌ Апелляция отклонена. Ограничение остаётся в силе.${suffix}`,
  }).catch(() => undefined);
  return { ok: true };
}

async function handleAppealCallback(env: ChannelMembershipAppealEnv, callback: TelegramCallbackQuery): Promise<Response | null> {
  const data = callback.data || '';
  if (data === 'membership:appeal') {
    await startAppeal(env, callback.from);
    await answerCallback(env, callback.id, 'Апелляция');
    return new Response('ok');
  }
  if (data === 'membership:appeal:cancel') {
    const appeal = await openAppeal(env, callback.from.id);
    if (appeal?.status === 'draft') {
      await env.DB.prepare(`UPDATE channel_membership_appeals SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'`)
        .bind(appeal.id).run();
      await telegramCall(env, 'sendMessage', { chat_id: callback.from.id, text: 'Апелляция отменена.' }).catch(() => undefined);
    }
    await answerCallback(env, callback.id, 'Отменено');
    return new Response('ok');
  }
  const decision = /^membership:appeal:(approve|reject):(ap-[a-z0-9]+|[A-Za-z0-9_-]+)$/.exec(data);
  if (!decision) return null;
  const action = decision[1];
  const targetAppealId = decision[2];
  if (!action || !targetAppealId) return null;
  if (!isAdminUser(env, callback.from)) {
    await answerCallback(env, callback.id, 'Недостаточно прав.');
    return new Response('ok');
  }
  const row = await appealById(env, targetAppealId);
  if (!row) {
    await answerCallback(env, callback.id, 'Апелляция не найдена.');
    return new Response('ok');
  }
  const result = await resolveAppeal(env, row, action === 'approve' ? 'approved' : 'rejected', callback.from.id);
  await answerCallback(env, callback.id, result.ok ? (action === 'approve' ? 'Блокировка снята.' : 'Апелляция отклонена.') : result.error || 'Не удалось обработать.');
  if (result.ok && callback.message?.chat?.id && callback.message.message_id) {
    await telegramCall(env, 'editMessageReplyMarkup', {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => undefined);
  }
  return new Response('ok');
}

export async function handleChannelMembershipAppealWebhook(
  request: Request,
  env: ChannelMembershipAppealEnv,
  _ctx: AppealExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/webhook' || request.method !== 'POST') return null;
  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expected || request.headers.get('x-telegram-bot-api-secret-token') !== expected) return null;
  const update = await request.clone().json().catch(() => null) as TelegramUpdate | null;
  if (!update) return null;
  if (update.callback_query) {
    const handled = await handleAppealCallback(env, update.callback_query);
    if (handled) return handled;
  }
  const message = update.message;
  if (!message?.from || message.chat.type !== 'private') return null;
  if (await submitAppealComment(env, message)) return new Response('ok');
  if (/^\/start\s+dl_\d+\s*$/.test(message.text || '')) {
    const access = await accessRow(env, message.from.id);
    if (!access?.blacklisted_at) return null;
    await ensurePhysicalBan(env, message.from.id);
    await sendBlacklistedWithAppeal(env, message.from.id);
    return new Response('ok');
  }
  return null;
}

export async function handleChannelMembershipAppealAdmin(
  request: Request,
  env: ChannelMembershipAppealEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const resolveMatch = /^\/api\/admin\/membership-appeals\/([^/]+)\/resolve$/.exec(url.pathname);
  if (url.pathname !== '/api/admin/membership-appeals' && !resolveMatch) return null;
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  await ensureAppealSchema(env);
  if (request.method === 'GET' && url.pathname === '/api/admin/membership-appeals') {
    const rows = await env.DB.prepare(`SELECT a.id,a.user_telegram_id,a.status,a.user_comment,a.admin_comment,a.submitted_at,a.resolved_at,a.resolved_by,a.created_at,
      u.username,u.first_name,u.last_name,s.blacklisted_at,s.blacklist_reason
      FROM channel_membership_appeals a
      LEFT JOIN users u ON u.telegram_id=a.user_telegram_id
      LEFT JOIN channel_access_state s ON s.user_telegram_id=a.user_telegram_id
      ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
        COALESCE(a.submitted_at,a.created_at) DESC LIMIT 200`).all<AppealAdminRow>();
    return json({ appeals: rows.results });
  }
  if (request.method === 'POST' && resolveMatch?.[1]) {
    const body = await request.json().catch(() => null) as { decision?: string; adminComment?: string } | null;
    const decision = body?.decision === 'approve' ? 'approved' : body?.decision === 'reject' ? 'rejected' : null;
    if (!decision) return json({ error: 'decision must be approve or reject.' }, 400);
    const row = await appealById(env, resolveMatch[1]);
    if (!row) return json({ error: 'Апелляция не найдена.' }, 404);
    if (row.status !== 'pending') return json({ error: 'Апелляция уже обработана.' }, 409);
    const result = await resolveAppeal(env, row, decision, admin.id, body?.adminComment || '');
    if (!result.ok) return json({ error: result.error || 'Не удалось обработать апелляцию.' }, 502);
    return json({ ok: true, id: row.id, status: decision, admin_user_id: admin.id });
  }
  return json({ error: 'Method not allowed.' }, 405);
}
