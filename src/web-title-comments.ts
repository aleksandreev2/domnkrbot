import type { D1DatabaseLike } from './ranobelib-runtime.js';
import {
  getSessionUser,
  isAdminUser,
  isSameOriginMutation,
  type WebAuthEnv,
  type WebTelegramUser,
} from './web-auth.js';

export interface WebTitleCommentsEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
}

type TitleCommentRow = {
  id: string;
  book_ref: string;
  author_telegram_id: string;
  parent_comment_id: string | null;
  body: string;
  is_pinned: number | string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  username: string | null;
  first_name: string | null;
  score: number | string | null;
  my_vote: number | string | null;
  my_report: number | string | null;
};

type CommentLocatorRow = {
  id: string;
  book_ref: string;
  author_telegram_id: string;
  deleted_at: string | null;
};

type CommentBody = {
  bookRef?: unknown;
  body?: unknown;
  parentCommentId?: unknown;
  value?: unknown;
  reason?: unknown;
  pinned?: unknown;
  sort?: unknown;
};

type TitleCommentsRoute =
  | { kind: 'root' }
  | { kind: 'comment'; commentId: string }
  | { kind: 'vote'; commentId: string }
  | { kind: 'report'; commentId: string }
  | { kind: 'pin'; commentId: string };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const COMMENTS_PATH = '/api/title/comments';
const COMMENT_MAX = 3000;
const REPORT_MAX = 500;
const COMMENTS_LIMIT = 300;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cleanBookRef(value: unknown): string {
  const ref = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9._:-]{1,180}$/.test(ref) ? ref : '';
}

function cleanCommentId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9-]{16,64}$/i.test(id) ? id : '';
}

function cleanSort(value: unknown): 'new' | 'top' {
  return value === 'top' ? 'top' : 'new';
}

function routeFor(pathname: string): TitleCommentsRoute | null {
  if (pathname === COMMENTS_PATH) return { kind: 'root' };
  if (!pathname.startsWith(`${COMMENTS_PATH}/`)) return null;
  const parts = pathname.slice(COMMENTS_PATH.length + 1).split('/').filter(Boolean);
  const commentId = cleanCommentId(parts[0]);
  if (!commentId) return null;
  if (parts.length === 1) return { kind: 'comment', commentId };
  if (parts.length !== 2) return null;
  if (parts[1] === 'vote') return { kind: 'vote', commentId };
  if (parts[1] === 'report') return { kind: 'report', commentId };
  if (parts[1] === 'pin') return { kind: 'pin', commentId };
  return null;
}

async function readBody(request: Request): Promise<CommentBody | Response> {
  const parsed = await request.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'Некорректное тело запроса.' }, 400);
  }
  return parsed as CommentBody;
}

async function ensureUser(env: WebTitleCommentsEnv, user: WebTelegramUser): Promise<void> {
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

async function titleExists(env: WebTitleCommentsEnv, bookRef: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT book_ref
    FROM ranobelib_titles
    WHERE book_ref = ?
    LIMIT 1
  `).bind(bookRef).first<{ book_ref: string }>();
  return Boolean(row);
}

async function requireUser(request: Request, env: WebTitleCommentsEnv): Promise<WebTelegramUser | Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Требуется вход через Telegram.' }, 401);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  return user;
}

function publicComment(row: TitleCommentRow, viewerId: string | null, admin: boolean) {
  const deleted = Boolean(row.deleted_at);
  const isOwn = Boolean(viewerId && viewerId === row.author_telegram_id);
  return {
    id: row.id,
    bookRef: row.book_ref,
    parentCommentId: row.parent_comment_id,
    body: deleted ? '' : row.body,
    deleted,
    pinned: Boolean(Number(row.is_pinned ?? 0)),
    author: {
      username: row.username || null,
      firstName: row.first_name || '',
    },
    score: deleted ? 0 : Number(row.score ?? 0) || 0,
    myVote: deleted ? 0 : Number(row.my_vote ?? 0) || 0,
    reportedByMe: Boolean(Number(row.my_report ?? 0)),
    isOwn,
    canDelete: Boolean(!deleted && viewerId && (isOwn || admin)),
    canPin: Boolean(!deleted && admin),
    canReport: Boolean(!deleted && viewerId && !isOwn),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listComments(
  request: Request,
  env: WebTitleCommentsEnv,
  bookRef: string,
  sort: 'new' | 'top',
): Promise<Response> {
  if (!await titleExists(env, bookRef)) return json({ error: 'Тайтл не найден.' }, 404);
  const user = await getSessionUser(request, env);
  const viewerId = user ? String(user.id) : null;
  const admin = isAdminUser(env, user);
  const orderBy = sort === 'top'
    ? 'c.is_pinned DESC, score DESC, c.created_at DESC, c.id DESC'
    : 'c.is_pinned DESC, c.created_at DESC, c.id DESC';
  const { results } = await env.DB.prepare(`
    SELECT c.id, c.book_ref, c.author_telegram_id, c.parent_comment_id,
           c.body, c.is_pinned, c.created_at, c.updated_at, c.deleted_at,
           u.username, u.first_name,
           COALESCE(SUM(v.value), 0) AS score,
           COALESCE(MAX(CASE WHEN v.voter_telegram_id = ? THEN v.value ELSE 0 END), 0) AS my_vote,
           CASE WHEN EXISTS (
             SELECT 1 FROM web_title_comment_reports r
             WHERE r.comment_id = c.id AND r.reporter_telegram_id = ?
           ) THEN 1 ELSE 0 END AS my_report
    FROM web_title_comments c
    LEFT JOIN users u ON u.telegram_id = c.author_telegram_id
    LEFT JOIN web_title_comment_votes v ON v.comment_id = c.id
    WHERE c.book_ref = ?
    GROUP BY c.id
    ORDER BY ${orderBy}
    LIMIT ${COMMENTS_LIMIT}
  `).bind(viewerId ?? '', viewerId ?? '', bookRef).all<TitleCommentRow>();
  return json({ sort, comments: results.map((row) => publicComment(row, viewerId, admin)) });
}

async function createComment(request: Request, env: WebTitleCommentsEnv): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;

  const bookRef = cleanBookRef(payload.bookRef);
  const text = typeof payload.body === 'string' ? payload.body.trim() : '';
  const parentCommentId = payload.parentCommentId == null || payload.parentCommentId === ''
    ? null
    : cleanCommentId(payload.parentCommentId);
  const sort = cleanSort(payload.sort);

  if (!bookRef) return json({ error: 'Некорректный ref.' }, 400);
  if (!text || text.length > COMMENT_MAX) {
    return json({ error: `Комментарий должен содержать от 1 до ${COMMENT_MAX} символов.` }, 400);
  }
  if (payload.parentCommentId != null && payload.parentCommentId !== '' && !parentCommentId) {
    return json({ error: 'Некорректный parentCommentId.' }, 400);
  }
  if (!await titleExists(env, bookRef)) return json({ error: 'Тайтл не найден.' }, 404);

  if (parentCommentId) {
    const parent = await env.DB.prepare(`
      SELECT id FROM web_title_comments
      WHERE id = ? AND book_ref = ? AND deleted_at IS NULL
      LIMIT 1
    `).bind(parentCommentId, bookRef).first<{ id: string }>();
    if (!parent) return json({ error: 'Родительский комментарий не найден.' }, 404);
  }

  await ensureUser(env, user);
  await env.DB.prepare(`
    INSERT INTO web_title_comments
      (id, book_ref, author_telegram_id, parent_comment_id, body)
    VALUES (?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), bookRef, String(user.id), parentCommentId, text).run();
  return listComments(request, env, bookRef, sort);
}

async function locateComment(
  env: WebTitleCommentsEnv,
  commentId: string,
  includeDeleted = true,
): Promise<CommentLocatorRow | null> {
  const deletedClause = includeDeleted ? '' : 'AND deleted_at IS NULL';
  return env.DB.prepare(`
    SELECT id, book_ref, author_telegram_id, deleted_at
    FROM web_title_comments
    WHERE id = ? ${deletedClause}
    LIMIT 1
  `).bind(commentId).first<CommentLocatorRow>();
}

async function deleteComment(request: Request, env: WebTitleCommentsEnv, commentId: string): Promise<Response> {
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
      UPDATE web_title_comments
      SET body = '', is_pinned = 0, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(commentId).run();
  }
  return listComments(request, env, existing.book_ref, 'new');
}

async function voteComment(request: Request, env: WebTitleCommentsEnv, commentId: string): Promise<Response> {
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
      DELETE FROM web_title_comment_votes
      WHERE comment_id = ? AND voter_telegram_id = ?
    `).bind(commentId, viewerId).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO web_title_comment_votes (comment_id, voter_telegram_id, value)
      VALUES (?, ?, ?)
      ON CONFLICT(comment_id, voter_telegram_id) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).bind(commentId, viewerId, value).run();
  }
  return listComments(request, env, existing.book_ref, cleanSort(payload.sort));
}

async function reportComment(request: Request, env: WebTitleCommentsEnv, commentId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;
  const existing = await locateComment(env, commentId, false);
  if (!existing) return json({ error: 'Комментарий не найден.' }, 404);
  const viewerId = String(user.id);
  if (existing.author_telegram_id === viewerId) return json({ error: 'Нельзя пожаловаться на свой комментарий.' }, 400);
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (reason.length > REPORT_MAX) return json({ error: `Причина не должна превышать ${REPORT_MAX} символов.` }, 400);
  await ensureUser(env, user);
  await env.DB.prepare(`
    INSERT INTO web_title_comment_reports
      (id, comment_id, reporter_telegram_id, reason, status)
    VALUES (?, ?, ?, ?, 'open')
    ON CONFLICT(comment_id, reporter_telegram_id) DO UPDATE SET
      reason = excluded.reason,
      status = 'open',
      updated_at = CURRENT_TIMESTAMP
  `).bind(crypto.randomUUID(), commentId, viewerId, reason).run();
  return listComments(request, env, existing.book_ref, cleanSort(payload.sort));
}

async function pinComment(request: Request, env: WebTitleCommentsEnv, commentId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  if (!isAdminUser(env, user)) return json({ error: 'Недостаточно прав для закрепления комментария.' }, 403);
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;
  const existing = await locateComment(env, commentId, false);
  if (!existing) return json({ error: 'Комментарий не найден.' }, 404);
  const pinned = payload.pinned === true || payload.pinned === 1;
  await env.DB.prepare(`
    UPDATE web_title_comments
    SET is_pinned = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND deleted_at IS NULL
  `).bind(pinned ? 1 : 0, commentId).run();
  return listComments(request, env, existing.book_ref, cleanSort(payload.sort));
}

export async function handleWebTitleCommentsApi(
  request: Request,
  env: WebTitleCommentsEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = routeFor(url.pathname);
  if (!route) return null;

  if (route.kind === 'root') {
    if (request.method === 'GET') {
      const bookRef = cleanBookRef(url.searchParams.get('ref'));
      const sort = cleanSort(url.searchParams.get('sort'));
      return bookRef ? listComments(request, env, bookRef, sort) : json({ error: 'Некорректный ref.' }, 400);
    }
    if (request.method === 'POST') return createComment(request, env);
    return json({ error: 'Method not allowed' }, 405);
  }

  if (route.kind === 'comment') {
    if (request.method === 'DELETE') return deleteComment(request, env, route.commentId);
    return json({ error: 'Method not allowed' }, 405);
  }
  if (route.kind === 'vote') {
    if (request.method === 'PUT') return voteComment(request, env, route.commentId);
    return json({ error: 'Method not allowed' }, 405);
  }
  if (route.kind === 'report') {
    if (request.method === 'POST') return reportComment(request, env, route.commentId);
    return json({ error: 'Method not allowed' }, 405);
  }
  if (request.method === 'PUT') return pinComment(request, env, route.commentId);
  return json({ error: 'Method not allowed' }, 405);
}
