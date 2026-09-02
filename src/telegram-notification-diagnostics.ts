type D1AllResult<T> = { results: T[] };
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1AllResult<T>>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }

export interface TelegramNotificationDiagnosticsEnv {
  DB: D1DatabaseLike;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export async function handleTelegramNotificationDiagnostics(
  request: Request,
  env: TelegramNotificationDiagnosticsEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/api/ranobelib/notification-health') return null;

  const bookRef = String(url.searchParams.get('book_ref') || '').trim();
  if (!bookRef) return json({ error: 'book_ref is required' }, 400);

  const latestRelease = await env.DB.prepare(`
    SELECT id, book_ref, title_snapshot, chapter_count, first_number, last_number, summary, created_at
    FROM ranobelib_releases
    WHERE book_ref = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(bookRef).first<Record<string, unknown>>();

  const eligible = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT s.user_telegram_id
      FROM telegram_subscription_settings s
      WHERE s.all_titles = 1
        AND NOT EXISTS (
          SELECT 1 FROM title_subscription_exclusions e
          WHERE e.user_telegram_id = s.user_telegram_id AND e.book_ref = ?
        )
      UNION
      SELECT ts.user_telegram_id
      FROM title_subscriptions ts
      WHERE ts.book_ref = ?
        AND NOT EXISTS (
          SELECT 1 FROM telegram_subscription_settings s
          WHERE s.user_telegram_id = ts.user_telegram_id AND s.all_titles = 1
        )
    )
  `).bind(bookRef, bookRef).first<{ count: number | string }>();

  const allMode = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM telegram_subscription_settings s
    WHERE s.all_titles = 1
      AND NOT EXISTS (
        SELECT 1 FROM title_subscription_exclusions e
        WHERE e.user_telegram_id = s.user_telegram_id AND e.book_ref = ?
      )
  `).bind(bookRef).first<{ count: number | string }>();

  const explicit = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM title_subscriptions ts
    WHERE ts.book_ref = ?
      AND NOT EXISTS (
        SELECT 1 FROM telegram_subscription_settings s
        WHERE s.user_telegram_id = ts.user_telegram_id AND s.all_titles = 1
      )
  `).bind(bookRef).first<{ count: number | string }>();

  let outbox: Record<string, unknown>[] = [];
  if (latestRelease?.id) {
    const result = await env.DB.prepare(`
      SELECT status, COUNT(*) AS count, MAX(attempts) AS max_attempts,
             MAX(available_at) AS available_at, MAX(last_error) AS last_error,
             MAX(updated_at) AS updated_at, MAX(delivered_at) AS delivered_at
      FROM ranobelib_notification_outbox
      WHERE release_id = ?
      GROUP BY status
      ORDER BY status
    `).bind(String(latestRelease.id)).all<Record<string, unknown>>();
    outbox = result.results;
  }

  if (url.searchParams.get('compact') === '1') {
    return json({ bookRef, releaseId: latestRelease?.id ?? null, outbox });
  }

  return json({
    bookRef,
    latestRelease,
    eligibleRecipients: Number(eligible?.count ?? 0) || 0,
    eligibleAllMode: Number(allMode?.count ?? 0) || 0,
    eligibleExplicit: Number(explicit?.count ?? 0) || 0,
    outbox,
  });
}