import {
  getSessionUser,
  isSameOriginMutation,
  requireAdminSession,
  type WebAuthEnv,
  type WebTelegramUser,
} from './web-auth.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<unknown>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatement }
interface R2ObjectLike {
  size: number;
  etag?: string;
  httpMetadata?: { contentType?: string };
  body?: ReadableStream;
}
interface R2UploadedPartLike { partNumber: number; etag: string }
interface R2MultipartUploadLike {
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | Uint8Array): Promise<R2UploadedPartLike>;
  complete(parts: R2UploadedPartLike[]): Promise<R2ObjectLike>;
  abort(): Promise<void>;
}
interface R2BucketLike {
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<{ uploadId: string }>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadLike;
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
}
export interface ProposalRawEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
  FILES?: R2BucketLike;
}

type RawUploadRow = {
  id: string;
  user_telegram_id: string;
  object_key: string;
  original_name: string;
  content_type: string;
  expected_size: number | string;
  part_size: number | string;
  r2_upload_id: string;
  status: string;
  etag?: string | null;
  attached_proposal_id?: string | null;
  created_at?: string;
  completed_at?: string | null;
};

type RawPartRow = { part_number: number | string; etag: string; size_bytes: number | string };

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const PART_SIZE = 16 * 1024 * 1024;
const MAX_RAW_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_PARTS = 10_000;
const ALLOWED_EXTENSIONS = new Set(['zip','rar','7z','tar','gz','tgz','txt','md','rtf','pdf','epub','doc','docx']);
let schemaPromise: Promise<void> | null = null;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const numberValue = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const isHttpUrl = (value: string) => !value || /^https?:\/\//i.test(value);

function extensionFor(filename: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

function safeDownloadName(filename: string): string {
  return filename.replace(/[\r\n"\\/]/g, '_').slice(0, 180) || 'raw.bin';
}

async function ensureSchema(env: ProposalRawEnv): Promise<void> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS proposal_raw_uploads (
        id TEXT PRIMARY KEY,
        user_telegram_id TEXT NOT NULL,
        object_key TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        expected_size INTEGER NOT NULL,
        part_size INTEGER NOT NULL,
        r2_upload_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'uploading',
        etag TEXT,
        attached_proposal_id TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT,
        aborted_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS proposal_raw_parts (
        upload_id TEXT NOT NULL,
        part_number INTEGER NOT NULL,
        etag TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (upload_id, part_number)
      )`,
      `CREATE TABLE IF NOT EXISTS title_proposal_details (
        proposal_id TEXT PRIMARY KEY,
        original_title TEXT NOT NULL DEFAULT '',
        extra_url TEXT NOT NULL DEFAULT '',
        raw_upload_id TEXT UNIQUE
      )`,
      `CREATE TABLE IF NOT EXISTS reader_chapter_content (
        book_ref TEXT NOT NULL,
        chapter_id INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (book_ref, chapter_id)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_proposal_raw_user_created ON proposal_raw_uploads(user_telegram_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_proposal_raw_status_created ON proposal_raw_uploads(status, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_title_proposal_raw ON title_proposal_details(raw_upload_id)',
    ];
    for (const statement of statements) await env.DB.prepare(statement).run();
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

async function upsertUser(env: ProposalRawEnv, user: WebTelegramUser): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id,username,first_name,last_name,language_code,updated_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,
      language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP
  `).bind(String(user.id), user.username ?? null, user.first_name, user.last_name ?? '', user.language_code ?? null).run();
}

async function requireUser(request: Request, env: ProposalRawEnv): Promise<WebTelegramUser | Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Войдите через Telegram на сайте.' }, 401);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  await upsertUser(env, user);
  return user;
}

async function ownedUpload(env: ProposalRawEnv, id: string, userId: number): Promise<RawUploadRow | null> {
  return env.DB.prepare(`SELECT id,user_telegram_id,object_key,original_name,content_type,expected_size,part_size,
    r2_upload_id,status,etag,attached_proposal_id,created_at,completed_at
    FROM proposal_raw_uploads WHERE id=? AND user_telegram_id=?`).bind(id, String(userId)).first<RawUploadRow>();
}

async function handleInit(request: Request, env: ProposalRawEnv): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  if (!env.FILES) return json({ error: 'Файловое хранилище временно недоступно.' }, 503);
  await ensureSchema(env);

  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body)) return json({ error: 'Invalid JSON body.' }, 400);
  const filename = text(body.filename);
  const contentType = text(body.contentType) || 'application/octet-stream';
  const size = numberValue(body.size);
  const ext = extensionFor(filename);
  if (!filename || filename.length > 180) return json({ error: 'Некорректное имя RAW-файла.' }, 400);
  if (!ALLOWED_EXTENSIONS.has(ext)) return json({ error: `Формат .${ext || '?'} пока не поддерживается.` }, 415);
  if (!size || !Number.isSafeInteger(size) || size < 1 || size > MAX_RAW_BYTES) {
    return json({ error: 'RAW-файл должен быть не больше 5 ГиБ.' }, 413);
  }
  const partCount = Math.ceil(size / PART_SIZE);
  if (partCount > MAX_PARTS) return json({ error: 'Файл требует слишком много частей.' }, 413);

  const id = crypto.randomUUID();
  const objectKey = `proposal-raw/${user.id}/${id}/source.${ext}`;
  const multipart = await env.FILES.createMultipartUpload(objectKey, { httpMetadata: { contentType } });
  try {
    await env.DB.prepare(`INSERT INTO proposal_raw_uploads
      (id,user_telegram_id,object_key,original_name,content_type,expected_size,part_size,r2_upload_id)
      VALUES (?,?,?,?,?,?,?,?)`).bind(id, String(user.id), objectKey, filename, contentType, size, PART_SIZE, multipart.uploadId).run();
  } catch (error) {
    await env.FILES.resumeMultipartUpload(objectKey, multipart.uploadId).abort().catch(() => undefined);
    throw error;
  }
  return json({ id, filename, size, contentType, partSize: PART_SIZE, partCount, maxSize: MAX_RAW_BYTES }, 201);
}

async function handleStatus(request: Request, env: ProposalRawEnv, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  await ensureSchema(env);
  const upload = await ownedUpload(env, id, user.id);
  if (!upload) return json({ error: 'RAW upload не найден.' }, 404);
  const { results } = await env.DB.prepare('SELECT part_number,etag,size_bytes FROM proposal_raw_parts WHERE upload_id=? ORDER BY part_number')
    .bind(id).all<RawPartRow>();
  return json({
    id: upload.id,
    filename: upload.original_name,
    size: Number(upload.expected_size),
    partSize: Number(upload.part_size),
    status: upload.status,
    attachedProposalId: upload.attached_proposal_id ?? null,
    parts: results.map((row) => ({ partNumber: Number(row.part_number), etag: row.etag, size: Number(row.size_bytes) })),
  });
}

async function handlePart(request: Request, env: ProposalRawEnv, id: string, partNumber: number): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  if (!env.FILES) return json({ error: 'Файловое хранилище временно недоступно.' }, 503);
  await ensureSchema(env);
  const upload = await ownedUpload(env, id, user.id);
  if (!upload) return json({ error: 'RAW upload не найден.' }, 404);
  if (upload.status !== 'uploading') return json({ error: 'RAW upload уже завершён или отменён.' }, 409);
  const expectedSize = Number(upload.expected_size);
  const partSize = Number(upload.part_size);
  const partCount = Math.ceil(expectedSize / partSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) return json({ error: 'Некорректный номер части.' }, 400);
  const contentLength = Number(request.headers.get('content-length'));
  const expectedPartSize = partNumber === partCount ? expectedSize - partSize * (partCount - 1) : partSize;
  if (!Number.isSafeInteger(contentLength) || contentLength !== expectedPartSize) {
    return json({ error: `Часть ${partNumber} должна содержать ${expectedPartSize} байт.` }, 400);
  }
  if (!request.body) return json({ error: 'Пустое тело части.' }, 400);

  const multipart = env.FILES.resumeMultipartUpload(upload.object_key, upload.r2_upload_id);
  const part = await multipart.uploadPart(partNumber, request.body);
  await env.DB.prepare(`INSERT INTO proposal_raw_parts (upload_id,part_number,etag,size_bytes)
    VALUES (?,?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=excluded.etag,size_bytes=excluded.size_bytes,created_at=CURRENT_TIMESTAMP`)
    .bind(id, part.partNumber, part.etag, contentLength).run();
  return json({ partNumber: part.partNumber, etag: part.etag, size: contentLength });
}

async function handleComplete(request: Request, env: ProposalRawEnv, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  if (!env.FILES) return json({ error: 'Файловое хранилище временно недоступно.' }, 503);
  await ensureSchema(env);
  const upload = await ownedUpload(env, id, user.id);
  if (!upload) return json({ error: 'RAW upload не найден.' }, 404);
  if (upload.status === 'ready') return json({ ok: true, id, status: 'ready' });
  if (upload.status !== 'uploading') return json({ error: 'RAW upload уже отменён.' }, 409);

  const expectedSize = Number(upload.expected_size);
  const partSize = Number(upload.part_size);
  const expectedParts = Math.ceil(expectedSize / partSize);
  const { results } = await env.DB.prepare('SELECT part_number,etag,size_bytes FROM proposal_raw_parts WHERE upload_id=? ORDER BY part_number')
    .bind(id).all<RawPartRow>();
  const total = results.reduce((sum, row) => sum + Number(row.size_bytes), 0);
  if (results.length !== expectedParts || total !== expectedSize) {
    return json({ error: 'Не все части RAW-файла загружены.' }, 409);
  }
  const parts = results.map((row) => ({ partNumber: Number(row.part_number), etag: row.etag }));
  const multipart = env.FILES.resumeMultipartUpload(upload.object_key, upload.r2_upload_id);
  const completed = await multipart.complete(parts);
  const stored = await env.FILES.head(upload.object_key);
  if (!stored || stored.size !== expectedSize) {
    await env.FILES.delete(upload.object_key).catch(() => undefined);
    return json({ error: 'Проверка размера RAW после загрузки не прошла.' }, 502);
  }
  await env.DB.prepare(`UPDATE proposal_raw_uploads SET status='ready',etag=?,completed_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(completed.etag ?? stored.etag ?? '', id).run();
  return json({ ok: true, id, status: 'ready', size: stored.size, filename: upload.original_name });
}

async function handleAbort(request: Request, env: ProposalRawEnv, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  if (!env.FILES) return json({ error: 'Файловое хранилище временно недоступно.' }, 503);
  await ensureSchema(env);
  const upload = await ownedUpload(env, id, user.id);
  if (!upload) return json({ error: 'RAW upload не найден.' }, 404);
  if (upload.attached_proposal_id) return json({ error: 'RAW уже прикреплён к заявке.' }, 409);
  if (upload.status === 'uploading') {
    await env.FILES.resumeMultipartUpload(upload.object_key, upload.r2_upload_id).abort().catch(() => undefined);
  } else if (upload.status === 'ready') {
    await env.FILES.delete(upload.object_key).catch(() => undefined);
  }
  await env.DB.prepare("UPDATE proposal_raw_uploads SET status='aborted',aborted_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
  await env.DB.prepare('DELETE FROM proposal_raw_parts WHERE upload_id=?').bind(id).run();
  return json({ ok: true, id, status: 'aborted' });
}

async function handleCreateTitleProposal(request: Request, env: ProposalRawEnv): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  await ensureSchema(env);
  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body)) return json({ error: 'Invalid JSON body.' }, 400);
  const title = text(body.title);
  const originalTitle = text(body.originalTitle);
  const sourceUrl = text(body.sourceUrl);
  const extraUrl = text(body.extraUrl);
  const comment = text(body.comment);
  const rawUploadId = text(body.rawUploadId);
  if (title.length < 2 || title.length > 180) return json({ error: 'Название должно содержать от 2 до 180 символов.' }, 400);
  if (originalTitle.length > 180 || sourceUrl.length > 500 || extraUrl.length > 500 || comment.length > 1500) return json({ error: 'Заявка слишком большая.' }, 413);
  if (!isHttpUrl(sourceUrl) || !isHttpUrl(extraUrl)) return json({ error: 'Ссылки должны начинаться с http:// или https://.' }, 400);
  if (!sourceUrl && !rawUploadId) return json({ error: 'Приложите RAW-файл или укажите рабочую ссылку на RAW.' }, 400);

  let raw: RawUploadRow | null = null;
  if (rawUploadId) {
    raw = await ownedUpload(env, rawUploadId, user.id);
    if (!raw) return json({ error: 'RAW upload не найден.' }, 404);
    if (raw.status !== 'ready') return json({ error: 'Дождитесь завершения загрузки RAW.' }, 409);
    if (raw.attached_proposal_id) return json({ error: 'Этот RAW уже прикреплён к другой заявке.' }, 409);
  }

  const duplicate = await env.DB.prepare(`SELECT id FROM chapter_proposals
    WHERE user_telegram_id=? AND proposal_type='title' AND lower(title)=lower(?)
      AND status IN ('pending','approved','planned','in_progress') LIMIT 1`).bind(String(user.id), title).first<{ id: string }>();
  if (duplicate) return json({ error: 'У вас уже есть активная заявка на этот тайтл.', id: duplicate.id }, 409);

  const proposalId = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO chapter_proposals
      (id,user_telegram_id,proposal_type,title,source_url,chapter_from,chapter_to,comment)
      VALUES (?,?,'title',?,?,NULL,NULL,?)`).bind(proposalId, String(user.id), title, sourceUrl, comment).run();
    await env.DB.prepare(`INSERT INTO title_proposal_details (proposal_id,original_title,extra_url,raw_upload_id)
      VALUES (?,?,?,?)`).bind(proposalId, originalTitle, extraUrl, rawUploadId || null).run();
    if (rawUploadId) {
      await env.DB.prepare('UPDATE proposal_raw_uploads SET attached_proposal_id=? WHERE id=? AND attached_proposal_id IS NULL')
        .bind(proposalId, rawUploadId).run();
    }
  } catch (error) {
    await env.DB.prepare('DELETE FROM title_proposal_details WHERE proposal_id=?').bind(proposalId).run().catch(() => undefined);
    await env.DB.prepare('DELETE FROM chapter_proposals WHERE id=?').bind(proposalId).run().catch(() => undefined);
    throw error;
  }
  return json({ id: proposalId, status: 'pending', rawUploadId: rawUploadId || null }, 201);
}

async function handleAdminList(request: Request, env: ProposalRawEnv): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  await ensureSchema(env);
  const { results } = await env.DB.prepare(`SELECT r.id,r.original_name,r.content_type,r.expected_size,r.status,r.created_at,r.completed_at,
    r.attached_proposal_id,p.title,p.user_telegram_id,d.original_title,d.extra_url
    FROM proposal_raw_uploads r
    LEFT JOIN chapter_proposals p ON p.id=r.attached_proposal_id
    LEFT JOIN title_proposal_details d ON d.proposal_id=p.id
    ORDER BY r.created_at DESC LIMIT 200`).all();
  return json({ uploads: results });
}

async function handleAdminDownload(request: Request, env: ProposalRawEnv, id: string): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  if (!env.FILES) return json({ error: 'Файловое хранилище временно недоступно.' }, 503);
  await ensureSchema(env);
  const row = await env.DB.prepare(`SELECT object_key,original_name,content_type,status FROM proposal_raw_uploads WHERE id=?`)
    .bind(id).first<{ object_key: string; original_name: string; content_type: string; status: string }>();
  if (!row || row.status !== 'ready') return json({ error: 'RAW-файл не найден.' }, 404);
  const object = await env.FILES.get(row.object_key);
  if (!object?.body) return json({ error: 'RAW object отсутствует в R2.' }, 404);
  return new Response(object.body, {
    headers: {
      'content-type': row.content_type || 'application/octet-stream',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="${safeDownloadName(row.original_name)}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function handleProposalRawApi(request: Request, env: ProposalRawEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/api/proposal-raw/init') return handleInit(request, env);
  if (request.method === 'POST' && url.pathname === '/api/title-proposals') return handleCreateTitleProposal(request, env);
  if (request.method === 'GET' && url.pathname === '/api/admin/proposal-raw') return handleAdminList(request, env);

  const status = /^\/api\/proposal-raw\/([^/]+)$/.exec(url.pathname);
  if (status?.[1] && request.method === 'GET') return handleStatus(request, env, decodeURIComponent(status[1]));
  if (status?.[1] && request.method === 'DELETE') return handleAbort(request, env, decodeURIComponent(status[1]));
  const part = /^\/api\/proposal-raw\/([^/]+)\/parts\/(\d+)$/.exec(url.pathname);
  if (part?.[1] && part[2] && request.method === 'PUT') return handlePart(request, env, decodeURIComponent(part[1]), Number(part[2]));
  const complete = /^\/api\/proposal-raw\/([^/]+)\/complete$/.exec(url.pathname);
  if (complete?.[1] && request.method === 'POST') return handleComplete(request, env, decodeURIComponent(complete[1]));
  const download = /^\/api\/admin\/proposal-raw\/([^/]+)\/download$/.exec(url.pathname);
  if (download?.[1] && request.method === 'GET') return handleAdminDownload(request, env, decodeURIComponent(download[1]));
  return null;
}

export const proposalRawLimits = {
  partSize: PART_SIZE,
  maxRawBytes: MAX_RAW_BYTES,
  allowedExtensions: Array.from(ALLOWED_EXTENSIONS),
};
