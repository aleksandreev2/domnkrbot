type D1RunResult = { meta?: { changes?: number }; success?: boolean; results?: unknown[] };
export interface TelegramFileCacheStatement {
  bind(...values: unknown[]): TelegramFileCacheStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
}
export interface TelegramFileCacheDB {
  prepare(query: string): TelegramFileCacheStatement;
}
export interface TelegramFileCacheEnv { DB: TelegramFileCacheDB }

const LOCK_TTL_SECONDS = 45;
const DEFAULT_WAIT_MS = 12_000;
const POLL_MS = 350;
let schemaPromise: Promise<void> | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function ensureTelegramFileCacheSchema(env: TelegramFileCacheEnv): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS publication_asset_cache_locks (
        asset_id INTEGER PRIMARY KEY,
        owner_token TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(asset_id) REFERENCES publication_assets(id) ON DELETE CASCADE
      )`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_publication_asset_cache_locks_expires
        ON publication_asset_cache_locks(expires_at)`).run();
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

export async function acquireTelegramFileCacheLease(env: TelegramFileCacheEnv, assetId: number): Promise<string | null> {
  await ensureTelegramFileCacheSchema(env);
  const owner = crypto.randomUUID();
  const result = await env.DB.prepare(`INSERT INTO publication_asset_cache_locks
      (asset_id,owner_token,acquired_at,expires_at)
      VALUES (?,?,CURRENT_TIMESTAMP,datetime('now','+${LOCK_TTL_SECONDS} seconds'))
      ON CONFLICT(asset_id) DO UPDATE SET
        owner_token=excluded.owner_token,
        acquired_at=excluded.acquired_at,
        expires_at=excluded.expires_at
      WHERE publication_asset_cache_locks.expires_at<=CURRENT_TIMESTAMP`)
    .bind(assetId, owner).run();
  return Number(result.meta?.changes ?? 0) > 0 ? owner : null;
}

export async function releaseTelegramFileCacheLease(env: TelegramFileCacheEnv, assetId: number, owner: string): Promise<void> {
  await env.DB.prepare('DELETE FROM publication_asset_cache_locks WHERE asset_id=? AND owner_token=?')
    .bind(assetId, owner).run();
}

export async function readTelegramFileId(env: TelegramFileCacheEnv, assetId: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT telegram_file_id FROM publication_assets WHERE id=? LIMIT 1')
    .bind(assetId).first<{ telegram_file_id?: string | null }>();
  const value = row?.telegram_file_id?.trim();
  return value || null;
}

export async function waitForTelegramFileId(env: TelegramFileCacheEnv, assetId: number, waitMs = DEFAULT_WAIT_MS): Promise<string | null> {
  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    const fileId = await readTelegramFileId(env, assetId);
    if (fileId) return fileId;
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  } while (Date.now() < deadline);
  return readTelegramFileId(env, assetId);
}

export async function storeTelegramFileId(env: TelegramFileCacheEnv, assetId: number, fileId: string): Promise<void> {
  const normalized = fileId.trim();
  if (!normalized) return;
  await env.DB.prepare('UPDATE publication_assets SET telegram_file_id=? WHERE id=?')
    .bind(normalized, assetId).run();
}

export async function clearTelegramFileId(env: TelegramFileCacheEnv, assetId: number, expectedFileId?: string | null): Promise<void> {
  if (expectedFileId) {
    await env.DB.prepare('UPDATE publication_assets SET telegram_file_id=NULL WHERE id=? AND telegram_file_id=?')
      .bind(assetId, expectedFileId).run();
    return;
  }
  await env.DB.prepare('UPDATE publication_assets SET telegram_file_id=NULL WHERE id=?')
    .bind(assetId).run();
}
