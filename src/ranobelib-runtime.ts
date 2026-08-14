import { RanobeLibClient } from './integrations/ranobelib/client.js';
import { detectReleaseDelta } from './integrations/ranobelib/release-detector.js';
import type { RanobeLibChapter, RanobeLibTeamBookRef } from './integrations/ranobelib/types.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<unknown>;
}
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch?(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

export interface RanobeLibRuntimeEnv {
  DB: D1DatabaseLike;
  RANOBELIB_TEAM_REF?: string;
  RANOBELIB_SYNC_BATCH_SIZE?: string;
}

export type RanobeLibTitleCard = {
  book_ref: string;
  url: string;
  title: string;
  summary: string | null;
  cover_url: string | null;
  chapter_count: number;
  latest_chapter_id: number | null;
  latest_volume: string | null;
  latest_number: string | null;
  latest_name: string | null;
  last_synced_at: string | null;
  last_release_at: string | null;
};

export type RanobeLibReleaseCard = {
  id: string;
  book_ref: string;
  url: string;
  title: string;
  cover_url: string | null;
  chapter_count: number;
  first_volume: string | null;
  first_number: string | null;
  last_volume: string | null;
  last_number: string | null;
  summary: string;
  created_at: string;
};

export type RanobeLibHomeData = {
  teamRef: string;
  titles: RanobeLibTitleCard[];
  releases: RanobeLibReleaseCard[];
  stats: {
    activeTitles: number;
    syncedTitles: number;
    releases: number;
  };
  sync: {
    lastSyncAt: string | null;
    lastError: string | null;
    cursor: number;
    syncing: boolean;
  };
};

export type RanobeLibSyncResult = {
  teamRef: string;
  discovered: number;
  processed: number;
  succeeded: number;
  failed: number;
  newReleases: number;
  nextCursor: number;
  errors: string[];
};

const DEFAULT_TEAM_REF = '11969--dom-nekromanta';
const DEFAULT_BATCH_SIZE = 16;
const MAX_BATCH_SIZE = 40;
const SYNC_STALE_MS = 8 * 60 * 1000;
const SYNC_CONCURRENCY = 4;

let schemaPromise: Promise<void> | null = null;
let syncPromise: Promise<RanobeLibSyncResult> | null = null;

export async function ensureRanobeLibSchema(env: RanobeLibRuntimeEnv): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = initializeSchema(env).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function initializeSchema(env: RanobeLibRuntimeEnv): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS ranobelib_titles (
      book_ref TEXT PRIMARY KEY,
      ranobelib_id INTEGER,
      slug TEXT,
      url TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      cover_url TEXT,
      chapter_count INTEGER NOT NULL DEFAULT 0,
      latest_chapter_id INTEGER,
      latest_volume TEXT,
      latest_number TEXT,
      latest_name TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      snapshot_ready INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_synced_at TEXT,
      last_release_at TEXT,
      sync_error TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS ranobelib_chapters (
      book_ref TEXT NOT NULL,
      chapter_id INTEGER NOT NULL,
      volume TEXT NOT NULL,
      number TEXT NOT NULL,
      name TEXT,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (book_ref, chapter_id),
      FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ranobelib_releases (
      id TEXT PRIMARY KEY,
      book_ref TEXT NOT NULL,
      title_snapshot TEXT NOT NULL,
      chapter_count INTEGER NOT NULL,
      first_chapter_id INTEGER,
      first_volume TEXT,
      first_number TEXT,
      last_chapter_id INTEGER,
      last_volume TEXT,
      last_number TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
    )`,
    'CREATE INDEX IF NOT EXISTS idx_ranobelib_titles_active_release ON ranobelib_titles(is_active, last_release_at DESC, last_synced_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_ranobelib_chapters_book ON ranobelib_chapters(book_ref, chapter_id)',
    'CREATE INDEX IF NOT EXISTS idx_ranobelib_releases_created ON ranobelib_releases(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_ranobelib_releases_book_created ON ranobelib_releases(book_ref, created_at DESC)',
  ];

  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}

export async function getRanobeLibHome(env: RanobeLibRuntimeEnv): Promise<RanobeLibHomeData> {
  await ensureRanobeLibSchema(env);
  const teamRef = teamRefFor(env);
  const [{ results: titleRows }, { results: releaseRows }, counts, lastSyncAt, lastError, cursor] = await Promise.all([
    env.DB.prepare(`
      SELECT book_ref, url, title, summary, cover_url, chapter_count, latest_chapter_id,
             latest_volume, latest_number, latest_name, last_synced_at, last_release_at
      FROM ranobelib_titles
      WHERE is_active = 1 AND snapshot_ready = 1
      ORDER BY COALESCE(last_release_at, last_synced_at) DESC, title COLLATE NOCASE ASC
      LIMIT 80
    `).all<RanobeLibTitleCard>(),
    env.DB.prepare(`
      SELECT r.id, r.book_ref, t.url, COALESCE(t.title, r.title_snapshot) AS title,
             t.cover_url, r.chapter_count, r.first_volume, r.first_number,
             r.last_volume, r.last_number, r.summary, r.created_at
      FROM ranobelib_releases r
      JOIN ranobelib_titles t ON t.book_ref = r.book_ref
      WHERE t.is_active = 1
      ORDER BY r.created_at DESC
      LIMIT 30
    `).all<RanobeLibReleaseCard>(),
    getCounts(env),
    getSetting(env, 'ranobelib_last_sync_at'),
    getSetting(env, 'ranobelib_last_sync_error'),
    getSetting(env, 'ranobelib_sync_cursor'),
  ]);

  return {
    teamRef,
    titles: titleRows.map(normalizeTitleCard),
    releases: releaseRows.map(normalizeReleaseCard),
    stats: counts,
    sync: {
      lastSyncAt,
      lastError,
      cursor: numberFrom(cursor, 0),
      syncing: syncPromise !== null,
    },
  };
}

export async function shouldKickRanobeLibSync(env: RanobeLibRuntimeEnv): Promise<boolean> {
  await ensureRanobeLibSchema(env);
  if (syncPromise) return false;
  const [lastSyncAt, row] = await Promise.all([
    getSetting(env, 'ranobelib_last_sync_at'),
    env.DB.prepare('SELECT COUNT(*) AS count FROM ranobelib_titles WHERE snapshot_ready = 1').first<{ count: number | string }>(),
  ]);
  const count = numberFrom(row?.count, 0);
  if (count === 0 || !lastSyncAt) return true;
  const last = new Date(lastSyncAt).getTime();
  return !Number.isFinite(last) || Date.now() - last > SYNC_STALE_MS;
}

export function syncRanobeLib(env: RanobeLibRuntimeEnv, options: { full?: boolean } = {}): Promise<RanobeLibSyncResult> {
  if (syncPromise) return syncPromise;
  syncPromise = runSync(env, options).finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

async function runSync(env: RanobeLibRuntimeEnv, options: { full?: boolean }): Promise<RanobeLibSyncResult> {
  await ensureRanobeLibSchema(env);
  const teamRef = teamRefFor(env);
  const client = new RanobeLibClient();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];

  let books: RanobeLibTeamBookRef[];
  try {
    books = await client.discoverTeamBooks(teamRef);
    if (books.length === 0) throw new Error(`RanobeLib team ${teamRef} returned no book links`);
    await setSetting(env, 'ranobelib_last_discovery_count', String(books.length));
  } catch (error) {
    const message = errorMessage(error);
    await setSetting(env, 'ranobelib_last_sync_error', message);
    throw error;
  }

  await env.DB.prepare('UPDATE ranobelib_titles SET is_active = 0').run();
  await executeStatements(env, books.map((book) => env.DB.prepare(`
    INSERT INTO ranobelib_titles (book_ref, ranobelib_id, slug, url, is_active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(book_ref) DO UPDATE SET ranobelib_id = excluded.ranobelib_id,
      slug = excluded.slug, url = excluded.url, is_active = 1
  `).bind(book.ref, book.id, book.slug, book.url)));

  const oldCursor = numberFrom(await getSetting(env, 'ranobelib_sync_cursor'), 0);
  const batchSize = options.full ? books.length : Math.min(batchSizeFor(env), books.length);
  const selected = options.full ? books : circularSlice(books, oldCursor, batchSize);
  let succeeded = 0;
  let failed = 0;
  let newReleases = 0;

  await mapWithConcurrency(selected, SYNC_CONCURRENCY, async (book) => {
    try {
      const created = await syncBook(env, client, book);
      succeeded += 1;
      if (created) newReleases += 1;
    } catch (error) {
      failed += 1;
      const message = `${book.ref}: ${errorMessage(error)}`;
      errors.push(message);
      await env.DB.prepare('UPDATE ranobelib_titles SET sync_error = ? WHERE book_ref = ?')
        .bind(message.slice(0, 1000), book.ref).run();
    }
  });

  const nextCursor = books.length === 0 ? 0 : (oldCursor + selected.length) % books.length;
  await Promise.all([
    setSetting(env, 'ranobelib_sync_cursor', String(nextCursor)),
    setSetting(env, 'ranobelib_last_sync_at', startedAt),
    setSetting(env, 'ranobelib_last_sync_error', errors.length ? errors.slice(0, 5).join('\n') : ''),
  ]);

  return {
    teamRef,
    discovered: books.length,
    processed: selected.length,
    succeeded,
    failed,
    newReleases,
    nextCursor,
    errors,
  };
}

async function syncBook(env: RanobeLibRuntimeEnv, client: RanobeLibClient, book: RanobeLibTeamBookRef): Promise<boolean> {
  const state = await env.DB.prepare('SELECT snapshot_ready FROM ranobelib_titles WHERE book_ref = ?')
    .bind(book.ref).first<{ snapshot_ready: number | string }>();
  const snapshotReady = numberFrom(state?.snapshot_ready, 0) === 1;
  const previousRows = snapshotReady
    ? (await env.DB.prepare(`
        SELECT chapter_id AS id, volume, number, name
        FROM ranobelib_chapters WHERE book_ref = ?
      `).bind(book.ref).all<RanobeLibChapter>()).results
    : undefined;

  const [title, chapters] = await Promise.all([
    client.getTitle(book.ref),
    client.getChapters(book.ref),
  ]);
  const latest = chapters.length ? chapters[chapters.length - 1]! : null;
  const delta = detectReleaseDelta(book.ref, previousRows, chapters);

  if (!snapshotReady) {
    await insertChapters(env, book.ref, chapters);
  } else if (delta) {
    if (delta.added.length) await insertChapters(env, book.ref, delta.added);
    if (delta.removed.length) {
      await executeStatements(env, delta.removed.map((chapter) => env.DB.prepare(
        'DELETE FROM ranobelib_chapters WHERE book_ref = ? AND chapter_id = ?',
      ).bind(book.ref, chapter.id)));
    }
  }

  const displayTitle = title.title || humanizeSlug(book.slug);
  const hasRelease = Boolean(snapshotReady && delta && delta.added.length > 0);
  if (hasRelease && delta) {
    const added = delta.added;
    const first = added[0]!;
    const last = added[added.length - 1]!;
    const releaseId = `${book.ref}:${first.id}-${last.id}:${added.length}`;
    await env.DB.prepare(`
      INSERT OR IGNORE INTO ranobelib_releases (
        id, book_ref, title_snapshot, chapter_count, first_chapter_id, first_volume,
        first_number, last_chapter_id, last_volume, last_number, summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      releaseId,
      book.ref,
      displayTitle,
      added.length,
      first.id,
      first.volume,
      first.number,
      last.id,
      last.volume,
      last.number,
      delta.summary,
    ).run();
  }

  await env.DB.prepare(`
    UPDATE ranobelib_titles SET
      ranobelib_id = ?, slug = ?, url = ?, title = ?, summary = ?, cover_url = ?,
      chapter_count = ?, latest_chapter_id = ?, latest_volume = ?, latest_number = ?, latest_name = ?,
      snapshot_ready = 1, is_active = 1, last_synced_at = CURRENT_TIMESTAMP,
      last_release_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_release_at END,
      sync_error = NULL
    WHERE book_ref = ?
  `).bind(
    title.id ?? book.id,
    title.slug ?? book.slug,
    book.url,
    displayTitle,
    title.summary,
    normalizeCoverUrl(title.coverUrl),
    chapters.length,
    latest?.id ?? null,
    latest?.volume ?? null,
    latest?.number ?? null,
    latest?.name ?? null,
    hasRelease ? 1 : 0,
    book.ref,
  ).run();

  return hasRelease;
}

async function insertChapters(env: RanobeLibRuntimeEnv, bookRef: string, chapters: RanobeLibChapter[]): Promise<void> {
  const statements = chapters.map((chapter) => env.DB.prepare(`
    INSERT INTO ranobelib_chapters (book_ref, chapter_id, volume, number, name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(book_ref, chapter_id) DO UPDATE SET
      volume = excluded.volume, number = excluded.number, name = excluded.name
  `).bind(bookRef, chapter.id, chapter.volume, chapter.number, chapter.name));
  await executeStatements(env, statements);
}

async function executeStatements(env: RanobeLibRuntimeEnv, statements: D1PreparedStatementLike[]): Promise<void> {
  if (!statements.length) return;
  const chunkSize = 50;
  for (let index = 0; index < statements.length; index += chunkSize) {
    const chunk = statements.slice(index, index + chunkSize);
    if (env.DB.batch) {
      await env.DB.batch(chunk);
    } else {
      for (const statement of chunk) await statement.run();
    }
  }
}

async function getCounts(env: RanobeLibRuntimeEnv): Promise<RanobeLibHomeData['stats']> {
  const row = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_titles,
      SUM(CASE WHEN is_active = 1 AND snapshot_ready = 1 THEN 1 ELSE 0 END) AS synced_titles,
      (SELECT COUNT(*) FROM ranobelib_releases) AS releases
    FROM ranobelib_titles
  `).first<{ active_titles: number | string | null; synced_titles: number | string | null; releases: number | string | null }>();
  return {
    activeTitles: numberFrom(row?.active_titles, 0),
    syncedTitles: numberFrom(row?.synced_titles, 0),
    releases: numberFrom(row?.releases, 0),
  };
}

async function getSetting(env: RanobeLibRuntimeEnv, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return typeof row?.value === 'string' ? row.value : null;
}

async function setSetting(env: RanobeLibRuntimeEnv, key: string, value: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(key, value).run();
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) await task(item);
    }
  });
  await Promise.all(workers);
}

function circularSlice<T>(items: T[], start: number, count: number): T[] {
  if (!items.length || count <= 0) return [];
  const normalizedStart = ((start % items.length) + items.length) % items.length;
  const result: T[] = [];
  for (let offset = 0; offset < Math.min(count, items.length); offset += 1) {
    const item = items[(normalizedStart + offset) % items.length];
    if (item !== undefined) result.push(item);
  }
  return result;
}

function normalizeTitleCard(row: RanobeLibTitleCard): RanobeLibTitleCard {
  return {
    ...row,
    chapter_count: numberFrom(row.chapter_count, 0),
    latest_chapter_id: nullableNumber(row.latest_chapter_id),
  };
}

function normalizeReleaseCard(row: RanobeLibReleaseCard): RanobeLibReleaseCard {
  return { ...row, chapter_count: numberFrom(row.chapter_count, 0) };
}

function normalizeCoverUrl(value: string | null): string | null {
  if (!value) return null;
  if (/^https:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://cover.imglib.info${value}`;
  if (value.startsWith('uploads/')) return `https://cover.imglib.info/${value}`;
  return null;
}

function humanizeSlug(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
}

function teamRefFor(env: RanobeLibRuntimeEnv): string {
  return env.RANOBELIB_TEAM_REF?.trim() || DEFAULT_TEAM_REF;
}

function batchSizeFor(env: RanobeLibRuntimeEnv): number {
  const parsed = Number(env.RANOBELIB_SYNC_BATCH_SIZE);
  if (!Number.isFinite(parsed)) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(parsed)));
}

function numberFrom(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
