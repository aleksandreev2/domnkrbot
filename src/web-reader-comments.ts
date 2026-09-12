import type { D1DatabaseLike } from './ranobelib-runtime.js';
import {
  getSessionUser,
  isAdminUser,
  isSameOriginMutation,
  type WebAuthEnv,
  type WebTelegramUser,
} from './web-auth.js';

export interface WebReaderCommentsEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
}

type ReaderCommentRow = {
  id: string;
  book_ref: string;
  chapter_id: number | string;
  author_telegram_id: string;
  parent_comment_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  username: string | null;
  first_name: string | null;
  score: number | string | null;
  my_vote: number | string | null;
};

type CommentLocatorRow = {
  id: string;
  book_ref: string;
  chapter_id: number | string;
  author_telegram_id: string;
  deleted_at: string | null;
};

type CommentBody = {
  bookRef?: unknown;
  chapterId?: unknown;
  body?: unknown;
  parentCommentId?: unknown;
  value?: unknown;
};

type ReaderCommentsRoute =
  | { kind: 'root' }
  | { kind: 'comment'; commentId: string }
  | { kind: 'vote'; commentId: string };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const COMMENTS_PATH = '/api/reader/comments';
const COMMENT_MAX = 3000;
const COMMENTS_LIMIT = 300;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cleanBookRef(value: unknown): string {
  const ref = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9._:-]{1,180}$/.test(ref) ? ref : '';
}

function cleanChapterId(value: unknown): number | null {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanCommentId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9-]{16,64}$/i.test(id) ? id : '';
}

function routeFor(pathname: string): ReaderCommentsRoute | null {
  if (pathname === COMMENTS_PATH) return { kind: 'root' };
  if (!pathname.startsWith(`${COMMENTS_PATH}/`)) return null;
  const parts = pathname.slice(COMMENTS_PATH.length + 1).split('/').filter(Boolean);
  const commentId = cleanCommentId(parts[0]);
  if (!commentId) return null;
  if (parts.length === 1) return { kind: 'comment', commentId };
  if (parts.length === 2 && parts[1] === 'vote') return { kind: 'vote', commentId };
  return null;
}

async function readBody(request: Request): Promise<CommentBody | Response> {
  const parsed = await request.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'Некорректное тело запроса.' }, 400);
  }
  return parsed as CommentBody;
}

async function ensureUser(env: WebReaderCommentsEnv, user: WebTelegramUser): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, language_code, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      language_code = excluded.language_code,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    String(user.id),
    user.username ?? null,
    user.first_name,
    user.last_name ?? '',
    user.language_code ?? null,
  ).run();
}

async function chapterExists(env: WebReaderCommentsEnv, bookRef: string, chapterId: number): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT c.chapter_id
    FROM ranobelib_chapters c
    INNER JOIN ranobelib_titles t ON t.book_ref = c.book_ref
    WHERE c.book_ref = ? AND c.chapter_id = ?
    LIMIT 1
  `).bind(bookRef, chapterId).first<{ chapter_id: number | string }>();
  return Boolean(row);
}

async function requireUser(request: Request, env: WebReaderCommentsEnv): Promise<WebTelegramUser | Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Требуется вход через Telegram.' }, 401);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  return user;
}

function publicComment(row: ReaderCommentRow, viewerId: string | null, admin: boolean) {
  const deleted = Boolean(row.deleted_at);
  return {
    id: row.id,
    bookRef: row.book_ref,
    chapterId: Number(row.chapter_id),
    parentCommentId: row.parent_comment_id,
    body: deleted ? '' : row.body,
    deleted,
    author: {
      username: row.username || null,
      firstName: row.first_name || '',
    },
    score: deleted ? 0 : Number(row.score ?? 0) || 0,
    myVote: deleted ? 0 : Number(row.my_vote ?? 0) || 0,
    isOwn: Boolean(viewerId && viewerId === row.author_telegram_id),
    canDelete: Boolean(!deleted && viewerId && (viewerId === row.author_telegram_id || admin)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listComments(
  request: Request,
  env: WebReaderCommentsEnv,
  bookRef: string,
  chapterId: number,
): Promise<Response> {
  if (!await chapterExists(env, bookRef, chapterId)) return json({ error: 'Глава не найдена.' }, 404);
  const user = await getSessionUser(request, env);
  const viewerId = user ? String(user.id) : null;
  const admin = isAdminUser(env, user);
  const { results } = await env.DB.prepare(`
    SELECT c.id, c.book_ref, c.chapter_id, c.author_telegram_id, c.parent_comment_id,
           c.body, c.created_at, c.updated_at, c.deleted_at,
           u.username, u.first_name,
           COALESCE(SUM(v.value), 0) AS score,
           COALESCE(MAX(CASE WHEN v.voter_telegram_id = ? THEN v.value ELSE 0 END), 0) AS my_vote
    FROM reader_chapter_comments c
    LEFT JOIN users u ON u.telegram_id = c.author_telegram_id
    LEFT JOIN reader_chapter_comment_votes v ON v.comment_id = c.id
    WHERE c.book_ref = ? AND c.chapter_id = ?
    GROUP BY c.id
    ORDER BY c.created_at ASC, c.id ASC
    LIMIT ${COMMENTS_LIMIT}
  `).bind(viewerId ?? '', bookRef, chapterId).all<ReaderCommentRow>();
  return json({ comments: results.map((row) => publicComment(row, viewerId, admin)) });
}

async function createComment(request: Request, env: WebReaderCommentsEnv): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;

  const bookRef = cleanBookRef(payload.bookRef);
  const chapterId = cleanChapterId(payload.chapterId);
  const text = typeof payload.body === 'string' ? payload.body.trim() : '';
  const parentCommentId = payload.parentCommentId == null || payload.parentCommentId === ''
    ? null
    : cleanCommentId(payload.parentCommentId);

  if (!bookRef || !chapterId) return json({ error: 'Некорректный ref или chapter.' }, 400);
  if (!text || text.length > COMMENT_MAX) {
    return json({ error: `Комментарий должен содержать от 1 до ${COMMENT_MAX} символов.` }, 400);
  }
  if (payload.parentCommentId != null && payload.parentCommentId !== '' && !parentCommentId) {
    return json({ error: 'Некорректный parentCommentId.' }, 400);
  }
  if (!await chapterExists(env, bookRef, chapterId)) return json({ error: 'Глава не найдена.' }, 404);

  if (parentCommentId) {
    const parent = await env.DB.prepare(`
      SELECT id FROM reader_chapter_comments
      WHERE id = ? AND book_ref = ? AND chapter_id = ?
      LIMIT 1
    `).bind(parentCommentId, bookRef, chapterId).first<{ id: string }>();
    if (!parent) return json({ error: 'Родительский комментарий не найден.' }, 404);
  }

  await ensureUser(env, user);
  await env.DB.prepare(`
    INSERT INTO reader_chapter_comments
      (id, book_ref, chapter_id, author_telegram_id, parent_comment_id, body)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), bookRef, chapterId, String(user.id), parentCommentId, text).run();

  return listComments(request, env, bookRef, chapterId);
}

async function locateComment(env: WebReaderCommentsEnv, commentId: string, includeDeleted = true): Promise<CommentLocatorRow | null> {
  const deletedClause = includeDeleted ? '' : 'AND deleted_at IS NULL';
  return env.DB.prepare(`
    SELECT id, book_ref, chapter_id, author_telegram_id, deleted_at
    FROM reader_chapter_comments
    WHERE id = ? ${deletedClause}
    LIMIT 1
  `).bind(commentId).first<CommentLocatorRow>();
}

async function deleteComment(
  request: Request,
  env: WebReaderCommentsEnv,
  commentId: string,
): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const existing = await locateComment(env, commentId);
  if (!existing) return json({ error: 'Комментарий не найден.' }, 404);

  const viewerId = String(user.id);
  if (existing.author_telegram_id !== viewerId && !isAdminUser(env, user)) {
    return json({ error: 'Недостаточно прав для удаления комментария.' }, 403);
  }

  if (!existing.deleted_at) {
    await env.DB.prepare(`
      UPDATE reader_chapter_comments
      SET body = '', deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(commentId).run();
  }

  return listComments(request, env, existing.book_ref, Number(existing.chapter_id));
}

async function voteComment(
  request: Request,
  env: WebReaderCommentsEnv,
  commentId: string,
): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;
  const value = Number(payload.value);
  if (value !== -1 && value !== 0 && value !== 1) return json({ error: 'Некорректная оценка.' }, 400);

  const existing = await locateComment(env, commentId, false);
  if (!existing) return json({ error: 'Комментарий не найден.' }, 404);
  await ensureUser(env, user);
  const viewerId = String(user.id);

  if (value === 0) {
    await env.DB.prepare(`
      DELETE FROM reader_chapter_comment_votes
      WHERE comment_id = ? AND voter_telegram_id = ?
    `).bind(commentId, viewerId).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO reader_chapter_comment_votes
        (comment_id, voter_telegram_id, value)
      VALUES (?, ?, ?)
      ON CONFLICT(comment_id, voter_telegram_id) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).bind(commentId, viewerId, value).run();
  }

  return listComments(request, env, existing.book_ref, Number(existing.chapter_id));
}

export async function handleWebReaderCommentsApi(
  request: Request,
  env: WebReaderCommentsEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = routeFor(url.pathname);
  if (!route) return null;

  if (route.kind === 'root') {
    if (request.method === 'GET') {
      const bookRef = cleanBookRef(url.searchParams.get('ref'));
      const chapterId = cleanChapterId(url.searchParams.get('chapter'));
      return bookRef && chapterId
        ? listComments(request, env, bookRef, chapterId)
        : json({ error: 'Некорректный ref или chapter.' }, 400);
    }
    if (request.method === 'POST') return createComment(request, env);
    return json({ error: 'Method not allowed' }, 405);
  }

  if (route.kind === 'comment') {
    if (request.method === 'DELETE') return deleteComment(request, env, route.commentId);
    return json({ error: 'Method not allowed' }, 405);
  }

  if (request.method === 'PUT') return voteComment(request, env, route.commentId);
  return json({ error: 'Method not allowed' }, 405);
}
