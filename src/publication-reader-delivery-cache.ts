import { checkDownloadMembership, type ChannelMembershipEnv } from './channel-membership-access.js';
import { ensurePublicationCommentGateSchema } from './publication-comment-gate.js';
import { BOOSTY_SUPPORT_URL, ensurePublicationOpsSchema, type PublicationOpsEnv } from './publication-ops.js';
import { handlePublicationReaderDeliveryWebhook as handleLegacyReaderWebhook } from './publication-reader-delivery.js';
import {
  acquireTelegramFileCacheLease,
  clearTelegramFileId,
  ensureTelegramFileCacheSchema,
  readTelegramFileId,
  releaseTelegramFileCacheLease,
  storeTelegramFileId,
  waitForTelegramFileId,
  type TelegramFileCacheDB,
} from './telegram-file-cache.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
type D1RunResult = { meta?: { changes?: number }; success?: boolean; results?: unknown[] };
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<D1RunResult>;
}
interface D1DatabaseLike extends TelegramFileCacheDB {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1RunResult[]>;
}
interface R2ObjectLike {
  size: number;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
  blob?: () => Promise<Blob>;
}
interface R2BucketLike { get(key: string): Promise<R2ObjectLike | null> }

export interface PublicationReaderDeliveryCacheEnv extends PublicationOpsEnv, ChannelMembershipEnv {
  DB: D1DatabaseLike;
  FILES?: R2BucketLike;
}
export interface ReaderDeliveryCacheExecutionContext { waitUntil(promise: Promise<unknown>): void }

type TelegramUser = { id: number; username?: string; first_name: string; last_name?: string; language_code?: string };
type TelegramMessage = {
  message_id: number;
  chat: { id: number | string; type?: string };
  from?: TelegramUser;
  text?: string;
  document?: { file_id?: string };
};
type TelegramCallbackQuery = { id: string; from: TelegramUser; data?: string; message?: TelegramMessage };
type TelegramUpdate = { message?: TelegramMessage; callback_query?: TelegramCallbackQuery };
type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string; error_code?: number };
type PublicationRow = {
  id: number;
  status: string;
  internal_title: string;
  gate_status: string | null;
  gate_message_id: number | null;
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
  asset_id: number;
  status: string;
  attempts: number;
  first_delivered_at: string | null;
  last_delivered_at: string | null;
  updated_at: string | null;
};
type DownloadContext = {
  publication: PublicationRow | null;
  assets: AssetRow[];
  thanked: boolean;
  deliveries: Map<number, DeliveryRow>;
};
type SendResult = {
  message: TelegramMessage;
  transport: 'telegram_file_id' | 'r2_upload';
  cache: 'hit' | 'waited' | 'cold' | 'repaired';
};

const RESEND_COOLDOWN_MS = 60_000;
const SENDING_STALE_MS = 2 * 60_000;

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: number | null,
    readonly description: string,
  ) { super(message); }
}

function botName(env: PublicationReaderDeliveryCacheEnv): string {
  return (env.BOT_USERNAME || 'domnekromanta_bot').replace(/^@/, '');
}
function downloadUrl(env: PublicationReaderDeliveryCacheEnv, publicationId: number): string {
  return `https://t.me/${botName(env)}?start=dl_${publicationId}`;
}
function supportRedirect(origin: string, publicationId: number): string {
  const url = new URL('/go/support', origin);
  url.searchParams.set('publication', String(publicationId));
  url.searchParams.set('source', 'bot');
  return url.toString();
}
function isRecent(value: string | null): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const age = Date.now() - timestamp;
  return age >= 0 && age < RESEND_COOLDOWN_MS;
}
function isFreshSending(row: DeliveryRow | undefined): boolean {
  if (!row || row.status !== 'sending' || !row.updated_at) return false;
  const timestamp = new Date(row.updated_at).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const age = Date.now() - timestamp;
  return age >= 0 && age < SENDING_STALE_MS;
}
function isInvalidCachedFileError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError) || error.errorCode !== 400) return false;
  return /(file[_ -]?id|file identifier|wrong remote file|wrong file identifier|invalid file)/i.test(error.description);
}

async function telegramJson<T>(env: PublicationReaderDeliveryCacheEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok) {
    const description = body?.description || `Telegram ${method} failed with HTTP ${response.status}`;
    throw new TelegramApiError(description, response.status, Number.isFinite(body?.error_code) ? Number(body?.error_code) : null, description);
  }
  return body.result as T;
}

async function r2Blob(env: PublicationReaderDeliveryCacheEnv, asset: AssetRow): Promise<Blob> {
  if (!env.FILES) throw new Error('R2 FILES binding is not configured');
  const object = await env.FILES.get(asset.r2_key);
  if (!object) throw new Error(`R2 object missing: ${asset.file_name}`);
  const stored = object.blob ? await object.blob() : new Blob([await object.arrayBuffer()]);
  const contentType = asset.mime_type || object.httpMetadata?.contentType || stored.type || 'application/octet-stream';
  return stored.type === contentType ? stored : new Blob([stored], { type: contentType });
}

async function uploadAsset(env: PublicationReaderDeliveryCacheEnv, userId: number, asset: AssetRow): Promise<TelegramMessage> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const form = new FormData();
  form.set('chat_id', String(userId));
  form.set('document', await r2Blob(env, asset), asset.file_name);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  const body = await response.json().catch(() => null) as TelegramResponse<TelegramMessage> | null;
  if (!response.ok || !body?.ok || !body.result) {
    const description = body?.description || `Telegram sendDocument failed with HTTP ${response.status}`;
    throw new TelegramApiError(description, response.status, Number.isFinite(body?.error_code) ? Number(body?.error_code) : null, description);
  }
  return body.result;
}

async function sendByFileId(env: PublicationReaderDeliveryCacheEnv, userId: number, fileId: string): Promise<TelegramMessage> {
  return telegramJson<TelegramMessage>(env, 'sendDocument', { chat_id: userId, document: fileId });
}

async function coldSendWithLease(
  env: PublicationReaderDeliveryCacheEnv,
  userId: number,
  asset: AssetRow,
  cache: 'cold' | 'repaired',
): Promise<SendResult> {
  const lease = await acquireTelegramFileCacheLease(env, asset.id);
  if (!lease) {
    const warmed = await waitForTelegramFileId(env, asset.id);
    if (!warmed) throw new Error(`Telegram cache warm timeout: ${asset.file_name}`);
    try {
      return { message: await sendByFileId(env, userId, warmed), transport: 'telegram_file_id', cache: 'waited' };
    } catch (error) {
      if (!isInvalidCachedFileError(error)) throw error;
      await clearTelegramFileId(env, asset.id, warmed).catch(() => undefined);
      return coldSendWithLease(env, userId, { ...asset, telegram_file_id: null }, 'repaired');
    }
  }

  try {
    const alreadyWarmed = await readTelegramFileId(env, asset.id);
    if (alreadyWarmed) {
      try {
        return { message: await sendByFileId(env, userId, alreadyWarmed), transport: 'telegram_file_id', cache: 'waited' };
      } catch (error) {
        if (!isInvalidCachedFileError(error)) throw error;
        await clearTelegramFileId(env, asset.id, alreadyWarmed).catch(() => undefined);
      }
    }
    const message = await uploadAsset(env, userId, asset);
    const fileId = message.document?.file_id?.trim();
    if (fileId) await storeTelegramFileId(env, asset.id, fileId);
    return { message, transport: 'r2_upload', cache };
  } finally {
    await releaseTelegramFileCacheLease(env, asset.id, lease).catch(() => undefined);
  }
}

async function sendAssetResilient(env: PublicationReaderDeliveryCacheEnv, userId: number, asset: AssetRow): Promise<SendResult> {
  const cached = asset.telegram_file_id?.trim() || await readTelegramFileId(env, asset.id);
  if (cached) {
    try {
      return { message: await sendByFileId(env, userId, cached), transport: 'telegram_file_id', cache: 'hit' };
    } catch (error) {
      if (!isInvalidCachedFileError(error)) throw error;
      await clearTelegramFileId(env, asset.id, cached).catch(() => undefined);
      return coldSendWithLease(env, userId, { ...asset, telegram_file_id: null }, 'repaired');
    }
  }
  return coldSendWithLease(env, userId, asset, 'cold');
}

async function recordEvent(
  env: PublicationReaderDeliveryCacheEnv,
  publicationId: number,
  eventType: string,
  options: { userId?: number | string | null; assetId?: number | null; success?: boolean; repeat?: boolean; details?: unknown } = {},
): Promise<void> {
  await env.DB.prepare(`INSERT INTO publication_reader_events
    (publication_id,asset_id,user_telegram_id,event_type,source,success,repeat,details,created_at)
    VALUES (?,?,?,?, 'bot',?,?,?,CURRENT_TIMESTAMP)`).bind(
      publicationId,
      options.assetId ?? null,
      options.userId == null ? null : String(options.userId),
      eventType,
      options.success === false ? 0 : 1,
      options.repeat ? 1 : 0,
      options.details === undefined ? null : JSON.stringify(options.details).slice(0, 1600),
    ).run();
}

async function readDownloadContext(env: PublicationReaderDeliveryCacheEnv, publicationId: number, userId: number): Promise<DownloadContext> {
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT p.id,p.status,p.internal_title,g.status AS gate_status,g.gate_message_id
      FROM publications p LEFT JOIN publication_comment_gates g ON g.publication_id=p.id WHERE p.id=? LIMIT 1`).bind(publicationId),
    env.DB.prepare(`SELECT id,publication_id,file_name,mime_type,r2_key,size_bytes,telegram_file_id,sort_order
      FROM publication_assets WHERE publication_id=? ORDER BY sort_order,id`).bind(publicationId),
    env.DB.prepare('SELECT publication_id FROM publication_thanks WHERE publication_id=? AND user_telegram_id=? LIMIT 1')
      .bind(publicationId, String(userId)),
    env.DB.prepare(`SELECT asset_id,status,attempts,first_delivered_at,last_delivered_at,updated_at
      FROM publication_deliveries WHERE publication_id=? AND user_telegram_id=?`).bind(publicationId, String(userId)),
  ]);
  const publication = (results[0]?.results?.[0] || null) as PublicationRow | null;
  const assets = (results[1]?.results || []) as AssetRow[];
  const thanked = Boolean(results[2]?.results?.length);
  const deliveries = new Map<number, DeliveryRow>(((results[3]?.results || []) as DeliveryRow[]).map((row) => [Number(row.asset_id), row]));
  return { publication, assets, thanked, deliveries };
}

async function claimDelivery(env: PublicationReaderDeliveryCacheEnv, publicationId: number, asset: AssetRow, userId: number, prior: DeliveryRow | undefined): Promise<{ claimed: boolean; repeat: boolean }> {
  if (isRecent(prior?.last_delivered_at || null) || isFreshSending(prior)) return { claimed: false, repeat: Boolean(prior?.first_delivered_at) };
  const result = await env.DB.prepare(`INSERT INTO publication_deliveries
      (publication_id,asset_id,user_telegram_id,status,attempts,updated_at)
      VALUES (?,?,?,'sending',1,CURRENT_TIMESTAMP)
      ON CONFLICT(publication_id,asset_id,user_telegram_id) DO UPDATE SET
        status='sending',attempts=publication_deliveries.attempts+1,last_error=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE publication_deliveries.status<>'sending' OR publication_deliveries.updated_at<=datetime('now','-2 minutes')`)
    .bind(publicationId, asset.id, String(userId)).run();
  return { claimed: Number(result.meta?.changes ?? 1) > 0, repeat: Boolean(prior?.first_delivered_at) };
}

async function deliverDownload(
  env: PublicationReaderDeliveryCacheEnv,
  publicationId: number,
  user: TelegramUser,
  origin: string,
  ctx: ReaderDeliveryCacheExecutionContext,
): Promise<void> {
  await Promise.all([ensurePublicationOpsSchema(env), ensurePublicationCommentGateSchema(env), ensureTelegramFileCacheSchema(env)]);
  const context = await readDownloadContext(env, publicationId, user.id);
  const pub = context.publication;
  if (!pub || pub.status !== 'published') {
    await telegramJson(env, 'sendMessage', { chat_id: user.id, text: 'Этот релиз недоступен или уже удалён.' }).catch(() => undefined);
    return;
  }
  if (!context.assets.length) {
    await telegramJson(env, 'sendMessage', { chat_id: user.id, text: 'У этого релиза нет файлов для скачивания.' }).catch(() => undefined);
    return;
  }
  if (Boolean(pub.gate_status) && !context.thanked) {
    await recordEvent(env, publicationId, 'thank_you_required', { userId: user.id }).catch(() => undefined);
    await telegramJson(env, 'sendMessage', { chat_id: user.id, text: 'Сначала нажмите «❤️ Спасибо» в комментариях к релизу. После этого бот сразу продолжит выдачу файлов.' }).catch(() => undefined);
    return;
  }

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (telegram_id,username,first_name,last_name,language_code,updated_at)
      VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP`)
      .bind(String(user.id), user.username ?? null, user.first_name || 'Telegram', user.last_name ?? '', user.language_code ?? null),
    env.DB.prepare(`INSERT INTO publication_reader_events
      (publication_id,asset_id,user_telegram_id,event_type,source,success,repeat,details,created_at)
      VALUES (?,NULL,?,'download_open','bot',1,0,NULL,CURRENT_TIMESTAMP)`).bind(publicationId, String(user.id)),
  ]).catch(() => undefined);

  if (!(await checkDownloadMembership(env, user, publicationId))) return;

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const asset of context.assets) {
    const prior = context.deliveries.get(asset.id);
    const claim = await claimDelivery(env, publicationId, asset, user.id, prior);
    if (!claim.claimed) { skipped += 1; continue; }
    ctx.waitUntil(recordEvent(env, publicationId, 'delivery_started', {
      userId: user.id,
      assetId: asset.id,
      repeat: claim.repeat,
      details: { transport: asset.telegram_file_id ? 'telegram_file_id' : 'cache_resolve' },
    }).catch(() => undefined));
    const startedAt = Date.now();
    try {
      const result = await sendAssetResilient(env, user.id, asset);
      const deliveredAt = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`UPDATE publication_deliveries SET status='delivered',first_delivered_at=COALESCE(first_delivered_at,?),
          last_delivered_at=?,telegram_message_id=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP
          WHERE publication_id=? AND asset_id=? AND user_telegram_id=?`)
          .bind(deliveredAt, deliveredAt, result.message.message_id, publicationId, asset.id, String(user.id)),
        env.DB.prepare(`INSERT INTO publication_reader_events
          (publication_id,asset_id,user_telegram_id,event_type,source,success,repeat,details,created_at)
          VALUES (?,?,?,'delivery_success','bot',1,?,?,CURRENT_TIMESTAMP)`)
          .bind(publicationId, asset.id, String(user.id), claim.repeat ? 1 : 0, JSON.stringify({
            transport: result.transport,
            cache: result.cache,
            latency_ms: Date.now() - startedAt,
          })),
      ]);
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await env.DB.batch([
        env.DB.prepare(`UPDATE publication_deliveries SET status='failed',last_error=?,updated_at=CURRENT_TIMESTAMP
          WHERE publication_id=? AND asset_id=? AND user_telegram_id=?`)
          .bind(message.slice(0, 1000), publicationId, asset.id, String(user.id)),
        env.DB.prepare(`INSERT INTO publication_reader_events
          (publication_id,asset_id,user_telegram_id,event_type,source,success,repeat,details,created_at)
          VALUES (?,?,?,'delivery_failed','bot',0,?,?,CURRENT_TIMESTAMP)`)
          .bind(publicationId, asset.id, String(user.id), claim.repeat ? 1 : 0, JSON.stringify({ error: message.slice(0, 300), latency_ms: Date.now() - startedAt })),
      ]).catch(() => undefined);
      failed += 1;
    }
  }

  if (sent === 0 && skipped > 0 && failed === 0) {
    await telegramJson(env, 'sendMessage', { chat_id: user.id, text: 'Файлы уже отправлялись меньше минуты назад — проверьте сообщения выше.' }).catch(() => undefined);
    return;
  }
  if (failed > 0) {
    await telegramJson(env, 'sendMessage', { chat_id: user.id, text: `Выдача завершена частично: отправлено ${sent}, ошибок ${failed}. Попробуйте повторить чуть позже.` }).catch(() => undefined);
    return;
  }
  if (sent > 0) {
    await telegramJson(env, 'sendMessage', {
      chat_id: user.id,
      text: `Готово: отправлено файлов — ${sent}. Приятного чтения!`,
      reply_markup: { inline_keyboard: [[{ text: '❤️ Поддержать переводчика', url: supportRedirect(origin, publicationId) }]] },
    }).catch(() => undefined);
  }
}

async function handleThankGate(
  env: PublicationReaderDeliveryCacheEnv,
  callback: TelegramCallbackQuery,
  origin: string,
  ctx: ReaderDeliveryCacheExecutionContext,
): Promise<void> {
  const match = /^gate-(?:thanks|download):(\d+)$/.exec(callback.data || '');
  if (!match) return;
  const publicationId = Number(match[1]);
  if (!Number.isSafeInteger(publicationId) || publicationId < 1) {
    await telegramJson(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Некорректный релиз.' }).catch(() => undefined);
    return;
  }
  await Promise.all([ensurePublicationOpsSchema(env), ensurePublicationCommentGateSchema(env), ensureTelegramFileCacheSchema(env)]);
  const gate = await env.DB.prepare(`SELECT p.status,g.status AS gate_status,g.gate_message_id
    FROM publications p LEFT JOIN publication_comment_gates g ON g.publication_id=p.id WHERE p.id=?`)
    .bind(publicationId).first<Record<string, unknown>>();
  const validMessage = Boolean(callback.message && gate?.gate_message_id && Number(callback.message.message_id) === Number(gate.gate_message_id));
  if (!gate || gate.status !== 'published' || gate.gate_status !== 'sent' || !validMessage) {
    await telegramJson(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Эта кнопка уже неактивна.' }).catch(() => undefined);
    return;
  }

  let returningReader = false;
  try {
    const grantResults = await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (telegram_id,username,first_name,last_name,language_code,updated_at)
        VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP`)
        .bind(String(callback.from.id), callback.from.username ?? null, callback.from.first_name || 'Telegram', callback.from.last_name ?? '', callback.from.language_code ?? null),
      env.DB.prepare('INSERT OR IGNORE INTO publication_thanks (publication_id,user_telegram_id,created_at) VALUES (?,?,CURRENT_TIMESTAMP)')
        .bind(publicationId, String(callback.from.id)),
      env.DB.prepare(`INSERT INTO publication_reader_events
        (publication_id,asset_id,user_telegram_id,event_type,source,success,repeat,details,created_at)
        VALUES (?,NULL,?,'download_gate_click','discussion',1,0,?,CURRENT_TIMESTAMP)`)
        .bind(publicationId, String(callback.from.id), JSON.stringify({ gateMessageId: gate.gate_message_id })),
      env.DB.prepare(`INSERT INTO publication_reader_events
        (publication_id,asset_id,user_telegram_id,event_type,source,success,repeat,details,created_at)
        VALUES (?,NULL,?,'thank_you_click','discussion',1,0,?,CURRENT_TIMESTAMP)`)
        .bind(publicationId, String(callback.from.id), JSON.stringify({ gateMessageId: gate.gate_message_id })),
      env.DB.prepare(`SELECT 1 AS active FROM publication_reader_events
        WHERE user_telegram_id=? AND source='bot' AND event_type IN ('download_open','delivery_success') LIMIT 1`)
        .bind(String(callback.from.id)),
    ]);
    returningReader = Boolean(grantResults[4]?.results?.length);
  } catch {
    await telegramJson(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Не удалось подготовить выдачу. Попробуйте ещё раз.' }).catch(() => undefined);
    return;
  }

  if (returningReader) ctx.waitUntil(deliverDownload(env, publicationId, callback.from, origin, ctx).catch(() => undefined));
  await telegramJson(env, 'answerCallbackQuery', { callback_query_id: callback.id, url: downloadUrl(env, publicationId) }).catch(async () => {
    await telegramJson(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Откройте бота, чтобы получить файлы.' }).catch(() => undefined);
  });
}

export async function handlePublicationReaderDeliveryCacheWebhook(
  request: Request,
  env: PublicationReaderDeliveryCacheEnv,
  ctx: ReaderDeliveryCacheExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/webhook' || request.method !== 'POST') return null;
  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (expected && request.headers.get('x-telegram-bot-api-secret-token') !== expected) return new Response('Forbidden', { status: 403 });
  const update = await request.clone().json().catch(() => null) as TelegramUpdate | null;
  if (!update) return null;

  if (/^gate-(?:thanks|download):/.test(update.callback_query?.data || '')) {
    ctx.waitUntil(handleThankGate(env, update.callback_query as TelegramCallbackQuery, url.origin, ctx));
    return new Response('ok');
  }
  const message = update.message;
  if (message?.chat?.type === 'private' && message.from && message.text?.startsWith('/start')) {
    const payload = message.text.trim().split(/\s+/, 2)[1] || '';
    const match = /^dl_(\d+)$/.exec(payload);
    if (match) {
      const publicationId = Number(match[1]);
      ctx.waitUntil(deliverDownload(env, publicationId, message.from, url.origin, ctx));
      return new Response('ok');
    }
  }

  return handleLegacyReaderWebhook(request, env as never, ctx as never);
}

export const publicationReaderSupportUrl = BOOSTY_SUPPORT_URL;
