import type { D1DatabaseLike } from './ranobelib-runtime.js';
import { handleCollectionItemsMutation, listCollectionItems } from './web-collection-items.js';
import { getSessionUser, isSameOriginMutation, type WebAuthEnv, type WebTelegramUser } from './web-auth.js';

export interface WebCollectionsEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
}

type CollectionRow = {
  id: string;
  owner_telegram_id: string;
  title: string;
  description: string;
  is_public: number | string;
  created_at: string;
  updated_at: string;
  owner_username?: string | null;
  owner_first_name?: string | null;
  item_count?: number | string | null;
};

type CollectionInput = {
  title?: unknown;
  description?: unknown;
  isPublic?: unknown;
};

type CollectionRoute = { kind: 'collection' | 'items'; id: string };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const COLLECTION_PREFIX = '/api/collections/';
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 4000;
const LIST_LIMIT = 60;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function collectionRoute(pathname: string): CollectionRoute | null {
  if (!pathname.startsWith(COLLECTION_PREFIX)) return null;
  const parts = pathname.slice(COLLECTION_PREFIX.length).split('/');
  if (!parts[0] || parts.length > 2 || (parts.length === 2 && parts[1] !== 'items')) return null;
  try {
    const id = decodeURIComponent(parts[0]).trim();
    if (!/^[a-f0-9-]{16,64}$/i.test(id)) return null;
    return { kind: parts[1] === 'items' ? 'items' : 'collection', id };
  } catch {
    return null;
  }
}

function publicCollection(row: CollectionRow, viewerId: string | null) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    isPublic: Number(row.is_public) === 1,
    itemCount: Number(row.item_count ?? 0) || 0,
    owner: {
      username: row.owner_username || null,
      firstName: row.owner_first_name || '',
    },
    isOwner: viewerId === row.owner_telegram_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readBody(request: Request): Promise<CollectionInput | Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Некорректное тело запроса.' }, 400);
  return body as CollectionInput;
}

function normalizedTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim().replace(/\s+/g, ' ');
  return title && title.length <= TITLE_MAX ? title : null;
}

function normalizedDescription(value: unknown): string | null {
  if (value === undefined) return '';
  if (typeof value !== 'string') return null;
  const description = value.trim();
  return description.length <= DESCRIPTION_MAX ? description : null;
}

function normalizedVisibility(value: unknown, fallback = true): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === 'boolean' ? value : null;
}

async function requireUser(request: Request, env: WebCollectionsEnv): Promise<WebTelegramUser | Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Требуется вход через Telegram.' }, 401);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  return user;
}

async function upsertWebUser(env: WebCollectionsEnv, user: WebTelegramUser): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, language_code, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      language_code = excluded.language_code,
      updated_at = CURRENT_TIMESTAMP
  `).bind(String(user.id), user.username ?? null, user.first_name, user.last_name ?? '', user.language_code ?? null).run();
}

async function requireOwnedCollection(env: WebCollectionsEnv, id: string, ownerId: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT id FROM web_collections
    WHERE id = ? AND owner_telegram_id = ?
  `).bind(id, ownerId).first<{ id: string }>();
  return Boolean(row);
}

async function listCollections(request: Request, env: WebCollectionsEnv, url: URL): Promise<Response> {
  const viewer = await getSessionUser(request, env);
  const viewerId = viewer ? String(viewer.id) : null;
  const mine = url.searchParams.get('mine') === '1';
  if (mine && !viewerId) return json({ error: 'Требуется вход через Telegram.' }, 401);
  const baseSelect = `
    SELECT c.id, c.owner_telegram_id, c.title, c.description, c.is_public, c.created_at, c.updated_at,
           u.username AS owner_username, u.first_name AS owner_first_name, COUNT(i.id) AS item_count
    FROM web_collections c
    LEFT JOIN users u ON u.telegram_id = c.owner_telegram_id
    LEFT JOIN web_collection_items i ON i.collection_id = c.id
  `;
  const statement = mine
    ? env.DB.prepare(`${baseSelect} WHERE c.owner_telegram_id = ? GROUP BY c.id ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ${LIST_LIMIT}`).bind(viewerId)
    : env.DB.prepare(`${baseSelect} WHERE c.is_public = 1 GROUP BY c.id ORDER BY c.updated_at DESC, c.created_at DESC LIMIT ${LIST_LIMIT}`);
  const { results } = await statement.all<CollectionRow>();
  return json({ collections: results.map((row) => publicCollection(row, viewerId)) });
}

async function getCollection(request: Request, env: WebCollectionsEnv, id: string): Promise<Response> {
  const viewer = await getSessionUser(request, env);
  const viewerId = viewer ? String(viewer.id) : null;
  const row = await env.DB.prepare(`
    SELECT c.id, c.owner_telegram_id, c.title, c.description, c.is_public, c.created_at, c.updated_at,
           u.username AS owner_username, u.first_name AS owner_first_name, COUNT(i.id) AS item_count
    FROM web_collections c
    LEFT JOIN users u ON u.telegram_id = c.owner_telegram_id
    LEFT JOIN web_collection_items i ON i.collection_id = c.id
    WHERE c.id = ? AND (c.is_public = 1 OR c.owner_telegram_id = ?)
    GROUP BY c.id
  `).bind(id, viewerId ?? '').first<CollectionRow>();
  if (!row) return json({ error: 'Коллекция не найдена.' }, 404);
  const items = await listCollectionItems(env, id);
  return json({ collection: publicCollection(row, viewerId), items });
}

async function createCollection(request: Request, env: WebCollectionsEnv): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const title = normalizedTitle(body.title);
  const description = normalizedDescription(body.description);
  const isPublic = normalizedVisibility(body.isPublic);
  if (!title) return json({ error: `Название должно содержать от 1 до ${TITLE_MAX} символов.` }, 400);
  if (description === null) return json({ error: `Описание не должно превышать ${DESCRIPTION_MAX} символов.` }, 400);
  if (isPublic === null) return json({ error: 'Некорректная видимость коллекции.' }, 400);
  await upsertWebUser(env, user);
  const id = crypto.randomUUID();
  const ownerId = String(user.id);
  await env.DB.prepare(`
    INSERT INTO web_collections (id, owner_telegram_id, title, description, is_public)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, ownerId, title, description, isPublic ? 1 : 0).run();
  const row = await env.DB.prepare(`
    SELECT c.id, c.owner_telegram_id, c.title, c.description, c.is_public, c.created_at, c.updated_at,
           u.username AS owner_username, u.first_name AS owner_first_name, 0 AS item_count
    FROM web_collections c LEFT JOIN users u ON u.telegram_id = c.owner_telegram_id
    WHERE c.id = ? AND c.owner_telegram_id = ?
  `).bind(id, ownerId).first<CollectionRow>();
  return json({ collection: row ? publicCollection(row, ownerId) : null }, 201);
}

async function updateCollection(request: Request, env: WebCollectionsEnv, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const ownerId = String(user.id);
  if (!await requireOwnedCollection(env, id, ownerId)) return json({ error: 'Коллекция не найдена.' }, 404);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const title = body.title === undefined ? undefined : normalizedTitle(body.title);
  const description = body.description === undefined ? undefined : normalizedDescription(body.description);
  const isPublic = body.isPublic === undefined ? undefined : normalizedVisibility(body.isPublic);
  if (body.title !== undefined && !title) return json({ error: `Название должно содержать от 1 до ${TITLE_MAX} символов.` }, 400);
  if (body.description !== undefined && description === null) return json({ error: `Описание не должно превышать ${DESCRIPTION_MAX} символов.` }, 400);
  if (body.isPublic !== undefined && isPublic === null) return json({ error: 'Некорректная видимость коллекции.' }, 400);
  if (title === undefined && description === undefined && isPublic === undefined) return json({ error: 'Нет изменений.' }, 400);
  await env.DB.prepare(`
    UPDATE web_collections
    SET title = COALESCE(?, title), description = COALESCE(?, description),
        is_public = COALESCE(?, is_public), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_telegram_id = ?
  `).bind(title ?? null, description ?? null, isPublic === undefined ? null : isPublic ? 1 : 0, id, ownerId).run();
  return getCollection(request, env, id);
}

async function deleteCollection(request: Request, env: WebCollectionsEnv, id: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const ownerId = String(user.id);
  if (!await requireOwnedCollection(env, id, ownerId)) return json({ error: 'Коллекция не найдена.' }, 404);
  await env.DB.prepare(`
    DELETE FROM web_collections
    WHERE id = ? AND owner_telegram_id = ?
  `).bind(id, ownerId).run();
  return json({ ok: true });
}

export async function handleWebCollectionsApi(request: Request, env: WebCollectionsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const route = collectionRoute(url.pathname);
  const isRoot = url.pathname === '/api/collections';
  if (!isRoot && !route) return null;
  if (isRoot) {
    if (request.method === 'GET') return listCollections(request, env, url);
    if (request.method === 'POST') return createCollection(request, env);
    return json({ error: 'Method not allowed' }, 405);
  }
  if (route.kind === 'items') {
    if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') {
      const response = await handleCollectionItemsMutation(request, env, route.id);
      if (!response.ok) return response;
      return getCollection(request, env, route.id);
    }
    return json({ error: 'Method not allowed' }, 405);
  }
  if (request.method === 'GET') return getCollection(request, env, route.id);
  if (request.method === 'PATCH') return updateCollection(request, env, route.id);
  if (request.method === 'DELETE') return deleteCollection(request, env, route.id);
  return json({ error: 'Method not allowed' }, 405);
}
