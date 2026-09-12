import type { D1DatabaseLike } from './ranobelib-runtime.js';
import { getSessionUser, isSameOriginMutation, type WebAuthEnv, type WebTelegramUser } from './web-auth.js';

export interface WebCollectionCommentsEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
}

type CollectionAccessRow = { owner_telegram_id: string; is_public: number | string };
type CommentRow = {
  id: string;
  collection_id: string;
  author_telegram_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  username: string | null;
  first_name: string | null;
};

type CommentBody = { body?: unknown; commentId?: unknown };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const COMMENT_MAX = 3000;
const COMMENTS_LIMIT = 100;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readBody(request: Request): Promise<CommentBody | Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Некорректное тело запроса.' }, 400);
  return body as CommentBody;
}

async function collectionAccess(
  request: Request,
  env: WebCollectionCommentsEnv,
  collectionId: string,
): Promise<{ viewer: WebTelegramUser | null; ownerId: string } | Response> {
  const viewer = await getSessionUser(request, env);
  const viewerId = viewer ? String(viewer.id) : '';
  const row = await env.DB.prepare(`
    SELECT owner_telegram_id, is_public
    FROM web_collections
    WHERE id = ? AND (is_public = 1 OR owner_telegram_id = ?)
  `).bind(collectionId, viewerId).first<CollectionAccessRow>();
  if (!row) return json({ error: 'Коллекция не найдена.' }, 404);
  return { viewer, ownerId: row.owner_telegram_id };
}

async function ensureUser(env: WebCollectionCommentsEnv, user: WebTelegramUser): Promise<void> {
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

function publicComment(row: CommentRow, viewerId: string | null, ownerId: string) {
  return {
    id: row.id,
    body: row.body,
    author: {
      username: row.username || null,
      firstName: row.first_name || '',
    },
    isOwn: viewerId === row.author_telegram_id,
    canDelete: Boolean(viewerId && (viewerId === row.author_telegram_id || viewerId === ownerId)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCollectionComments(
  request: Request,
  env: WebCollectionCommentsEnv,
  collectionId: string,
): Promise<Response> {
  const access = await collectionAccess(request, env, collectionId);
  if (access instanceof Response) return access;
  const viewerId = access.viewer ? String(access.viewer.id) : null;
  const { results } = await env.DB.prepare(`
    SELECT c.id, c.collection_id, c.author_telegram_id, c.body, c.created_at, c.updated_at,
           u.username, u.first_name
    FROM web_collection_comments c
    LEFT JOIN users u ON u.telegram_id = c.author_telegram_id
    WHERE c.collection_id = ?
    ORDER BY c.created_at ASC, c.id ASC
    LIMIT ${COMMENTS_LIMIT}
  `).bind(collectionId).all<CommentRow>();
  return json({ comments: results.map((row) => publicComment(row, viewerId, access.ownerId)) });
}

export async function handleCollectionCommentsMutation(
  request: Request,
  env: WebCollectionCommentsEnv,
  collectionId: string,
): Promise<Response> {
  const access = await collectionAccess(request, env, collectionId);
  if (access instanceof Response) return access;
  const user = access.viewer;
  if (!user) return json({ error: 'Требуется вход через Telegram.' }, 401);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  const viewerId = String(user.id);
  const body = await readBody(request);
  if (body instanceof Response) return body;

  if (request.method === 'POST') {
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text || text.length > COMMENT_MAX) return json({ error: `Комментарий должен содержать от 1 до ${COMMENT_MAX} символов.` }, 400);
    await ensureUser(env, user);
    await env.DB.prepare(`
      INSERT INTO web_collection_comments (id, collection_id, author_telegram_id, body)
      VALUES (?, ?, ?, ?)
    `).bind(crypto.randomUUID(), collectionId, viewerId, text).run();
  } else if (request.method === 'DELETE') {
    const commentId = typeof body.commentId === 'string' ? body.commentId.trim() : '';
    if (!commentId) return json({ error: 'Комментарий не указан.' }, 400);
    const existing = await env.DB.prepare(`
      SELECT id FROM web_collection_comments
      WHERE id = ? AND collection_id = ?
        AND (
          author_telegram_id = ?
          OR EXISTS (
            SELECT 1 FROM web_collections
            WHERE id = ? AND owner_telegram_id = ?
          )
        )
    `).bind(commentId, collectionId, viewerId, collectionId, viewerId).first<{ id: string }>();
    if (!existing) return json({ error: 'Комментарий не найден.' }, 404);
    await env.DB.prepare(`
      DELETE FROM web_collection_comments
      WHERE id = ? AND collection_id = ?
        AND (
          author_telegram_id = ?
          OR EXISTS (
            SELECT 1 FROM web_collections
            WHERE id = ? AND owner_telegram_id = ?
          )
        )
    `).bind(commentId, collectionId, viewerId, collectionId, viewerId).run();
  } else {
    return json({ error: 'Method not allowed' }, 405);
  }

  return listCollectionComments(request, env, collectionId);
}
