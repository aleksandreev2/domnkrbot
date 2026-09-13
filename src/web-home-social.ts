import type { D1DatabaseLike } from './ranobelib-runtime.js';

export interface WebHomeSocialEnv {
  DB: D1DatabaseLike;
}

type DiscussionRow = {
  id: string;
  book_ref: string;
  title: string;
  body: string;
  book_title: string | null;
  updated_at: string;
  reply_count: number | string | null;
};

type ReviewRow = {
  id: string;
  book_ref: string;
  body: string;
  book_title: string | null;
  cover_url: string | null;
  username: string | null;
  first_name: string | null;
  updated_at: string;
  score: number | string | null;
};

type CollectionRow = {
  id: string;
  title: string;
  updated_at: string;
  item_count: number | string | null;
  cover_urls: string | null;
};

type TopUserRow = {
  user_telegram_id: string;
  username: string | null;
  first_name: string | null;
  activity_count: number | string | null;
};

const HOME_SOCIAL_PATH = '/api/home/social';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=30, s-maxage=60',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function number(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function handleWebHomeSocialApi(
  request: Request,
  env: WebHomeSocialEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== HOME_SOCIAL_PATH) return null;
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const [discussions, reviews, collections, topUsers] = await Promise.all([
    env.DB.prepare(`
      SELECT d.id, d.book_ref, d.title, d.body, d.updated_at,
             COALESCE(t.title, d.book_ref) AS book_title,
             COUNT(r.id) AS reply_count
      FROM web_title_discussions d
      LEFT JOIN web_title_discussion_replies r
        ON r.discussion_id = d.id AND r.deleted_at IS NULL
      LEFT JOIN ranobelib_titles t ON t.book_ref = d.book_ref
      WHERE d.deleted_at IS NULL
      GROUP BY d.id
      ORDER BY d.updated_at DESC, d.id DESC
      LIMIT 4
    `).all<DiscussionRow>(),
    env.DB.prepare(`
      SELECT r.id, r.book_ref, r.body, r.updated_at,
             COALESCE(t.title, r.book_ref) AS book_title, t.cover_url,
             u.username, u.first_name,
             COALESCE(SUM(v.value), 0) AS score
      FROM web_title_reviews r
      LEFT JOIN web_title_review_votes v ON v.review_id = r.id
      LEFT JOIN users u ON u.telegram_id = r.author_telegram_id
      LEFT JOIN ranobelib_titles t ON t.book_ref = r.book_ref
      WHERE r.deleted_at IS NULL
      GROUP BY r.id
      ORDER BY r.updated_at DESC, r.id DESC
      LIMIT 4
    `).all<ReviewRow>(),
    env.DB.prepare(`
      SELECT c.id, c.title, c.updated_at,
             COUNT(i.id) AS item_count,
             GROUP_CONCAT(t.cover_url, '|||') AS cover_urls
      FROM web_collections c
      LEFT JOIN web_collection_items i ON i.collection_id = c.id
      LEFT JOIN ranobelib_titles t ON t.book_ref = i.book_ref
      WHERE c.is_public = 1
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.created_at DESC
      LIMIT 4
    `).all<CollectionRow>(),
    env.DB.prepare(`
      SELECT e.user_telegram_id, u.username, u.first_name,
             COUNT(*) AS activity_count
      FROM publication_reader_events e
      LEFT JOIN users u ON u.telegram_id = e.user_telegram_id
      WHERE e.user_telegram_id IS NOT NULL
        AND e.success = 1
        AND e.created_at >= datetime('now', '-7 days')
      GROUP BY e.user_telegram_id
      ORDER BY activity_count DESC, e.user_telegram_id ASC
      LIMIT 10
    `).all<TopUserRow>(),
  ]);

  return json({
    discussions: discussions.results.map((row) => ({
      id: row.id,
      bookRef: row.book_ref,
      bookTitle: row.book_title || row.book_ref,
      title: row.title,
      body: row.body,
      replyCount: number(row.reply_count),
      updatedAt: row.updated_at,
    })),
    reviews: reviews.results.map((row) => ({
      id: row.id,
      bookRef: row.book_ref,
      bookTitle: row.book_title || row.book_ref,
      coverUrl: row.cover_url || null,
      body: row.body,
      author: row.username ? `@${row.username}` : row.first_name || 'Читатель',
      score: number(row.score),
      updatedAt: row.updated_at,
    })),
    collections: collections.results.map((row) => ({
      id: row.id,
      title: row.title,
      itemCount: number(row.item_count),
      coverUrls: (row.cover_urls || '').split('|||').filter(Boolean).slice(0, 3),
      updatedAt: row.updated_at,
    })),
    topUsers: topUsers.results.map((row, index) => ({
      id: row.user_telegram_id,
      name: row.username ? `@${row.username}` : row.first_name || `Читатель ${index + 1}`,
      rank: index + 1,
      activityCount: number(row.activity_count),
    })),
  });
}
