import type { D1DatabaseLike } from './ranobelib-runtime.js';
import {
  getSessionUser,
  isSameOriginMutation,
  type WebAuthEnv,
  type WebTelegramUser,
} from './web-auth.js';

export interface WebTitleDiscussionsEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
}

type DiscussionRow = {
  id: string;
  book_ref: string;
  author_telegram_id: string;
  title: string;
  body: string;
  category: string;
  created_at: string;
  updated_at: string;
  username: string | null;
  first_name: string | null;
  reply_count: number | string | null;
};

type DiscussionLocator = {
  id: string;
  book_ref: string;
};

type DiscussionBody = {
  bookRef?: unknown;
  title?: unknown;
  body?: unknown;
  category?: unknown;
};

type DiscussionRoute =
  | { kind: 'root' }
  | { kind: 'replies'; discussionId: string };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const DISCUSSIONS_PATH = '/api/title/discussions';
const THREAD_TITLE_MAX = 140;
const THREAD_BODY_MAX = 6000;
const REPLY_BODY_MAX = 6000;
const DISCUSSIONS_LIMIT = 100;
const DEFAULT_CATEGORY = 'Обсуждение тайтла';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cleanBookRef(value: unknown): string {
  const ref = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9._:-]{1,180}$/.test(ref) ? ref : '';
}

function cleanDiscussionId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9-]{16,64}$/i.test(id) ? id : '';
}

function cleanCategory(value: unknown): string {
  const category = typeof value === 'string' ? value.trim() : '';
  return category.slice(0, 80) || DEFAULT_CATEGORY;
}

function routeFor(pathname: string): DiscussionRoute | null {
  if (pathname === DISCUSSIONS_PATH) return { kind: 'root' };
  if (!pathname.startsWith(`${DISCUSSIONS_PATH}/`)) return null;
  const parts = pathname.slice(DISCUSSIONS_PATH.length + 1).split('/').filter(Boolean);
  const discussionId = cleanDiscussionId(parts[0]);
  if (!discussionId || parts.length !== 2 || parts[1] !== 'replies') return null;
  return { kind: 'replies', discussionId };
}

async function readBody(request: Request): Promise<DiscussionBody | Response> {
  const parsed = await request.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'Некорректное тело запроса.' }, 400);
  }
  return parsed as DiscussionBody;
}

async function ensureUser(env: WebTitleDiscussionsEnv, user: WebTelegramUser): Promise<void> {
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

async function titleExists(env: WebTitleDiscussionsEnv, bookRef: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT book_ref
    FROM ranobelib_titles
    WHERE book_ref = ?
    LIMIT 1
  `).bind(bookRef).first<{ book_ref: string }>();
  return Boolean(row);
}

async function requireUser(request: Request, env: WebTitleDiscussionsEnv): Promise<WebTelegramUser | Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Требуется вход через Telegram.' }, 401);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  return user;
}

function publicDiscussion(row: DiscussionRow) {
  return {
    id: row.id,
    bookRef: row.book_ref,
    title: row.title,
    body: row.body,
    category: row.category,
    author: {
      username: row.username || null,
      firstName: row.first_name || '',
    },
    replyCount: Number(row.reply_count ?? 0) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listDiscussions(
  request: Request,
  env: WebTitleDiscussionsEnv,
  bookRef: string,
): Promise<Response> {
  if (!await titleExists(env, bookRef)) return json({ error: 'Тайтл не найден.' }, 404);
  await getSessionUser(request, env);
  const { results } = await env.DB.prepare(`
    SELECT d.id, d.book_ref, d.author_telegram_id, d.title, d.body, d.category,
           d.created_at, d.updated_at, u.username, u.first_name,
           COUNT(r.id) AS reply_count
    FROM web_title_discussions d
    LEFT JOIN users u ON u.telegram_id = d.author_telegram_id
    LEFT JOIN web_title_discussion_replies r
      ON r.discussion_id = d.id AND r.deleted_at IS NULL
    WHERE d.book_ref = ? AND d.deleted_at IS NULL
    GROUP BY d.id
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT ${DISCUSSIONS_LIMIT}
  `).bind(bookRef).all<DiscussionRow>();
  return json({ sort: 'updates', discussions: results.map(publicDiscussion) });
}

async function createDiscussion(request: Request, env: WebTitleDiscussionsEnv): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;

  const bookRef = cleanBookRef(payload.bookRef);
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  const category = cleanCategory(payload.category);
  if (!bookRef) return json({ error: 'Некорректный ref.' }, 400);
  if (!title || title.length > THREAD_TITLE_MAX) {
    return json({ error: `Заголовок должен содержать от 1 до ${THREAD_TITLE_MAX} символов.` }, 400);
  }
  if (!body || body.length > THREAD_BODY_MAX) {
    return json({ error: `Текст темы должен содержать от 1 до ${THREAD_BODY_MAX} символов.` }, 400);
  }
  if (!await titleExists(env, bookRef)) return json({ error: 'Тайтл не найден.' }, 404);

  await ensureUser(env, user);
  await env.DB.prepare(`
    INSERT INTO web_title_discussions
      (id, book_ref, author_telegram_id, title, body, category)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), bookRef, String(user.id), title, body, category).run();
  return listDiscussions(request, env, bookRef);
}

async function createReply(
  request: Request,
  env: WebTitleDiscussionsEnv,
  discussionId: string,
): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;
  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!body || body.length > REPLY_BODY_MAX) {
    return json({ error: `Ответ должен содержать от 1 до ${REPLY_BODY_MAX} символов.` }, 400);
  }

  const discussion = await env.DB.prepare(`
    SELECT id, book_ref
    FROM web_title_discussions
    WHERE id = ? AND deleted_at IS NULL
    LIMIT 1
  `).bind(discussionId).first<DiscussionLocator>();
  if (!discussion) return json({ error: 'Обсуждение не найдено.' }, 404);

  await ensureUser(env, user);
  await env.DB.prepare(`
    INSERT INTO web_title_discussion_replies
      (id, discussion_id, author_telegram_id, body)
    VALUES (?, ?, ?, ?)
  `).bind(crypto.randomUUID(), discussionId, String(user.id), body).run();
  await env.DB.prepare(`
    UPDATE web_title_discussions
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND deleted_at IS NULL
  `).bind(discussionId).run();
  return listDiscussions(request, env, discussion.book_ref);
}

export async function handleWebTitleDiscussionsApi(
  request: Request,
  env: WebTitleDiscussionsEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = routeFor(url.pathname);
  if (!route) return null;

  if (route.kind === 'root') {
    if (request.method === 'GET') {
      const bookRef = cleanBookRef(url.searchParams.get('ref'));
      return bookRef ? listDiscussions(request, env, bookRef) : json({ error: 'Некорректный ref.' }, 400);
    }
    if (request.method === 'POST') return createDiscussion(request, env);
    return json({ error: 'Method not allowed' }, 405);
  }

  if (route.kind === 'replies' && request.method === 'POST') {
    return createReply(request, env, route.discussionId);
  }
  return json({ error: 'Method not allowed' }, 405);
}
