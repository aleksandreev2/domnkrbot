import { firstAdminId, requireAdminSession, type WebAuthEnv } from './web-auth.js';
import {
  acquireTelegramFileCacheLease,
  ensureTelegramFileCacheSchema,
  releaseTelegramFileCacheLease,
  storeTelegramFileId,
  waitForTelegramFileId,
  type TelegramFileCacheDB,
} from './telegram-file-cache.js';

type D1AllResult<T> = { results: T[] };
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1AllResult<T>>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
interface D1DatabaseLike extends TelegramFileCacheDB {
  prepare(query: string): D1PreparedStatementLike;
}
interface R2ObjectLike {
  size: number;
  httpMetadata?: { contentType?: string };
  blob(): Promise<Blob>;
}
interface R2BucketLike { get(key: string): Promise<R2ObjectLike | null> }

export interface PublicationFileCachePrewarmEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
  FILES?: R2BucketLike;
}

type AssetRow = {
  id: number;
  publication_id: number;
  file_name: string;
  mime_type: string | null;
  r2_key: string;
  size_bytes: number;
  telegram_file_id: string | null;
};
type TelegramMessage = { message_id: number; document?: { file_id?: string } };
type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string };

async function telegramJson<T>(env: PublicationFileCachePrewarmEnv, method: string, payload: Record<string, unknown>): Promise<T> {
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

async function telegramUpload(env: PublicationFileCachePrewarmEnv, chatId: number, asset: AssetRow): Promise<TelegramMessage> {
  if (!env.FILES) throw new Error('R2 FILES binding is not configured');
  const object = await env.FILES.get(asset.r2_key);
  if (!object) throw new Error(`R2 object missing: ${asset.file_name}`);
  const stored = await object.blob();
  const contentType = asset.mime_type || object.httpMetadata?.contentType || stored.type || 'application/octet-stream';
  const document = stored.type === contentType ? stored : new Blob([stored], { type: contentType });
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('disable_notification', 'true');
  form.set('document', document, asset.file_name);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  const body = await response.json().catch(() => null) as TelegramResponse<TelegramMessage> | null;
  if (!response.ok || !body?.ok || !body.result) throw new Error(body?.description || `Telegram sendDocument failed with HTTP ${response.status}`);
  return body.result;
}

async function logPrewarm(env: PublicationFileCachePrewarmEnv, publicationId: number, level: string, event: string, message: string, details: unknown): Promise<void> {
  await env.DB.prepare(`INSERT INTO publication_logs (publication_id,level,event,message,details,created_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .bind(publicationId, level, event, message, JSON.stringify(details).slice(0, 1600)).run().catch(() => undefined);
}

export async function handlePublicationFileCachePrewarm(request: Request, env: PublicationFileCachePrewarmEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/admin\/publications\/(\d+)\/publish$/.exec(url.pathname);
  if (request.method !== 'POST' || !match) return null;

  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const publicationId = Number(match[1]);
  if (!Number.isSafeInteger(publicationId) || publicationId < 1) return null;

  const publication = await env.DB.prepare('SELECT id,status FROM publications WHERE id=? LIMIT 1')
    .bind(publicationId).first<{ id: number; status: string }>();
  if (!publication || publication.status === 'published' || publication.status === 'deleted') return null;

  const { results: assets } = await env.DB.prepare(`SELECT id,publication_id,file_name,mime_type,r2_key,size_bytes,telegram_file_id
    FROM publication_assets WHERE publication_id=? ORDER BY sort_order,id`)
    .bind(publicationId).all<AssetRow>();
  if (!assets.length || assets.every((asset) => Boolean(asset.telegram_file_id))) return null;

  const adminId = firstAdminId(env);
  if (!adminId || !env.FILES) {
    await logPrewarm(env, publicationId, 'warning', 'telegram_cache_prewarm_skipped', 'Telegram file cache не прогрет перед публикацией.', {
      reason: !adminId ? 'admin_chat_unavailable' : 'r2_unavailable',
      pending: assets.filter((asset) => !asset.telegram_file_id).length,
    });
    return null;
  }

  await ensureTelegramFileCacheSchema(env);
  let warmed = 0;
  let reused = 0;
  let failed = 0;
  const errors: Array<{ assetId: number; file: string; error: string }> = [];

  for (const asset of assets) {
    if (asset.telegram_file_id) { reused += 1; continue; }
    const lease = await acquireTelegramFileCacheLease(env, asset.id);
    if (!lease) {
      const fileId = await waitForTelegramFileId(env, asset.id);
      if (fileId) reused += 1;
      else {
        failed += 1;
        errors.push({ assetId: asset.id, file: asset.file_name, error: 'cache_warm_in_progress_timeout' });
      }
      continue;
    }

    try {
      const sent = await telegramUpload(env, adminId, asset);
      const fileId = sent.document?.file_id?.trim();
      if (!fileId) throw new Error('Telegram did not return document.file_id');
      await storeTelegramFileId(env, asset.id, fileId);
      warmed += 1;
      await telegramJson(env, 'deleteMessage', { chat_id: adminId, message_id: sent.message_id }).catch(() => undefined);
    } catch (error) {
      failed += 1;
      errors.push({ assetId: asset.id, file: asset.file_name, error: (error instanceof Error ? error.message : String(error)).slice(0, 240) });
    } finally {
      await releaseTelegramFileCacheLease(env, asset.id, lease).catch(() => undefined);
    }
  }

  await logPrewarm(
    env,
    publicationId,
    failed ? 'warning' : 'success',
    failed ? 'telegram_cache_prewarm_partial' : 'telegram_cache_prewarmed',
    failed ? 'Telegram file cache прогрет частично; R2 fallback сохранён.' : 'Telegram file cache прогрет перед публикацией.',
    { warmed, reused, failed, errors },
  );
  return null;
}
