import type { D1DatabaseLike } from './ranobelib-runtime.js';
import { getSessionUser, isSameOriginMutation, type WebAuthEnv, type WebTelegramUser } from './web-auth.js';

export interface WebTitleStateEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
}

type TitleStateBody = {
  bookRef?: unknown;
  value?: unknown;
};

type TitleStateRoute = 'root' | 'list' | 'rating';
type ListStatus = 'reading' | 'planned' | 'dropped' | 'completed' | 'favorite' | 'other';
type CountRow = { count: number | string | null };
type RatingAggregateRow = { average: number | string | null; count: number | string | null };
type ListAggregateRow = { list_status: string | null; count: number | string | null };
type ViewerStateRow = { list_status: string | null; rating: number | string | null };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const ROOT_PATH = '/api/title/state';
const LIST_STATUSES = new Set<ListStatus>(['reading', 'planned', 'dropped', 'completed', 'favorite', 'other']);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cleanBookRef(value: unknown): string {
  const ref = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9._:-]{1,180}$/.test(ref) ? ref : '';
}

function stateRoute(pathname: string): TitleStateRoute | null {
  if (pathname === ROOT_PATH) return 'root';
  if (pathname === `${ROOT_PATH}/list`) return 'list';
  if (pathname === `${ROOT_PATH}/rating`) return 'rating';
  return null;
}

async function readBody(request: Request): Promise<TitleStateBody | Response> {
  const parsed = await request.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'Некорректное тело запроса.' }, 400);
  }
  return parsed as TitleStateBody;
}

async function ensureUser(env: WebTitleStateEnv, user: WebTelegramUser): Promise<void> {
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

async function titleExists(env: WebTitleStateEnv, bookRef: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT book_ref
    FROM ranobelib_titles
    WHERE book_ref = ?
    LIMIT 1
  `).bind(bookRef).first<{ book_ref: string }>();
  return Boolean(row);
}

async function requireUser(request: Request, env: WebTitleStateEnv): Promise<WebTelegramUser | Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Требуется вход через Telegram.' }, 401);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  return user;
}

function emptyListCounts(): Record<ListStatus, number> {
  return { reading: 0, planned: 0, dropped: 0, completed: 0, favorite: 0, other: 0 };
}

async function readTitleState(request: Request, env: WebTitleStateEnv, bookRef: string): Promise<Response> {
  if (!await titleExists(env, bookRef)) return json({ error: 'Тайтл не найден.' }, 404);
  const user = await getSessionUser(request, env);
  const viewerId = user ? String(user.id) : '';

  const [rating, listRows, viewer] = await Promise.all([
    env.DB.prepare(`
      SELECT AVG(rating) AS average, COUNT(*) AS count
      FROM web_title_user_state
      WHERE book_ref = ? AND rating IS NOT NULL
    `).bind(bookRef).first<RatingAggregateRow>(),
    env.DB.prepare(`
      SELECT list_status, COUNT(*) AS count
      FROM web_title_user_state
      WHERE book_ref = ? AND list_status IS NOT NULL
      GROUP BY list_status
    `).bind(bookRef).all<ListAggregateRow>(),
    viewerId
      ? env.DB.prepare(`
          SELECT list_status, rating
          FROM web_title_user_state
          WHERE book_ref = ? AND user_telegram_id = ?
          LIMIT 1
        `).bind(bookRef, viewerId).first<ViewerStateRow>()
      : Promise.resolve(null),
  ]);

  const listCounts = emptyListCounts();
  for (const row of listRows.results) {
    if (row.list_status && LIST_STATUSES.has(row.list_status as ListStatus)) {
      listCounts[row.list_status as ListStatus] = Number(row.count ?? 0) || 0;
    }
  }
  const listTotal = Object.values(listCounts).reduce((sum, count) => sum + count, 0);
  const ratingCount = Number(rating?.count ?? 0) || 0;
  const average = ratingCount ? Number(rating?.average ?? 0) : null;

  return json({
    ratingAverage: average === null || !Number.isFinite(average) ? null : Math.round(average * 10) / 10,
    ratingCount,
    listTotal,
    listCounts,
    myRating: viewer?.rating === null || viewer?.rating === undefined ? null : Number(viewer.rating) || null,
    myListStatus: viewer?.list_status && LIST_STATUSES.has(viewer.list_status as ListStatus)
      ? viewer.list_status
      : null,
  });
}

async function parseMutation(
  request: Request,
  env: WebTitleStateEnv,
): Promise<{ user: WebTelegramUser; payload: TitleStateBody; bookRef: string } | Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;
  const bookRef = cleanBookRef(payload.bookRef);
  if (!bookRef) return json({ error: 'Некорректный ref тайтла.' }, 400);
  if (!await titleExists(env, bookRef)) return json({ error: 'Тайтл не найден.' }, 404);
  await ensureUser(env, user);
  return { user, payload, bookRef };
}

async function cleanupEmptyState(env: WebTitleStateEnv, bookRef: string, viewerId: string): Promise<void> {
  await env.DB.prepare(`
    DELETE FROM web_title_user_state
    WHERE book_ref = ? AND user_telegram_id = ?
      AND list_status IS NULL AND rating IS NULL
  `).bind(bookRef, viewerId).run();
}

async function mutateList(request: Request, env: WebTitleStateEnv): Promise<Response> {
  const scope = await parseMutation(request, env);
  if (scope instanceof Response) return scope;
  const raw = scope.payload.value;
  const value = raw === null ? null : typeof raw === 'string' ? raw.trim() : '';
  if (value !== null && !LIST_STATUSES.has(value as ListStatus)) {
    return json({ error: 'Некорректный статус списка.' }, 400);
  }
  const viewerId = String(scope.user.id);

  await env.DB.prepare(`
    INSERT INTO web_title_user_state (book_ref, user_telegram_id, list_status)
    VALUES (?, ?, ?)
    ON CONFLICT(book_ref, user_telegram_id) DO UPDATE SET
      list_status = excluded.list_status,
      updated_at = CURRENT_TIMESTAMP
  `).bind(scope.bookRef, viewerId, value).run();
  await cleanupEmptyState(env, scope.bookRef, viewerId);
  return readTitleState(request, env, scope.bookRef);
}

async function mutateRating(request: Request, env: WebTitleStateEnv): Promise<Response> {
  const scope = await parseMutation(request, env);
  if (scope instanceof Response) return scope;
  const raw = scope.payload.value;
  const rating = raw === null ? null : Number(raw);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 10)) {
    return json({ error: 'Оценка должна быть от 1 до 10.' }, 400);
  }
  const viewerId = String(scope.user.id);

  await env.DB.prepare(`
    INSERT INTO web_title_user_state (book_ref, user_telegram_id, rating)
    VALUES (?, ?, ?)
    ON CONFLICT(book_ref, user_telegram_id) DO UPDATE SET
      rating = excluded.rating,
      updated_at = CURRENT_TIMESTAMP
  `).bind(scope.bookRef, viewerId, rating).run();
  await cleanupEmptyState(env, scope.bookRef, viewerId);
  return readTitleState(request, env, scope.bookRef);
}

export async function handleWebTitleStateApi(
  request: Request,
  env: WebTitleStateEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = stateRoute(url.pathname);
  if (!route) return null;

  if (route === 'root') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const bookRef = cleanBookRef(url.searchParams.get('ref'));
    return bookRef ? readTitleState(request, env, bookRef) : json({ error: 'Некорректный ref тайтла.' }, 400);
  }

  if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);
  if (route === 'list') return mutateList(request, env);
  return mutateRating(request, env);
}
