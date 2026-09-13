import type { D1DatabaseLike } from './ranobelib-runtime.js';
import {
  getSessionUser,
  isAdminUser,
  isSameOriginMutation,
  type WebAuthEnv,
  type WebTelegramUser,
} from './web-auth.js';

export interface WebTitleReviewsEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
}

type ReviewRow = {
  id: string;
  book_ref: string;
  author_telegram_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  username: string | null;
  first_name: string | null;
  score: number | string | null;
  my_vote: number | string | null;
};

type ReviewLocatorRow = {
  id: string;
  book_ref: string;
  author_telegram_id: string;
};

type ReviewBody = {
  bookRef?: unknown;
  body?: unknown;
  value?: unknown;
  sort?: unknown;
};

type ReviewRoute =
  | { kind: 'root' }
  | { kind: 'review'; reviewId: string }
  | { kind: 'vote'; reviewId: string };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const REVIEWS_PATH = '/api/title/reviews';
const REVIEW_MAX = 6000;
const REVIEWS_LIMIT = 200;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cleanBookRef(value: unknown): string {
  const ref = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9._:-]{1,180}$/.test(ref) ? ref : '';
}

function cleanReviewId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9-]{16,64}$/i.test(id) ? id : '';
}

function cleanSort(value: unknown): 'new' | 'top' {
  return value === 'top' ? 'top' : 'new';
}

function routeFor(pathname: string): ReviewRoute | null {
  if (pathname === REVIEWS_PATH) return { kind: 'root' };
  if (!pathname.startsWith(`${REVIEWS_PATH}/`)) return null;
  const parts = pathname.slice(REVIEWS_PATH.length + 1).split('/').filter(Boolean);
  const reviewId = cleanReviewId(parts[0]);
  if (!reviewId) return null;
  if (parts.length === 1) return { kind: 'review', reviewId };
  if (parts.length === 2 && parts[1] === 'vote') return { kind: 'vote', reviewId };
  return null;
}

async function readBody(request: Request): Promise<ReviewBody | Response> {
  const parsed = await request.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'Некорректное тело запроса.' }, 400);
  }
  return parsed as ReviewBody;
}

async function ensureUser(env: WebTitleReviewsEnv, user: WebTelegramUser): Promise<void> {
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

async function titleExists(env: WebTitleReviewsEnv, bookRef: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT book_ref FROM ranobelib_titles WHERE book_ref = ? LIMIT 1
  `).bind(bookRef).first<{ book_ref: string }>();
  return Boolean(row);
}

async function requireUser(request: Request, env: WebTitleReviewsEnv): Promise<WebTelegramUser | Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Требуется вход через Telegram.' }, 401);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  await ensureUser(env, user);
  return user;
}

function publicReview(row: ReviewRow, viewerId: string | null, admin: boolean) {
  const isOwn = Boolean(viewerId && viewerId === row.author_telegram_id);
  return {
    id: row.id,
    bookRef: row.book_ref,
    body: row.body,
    author: {
      username: row.username || null,
      firstName: row.first_name || '',
    },
    score: Number(row.score ?? 0) || 0,
    myVote: Number(row.my_vote ?? 0) || 0,
    isOwn,
    canDelete: Boolean(viewerId && (isOwn || admin)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listReviews(
  request: Request,
  env: WebTitleReviewsEnv,
  bookRef: string,
  sort: 'new' | 'top',
): Promise<Response> {
  if (!await titleExists(env, bookRef)) return json({ error: 'Тайтл не найден.' }, 404);
  const user = await getSessionUser(request, env);
  const viewerId = user ? String(user.id) : null;
  const admin = isAdminUser(env, user);
  const orderBy = sort === 'top'
    ? 'score DESC, r.updated_at DESC, r.id DESC'
    : 'r.created_at DESC, r.id DESC';
  const { results } = await env.DB.prepare(`
    SELECT r.id, r.book_ref, r.author_telegram_id, r.body, r.created_at, r.updated_at,
           u.username, u.first_name,
           COALESCE(SUM(v.value), 0) AS score,
           COALESCE(MAX(CASE WHEN v.voter_telegram_id = ? THEN v.value ELSE 0 END), 0) AS my_vote
    FROM web_title_reviews r
    LEFT JOIN users u ON u.telegram_id = r.author_telegram_id
    LEFT JOIN web_title_review_votes v ON v.review_id = r.id
    WHERE r.book_ref = ? AND r.deleted_at IS NULL
    GROUP BY r.id
    ORDER BY ${orderBy}
    LIMIT ${REVIEWS_LIMIT}
  `).bind(viewerId ?? '', bookRef).all<ReviewRow>();
  return json({ sort, reviews: results.map((row) => publicReview(row, viewerId, admin)) });
}

async function createReview(request: Request, env: WebTitleReviewsEnv): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;
  const bookRef = cleanBookRef(payload.bookRef);
  const text = typeof payload.body === 'string' ? payload.body.trim() : '';
  const sort = cleanSort(payload.sort);
  if (!bookRef) return json({ error: 'Некорректный ref.' }, 400);
  if (!text || text.length > REVIEW_MAX) {
    return json({ error: `Отзыв должен содержать от 1 до ${REVIEW_MAX} символов.` }, 400);
  }
  if (!await titleExists(env, bookRef)) return json({ error: 'Тайтл не найден.' }, 404);
  const authorId = String(user.id);
  const existing = await env.DB.prepare(`
    SELECT id FROM web_title_reviews
    WHERE book_ref = ? AND author_telegram_id = ?
    LIMIT 1
  `).bind(bookRef, authorId).first<{ id: string }>();
  if (existing) return json({ error: 'У вас уже есть отзыв на этот тайтл.' }, 409);
  await env.DB.prepare(`
    INSERT INTO web_title_reviews (id, book_ref, author_telegram_id, body)
    VALUES (?, ?, ?, ?)
  `).bind(crypto.randomUUID(), bookRef, authorId, text).run();
  return listReviews(request, env, bookRef, sort);
}

async function locateReview(env: WebTitleReviewsEnv, reviewId: string): Promise<ReviewLocatorRow | null> {
  return env.DB.prepare(`
    SELECT id, book_ref, author_telegram_id
    FROM web_title_reviews
    WHERE id = ? AND deleted_at IS NULL
    LIMIT 1
  `).bind(reviewId).first<ReviewLocatorRow>();
}

async function updateReview(request: Request, env: WebTitleReviewsEnv, reviewId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;
  const existing = await locateReview(env, reviewId);
  if (!existing) return json({ error: 'Отзыв не найден.' }, 404);
  if (existing.author_telegram_id !== String(user.id)) return json({ error: 'Редактировать можно только свой отзыв.' }, 403);
  const text = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!text || text.length > REVIEW_MAX) {
    return json({ error: `Отзыв должен содержать от 1 до ${REVIEW_MAX} символов.` }, 400);
  }
  await env.DB.prepare(`
    UPDATE web_title_reviews
    SET body = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND author_telegram_id = ? AND deleted_at IS NULL
  `).bind(text, reviewId, String(user.id)).run();
  return listReviews(request, env, existing.book_ref, cleanSort(payload.sort));
}

async function deleteReview(request: Request, env: WebTitleReviewsEnv, reviewId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const existing = await locateReview(env, reviewId);
  if (!existing) return json({ error: 'Отзыв не найден.' }, 404);
  if (existing.author_telegram_id !== String(user.id) && !isAdminUser(env, user)) {
    return json({ error: 'Недостаточно прав для удаления отзыва.' }, 403);
  }
  await env.DB.prepare(`
    UPDATE web_title_reviews
    SET body = '', deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(reviewId).run();
  return listReviews(request, env, existing.book_ref, 'new');
}

async function voteReview(request: Request, env: WebTitleReviewsEnv, reviewId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;
  const value = Number(payload.value);
  if (value !== -1 && value !== 0 && value !== 1) return json({ error: 'Некорректная оценка.' }, 400);
  const existing = await locateReview(env, reviewId);
  if (!existing) return json({ error: 'Отзыв не найден.' }, 404);
  const viewerId = String(user.id);
  if (value === 0) {
    await env.DB.prepare(`
      DELETE FROM web_title_review_votes
      WHERE review_id = ? AND voter_telegram_id = ?
    `).bind(reviewId, viewerId).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO web_title_review_votes (review_id, voter_telegram_id, value)
      VALUES (?, ?, ?)
      ON CONFLICT(review_id, voter_telegram_id) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).bind(reviewId, viewerId, value).run();
  }
  return listReviews(request, env, existing.book_ref, cleanSort(payload.sort));
}

export async function handleWebTitleReviewsApi(
  request: Request,
  env: WebTitleReviewsEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = routeFor(url.pathname);
  if (!route) return null;

  if (route.kind === 'root') {
    if (request.method === 'GET') {
      const bookRef = cleanBookRef(url.searchParams.get('ref'));
      const sort = cleanSort(url.searchParams.get('sort'));
      return bookRef ? listReviews(request, env, bookRef, sort) : json({ error: 'Некорректный ref.' }, 400);
    }
    if (request.method === 'POST') return createReview(request, env);
    return json({ error: 'Method not allowed' }, 405);
  }

  if (route.kind === 'review') {
    if (request.method === 'PATCH') return updateReview(request, env, route.reviewId);
    if (request.method === 'DELETE') return deleteReview(request, env, route.reviewId);
    return json({ error: 'Method not allowed' }, 405);
  }

  if (route.kind === 'vote') {
    if (request.method === 'PUT') return voteReview(request, env, route.reviewId);
    return json({ error: 'Method not allowed' }, 405);
  }

  return null;
}
