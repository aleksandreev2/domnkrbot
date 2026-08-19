import type { D1DatabaseLike } from './ranobelib-runtime.js';

export interface ReaderProposalSchemaEnv { DB: D1DatabaseLike }
let schemaPromise: Promise<void> | null = null;

export function ensureReaderProposalSchema(env: ReaderProposalSchemaEnv): Promise<void> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = initialize(env).catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

async function initialize(env: ReaderProposalSchemaEnv): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS proposal_raw_uploads (
      id TEXT PRIMARY KEY,
      user_telegram_id TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      expected_size INTEGER NOT NULL,
      part_size INTEGER NOT NULL,
      r2_upload_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'uploading',
      etag TEXT,
      attached_proposal_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      aborted_at TEXT,
      FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
      FOREIGN KEY (attached_proposal_id) REFERENCES chapter_proposals(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS proposal_raw_parts (
      upload_id TEXT NOT NULL,
      part_number INTEGER NOT NULL,
      etag TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (upload_id, part_number),
      FOREIGN KEY (upload_id) REFERENCES proposal_raw_uploads(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS title_proposal_details (
      proposal_id TEXT PRIMARY KEY,
      original_title TEXT NOT NULL DEFAULT '',
      extra_url TEXT NOT NULL DEFAULT '',
      raw_upload_id TEXT UNIQUE,
      FOREIGN KEY (proposal_id) REFERENCES chapter_proposals(id) ON DELETE CASCADE,
      FOREIGN KEY (raw_upload_id) REFERENCES proposal_raw_uploads(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS reader_chapter_content (
      book_ref TEXT NOT NULL,
      chapter_id INTEGER NOT NULL,
      content_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (book_ref, chapter_id),
      FOREIGN KEY (book_ref, chapter_id) REFERENCES ranobelib_chapters(book_ref, chapter_id) ON DELETE CASCADE
    )`,
    'CREATE INDEX IF NOT EXISTS idx_proposal_raw_user_created ON proposal_raw_uploads(user_telegram_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_proposal_raw_status_created ON proposal_raw_uploads(status, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_title_proposal_raw ON title_proposal_details(raw_upload_id)',
  ];
  for (const statement of statements) await env.DB.prepare(statement).run();
}
