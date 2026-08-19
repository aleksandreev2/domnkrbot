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
  size?: number;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface PublishingEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
  FILES?: R2BucketLike;
}

export type PublishingTelegramMessage = {
  message_id: number;
  chat?: { id: number | string; type?: string };
  is_automatic_forward?: boolean;
  forward_origin?: { type?: string; message_id?: number };
  document?: { file_id?: string };
  photo?: Array<{ file_id?: string }>;
};

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
  created_at: string;
};

type DraftPayload = {
  internal_title?: unknown;
  body_html?: unknown;
  add_footer?: unknown;
  add_bot_comment?: unknown;
};

const MAX_TITLE = 180;
const MAX_BODY = 700;
const MAX_FILES = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 45 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const FILES_LINE = '📎 Файлы находятся в комментариях.';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
let schemaPromise: Promise<void> | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function flag(value: unknown, fallback = true): number {
  if (value === undefined || value === null) return fallback ? 1 : 0;
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function normalizeChatId(value: string): string | number {
  const raw = value.trim();
  if (/^-?\d+$/.test(raw)) {
    const number = Number(raw);
    if (Number.isSafeInteger(number)) return number;
  }
  return raw.startsWith('@') ? raw : `@${raw}`;
}

function safeName(value: string): string {
  const cleaned = value.replace(/[\\/\0-\x1f\x7f]+/g, '-').replace(/\s+/g, ' ').trim();
  return (cleaned || 'file').slice(0, 140);
}

function contentDisposition(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function ensurePublishingSchema(env: PublishingEnv): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = initializePublishingSchema(env).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function initializePublishingSchema(env: PublishingEnv): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'draft',
      internal_title TEXT NOT NULL,
      body_html TEXT NOT NULL,
      add_footer INTEGER NOT NULL DEFAULT 1,
      add_bot_comment INTEGER NOT NULL DEFAULT 1,
      image_key TEXT,
      image_mime TEXT,
      image_name TEXT,
      channel_message_id INTEGER,
      discussion_message_id INTEGER,
      error_text TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      published_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS publication_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      r2_key TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL,
      telegram_file_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(publication_id) REFERENCES publications(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS publication_editor_drafts (
      admin_user_id TEXT PRIMARY KEY,
      internal_title TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      add_footer INTEGER NOT NULL DEFAULT 1,
      add_bot_comment INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS publication_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      internal_title TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      add_footer INTEGER NOT NULL DEFAULT 1,
      add_bot_comment INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS publication_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_id INTEGER,
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX IF NOT EXISTS idx_publications_status_created ON publications(status, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_publication_assets_publication ON publication_assets(publication_id, sort_order, id)',
  ];
  for (const statement of statements) await env.DB.prepare(statement).run();
}

async function setting(env: PublishingEnv, key: string): Promise<string> {
  try {
    return (await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>())?.value?.trim() || '';
  } catch {
    return '';
  }
}

async function setSetting(env: PublishingEnv, key: string, value: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP
  `).bind(key, value).run();
}

async function telegramCall<T>(env: PublishingEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  return body.result as T;
}

async function telegramUpload<T>(env: PublishingEnv, method: string, form: FormData): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form });
  const body = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  return body.result as T;
}

async function getPublication(env: PublishingEnv, id: number): Promise<PublicationRow | null> {
  return env.DB.prepare(`
    SELECT id,status,internal_title,body_html,add_footer,add_bot_comment,image_key,image_mime,image_name,
           channel_message_id,discussion_message_id,error_text,created_by,created_at,updated_at,published_at
    FROM publications WHERE id=?
  `).bind(id).first<PublicationRow>();
}

async function getAssets(env: PublishingEnv, publicationId: number): Promise<AssetRow[]> {
  const { results } = await env.DB.prepare(`
    SELECT id,publication_id,file_name,mime_type,r2_key,size_bytes,telegram_file_id,sort_order,created_at
    FROM publication_assets WHERE publication_id=? ORDER BY sort_order,id
  `).bind(publicationId).all<AssetRow>();
  return results;
}

async function publicationDetail(env: PublishingEnv, id: number): Promise<Record<string, unknown> | null> {
  const row = await getPublication(env, id);
  if (!row) return null;
  return { ...row, assets: await getAssets(env, id) };
}

async function listPublications(env: PublishingEnv): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(`
    SELECT p.id,p.status,p.internal_title,p.body_html,p.add_footer,p.add_bot_comment,p.image_key,p.image_mime,p.image_name,
           p.channel_message_id,p.discussion_message_id,p.error_text,p.created_by,p.created_at,p.updated_at,p.published_at,
           COUNT(a.id) AS file_count,COALESCE(SUM(a.size_bytes),0) AS file_bytes
    FROM publications p LEFT JOIN publication_assets a ON a.publication_id=p.id
    GROUP BY p.id ORDER BY p.id DESC LIMIT 80
  `).all<Record<string, unknown>>();
  return results;
}

async function composePost(env: PublishingEnv, publication: PublicationRow): Promise<string> {
  const parts = [publication.body_html.trim()];
  const assets = await getAssets(env, publication.id);
  if (assets.length) parts.push(FILES_LINE);
  if (publication.add_footer) {
    const bot = (env.BOT_USERNAME || 'domnekromanta_bot').replace(/^@/, '');
    parts.push(`Дом Некроманта · переводы сообщества\nhttps://t.me/${bot}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

async function logPublication(env: PublishingEnv, id: number, level: string, event: string, message: string, details?: unknown): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO publication_logs (publication_id,level,event,message,details,created_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
  `).bind(id, level, event, message, details ? JSON.stringify(details).slice(0, 1600) : null).run().catch(() => undefined);
}

async function r2Blob(env: PublishingEnv, key: string, type: string, name: string): Promise<Blob> {
  if (!env.FILES) throw new Error('R2 FILES binding is not configured');
  const object = await env.FILES.get(key);
  if (!object) throw new Error(`Stored file is missing: ${name}`);
  return new Blob([await object.arrayBuffer()], { type: type || object.httpMetadata?.contentType || 'application/octet-stream' });
}

async function sendImage(env: PublishingEnv, chatId: string | number, publication: PublicationRow, caption: string): Promise<PublishingTelegramMessage> {
  if (!publication.image_key) return telegramCall(env, 'sendMessage', { chat_id: chatId, text: caption, link_preview_options: { is_disabled: true } });
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption);
  form.set('photo', await r2Blob(env, publication.image_key, publication.image_mime || 'image/jpeg', publication.image_name || 'cover.jpg'), publication.image_name || 'cover.jpg');
  return telegramUpload(env, 'sendPhoto', form);
}

async function sendDocumentAsset(env: PublishingEnv, chatId: string | number, asset: AssetRow, replyTo?: number): Promise<PublishingTelegramMessage> {
  if (asset.telegram_file_id) {
    return telegramCall(env, 'sendDocument', {
      chat_id: chatId,
      document: asset.telegram_file_id,
      ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
    });
  }
  const form = new FormData();
  form.set('chat_id', String(chatId));
  if (replyTo) form.set('reply_parameters', JSON.stringify({ message_id: replyTo }));
  form.set('document', await r2Blob(env, asset.r2_key, asset.mime_type || 'application/octet-stream', asset.file_name), asset.file_name);
  const sent = await telegramUpload<PublishingTelegramMessage>(env, 'sendDocument', form);
  const fileId = sent.document?.file_id;
  if (fileId) await env.DB.prepare('UPDATE publication_assets SET telegram_file_id=? WHERE id=?').bind(fileId, asset.id).run();
  return sent;
}

async function createPublication(request: Request, env: PublishingEnv, adminId: number): Promise<Response> {
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: 'Use multipart/form-data.' }, 400);
  const title = cleanText(form.get('internal_title'), MAX_TITLE);
  const body = cleanText(form.get('body'), MAX_BODY);
  if (!title || !body) return json({ error: 'Название и текст публикации обязательны.' }, 400);

  const image = form.get('image');
  const files = form.getAll('files').filter((item): item is File => item instanceof File && item.size > 0);
  if (files.length > MAX_FILES) return json({ error: `Можно прикрепить максимум ${MAX_FILES} файлов.` }, 400);
  if (files.some((file) => file.size > MAX_FILE_BYTES)) return json({ error: 'Один из файлов больше 45 МБ.' }, 413);
  if (image instanceof File && image.size > MAX_IMAGE_BYTES) return json({ error: 'Изображение больше 8 МБ.' }, 413);
  const imageBytes = image instanceof File ? image.size : 0;
  const totalBytes = imageBytes + files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) return json({ error: 'Общий размер вложений больше 80 МБ.' }, 413);
  if ((imageBytes || files.length) && !env.FILES) return json({ error: 'R2 FILES binding не настроен. Текстовый черновик можно создать без файлов.' }, 503);
  if (image instanceof File && image.size > 0 && !IMAGE_TYPES.has(image.type || '')) return json({ error: 'Изображение должно быть JPEG, PNG, WebP или AVIF.' }, 415);

  const insert = await env.DB.prepare(`
    INSERT INTO publications (internal_title,body_html,add_footer,add_bot_comment,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `).bind(title, body, flag(form.get('add_footer')), flag(form.get('add_bot_comment')), String(adminId)).run();
  const id = Number(insert?.meta?.last_row_id || 0);
  if (!id) return json({ error: 'Не удалось создать публикацию.' }, 500);

  const createdKeys: string[] = [];
  try {
    if (image instanceof File && image.size > 0 && env.FILES) {
      const key = `publications/${id}/image/${crypto.randomUUID()}-${safeName(image.name || 'cover')}`;
      await env.FILES.put(key, image.stream(), { httpMetadata: { contentType: image.type || 'application/octet-stream' } });
      createdKeys.push(key);
      await env.DB.prepare('UPDATE publications SET image_key=?,image_mime=?,image_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(key, image.type || null, safeName(image.name || 'cover'), id).run();
    }
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file) continue;
      const key = `publications/${id}/files/${crypto.randomUUID()}-${safeName(file.name)}`;
      await env.FILES!.put(key, file.stream(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
      createdKeys.push(key);
      await env.DB.prepare(`
        INSERT INTO publication_assets (publication_id,file_name,mime_type,r2_key,size_bytes,sort_order,created_at)
        VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
      `).bind(id, safeName(file.name), file.type || null, key, file.size, index).run();
    }
  } catch (error) {
    for (const key of createdKeys) await env.FILES?.delete(key).catch(() => undefined);
    await env.DB.prepare('DELETE FROM publication_assets WHERE publication_id=?').bind(id).run().catch(() => undefined);
    await env.DB.prepare('DELETE FROM publications WHERE id=?').bind(id).run().catch(() => undefined);
    throw error;
  }

  await logPublication(env, id, 'success', 'draft_created', 'Черновик публикации создан.', { files: files.length, bytes: totalBytes });
  return json({ ok: true, publication: await publicationDetail(env, id) }, 201);
}

async function deletePublication(env: PublishingEnv, id: number): Promise<Response> {
  const publication = await getPublication(env, id);
  if (!publication) return json({ error: 'Публикация не найдена.' }, 404);
  if (publication.status === 'published') return json({ error: 'Опубликованный пост нельзя удалить как черновик.' }, 409);
  const assets = await getAssets(env, id);
  const keys = [...assets.map((asset) => asset.r2_key), publication.image_key].filter((value): value is string => Boolean(value));
  for (const key of keys) await env.FILES?.delete(key).catch(() => undefined);
  await env.DB.prepare('DELETE FROM publication_assets WHERE publication_id=?').bind(id).run();
  await env.DB.prepare('DELETE FROM publications WHERE id=?').bind(id).run();
  return json({ ok: true });
}

async function testPublication(env: PublishingEnv, publication: PublicationRow): Promise<Response> {
  const adminId = firstAdminId(env);
  if (!adminId) return json({ error: 'ADMIN_TELEGRAM_IDS не настроен.' }, 409);
  const caption = `🧪 ТЕСТ ПУБЛИКАЦИИ\n\n${await composePost(env, publication)}`;
  await sendImage(env, adminId, publication, caption);
  for (const asset of await getAssets(env, publication.id)) await sendDocumentAsset(env, adminId, asset);
  await logPublication(env, publication.id, 'success', 'preview_sent', 'Тест публикации отправлен администратору.');
  return json({ ok: true });
}

async function publishPublication(env: PublishingEnv, publication: PublicationRow): Promise<Response> {
  if (publication.status === 'published') return json({ error: 'Публикация уже отправлена.' }, 409);
  const channel = await setting(env, 'publish_channel_id');
  if (!channel) return json({ error: 'Сначала укажите канал публикации в настройках.' }, 409);
  const assets = await getAssets(env, publication.id);
  const discussion = await setting(env, 'discussion_chat_id');
  if (assets.length && !discussion) return json({ error: 'Для публикаций с файлами укажите discussion group: файлы отправляются в комментарии.' }, 409);

  await env.DB.prepare("UPDATE publications SET status='publishing',error_text=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(publication.id).run();
  try {
    const sent = await sendImage(env, normalizeChatId(channel), publication, await composePost(env, publication));
    await env.DB.prepare(`
      UPDATE publications SET status='published',channel_message_id=?,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(sent.message_id, publication.id).run();
    await logPublication(env, publication.id, 'success', 'published', 'Публикация отправлена в Telegram-канал.', { channel_message_id: sent.message_id });
    return json({ ok: true, channelMessageId: sent.message_id, waitingForDiscussion: assets.length > 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare("UPDATE publications SET status='failed',error_text=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(message.slice(0, 800), publication.id).run();
    await logPublication(env, publication.id, 'error', 'publish_failed', 'Публикация не отправлена.', message);
    return json({ error: message }, 502);
  }
}

async function settingsResponse(env: PublishingEnv): Promise<Record<string, unknown>> {
  return {
    publishChannelId: await setting(env, 'publish_channel_id'),
    discussionChatId: await setting(env, 'discussion_chat_id'),
    storageReady: Boolean(env.FILES),
  };
}

export async function handlePublishingApi(request: Request, env: PublishingEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const mediaMatch = /^\/media\/publications\/(\d+)\/image$/.exec(url.pathname);
  if (request.method === 'GET' && mediaMatch) {
    const admin = await requireAdminSession(request, env);
    if (admin instanceof Response) return admin;
    const publication = await getPublication(env, Number(mediaMatch[1]));
    if (!publication?.image_key || !env.FILES) return new Response('Not found', { status: 404 });
    const object = await env.FILES.get(publication.image_key);
    if (!object) return new Response('Not found', { status: 404 });
    return new Response(await object.arrayBuffer(), {
      headers: {
        'content-type': publication.image_mime || object.httpMetadata?.contentType || 'application/octet-stream',
        'cache-control': 'private, no-store',
      },
    });
  }

  if (!url.pathname.startsWith('/api/admin/publishing') && !url.pathname.startsWith('/api/admin/publications') && !url.pathname.startsWith('/api/admin/files')) return null;
  await ensurePublishingSchema(env);
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;

  if (request.method === 'GET' && url.pathname === '/api/admin/publishing') {
    return json({ settings: await settingsResponse(env), publications: await listPublications(env) });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/publishing/settings') {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return json({ error: 'Invalid JSON body.' }, 400);
    const publishChannel = String(body.publishChannelId ?? '').trim().slice(0, 128);
    const discussionChat = String(body.discussionChatId ?? '').trim().slice(0, 128);
    await setSetting(env, 'publish_channel_id', publishChannel);
    await setSetting(env, 'discussion_chat_id', discussionChat);
    return json({ ok: true, settings: await settingsResponse(env) });
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/publishing-center') {
    const [draft, templates] = await Promise.all([
      env.DB.prepare('SELECT admin_user_id,internal_title,body_html,add_footer,add_bot_comment,updated_at FROM publication_editor_drafts WHERE admin_user_id=?')
        .bind(String(admin.id)).first<Record<string, unknown>>(),
      env.DB.prepare('SELECT id,name,internal_title,body_html,add_footer,add_bot_comment,created_at,updated_at FROM publication_templates ORDER BY updated_at DESC,id DESC LIMIT 50')
        .all<Record<string, unknown>>(),
    ]);
    return json({
      draft: draft || null,
      templates: templates.results,
      storageReady: Boolean(env.FILES),
      limits: { title: MAX_TITLE, body: MAX_BODY, files: MAX_FILES, imageBytes: MAX_IMAGE_BYTES, fileBytes: MAX_FILE_BYTES, totalBytes: MAX_TOTAL_BYTES },
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/publishing-center/draft') {
    const body = await request.json().catch(() => ({})) as DraftPayload;
    const title = cleanText(body.internal_title, MAX_TITLE);
    const text = cleanText(body.body_html, MAX_BODY);
    await env.DB.prepare(`
      INSERT INTO publication_editor_drafts (admin_user_id,internal_title,body_html,add_footer,add_bot_comment,updated_at)
      VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(admin_user_id) DO UPDATE SET internal_title=excluded.internal_title,body_html=excluded.body_html,
        add_footer=excluded.add_footer,add_bot_comment=excluded.add_bot_comment,updated_at=CURRENT_TIMESTAMP
    `).bind(String(admin.id), title, text, flag(body.add_footer), flag(body.add_bot_comment)).run();
    return json({ ok: true, draft: { internal_title: title, body_html: text, add_footer: flag(body.add_footer), add_bot_comment: flag(body.add_bot_comment), updated_at: new Date().toISOString() } });
  }
  if (request.method === 'DELETE' && url.pathname === '/api/admin/publishing-center/draft') {
    await env.DB.prepare('DELETE FROM publication_editor_drafts WHERE admin_user_id=?').bind(String(admin.id)).run();
    return json({ ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/publishing-center/templates') {
    const body = await request.json().catch(() => ({})) as DraftPayload & { name?: unknown };
    const name = cleanText(body.name, 80);
    const title = cleanText(body.internal_title, MAX_TITLE);
    const text = cleanText(body.body_html, MAX_BODY);
    if (!name || !text) return json({ error: 'Для шаблона нужны название и текст.' }, 400);
    const insert = await env.DB.prepare(`
      INSERT INTO publication_templates (name,internal_title,body_html,add_footer,add_bot_comment,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `).bind(name, title, text, flag(body.add_footer), flag(body.add_bot_comment), String(admin.id)).run();
    return json({ ok: true, id: Number(insert?.meta?.last_row_id || 0) }, 201);
  }
  const templateDelete = /^\/api\/admin\/publishing-center\/templates\/(\d+)$/.exec(url.pathname);
  if (request.method === 'DELETE' && templateDelete) {
    await env.DB.prepare('DELETE FROM publication_templates WHERE id=?').bind(Number(templateDelete[1])).run();
    return json({ ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/publishing-center/preflight') {
    const body = await request.json().catch(() => ({})) as DraftPayload & { file_sizes?: unknown; image_size?: unknown };
    const title = cleanText(body.internal_title, MAX_TITLE);
    const text = cleanText(body.body_html, MAX_BODY);
    const fileSizes = Array.isArray(body.file_sizes) ? body.file_sizes.map(Number).filter(Number.isFinite) : [];
    const imageSize = Math.max(0, Number(body.image_size || 0));
    const total = imageSize + fileSizes.reduce((sum, value) => sum + Math.max(0, value), 0);
    const [publishChannel, discussionChat] = await Promise.all([
      setting(env, 'publish_channel_id'),
      setting(env, 'discussion_chat_id'),
    ]);
    const filesWithinLimit = fileSizes.every((size) => size >= 0 && size <= MAX_FILE_BYTES);
    const checks = [
      { id: 'title', label: 'Название', status: title ? 'ok' : 'error', message: title ? `${title.length} / ${MAX_TITLE}` : 'Заполните название.' },
      { id: 'body', label: 'Текст', status: text ? 'ok' : 'error', message: text ? `${text.length} / ${MAX_BODY}` : 'Добавьте текст.' },
      { id: 'storage', label: 'Файлы', status: (fileSizes.length || imageSize) && !env.FILES ? 'error' : 'ok', message: env.FILES ? 'R2 FILES подключён.' : 'R2 FILES пока не подключён.' },
      { id: 'file_count', label: 'Вложения', status: fileSizes.length <= MAX_FILES ? 'ok' : 'error', message: `${fileSizes.length} / ${MAX_FILES}` },
      { id: 'file_size', label: 'Файл ≤ 45 МБ', status: filesWithinLimit ? 'ok' : 'error', message: filesWithinLimit ? 'Размер отдельных файлов допустим.' : 'Есть файл больше 45 МБ.' },
      { id: 'image_size', label: 'Картинка ≤ 8 МБ', status: imageSize <= MAX_IMAGE_BYTES ? 'ok' : 'error', message: imageSize <= MAX_IMAGE_BYTES ? 'Размер изображения допустим.' : 'Изображение больше 8 МБ.' },
      { id: 'total_size', label: 'Размер', status: total <= MAX_TOTAL_BYTES ? 'ok' : 'error', message: `${Math.round(total / 1024 / 1024 * 10) / 10} / 80 МБ` },
      { id: 'channel', label: 'Канал', status: publishChannel ? 'ok' : 'error', message: publishChannel ? 'Настроен.' : 'Укажите канал в настройках.' },
      { id: 'discussion', label: 'Комментарии', status: fileSizes.length && !discussionChat ? 'error' : 'ok', message: fileSizes.length ? (discussionChat ? 'Discussion group настроена.' : 'Нужна discussion group для файлов.') : 'Файлов нет.' },
    ];
    return json({ ready: !checks.some((check) => check.status === 'error'), checks });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/publications') return createPublication(request, env, admin.id);
  const actionMatch = /^\/api\/admin\/publications\/(\d+)\/(test|publish)$/.exec(url.pathname);
  if (request.method === 'POST' && actionMatch) {
    const publication = await getPublication(env, Number(actionMatch[1]));
    if (!publication) return json({ error: 'Публикация не найдена.' }, 404);
    return actionMatch[2] === 'test' ? testPublication(env, publication) : publishPublication(env, publication);
  }
  const publicationDelete = /^\/api\/admin\/publications\/(\d+)$/.exec(url.pathname);
  if (request.method === 'DELETE' && publicationDelete) return deletePublication(env, Number(publicationDelete[1]));

  if (request.method === 'GET' && url.pathname === '/api/admin/files') {
    const { results } = await env.DB.prepare(`
      SELECT a.id,a.publication_id,a.file_name,a.mime_type,a.size_bytes,a.telegram_file_id,a.created_at,
             p.internal_title,p.status FROM publication_assets a JOIN publications p ON p.id=a.publication_id
      ORDER BY a.id DESC LIMIT 200
    `).all<Record<string, unknown>>();
    return json({ storageReady: Boolean(env.FILES), files: results });
  }
  const downloadMatch = /^\/api\/admin\/files\/(\d+)\/download$/.exec(url.pathname);
  if (request.method === 'GET' && downloadMatch) {
    const asset = await env.DB.prepare(`
      SELECT id,publication_id,file_name,mime_type,r2_key,size_bytes,telegram_file_id,sort_order,created_at
      FROM publication_assets WHERE id=?
    `).bind(Number(downloadMatch[1])).first<AssetRow>();
    if (!asset || !env.FILES) return new Response('Not found', { status: 404 });
    const object = await env.FILES.get(asset.r2_key);
    if (!object) return new Response('Not found', { status: 404 });
    return new Response(await object.arrayBuffer(), {
      headers: {
        'content-type': asset.mime_type || object.httpMetadata?.contentType || 'application/octet-stream',
        'content-disposition': contentDisposition(asset.file_name),
        'cache-control': 'private, no-store',
      },
    });
  }

  return json({ error: 'Not found' }, 404);
}

export async function handlePublicationDiscussionForward(message: PublishingTelegramMessage, env: PublishingEnv): Promise<boolean> {
  if (!message.is_automatic_forward || message.forward_origin?.type !== 'channel' || !message.forward_origin.message_id) return false;
  const discussion = await setting(env, 'discussion_chat_id');
  if (!discussion || String(message.chat?.id ?? '') !== String(normalizeChatId(discussion))) return false;
  const publication = await env.DB.prepare(`
    SELECT id,status,internal_title,body_html,add_footer,add_bot_comment,image_key,image_mime,image_name,
           channel_message_id,discussion_message_id,error_text,created_by,created_at,updated_at,published_at
    FROM publications WHERE channel_message_id=? AND status='published' ORDER BY id DESC LIMIT 1
  `).bind(message.forward_origin.message_id).first<PublicationRow>();
  if (!publication) return false;
  await env.DB.prepare('UPDATE publications SET discussion_message_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(message.message_id, publication.id).run();
  for (const asset of await getAssets(env, publication.id)) {
    try {
      await sendDocumentAsset(env, normalizeChatId(discussion), asset, message.message_id);
    } catch (error) {
      await logPublication(env, publication.id, 'error', 'discussion_file_failed', `Не удалось отправить ${asset.file_name}.`, String(error));
    }
  }
  if (publication.add_bot_comment) {
    const bot = (env.BOT_USERNAME || 'domnekromanta_bot').replace(/^@/, '');
    await telegramCall(env, 'sendMessage', {
      chat_id: normalizeChatId(discussion),
      text: `Есть что предложить для перевода? https://t.me/${bot}`,
      reply_parameters: { message_id: message.message_id },
    }).catch(() => undefined);
  }
  await logPublication(env, publication.id, 'success', 'discussion_files_sent', 'Файлы публикации отправлены в комментарии.');
  return true;
}
