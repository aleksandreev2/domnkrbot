import { ensurePublicationOpsSchema, BOOSTY_SUPPORT_URL, type PublicationOpsEnv } from './publication-ops.js';
import { firstAdminId, requireAdminSession } from './web-auth.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<any>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }
interface R2ObjectLike {
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2BucketLike { get(key: string): Promise<R2ObjectLike | null> }

export interface PublicationCommentGateEnv extends PublicationOpsEnv {
  DB: D1DatabaseLike;
  FILES?: R2BucketLike;
}
export interface CommentGateExecutionContext { waitUntil(promise: Promise<unknown>): void }

type Publication = {
  id: number;
  status: string;
  internal_title: string;
  body_html: string;
  add_footer: number;
  add_bot_comment: number;
  image_key: string | null;
  image_mime: string | null;
  image_name: string | null;
  channel_message_id: number | null;
  discussion_message_id: number | null;
};
type Asset = { id: number; file_name: string };
type TelegramMessage = {
  message_id: number;
  chat: { id: number | string; type?: string };
  is_automatic_forward?: boolean;
  forward_origin?: { type?: string; message_id?: number };
};
type TelegramCallbackQuery = {
  id: string;
  from: { id: number; username?: string; first_name?: string };
  data?: string;
  message?: TelegramMessage;
};
type TelegramUpdate = { message?: TelegramMessage; callback_query?: TelegramCallbackQuery };
type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string };
type ChatInfo = { id: number | string; type?: string; linked_chat_id?: number | string };
type GateRow = {
  publication_id: number;
  discussion_message_id: number | null;
  gate_message_id: number | null;
  status: string;
  attempts: number;
  last_error: string | null;
};

const MAX_BODY = 700;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
let gateSchemaPromise: Promise<void> | null = null;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char] || char));

function normalizeChatId(value: string): string | number {
  const raw = value.trim();
  if (/^-?\d+$/.test(raw)) {
    const number = Number(raw);
    if (Number.isSafeInteger(number)) return number;
  }
  return raw.startsWith('@') ? raw : `@${raw}`;
}
function botName(env: PublicationCommentGateEnv): string {
  return (env.BOT_USERNAME || 'domnekromanta_bot').replace(/^@/, '');
}
function downloadUrl(env: PublicationCommentGateEnv, publicationId: number): string {
  return `https://t.me/${botName(env)}?start=dl_${publicationId}`;
}
function supportRedirect(origin: string, publicationId: number): string {
  const url = new URL('/go/support', origin);
  url.searchParams.set('publication', String(publicationId));
  url.searchParams.set('source', 'discussion');
  return url.toString();
}

export function composeChannelPublication(
  publication: Pick<Publication, 'body_html' | 'add_footer'>,
  botUsername = 'domnekromanta_bot',
): string {
  const parts = [publication.body_html.trim()];
  if (publication.add_footer) {
    parts.push(`Дом Некроманта · переводы сообщества\nhttps://t.me/${botUsername.replace(/^@/, '')}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

export async function ensurePublicationCommentGateSchema(env: PublicationCommentGateEnv): Promise<void> {
  if (gateSchemaPromise) return gateSchemaPromise;
  gateSchemaPromise = (async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS publication_comment_gates (
      publication_id INTEGER PRIMARY KEY,
      discussion_message_id INTEGER,
      gate_message_id INTEGER,
      status TEXT NOT NULL DEFAULT 'waiting_forward',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(publication_id) REFERENCES publications(id) ON DELETE CASCADE
    )`).run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_publication_comment_gates_status ON publication_comment_gates(status, updated_at DESC)').run();
  })().catch((error) => {
    gateSchemaPromise = null;
    throw error;
  });
  return gateSchemaPromise;
}

async function setting(env: PublicationCommentGateEnv, key: string): Promise<string> {
  try {
    return (await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>())?.value?.trim() || '';
  } catch {
    return '';
  }
}
async function getPublication(env: PublicationCommentGateEnv, id: number): Promise<Publication | null> {
  return env.DB.prepare(`SELECT id,status,internal_title,body_html,add_footer,add_bot_comment,image_key,image_mime,image_name,
    channel_message_id,discussion_message_id FROM publications WHERE id=?`).bind(id).first<Publication>();
}
async function publicationByChannelMessage(env: PublicationCommentGateEnv, messageId: number): Promise<Publication | null> {
  return env.DB.prepare(`SELECT id,status,internal_title,body_html,add_footer,add_bot_comment,image_key,image_mime,image_name,
    channel_message_id,discussion_message_id FROM publications WHERE channel_message_id=? AND status='published' ORDER BY id DESC LIMIT 1`)
    .bind(messageId).first<Publication>();
}
async function assets(env: PublicationCommentGateEnv, id: number): Promise<Asset[]> {
  return (await env.DB.prepare('SELECT id,file_name FROM publication_assets WHERE publication_id=? ORDER BY sort_order,id').bind(id).all<Asset>()).results;
}
async function gateRow(env: PublicationCommentGateEnv, id: number): Promise<GateRow | null> {
  await ensurePublicationCommentGateSchema(env);
  return env.DB.prepare(`SELECT publication_id,discussion_message_id,gate_message_id,status,attempts,last_error
    FROM publication_comment_gates WHERE publication_id=?`).bind(id).first<GateRow>();
}
async function log(env: PublicationCommentGateEnv, publicationId: number, level: string, event: string, message: string, details?: unknown): Promise<void> {
  await env.DB.prepare(`INSERT INTO publication_logs (publication_id,level,event,message,details,created_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)`).bind(
      publicationId, level, event, message, details === undefined ? null : JSON.stringify(details).slice(0, 1600),
    ).run().catch(() => undefined);
}
async function recordEvent(env: PublicationCommentGateEnv, publicationId: number, eventType: string, userId: number | null, details?: unknown): Promise<void> {
  await ensurePublicationOpsSchema(env);
  await env.DB.prepare(`INSERT INTO publication_reader_events
    (publication_id,asset_id,user_telegram_id,event_type,source,success,repeat,details,created_at)
    VALUES (?,NULL,?,?,'discussion',1,0,?,CURRENT_TIMESTAMP)`).bind(
      publicationId, userId == null ? null : String(userId), eventType,
      details === undefined ? null : JSON.stringify(details).slice(0, 1200),
    ).run().catch(() => undefined);
}

async function telegramCall<T>(env: PublicationCommentGateEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  return body.result as T;
}
async function r2Blob(env: PublicationCommentGateEnv, key: string, name: string, mime: string | null): Promise<Blob> {
  if (!env.FILES) throw new Error('R2 FILES binding is not configured');
  const object = await env.FILES.get(key);
  if (!object) throw new Error(`Stored image is missing: ${name}`);
  return new Blob([await object.arrayBuffer()], { type: mime || object.httpMetadata?.contentType || 'application/octet-stream' });
}
async function sendChannelPost(env: PublicationCommentGateEnv, chatId: string | number, pub: Publication, text: string): Promise<TelegramMessage> {
  if (!pub.image_key) {
    return telegramCall<TelegramMessage>(env, 'sendMessage', {
      chat_id: chatId, text, link_preview_options: { is_disabled: true },
    });
  }
  if (text.length > 1024) throw new Error(`Telegram caption занимает ${text.length} / 1024 символов.`);
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', text);
  form.set('photo', await r2Blob(env, pub.image_key, pub.image_name || 'cover.jpg', pub.image_mime), pub.image_name || 'cover.jpg');
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
  const body = await response.json().catch(() => null) as TelegramResponse<TelegramMessage> | null;
  if (!response.ok || !body?.ok || !body.result) throw new Error(body?.description || `Telegram sendPhoto failed with HTTP ${response.status}`);
  return body.result;
}

async function linkedDiscussionId(env: PublicationCommentGateEnv): Promise<number | string | null> {
  const channel = await setting(env, 'publish_channel_id');
  if (!channel) return null;
  try {
    const info = await telegramCall<ChatInfo>(env, 'getChat', { chat_id: normalizeChatId(channel) });
    return info.linked_chat_id ?? null;
  } catch {
    return null;
  }
}

function gateMessage(pub: Publication, fileCount: number, env: PublicationCommentGateEnv): string {
  const lines = [`<b>${escapeHtml(pub.internal_title || `Релиз #${pub.id}`)}</b>`];
  if (fileCount > 0) {
    lines.push('', `📥 Файлы релиза выдаёт @${escapeHtml(botName(env))} в личных сообщениях.`);
    lines.push('Нажмите «Скачать». Если Telegram покажет «Запустить» — нажмите один раз, и бот сразу продолжит выдачу.');
  }
  lines.push('', '❤️ Если перевод понравился, можно поддержать переводчика.');
  return lines.join('\n');
}
function gateKeyboard(pub: Publication, fileCount: number, env: PublicationCommentGateEnv, origin: string): Record<string, unknown> {
  const buttons: Array<Record<string, string>> = [];
  if (fileCount > 0) buttons.push({ text: '📥 Скачать', callback_data: `gate-download:${pub.id}` });
  buttons.push({ text: '❤️ Поддержать переводчика', url: supportRedirect(origin, pub.id) });
  return { inline_keyboard: [buttons] };
}

async function deliverGateComment(
  env: PublicationCommentGateEnv,
  pub: Publication,
  discussionMessageId: number,
  discussionChatId: number | string,
  origin: string,
): Promise<{ sent: boolean; messageId?: number }> {
  await ensurePublicationCommentGateSchema(env);
  const fileCount = (await assets(env, pub.id)).length;
  if (fileCount === 0 && pub.add_bot_comment !== 1) return { sent: false };

  const existing = await gateRow(env, pub.id);
  if (existing?.status === 'sent' && Number(existing.discussion_message_id) === Number(discussionMessageId) && existing.gate_message_id) {
    return { sent: false, messageId: existing.gate_message_id };
  }

  await env.DB.prepare(`INSERT INTO publication_comment_gates
      (publication_id,discussion_message_id,gate_message_id,status,attempts,last_error,created_at,updated_at)
      VALUES (?,?,NULL,'pending',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT(publication_id) DO UPDATE SET discussion_message_id=excluded.discussion_message_id,
        status='pending',attempts=publication_comment_gates.attempts+1,last_error=NULL,updated_at=CURRENT_TIMESTAMP`)
    .bind(pub.id, discussionMessageId).run();

  try {
    const sent = await telegramCall<TelegramMessage>(env, 'sendMessage', {
      chat_id: discussionChatId,
      text: gateMessage(pub, fileCount, env),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_parameters: { message_id: discussionMessageId },
      reply_markup: gateKeyboard(pub, fileCount, env, origin),
    });
    await env.DB.prepare(`UPDATE publication_comment_gates SET gate_message_id=?,status='sent',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE publication_id=?`)
      .bind(sent.message_id, pub.id).run();
    await log(env, pub.id, 'success', 'comment_gate_sent', 'Download/support gate отправлен одним комментарием в discussion thread.', {
      gateMessageId: sent.message_id, discussionMessageId, fileCount,
    });
    return { sent: true, messageId: sent.message_id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`UPDATE publication_comment_gates SET status='failed',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE publication_id=?`)
      .bind(message.slice(0, 1000), pub.id).run().catch(() => undefined);
    await log(env, pub.id, 'error', 'comment_gate_failed', 'Не удалось отправить download/support gate в discussion thread.', message);
    throw error;
  }
}

async function publish(request: Request, env: PublicationCommentGateEnv, id: number): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  await ensurePublicationCommentGateSchema(env);
  const pub = await getPublication(env, id);
  if (!pub) return json({ error: 'Публикация не найдена.' }, 404);
  if (pub.status === 'published') return json({ error: 'Публикация уже отправлена.' }, 409);
  if (pub.status === 'deleted') return json({ error: 'Архивную публикацию нельзя отправить повторно.' }, 409);
  const channel = await setting(env, 'publish_channel_id');
  if (!channel) return json({ error: 'Канал публикации не настроен.' }, 409);
  const fileCount = (await assets(env, id)).length;
  const needsGate = fileCount > 0 || pub.add_bot_comment === 1;
  const discussion = needsGate ? await linkedDiscussionId(env) : null;
  if (needsGate && !discussion) {
    return json({ error: 'Для download/support gate нужна связанная discussion group: служебные кнопки больше не публикуются в самом канале.' }, 409);
  }
  const text = composeChannelPublication(pub, botName(env));
  if (pub.image_key && text.length > 1024) return json({ error: `Telegram caption занимает ${text.length} / 1024 символов.` }, 400);

  await env.DB.prepare("UPDATE publications SET status='publishing',error_text=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
  try {
    const sent = await sendChannelPost(env, normalizeChatId(channel), pub, text);
    await env.DB.prepare("UPDATE publications SET status='published',channel_message_id=?,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,error_text=NULL WHERE id=?")
      .bind(sent.message_id, id).run();
    if (needsGate) {
      await env.DB.prepare(`INSERT INTO publication_comment_gates(publication_id,status,attempts,created_at,updated_at)
        VALUES (?,'waiting_forward',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        ON CONFLICT(publication_id) DO UPDATE SET status='waiting_forward',last_error=NULL,updated_at=CURRENT_TIMESTAMP`).bind(id).run();
    }
    await log(env, id, 'success', 'published_waiting_comment_gate', 'Пост опубликован без inline-кнопок; gate появится в комментариях после automatic forward.', {
      adminUserId: admin.id, fileCount, channelMessageId: sent.message_id,
    });
    return json({ ok: true, publication: await getPublication(env, id), delivery: { mode: fileCount ? 'comment_gate_bot_private' : needsGate ? 'comment_support' : 'none', waitingForDiscussion: needsGate } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare("UPDATE publications SET status='failed',error_text=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(message.slice(0, 1000), id).run().catch(() => undefined);
    await log(env, id, 'error', 'publish_failed', 'Telegram не опубликовал чистый канальный пост.', message);
    return json({ error: message }, 502);
  }
}

async function testPublication(request: Request, env: PublicationCommentGateEnv, id: number): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const pub = await getPublication(env, id);
  if (!pub) return json({ error: 'Публикация не найдена.' }, 404);
  const target = firstAdminId(env);
  if (!target) return json({ error: 'ADMIN_TELEGRAM_IDS не настроен.' }, 409);
  const fileRows = await assets(env, id);
  const channelText = `🧪 КАНАЛ · без служебных кнопок\n\n${composeChannelPublication(pub, botName(env))}`;
  try {
    await sendChannelPost(env, target, pub, channelText);
    const preview = [
      '🧪 КОММЕНТАРИЙ БОТА',
      '',
      gateMessage(pub, fileRows.length, env).replace(/<\/?b>/g, ''),
      '',
      fileRows.length ? `Вложений для приватной выдачи: ${fileRows.length}.` : 'Файлов для приватной выдачи нет.',
      fileRows.length ? fileRows.map((asset) => `• ${asset.file_name}`).join('\n') : '',
      '',
      'В реальной публикации кнопки «Скачать» и «Поддержать переводчика» появятся только в этом комментарии.',
    ].filter(Boolean).join('\n');
    await telegramCall(env, 'sendMessage', { chat_id: target, text: preview, link_preview_options: { is_disabled: true } });
    await log(env, id, 'success', 'comment_gate_test_sent', 'Тест показал отдельно чистый пост канала и будущий gate-комментарий.', { adminUserId: admin.id, fileCount: fileRows.length });
    return json({ ok: true, channelClean: true, commentGatePreview: true, fileCount: fileRows.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(env, id, 'error', 'comment_gate_test_failed', 'Тест comment-gate публикации не отправлен.', message);
    return json({ error: message }, 502);
  }
}

async function edit(request: Request, env: PublicationCommentGateEnv, id: number): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const pub = await getPublication(env, id);
  if (!pub) return json({ error: 'Публикация не найдена.' }, 404);
  const input = await request.json().catch(() => null) as { body?: unknown } | null;
  const body = typeof input?.body === 'string' ? input.body.trim() : '';
  if (!body || body.length > MAX_BODY) return json({ error: `Текст должен содержать от 1 до ${MAX_BODY} символов.` }, 400);
  const text = composeChannelPublication({ ...pub, body_html: body }, botName(env));
  if (pub.image_key && text.length > 1024) return json({ error: `Telegram caption занимает ${text.length} / 1024 символов.` }, 400);

  if (pub.status === 'published') {
    const channel = await setting(env, 'publish_channel_id');
    if (!channel || !pub.channel_message_id) return json({ error: 'У опубликованного поста нет канала или Telegram message ID.' }, 409);
    try {
      const common = { chat_id: normalizeChatId(channel), message_id: pub.channel_message_id, reply_markup: { inline_keyboard: [] } };
      if (pub.image_key) await telegramCall(env, 'editMessageCaption', { ...common, caption: text });
      else await telegramCall(env, 'editMessageText', { ...common, text, link_preview_options: { is_disabled: true } });
    } catch (error) {
      await log(env, id, 'error', 'clean_post_edit_failed', 'Telegram не обновил чистый канальный пост; D1 не изменён.', String(error));
      return json({ error: error instanceof Error ? error.message : 'Telegram не обновил пост.' }, 502);
    }
  }
  await env.DB.prepare('UPDATE publications SET body_html=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(body, id).run();
  await log(env, id, 'success', 'clean_post_edited', 'Текст обновлён; inline-кнопки канального поста удалены.', { adminUserId: admin.id });
  return json({ ok: true, id, body_html: body });
}

async function reconcile(request: Request, env: PublicationCommentGateEnv, id: number): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const pub = await getPublication(env, id);
  if (!pub || pub.status !== 'published') return json({ error: 'Нужна опубликованная публикация.' }, 409);
  const channel = await setting(env, 'publish_channel_id');
  if (!channel || !pub.channel_message_id) return json({ error: 'Нет Telegram channel message ID.' }, 409);
  const text = composeChannelPublication(pub, botName(env));
  try {
    const common = { chat_id: normalizeChatId(channel), message_id: pub.channel_message_id, reply_markup: { inline_keyboard: [] } };
    if (pub.image_key) await telegramCall(env, 'editMessageCaption', { ...common, caption: text });
    else await telegramCall(env, 'editMessageText', { ...common, text, link_preview_options: { is_disabled: true } });
    await log(env, id, 'success', 'channel_cta_removed', 'Inline-кнопки и служебный CTA удалены из канального поста.', { adminUserId: admin.id });
    return json({
      ok: true,
      cleanedChannelPost: true,
      discussionMessageId: pub.discussion_message_id,
      note: pub.discussion_message_id
        ? 'Канал очищен. Существующий комментарий не дублировался.'
        : 'Канал очищен. Для старого поста automatic forward уже нельзя безопасно переотправить без риска дубля.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(env, id, 'error', 'channel_cta_remove_failed', 'Не удалось удалить inline-кнопки из канального поста.', message);
    return json({ error: message }, 502);
  }
}

async function handleGateCallback(env: PublicationCommentGateEnv, callback: TelegramCallbackQuery): Promise<void> {
  const match = /^gate-download:(\d+)$/.exec(callback.data || '');
  if (!match) return;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id < 1) {
    await telegramCall(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Некорректный релиз.' }).catch(() => undefined);
    return;
  }
  const [pub, gate] = await Promise.all([getPublication(env, id), gateRow(env, id)]);
  const validMessage = Boolean(callback.message && gate?.gate_message_id && Number(callback.message.message_id) === Number(gate.gate_message_id));
  if (!pub || pub.status !== 'published' || gate?.status !== 'sent' || !validMessage) {
    await telegramCall(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Эта кнопка уже неактивна.' }).catch(() => undefined);
    return;
  }
  await recordEvent(env, id, 'download_gate_click', callback.from.id, { gateMessageId: gate.gate_message_id }).catch(() => undefined);
  await telegramCall(env, 'answerCallbackQuery', {
    callback_query_id: callback.id,
    url: downloadUrl(env, id),
  }).catch(async () => {
    await telegramCall(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Откройте бота, чтобы скачать файлы.' }).catch(() => undefined);
  });
}

async function handleAutomaticForward(env: PublicationCommentGateEnv, message: TelegramMessage, origin: string, ctx: CommentGateExecutionContext): Promise<boolean> {
  if (!message.is_automatic_forward || message.forward_origin?.type !== 'channel' || !message.forward_origin.message_id) return false;
  const linked = await linkedDiscussionId(env);
  if (linked == null || Number(linked) !== Number(message.chat.id)) return false;
  const pub = await publicationByChannelMessage(env, message.forward_origin.message_id);
  if (!pub) return false;
  await ensurePublicationCommentGateSchema(env);
  await env.DB.prepare('UPDATE publications SET discussion_message_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(message.message_id, pub.id).run();
  ctx.waitUntil(deliverGateComment(env, { ...pub, discussion_message_id: message.message_id }, message.message_id, message.chat.id, origin).catch(() => undefined));
  return true;
}

export async function handlePublicationCommentGateWebhook(
  request: Request,
  env: PublicationCommentGateEnv,
  ctx: CommentGateExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/webhook' || request.method !== 'POST') return null;
  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (expected && request.headers.get('x-telegram-bot-api-secret-token') !== expected) return new Response('Forbidden', { status: 403 });
  const update = await request.clone().json().catch(() => null) as TelegramUpdate | null;
  if (!update) return null;
  if (update.callback_query?.data?.startsWith('gate-download:')) {
    ctx.waitUntil(handleGateCallback(env, update.callback_query));
    return new Response('ok');
  }
  if (update.message && await handleAutomaticForward(env, update.message, url.origin, ctx)) return new Response('ok');
  return null;
}

export async function handlePublicationCommentGateRequest(request: Request, env: PublicationCommentGateEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/admin\/publications\/(\d+)\/(test|publish|edit|reconcile-gate)$/.exec(url.pathname);
  if (!match || request.method !== 'POST') return null;
  const id = Number(match[1]);
  if (match[2] === 'publish') return publish(request, env, id);
  if (match[2] === 'test') return testPublication(request, env, id);
  if (match[2] === 'edit') return edit(request, env, id);
  return reconcile(request, env, id);
}

export const publicationCommentGateSupportUrl = BOOSTY_SUPPORT_URL;
