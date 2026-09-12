import type { D1DatabaseLike } from './ranobelib-runtime.js';
import { getSessionUser, isSameOriginMutation, type WebAuthEnv } from './web-auth.js';

export interface WebCollectionItemsEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
}

export type CollectionItemCard = {
  bookRef: string;
  title: string;
  coverUrl: string | null;
  chapterCount: number;
  groupName: string;
  position: number;
  note: string;
  createdAt: string;
  updatedAt: string;
};

type CollectionItemRow = {
  book_ref: string;
  group_name: string;
  position: number | string;
  note: string;
  created_at: string;
  updated_at: string;
  title: string | null;
  cover_url: string | null;
  chapter_count: number | string | null;
};

type CollectionItemInput = {
  bookRef?: unknown;
  groupName?: unknown;
  note?: unknown;
  position?: unknown;
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const GROUP_MAX = 100;
const NOTE_MAX = 1000;
const BOOK_REF_MAX = 260;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function normalizedBookRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  return ref && ref.length <= BOOK_REF_MAX && !/[/?#]/.test(ref) ? ref : null;
}

function normalizedGroup(value: unknown, fallback = ''): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return null;
  const group = value.trim().replace(/\s+/g, ' ');
  return group.length <= GROUP_MAX ? group : null;
}

function normalizedNote(value: unknown, fallback = ''): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return null;
  const note = value.trim();
  return note.length <= NOTE_MAX ? note : null;
}

function normalizedPosition(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const position = Number(value);
  return Number.isSafeInteger(position) && position >= 0 && position <= 100000 ? position : null;
}

async function readBody(request: Request): Promise<CollectionItemInput | Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Некорректное тело запроса.' }, 400);
  }
  return body as CollectionItemInput;
}

async function requireOwnedCollection(
  request: Request,
  env: WebCollectionItemsEnv,
  collectionId: string,
): Promise<string | Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Требуется вход через Telegram.' }, 401);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  const ownerId = String(user.id);
  const row = await env.DB.prepare(`
    SELECT id FROM web_collections
    WHERE id = ? AND owner_telegram_id = ?
  `).bind(collectionId, ownerId).first<{ id: string }>();
  if (!row) return json({ error: 'Коллекция не найдена.' }, 404);
  return ownerId;
}

export async function listCollectionItems(
  env: WebCollectionItemsEnv,
  collectionId: string,
): Promise<CollectionItemCard[]> {
  const { results } = await env.DB.prepare(`
    SELECT i.book_ref, i.group_name, i.position, i.note, i.created_at, i.updated_at,
           t.title, t.cover_url, t.chapter_count
    FROM web_collection_items i
    JOIN ranobelib_titles t ON t.book_ref = i.book_ref
    WHERE i.collection_id = ?
    ORDER BY CASE WHEN i.group_name = '' THEN 0 ELSE 1 END,
             i.group_name COLLATE NOCASE ASC, i.position ASC, i.id ASC
  `).bind(collectionId).all<CollectionItemRow>();
  return results.map((row) => ({
    bookRef: row.book_ref,
    title: row.title || row.book_ref,
    coverUrl: row.cover_url,
    chapterCount: Number(row.chapter_count ?? 0) || 0,
    groupName: row.group_name,
    position: Number(row.position) || 0,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function handleCollectionItemsMutation(
  request: Request,
  env: WebCollectionItemsEnv,
  collectionId: string,
): Promise<Response> {
  const owner = await requireOwnedCollection(request, env, collectionId);
  if (owner instanceof Response) return owner;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const bookRef = normalizedBookRef(body.bookRef);
  if (!bookRef) return json({ error: 'Некорректный тайтл.' }, 400);

  if (request.method === 'POST') {
    const groupName = normalizedGroup(body.groupName);
    const note = normalizedNote(body.note);
    if (groupName === null) return json({ error: `Название группы не должно превышать ${GROUP_MAX} символов.` }, 400);
    if (note === null) return json({ error: `Заметка не должна превышать ${NOTE_MAX} символов.` }, 400);
    const title = await env.DB.prepare(`
      SELECT book_ref FROM ranobelib_titles
      WHERE book_ref = ? AND snapshot_ready = 1
    `).bind(bookRef).first<{ book_ref: string }>();
    if (!title) return json({ error: 'Тайтл не найден в НекромантЛиб.' }, 404);
    const existing = await env.DB.prepare(`
      SELECT id FROM web_collection_items
      WHERE collection_id = ? AND book_ref = ?
    `).bind(collectionId, bookRef).first<{ id: number }>();
    if (existing) return json({ error: 'Тайтл уже есть в коллекции.' }, 409);
    await env.DB.prepare(`
      INSERT INTO web_collection_items (collection_id, book_ref, group_name, position, note)
      VALUES (
        ?, ?, ?,
        COALESCE((SELECT MAX(position) + 1 FROM web_collection_items WHERE collection_id = ?), 0),
        ?
      )
    `).bind(collectionId, bookRef, groupName, collectionId, note).run();
  } else if (request.method === 'PATCH') {
    const groupName = body.groupName === undefined ? undefined : normalizedGroup(body.groupName);
    const note = body.note === undefined ? undefined : normalizedNote(body.note);
    const position = normalizedPosition(body.position);
    if (body.groupName !== undefined && groupName === null) return json({ error: `Название группы не должно превышать ${GROUP_MAX} символов.` }, 400);
    if (body.note !== undefined && note === null) return json({ error: `Заметка не должна превышать ${NOTE_MAX} символов.` }, 400);
    if (body.position !== undefined && position === null) return json({ error: 'Некорректная позиция.' }, 400);
    if (groupName === undefined && note === undefined && position === undefined) return json({ error: 'Нет изменений.' }, 400);
    await env.DB.prepare(`
      UPDATE web_collection_items
      SET group_name = COALESCE(?, group_name),
          note = COALESCE(?, note),
          position = COALESCE(?, position),
          updated_at = CURRENT_TIMESTAMP
      WHERE collection_id = ? AND book_ref = ?
    `).bind(groupName ?? null, note ?? null, position ?? null, collectionId, bookRef).run();
  } else if (request.method === 'DELETE') {
    await env.DB.prepare(`
      DELETE FROM web_collection_items
      WHERE collection_id = ? AND book_ref = ?
    `).bind(collectionId, bookRef).run();
  } else {
    return json({ error: 'Method not allowed' }, 405);
  }

  await env.DB.prepare(`
    UPDATE web_collections
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_telegram_id = ?
  `).bind(collectionId, owner).run();
  return json({ ok: true });
}
