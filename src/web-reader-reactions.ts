import type { D1DatabaseLike } from './ranobelib-runtime.js';
import { getSessionUser, isSameOriginMutation, type WebAuthEnv, type WebTelegramUser } from './web-auth.js';

export interface WebReaderReactionsEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
}

type ReactionBody = {
  bookRef?: unknown;
  chapterId?: unknown;
  value?: unknown;
};

type CountRow = { count: number | string | null };
type RatingAggregateRow = { average: number | string | null; count: number | string | null };
type RatingRow = { rating: number | string };

type ReactionRoute = 'root' | 'thanks' | 'rating';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const ROOT_PATH = '/api/reader/reactions';

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

function reactionRoute(pathname: string): ReactionRoute | null {
  if (pathname === ROOT_PATH) return 'root';
  if (pathname === `${ROOT_PATH}/thanks`) return 'thanks';
  if (pathname === `${ROOT_PATH}/rating`) return 'rating';
  return null;
}

async function readBody(request: Request): Promise<ReactionBody | Response> {
  const parsed = await request.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'Некорректное тело запроса.' }, 400);
  }
  return parsed as ReactionBody;
}

async function ensureUser(env: WebReaderReactionsEnv, user: WebTelegramUser): Promise<void> {
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

async function chapterExists(env: WebReaderReactionsEnv, bookRef: string, chapterId: number): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT chapter_id
    FROM ranobelib_chapters
    WHERE book_ref = ? AND chapter_id = ?
    LIMIT 1
  `).bind(bookRef, chapterId).first<{ chapter_id: number | string }>();
  return Boolean(row);
}

async function requireUser(request: Request, env: WebReaderReactionsEnv): Promise<WebTelegramUser | Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Требуется вход через Telegram.' }, 401);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  return user;
}

async function readReactionState(
  request: Request,
  env: WebReaderReactionsEnv,
  bookRef: string,
  chapterId: number,
): Promise<Response> {
  if (!await chapterExists(env, bookRef, chapterId)) return json({ error: 'Глава не найдена.' }, 404);
  const user = await getSessionUser(request, env);
  const viewerId = user ? String(user.id) : '';

  const [thanks, rating, viewerThanks, viewerRating] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM reader_chapter_thanks
      WHERE book_ref = ? AND chapter_id = ?
    `).bind(bookRef, chapterId).first<CountRow>(),
    env.DB.prepare(`
      SELECT AVG(rating) AS average, COUNT(*) AS count
      FROM reader_chapter_ratings
      WHERE book_ref = ? AND chapter_id = ?
    `).bind(bookRef, chapterId).first<RatingAggregateRow>(),
    viewerId
      ? env.DB.prepare(`
          SELECT COUNT(*) AS count
          FROM reader_chapter_thanks
          WHERE book_ref = ? AND chapter_id = ? AND user_telegram_id = ?
        `).bind(bookRef, chapterId, viewerId).first<CountRow>()
      : Promise.resolve(null),
    viewerId
      ? env.DB.prepare(`
          SELECT rating
          FROM reader_chapter_ratings
          WHERE book_ref = ? AND chapter_id = ? AND user_telegram_id = ?
          LIMIT 1
        `).bind(bookRef, chapterId, viewerId).first<RatingRow>()
      : Promise.resolve(null),
  ]);

  const ratingCount = Number(rating?.count ?? 0) || 0;
  const average = ratingCount ? Number(rating?.average ?? 0) : null;
  return json({
    thanksCount: Number(thanks?.count ?? 0) || 0,
    thanked: Boolean(Number(viewerThanks?.count ?? 0)),
    ratingAverage: average === null || !Number.isFinite(average) ? null : Math.round(average * 10) / 10,
    ratingCount,
    myRating: viewerRating ? Number(viewerRating.rating) || null : null,
  });
}

async function parseScopedMutation(
  request: Request,
  env: WebReaderReactionsEnv,
): Promise<{ user: WebTelegramUser; payload: ReactionBody; bookRef: string; chapterId: number } | Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;
  const bookRef = cleanBookRef(payload.bookRef);
  const chapterId = cleanChapterId(payload.chapterId);
  if (!bookRef || !chapterId) return json({ error: 'Некорректный ref или chapter.' }, 400);
  if (!await chapterExists(env, bookRef, chapterId)) return json({ error: 'Глава не найдена.' }, 404);
  await ensureUser(env, user);
  return { user, payload, bookRef, chapterId };
}

async function mutateThanks(request: Request, env: WebReaderReactionsEnv): Promise<Response> {
  const scope = await parseScopedMutation(request, env);
  if (scope instanceof Response) return scope;
  const value = scope.payload.value;
  if (typeof value !== 'boolean') return json({ error: 'Некорректное значение благодарности.' }, 400);
  const viewerId = String(scope.user.id);

  if (value) {
    await env.DB.prepare(`
      INSERT INTO reader_chapter_thanks (book_ref, chapter_id, user_telegram_id)
      VALUES (?, ?, ?)
      ON CONFLICT(book_ref, chapter_id, user_telegram_id) DO NOTHING
    `).bind(scope.bookRef, scope.chapterId, viewerId).run();
  } else {
    await env.DB.prepare(`
      DELETE FROM reader_chapter_thanks
      WHERE book_ref = ? AND chapter_id = ? AND user_telegram_id = ?
    `).bind(scope.bookRef, scope.chapterId, viewerId).run();
  }

  return readReactionState(request, env, scope.bookRef, scope.chapterId);
}

async function mutateRating(request: Request, env: WebReaderReactionsEnv): Promise<Response> {
  const scope = await parseScopedMutation(request, env);
  if (scope instanceof Response) return scope;
  const rating = Number(scope.payload.value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) return json({ error: 'Оценка должна быть от 1 до 10.' }, 400);
  const viewerId = String(scope.user.id);

  await env.DB.prepare(`
    INSERT INTO reader_chapter_ratings (book_ref, chapter_id, user_telegram_id, rating)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(book_ref, chapter_id, user_telegram_id) DO UPDATE SET
      rating = excluded.rating,
      updated_at = CURRENT_TIMESTAMP
  `).bind(scope.bookRef, scope.chapterId, viewerId, rating).run();

  return readReactionState(request, env, scope.bookRef, scope.chapterId);
}

export async function handleWebReaderReactionsApi(
  request: Request,
  env: WebReaderReactionsEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = reactionRoute(url.pathname);
  if (!route) return null;

  if (route === 'root') {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const bookRef = cleanBookRef(url.searchParams.get('ref'));
    const chapterId = cleanChapterId(url.searchParams.get('chapter'));
    return bookRef && chapterId
      ? readReactionState(request, env, bookRef, chapterId)
      : json({ error: 'Некорректный ref или chapter.' }, 400);
  }

  if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);
  if (route === 'thanks') return mutateThanks(request, env);
  return mutateRating(request, env);
}
