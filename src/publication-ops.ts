import { firstAdminId, requireAdminSession, type WebAuthEnv } from './web-auth.js';

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
  size: number;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2BucketLike { get(key: string): Promise<R2ObjectLike | null> }

export interface PublicationOpsEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
  FILES?: R2BucketLike;
  TELEGRAM_WEBHOOK_SECRET?: string;
}
export interface ExecutionContextLike { waitUntil(promise: Promise<unknown>): void }

type PublicationRow = {
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
  error_text: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};
type AssetRow = {
  id: number;
  publication_id: number;
  file_name: string;
  mime_type: string | null;
  r2_key: string;
  size_bytes: number;
  telegram_file_id: string | null;
  sort_order: number;
};
type DeliveryRow = {
  status: string;
  attempts: number | string;
  first_delivered_at: string | null;
  last_delivered_at: string | null;
};
type TelegramUser = { id: number; username?: string; first_name: string; last_name?: string; language_code?: string };
type TelegramMessage = {
  message_id: number;
  chat: { id: number | string; type?: string };
  from?: TelegramUser;
  text?: string;
  is_automatic_forward?: boolean;
  forward_origin?: { type?: string; message_id?: number };
  document?: { file_id?: string };
};
type TelegramCallbackQuery = { id: string; from: TelegramUser; data?: string; message?: TelegramMessage };
type TelegramUpdate = { message?: TelegramMessage; callback_query?: TelegramCallbackQuery };
type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string; error_code?: number };

export const BOOSTY_SUPPORT_URL = 'https://boosty.to/domnekromanta/single-payment/donation/818248/target?share=target_link';
const MAX_BODY = 700;
const RESEND_COOLDOWN_MS = 60_000;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
let schemaPromise: Promise<void> | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function normalizeChatId(value: string): string | number {
  const raw = value.trim();
  if (/^-?\d+$/.test(raw)) {
    const number = Number(raw);
    if (Number.isSafeInteger(number)) return number;
  }
  return raw.startsWith('@') ? raw : `@${raw}`;
}
function botName(env: PublicationOpsEnv): string {
  return (env.BOT_USERNAME || 'domnekromanta_bot').replace(/^@/, '');
}
function downloadUrl(env: PublicationOpsEnv, publicationId: number): string {
  return `https://t.me/${botName(env)}?start=dl_${publicationId}`;
}
function supportRedirect(origin: string, publicationId: number, source: string): string {
  const url = new URL('/go/support', origin);
  url.searchParams.set('publication', String(publicationId));
  url.searchParams.set('source', source);
  return url.toString();
}
export function composeManagedPublication(publication: Pick<PublicationRow, 'id' | 'body_html' | 'add_footer'>, assetCount: number, botUsername = 'domnekromanta_bot'): string {
  const bot = botUsername.replace(/^@/, '');
  const parts = [publication.body_html.trim()];
  if (assetCount > 0) parts.push('📥 Скачать перевод можно через бота — кнопка под постом.');
  parts.push('❤️ Поддержать переводчика — кнопка под постом.');
  if (publication.add_footer) parts.push(`Дом Некроманта · переводы сообщества\nhttps://t.me/${bot}`);
  return parts.filter(Boolean).join('\n\n');
}
function publicationKeyboard(env: PublicationOpsEnv, origin: string, publicationId: number, assetCount: number, source: string): Record<string, unknown> {
  const row: Array<Record<string, string>> = [];
  if (assetCount > 0) row.push({ text: '📥 Скачать', url: downloadUrl(env, publicationId) });
  row.push({ text: '❤️ Поддержать переводчика', url: supportRedirect(origin, publicationId, source) });
  return { inline_keyboard: [row] };
}

export async function ensurePublicationOpsSchema(env: PublicationOpsEnv): Promise<void> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS publication_deliveries (
        publication_id INTEGER NOT NULL,
        asset_id INTEGER NOT NULL,
        user_telegram_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        first_delivered_at TEXT,
        last_delivered_at TEXT,
        telegram_message_id INTEGER,
        last_error TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (publication_id, asset_id, user_telegram_id),
        FOREIGN KEY(publication_id) REFERENCES publications(id) ON DELETE CASCADE,
        FOREIGN KEY(asset_id) REFERENCES publication_assets(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS publication_reader_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        publication_id INTEGER NOT NULL,
        asset_id INTEGER,
        user_telegram_id TEXT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'bot',
        success INTEGER NOT NULL DEFAULT 1,
        repeat INTEGER NOT NULL DEFAULT 0,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(publication_id) REFERENCES publications(id) ON DELETE CASCADE,
        FOREIGN KEY(asset_id) REFERENCES publication_assets(id) ON DELETE SET NULL
      )`,
      `CREATE TABLE IF NOT EXISTS publication_thanks (
        publication_id INTEGER NOT NULL,
        user_telegram_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (publication_id, user_telegram_id),
        FOREIGN KEY(publication_id) REFERENCES publications(id) ON DELETE CASCADE
      )`,
      'CREATE INDEX IF NOT EXISTS idx_publication_deliveries_user_updated ON publication_deliveries(user_telegram_id, updated_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_publication_reader_events_created ON publication_reader_events(created_at DESC, event_type)',
      'CREATE INDEX IF NOT EXISTS idx_publication_reader_events_publication ON publication_reader_events(publication_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_publication_reader_events_user ON publication_reader_events(user_telegram_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_publication_thanks_created ON publication_thanks(created_at DESC)',
    ];
    for (const statement of statements) await env.DB.prepare(statement).run();
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

async function setting(env: PublicationOpsEnv, key: string): Promise<string> {
  try {
    return (await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>())?.value?.trim() || '';
  } catch {
    return '';
  }
}
async function publication(env: PublicationOpsEnv, id: number): Promise<PublicationRow | null> {
  return env.DB.prepare(`SELECT id,status,internal_title,body_html,add_footer,add_bot_comment,image_key,image_mime,image_name,
    channel_message_id,discussion_message_id,error_text,created_by,created_at,updated_at,published_at FROM publications WHERE id=?`)
    .bind(id).first<PublicationRow>();
}
async function assets(env: PublicationOpsEnv, id: number): Promise<AssetRow[]> {
  const result = await env.DB.prepare(`SELECT id,publication_id,file_name,mime_type,r2_key,size_bytes,telegram_file_id,sort_order
    FROM publication_assets WHERE publication_id=? ORDER BY sort_order,id`).bind(id).all<AssetRow>();
  return result.results;
}
async function log(env: PublicationOpsEnv, publicationId: number, level: string, event: string, message: string, details?: unknown): Promise<void> {
  await env.DB.prepare(`INSERT INTO publication_logs (publication_id,level,event,message,details,created_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)`).bind(publicationId, level, event, message, details === undefined ? null : JSON.stringify(details).slice(0, 1800)).run().catch(() => undefined);
}
async function recordEvent(env: PublicationOpsEnv, publicationId: number, eventType: string, options: { assetId?: number | null; userId?: number | string | null; source?: string; success?: boolean; repeat?: boolean; details?: unknown } = {}): Promise<void> {
  await ensurePublicationOpsSchema(env);
  await env.DB.prepare(`INSERT INTO publication_reader_events
    (publication_id,asset_id,user_telegram_id,event_type,source,success,repeat,details,created_at)
    VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`).bind(
      publicationId,
      options.assetId ?? null,
      options.userId == null ? null : String(options.userId),
      eventType,
      options.source || 'bot',
      options.success === false ? 0 : 1,
      options.repeat ? 1 : 0,
      options.details === undefined ? null : JSON.stringify(options.details).slice(0, 1600),
    ).run();
}
async function telegramCall<T>(env: PublicationOpsEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  return body.result as T;
}
async function telegramUpload(env: PublicationOpsEnv, method: 'sendPhoto' | 'sendDocument', form: FormData): Promise<TelegramMessage> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form });
  const body = await response.json().catch(() => null) as TelegramResponse<TelegramMessage> | null;
  if (!response.ok || !body?.ok || !body.result) throw new Error(body?.description || `Telegram ${method} upload failed with HTTP ${response.status}`);
  return body.result;
}
async function r2Blob(env: PublicationOpsEnv, key: string, filename: string, mime: string | null): Promise<Blob> {
  if (!env.FILES) throw new Error('R2 FILES binding is not configured');
  const object = await env.FILES.get(key);
  if (!object) throw new Error(`R2 object missing: ${key}`);
  return new Blob([await object.arrayBuffer()], { type: mime || object.httpMetadata?.contentType || 'application/octet-stream' });
}
async function sendPost(env: PublicationOpsEnv, chatId: string | number, pub: PublicationRow, text: string, replyMarkup?: Record<string, unknown>): Promise<TelegramMessage> {
  if (!pub.image_key) {
    return telegramCall<TelegramMessage>(env, 'sendMessage', {
      chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
  if (text.length > 1024) throw new Error(`Telegram caption занимает ${text.length} / 1024 символов.`);
  const blob = await r2Blob(env, pub.image_key, pub.image_name || 'cover.jpg', pub.image_mime);
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', text);
  form.set('photo', blob, pub.image_name || 'cover.jpg');
  if (replyMarkup) form.set('reply_markup', JSON.stringify(replyMarkup));
  return telegramUpload(env, 'sendPhoto', form);
}
async function sendAsset(env: PublicationOpsEnv, chatId: string | number, asset: AssetRow): Promise<TelegramMessage> {
  if (asset.telegram_file_id) return telegramCall<TelegramMessage>(env, 'sendDocument', { chat_id: chatId, document: asset.telegram_file_id });
  const blob = await r2Blob(env, asset.r2_key, asset.file_name, asset.mime_type);
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('document', blob, asset.file_name);
  const sent = await telegramUpload(env, 'sendDocument', form);
  const fileId = sent.document?.file_id;
  if (fileId) await env.DB.prepare('UPDATE publication_assets SET telegram_file_id=? WHERE id=?').bind(fileId, asset.id).run();
  return sent;
}

async function handlePublish(request: Request, env: PublicationOpsEnv, id: number): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const pub = await publication(env, id);
  if (!pub) return json({ error: 'Публикация не найдена.' }, 404);
  if (pub.status === 'published') return json({ error: 'Публикация уже отправлена.' }, 409);
  if (pub.status === 'deleted') return json({ error: 'Архивную публикацию нельзя отправить повторно. Создайте новый черновик.' }, 409);
  const channel = await setting(env, 'publish_channel_id');
  if (!channel) return json({ error: 'Канал публикации не настроен.' }, 409);
  const files = await assets(env, id);
  const text = composeManagedPublication(pub, files.length, botName(env));
  const origin = new URL(request.url).origin;
  const markup = publicationKeyboard(env, origin, id, files.length, 'channel');
  await env.DB.prepare("UPDATE publications SET status='publishing',error_text=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
  try {
    const sent = await sendPost(env, normalizeChatId(channel), pub, text, markup);
    await env.DB.prepare("UPDATE publications SET status='published',channel_message_id=?,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,error_text=NULL WHERE id=?")
      .bind(sent.message_id, id).run();
    await log(env, id, 'success', 'published_with_download_gate', 'Пост опубликован с выдачей файлов через Telegram-бота.', { adminUserId: admin.id, fileCount: files.length });
    return json({ ok: true, publication: await publication(env, id), delivery: { mode: files.length ? 'bot' : 'none', support: BOOSTY_SUPPORT_URL } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare("UPDATE publications SET status='failed',error_text=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(message.slice(0, 1000), id).run().catch(() => undefined);
    await log(env, id, 'error', 'publish_failed', 'Telegram не опубликовал пост.', message);
    return json({ error: message }, 502);
  }
}

async function handleTest(request: Request, env: PublicationOpsEnv, id: number): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const pub = await publication(env, id);
  if (!pub) return json({ error: 'Публикация не найдена.' }, 404);
  const files = await assets(env, id);
  const target = firstAdminId(env);
  if (!target) return json({ error: 'ADMIN_TELEGRAM_IDS не настроен.' }, 409);
  const text = `${composeManagedPublication(pub, files.length, botName(env))}\n\n🧪 Тестовая отправка: файлы ниже отправлены напрямую администратору.`;
  try {
    await sendPost(env, target, pub, text, { inline_keyboard: [[{ text: '❤️ Поддержать переводчика', url: BOOSTY_SUPPORT_URL }]] });
    let sentFiles = 0;
    for (const asset of files) { await sendAsset(env, target, asset); sentFiles += 1; }
    await log(env, id, 'success', 'test_sent', 'Тестовая публикация и файлы отправлены администратору.', { adminUserId: admin.id, sentFiles });
    return json({ ok: true, sentFiles });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(env, id, 'error', 'test_failed', 'Тестовая публикация не отправлена.', message);
    return json({ error: message }, 502);
  }
}

async function handleEdit(request: Request, env: PublicationOpsEnv, id: number): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const pub = await publication(env, id);
  if (!pub) return json({ error: 'Публикация не найдена.' }, 404);
  const input = await request.json().catch(() => null) as { body?: unknown } | null;
  const body = typeof input?.body === 'string' ? input.body.trim() : '';
  if (!body || body.length > MAX_BODY) return json({ error: `Текст должен содержать от 1 до ${MAX_BODY} символов.` }, 400);
  const files = await assets(env, id);
  const managed = composeManagedPublication({ ...pub, body_html: body }, files.length, botName(env));
  if (pub.image_key && managed.length > 1024) return json({ error: `После служебных строк caption занимает ${managed.length} / 1024 символов.` }, 400);
  if (pub.status === 'published') {
    const channel = await setting(env, 'publish_channel_id');
    if (!channel || !pub.channel_message_id) return json({ error: 'У опубликованного поста нет канала или Telegram message ID.' }, 409);
    const markup = publicationKeyboard(env, new URL(request.url).origin, id, files.length, 'channel');
    try {
      if (pub.image_key) await telegramCall(env, 'editMessageCaption', { chat_id: normalizeChatId(channel), message_id: pub.channel_message_id, caption: managed, reply_markup: markup });
      else await telegramCall(env, 'editMessageText', { chat_id: normalizeChatId(channel), message_id: pub.channel_message_id, text: managed, link_preview_options: { is_disabled: true }, reply_markup: markup });
    } catch (error) {
      await log(env, id, 'error', 'post_edit_failed', 'Telegram не обновил пост; D1 не изменён.', String(error));
      return json({ error: error instanceof Error ? error.message : 'Telegram не обновил пост.' }, 502);
    }
  }
  await env.DB.prepare('UPDATE publications SET body_html=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(body, id).run();
  await log(env, id, 'success', 'post_edited', 'Текст публикации обновлён с сохранением download/support блока.', { adminUserId: admin.id });
  return json({ ok: true, id, body_html: body });
}

async function handleSupportRedirect(request: Request, env: PublicationOpsEnv): Promise<Response> {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get('publication'));
  const sourceRaw = url.searchParams.get('source') || 'channel';
  const source = ['channel', 'discussion', 'bot', 'test'].includes(sourceRaw) ? sourceRaw : 'channel';
  if (Number.isSafeInteger(id) && id > 0) {
    const pub = await publication(env, id).catch(() => null);
    if (pub?.status === 'published') await recordEvent(env, id, 'support_click', { source }).catch(() => undefined);
  }
  return new Response(null, { status: 302, headers: { location: BOOSTY_SUPPORT_URL, 'cache-control': 'no-store' } });
}

async function analytics(request: Request, env: PublicationOpsEnv): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  await ensurePublicationOpsSchema(env);
  const rawDays = Number(new URL(request.url).searchParams.get('days') || 30);
  const days = [0, 7, 30, 90, 365].includes(rawDays) ? rawDays : 30;
  const since = days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
  const eventWhere = since ? 'WHERE created_at>=?' : '';
  const eventBindings = since ? [since] : [];
  const eventSummary = await env.DB.prepare(`SELECT
      SUM(CASE WHEN event_type='download_open' THEN 1 ELSE 0 END) download_opens,
      COUNT(DISTINCT CASE WHEN event_type IN ('download_open','delivery_success') THEN user_telegram_id END) unique_readers,
      SUM(CASE WHEN event_type='delivery_success' THEN 1 ELSE 0 END) deliveries,
      SUM(CASE WHEN event_type='delivery_success' THEN repeat ELSE 0 END) repeat_deliveries,
      SUM(CASE WHEN event_type='delivery_failed' THEN 1 ELSE 0 END) delivery_failures,
      SUM(CASE WHEN event_type='support_click' THEN 1 ELSE 0 END) support_clicks
    FROM publication_reader_events ${eventWhere}`).bind(...eventBindings).first<Record<string, number | string | null>>();
  const thanks = await env.DB.prepare(`SELECT COUNT(*) count FROM publication_thanks ${since ? 'WHERE created_at>=?' : ''}`).bind(...eventBindings).first<{ count: number | string }>();
  const published = await env.DB.prepare(`SELECT COUNT(*) count FROM publications WHERE status='published' ${since ? 'AND published_at>=?' : ''}`).bind(...eventBindings).first<{ count: number | string }>();
  const grouped = await env.DB.prepare(`SELECT publication_id,
      COUNT(DISTINCT CASE WHEN event_type IN ('download_open','delivery_success') THEN user_telegram_id END) readers,
      SUM(CASE WHEN event_type='download_open' THEN 1 ELSE 0 END) opens,
      SUM(CASE WHEN event_type='delivery_success' THEN 1 ELSE 0 END) deliveries,
      SUM(CASE WHEN event_type='delivery_success' THEN repeat ELSE 0 END) repeats,
      SUM(CASE WHEN event_type='delivery_failed' THEN 1 ELSE 0 END) failures,
      SUM(CASE WHEN event_type='support_click' THEN 1 ELSE 0 END) support_clicks
    FROM publication_reader_events ${eventWhere} GROUP BY publication_id`).bind(...eventBindings).all<Record<string, number | string>>();
  const thanksGrouped = await env.DB.prepare(`SELECT publication_id,COUNT(*) thanks FROM publication_thanks ${since ? 'WHERE created_at>=?' : ''} GROUP BY publication_id`).bind(...eventBindings).all<Record<string, number | string>>();
  const pubs = await env.DB.prepare(`SELECT p.id,p.internal_title,p.status,p.published_at,p.discussion_message_id,p.error_text,
      COUNT(a.id) file_count FROM publications p LEFT JOIN publication_assets a ON a.publication_id=p.id
      WHERE p.status='published' GROUP BY p.id ORDER BY p.published_at DESC LIMIT 100`).all<Record<string, unknown>>();
  const metrics = new Map(grouped.results.map((row) => [Number(row.publication_id), row]));
  const thankMap = new Map(thanksGrouped.results.map((row) => [Number(row.publication_id), Number(row.thanks || 0)]));
  const releases = pubs.results.map((pub) => {
    const row = metrics.get(Number(pub.id)) || {};
    return {
      id: Number(pub.id), title: String(pub.internal_title || `Публикация #${pub.id}`), published_at: pub.published_at,
      file_count: Number(pub.file_count || 0), discussion_ready: Boolean(pub.discussion_message_id),
      readers: Number(row.readers || 0), download_opens: Number(row.opens || 0), deliveries: Number(row.deliveries || 0),
      repeat_deliveries: Number(row.repeats || 0), delivery_failures: Number(row.failures || 0),
      thanks: thankMap.get(Number(pub.id)) || 0, support_clicks: Number(row.support_clicks || 0), error_text: pub.error_text || null,
    };
  });
  releases.sort((a, b) => b.readers - a.readers || b.deliveries - a.deliveries || b.id - a.id);
  const recent = await env.DB.prepare(`SELECT e.id,e.publication_id,e.asset_id,e.user_telegram_id,e.event_type,e.source,e.success,e.repeat,e.created_at,
      p.internal_title FROM publication_reader_events e JOIN publications p ON p.id=e.publication_id
      ${since ? 'WHERE e.created_at>=?' : ''} ORDER BY e.id DESC LIMIT 60`).bind(...eventBindings).all<Record<string, unknown>>();
  const attention = releases.filter((item) => item.delivery_failures > 0 || (item.file_count > 0 && !item.discussion_ready)).slice(0, 20);
  return json({
    period: { days, since },
    summary: {
      published: Number(published?.count || 0), download_opens: Number(eventSummary?.download_opens || 0),
      unique_readers: Number(eventSummary?.unique_readers || 0), deliveries: Number(eventSummary?.deliveries || 0),
      repeat_deliveries: Number(eventSummary?.repeat_deliveries || 0), delivery_failures: Number(eventSummary?.delivery_failures || 0),
      thanks: Number(thanks?.count || 0), support_clicks: Number(eventSummary?.support_clicks || 0),
    },
    top_releases: releases.slice(0, 15), attention, recent_events: recent.results,
  });
}

export async function handlePublicationOpsRequest(request: Request, env: PublicationOpsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/go/support') return handleSupportRedirect(request, env);
  if (request.method === 'GET' && url.pathname === '/api/admin/publishing-analytics') return analytics(request, env);
  const action = /^\/api\/admin\/publications\/(\d+)\/(test|publish|edit)$/.exec(url.pathname);
  if (!action || request.method !== 'POST') return null;
  const id = Number(action[1]);
  if (action[2] === 'publish') return handlePublish(request, env, id);
  if (action[2] === 'test') return handleTest(request, env, id);
  return handleEdit(request, env, id);
}

async function upsertTelegramUser(env: PublicationOpsEnv, user: TelegramUser): Promise<void> {
  await env.DB.prepare(`INSERT INTO users (telegram_id,username,first_name,last_name,language_code,updated_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP`)
    .bind(String(user.id), user.username ?? null, user.first_name || 'Telegram', user.last_name ?? '', user.language_code ?? null).run();
}
async function claimDelivery(env: PublicationOpsEnv, publicationId: number, assetId: number, userId: number): Promise<{ repeat: boolean; recent: boolean }> {
  const existing = await env.DB.prepare(`SELECT status,attempts,first_delivered_at,last_delivered_at FROM publication_deliveries
    WHERE publication_id=? AND asset_id=? AND user_telegram_id=?`).bind(publicationId, assetId, String(userId)).first<DeliveryRow>();
  if (existing?.last_delivered_at) {
    const age = Date.now() - new Date(existing.last_delivered_at).getTime();
    if (Number.isFinite(age) && age >= 0 && age < RESEND_COOLDOWN_MS) return { repeat: true, recent: true };
  }
  await env.DB.prepare(`INSERT INTO publication_deliveries
      (publication_id,asset_id,user_telegram_id,status,attempts,updated_at)
      VALUES (?,?,?,'sending',1,CURRENT_TIMESTAMP)
      ON CONFLICT(publication_id,asset_id,user_telegram_id) DO UPDATE SET status='sending',attempts=attempts+1,last_error=NULL,updated_at=CURRENT_TIMESTAMP`)
    .bind(publicationId, assetId, String(userId)).run();
  return { repeat: Boolean(existing?.first_delivered_at), recent: false };
}
async function deliverDownload(env: PublicationOpsEnv, publicationId: number, user: TelegramUser, origin: string): Promise<void> {
  await ensurePublicationOpsSchema(env);
  const pub = await publication(env, publicationId);
  if (!pub || pub.status !== 'published') {
    await telegramCall(env, 'sendMessage', { chat_id: user.id, text: 'Этот релиз недоступен или уже удалён.' }).catch(() => undefined);
    return;
  }
  const files = await assets(env, publicationId);
  if (!files.length) {
    await telegramCall(env, 'sendMessage', { chat_id: user.id, text: 'У этого релиза нет файлов для скачивания.' }).catch(() => undefined);
    return;
  }
  await upsertTelegramUser(env, user).catch(() => undefined);
  await recordEvent(env, publicationId, 'download_open', { userId: user.id, source: 'bot' }).catch(() => undefined);
  let sent = 0, skipped = 0, failed = 0;
  for (const asset of files) {
    const claim = await claimDelivery(env, publicationId, asset.id, user.id);
    if (claim.recent) { skipped += 1; continue; }
    try {
      const message = await sendAsset(env, user.id, asset);
      const now = new Date().toISOString();
      await env.DB.prepare(`UPDATE publication_deliveries SET status='delivered',first_delivered_at=COALESCE(first_delivered_at,?),last_delivered_at=?,telegram_message_id=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE publication_id=? AND asset_id=? AND user_telegram_id=?`).bind(now, now, message.message_id, publicationId, asset.id, String(user.id)).run();
      await recordEvent(env, publicationId, 'delivery_success', { assetId: asset.id, userId: user.id, source: 'bot', repeat: claim.repeat });
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await env.DB.prepare(`UPDATE publication_deliveries SET status='failed',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE publication_id=? AND asset_id=? AND user_telegram_id=?`)
        .bind(message.slice(0, 1000), publicationId, asset.id, String(user.id)).run().catch(() => undefined);
      await recordEvent(env, publicationId, 'delivery_failed', { assetId: asset.id, userId: user.id, source: 'bot', success: false, repeat: claim.repeat, details: { error: message.slice(0, 300) } }).catch(() => undefined);
      failed += 1;
    }
  }
  if (sent === 0 && skipped > 0 && failed === 0) {
    await telegramCall(env, 'sendMessage', { chat_id: user.id, text: 'Файлы уже отправлялись меньше минуты назад — проверьте сообщения выше.' }).catch(() => undefined);
    return;
  }
  const status = failed ? `Готово частично: отправлено ${sent}, ошибок ${failed}. Повторите скачивание чуть позже.` : `Готово: отправлено файлов — ${sent}. Приятного чтения!`;
  await telegramCall(env, 'sendMessage', {
    chat_id: user.id,
    text: status,
    reply_markup: { inline_keyboard: [
      [{ text: '❤️ Спасибо', callback_data: `thanks:${publicationId}` }],
      [{ text: '❤️ Поддержать переводчика', url: supportRedirect(origin, publicationId, 'bot') }],
    ] },
  }).catch(() => undefined);
}
async function handleThanks(env: PublicationOpsEnv, callback: TelegramCallbackQuery): Promise<void> {
  const id = Number(callback.data?.slice('thanks:'.length));
  await telegramCall(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Спасибо ❤️' }).catch(() => undefined);
  if (!Number.isSafeInteger(id) || id < 1) return;
  await ensurePublicationOpsSchema(env);
  const pub = await publication(env, id);
  if (!pub || pub.status !== 'published') return;
  await env.DB.prepare('INSERT OR IGNORE INTO publication_thanks (publication_id,user_telegram_id,created_at) VALUES (?,?,CURRENT_TIMESTAMP)')
    .bind(id, String(callback.from.id)).run();
  await recordEvent(env, id, 'thank_you_click', { userId: callback.from.id, source: 'bot' }).catch(() => undefined);
}
async function handleDiscussionForward(env: PublicationOpsEnv, message: TelegramMessage, origin: string): Promise<boolean> {
  if (!message.is_automatic_forward || message.forward_origin?.type !== 'channel' || !message.forward_origin.message_id) return false;
  const discussion = await setting(env, 'discussion_chat_id');
  if (!discussion || String(message.chat?.id ?? '') !== String(normalizeChatId(discussion))) return false;
  const pub = await env.DB.prepare(`SELECT id,status,internal_title,body_html,add_footer,add_bot_comment,image_key,image_mime,image_name,
    channel_message_id,discussion_message_id,error_text,created_by,created_at,updated_at,published_at
    FROM publications WHERE channel_message_id=? AND status='published' ORDER BY id DESC LIMIT 1`)
    .bind(message.forward_origin.message_id).first<PublicationRow>();
  if (!pub) return false;
  const files = await assets(env, pub.id);
  if (!files.length) return false;
  await env.DB.prepare('UPDATE publications SET discussion_message_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(message.message_id, pub.id).run();
  const text = `📥 Скачать файлы релиза можно через @${botName(env)} в личные сообщения.\n\n❤️ Поддержать переводчика — кнопка ниже.`;
  await telegramCall(env, 'sendMessage', {
    chat_id: normalizeChatId(discussion), text,
    reply_parameters: { message_id: message.message_id },
    reply_markup: publicationKeyboard(env, origin, pub.id, files.length, 'discussion'),
  }).catch(async (error) => { await log(env, pub.id, 'error', 'download_gate_comment_failed', 'Не удалось отправить download gate в комментарии.', String(error)); });
  await log(env, pub.id, 'success', 'download_gate_ready', 'Файлы не публикуются в комментариях; включена выдача через бота.', { fileCount: files.length });
  return true;
}

export async function handlePublicationOpsWebhook(request: Request, env: PublicationOpsEnv, ctx: ExecutionContextLike): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/webhook' || request.method !== 'POST') return null;
  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (expected && request.headers.get('x-telegram-bot-api-secret-token') !== expected) return new Response('Forbidden', { status: 403 });
  const update = await request.clone().json().catch(() => null) as TelegramUpdate | null;
  if (!update) return null;
  if (update.callback_query?.data?.startsWith('thanks:')) {
    ctx.waitUntil(handleThanks(env, update.callback_query));
    return new Response('ok');
  }
  const message = update.message;
  if (message?.chat?.type === 'private' && message.from && message.text?.startsWith('/start')) {
    const payload = message.text.trim().split(/\s+/, 2)[1] || '';
    const match = /^dl_(\d+)$/.exec(payload);
    if (match) {
      const id = Number(match[1]);
      ctx.waitUntil(deliverDownload(env, id, message.from, new URL(request.url).origin));
      return new Response('ok');
    }
  }
  if (message && await handleDiscussionForward(env, message, new URL(request.url).origin)) return new Response('ok');
  return null;
}
