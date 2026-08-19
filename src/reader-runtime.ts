import type { D1DatabaseLike } from './ranobelib-runtime.js';

export interface ReaderEnv { DB: D1DatabaseLike }

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

function cleanRef(value: string | null): string {
  const ref = (value ?? '').trim();
  return /^[a-zA-Z0-9._:-]{1,180}$/.test(ref) ? ref : '';
}

function chapterId(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function getCatalog(env: ReaderEnv): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT book_ref,url,title,summary,cover_url,chapter_count,latest_chapter_id,
    latest_volume,latest_number,latest_name,last_synced_at,last_release_at
    FROM ranobelib_titles WHERE is_active=1 AND snapshot_ready=1
    ORDER BY COALESCE(last_release_at,last_synced_at) DESC,title COLLATE NOCASE ASC LIMIT 120`).all();
  return json({ titles: results });
}

async function getTitle(env: ReaderEnv, ref: string): Promise<Response> {
  const title = await env.DB.prepare(`SELECT book_ref,url,title,summary,cover_url,chapter_count,latest_chapter_id,
    latest_volume,latest_number,latest_name,last_synced_at,last_release_at
    FROM ranobelib_titles WHERE book_ref=? AND is_active=1 LIMIT 1`).bind(ref).first<Record<string, unknown>>();
  if (!title) return json({ error: 'Тайтл не найден.' }, 404);
  const { results: chapters } = await env.DB.prepare(`SELECT chapter_id,volume,number,name,first_seen_at
    FROM ranobelib_chapters WHERE book_ref=? ORDER BY CAST(volume AS REAL) DESC,CAST(number AS REAL) DESC,chapter_id DESC LIMIT 2000`)
    .bind(ref).all();
  const { results: available } = await env.DB.prepare('SELECT chapter_id FROM reader_chapter_content WHERE book_ref=?').bind(ref).all<{ chapter_id: number | string }>()
    .catch(() => ({ results: [] as { chapter_id: number | string }[] }));
  const availableSet = new Set(available.map((row) => Number(row.chapter_id)));
  return json({ title, chapters: chapters.map((chapter) => ({ ...chapter, readerAvailable: availableSet.has(Number(chapter.chapter_id)) })) });
}

async function getChapter(env: ReaderEnv, ref: string, id: number): Promise<Response> {
  const [title, chapter, content] = await Promise.all([
    env.DB.prepare(`SELECT book_ref,url,title,summary,cover_url,chapter_count,latest_chapter_id,latest_volume,latest_number,latest_name
      FROM ranobelib_titles WHERE book_ref=? AND is_active=1 LIMIT 1`).bind(ref).first<Record<string, unknown>>(),
    env.DB.prepare('SELECT chapter_id,volume,number,name,first_seen_at FROM ranobelib_chapters WHERE book_ref=? AND chapter_id=?')
      .bind(ref, id).first<Record<string, unknown>>(),
    env.DB.prepare('SELECT content_json,updated_at FROM reader_chapter_content WHERE book_ref=? AND chapter_id=?')
      .bind(ref, id).first<{ content_json: string; updated_at: string }>().catch(() => null),
  ]);
  if (!title || !chapter) return json({ error: 'Глава не найдена.' }, 404);

  let blocks: unknown[] | null = null;
  if (content?.content_json) {
    try {
      const parsed = JSON.parse(content.content_json);
      if (Array.isArray(parsed)) blocks = parsed;
    } catch {
      blocks = null;
    }
  }
  const [previous, next] = await Promise.all([
    env.DB.prepare(`SELECT chapter_id,volume,number,name FROM ranobelib_chapters WHERE book_ref=? AND chapter_id<? ORDER BY chapter_id DESC LIMIT 1`)
      .bind(ref, id).first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT chapter_id,volume,number,name FROM ranobelib_chapters WHERE book_ref=? AND chapter_id>? ORDER BY chapter_id ASC LIMIT 1`)
      .bind(ref, id).first<Record<string, unknown>>(),
  ]);
  return json({ title, chapter, content: blocks, contentUpdatedAt: content?.updated_at ?? null, previous, next });
}

export async function handleReaderApi(request: Request, env: ReaderEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'GET') return null;
  if (url.pathname === '/api/catalog') return getCatalog(env);
  if (url.pathname === '/api/title') {
    const ref = cleanRef(url.searchParams.get('ref'));
    return ref ? getTitle(env, ref) : json({ error: 'Некорректный ref тайтла.' }, 400);
  }
  if (url.pathname === '/api/reader/chapter') {
    const ref = cleanRef(url.searchParams.get('ref'));
    const id = chapterId(url.searchParams.get('chapter'));
    return ref && id ? getChapter(env, ref, id) : json({ error: 'Некорректный ref или chapter.' }, 400);
  }
  return null;
}
