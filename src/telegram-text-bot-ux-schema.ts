type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
};

type D1DatabaseLike = {
  prepare(query: string): D1PreparedStatementLike;
};

export type TelegramTextBotUxSchemaEnv = {
  DB: D1DatabaseLike;
};

export type NotificationSearchReturn = 'home' | 'mine' | 'all';

export type NotificationSearchState = {
  query: string;
  page: number;
  returnScope: NotificationSearchReturn;
};

type NotificationSearchStateRow = {
  query: string | null;
  page: number | string | null;
  return_scope: string | null;
};

export async function ensureTelegramTextBotUxSchema(env: TelegramTextBotUxSchemaEnv): Promise<void> {
  try {
    await env.DB.prepare(`
      ALTER TABLE telegram_proposal_sessions
      ADD COLUMN return_to_review INTEGER NOT NULL DEFAULT 0 CHECK (return_to_review IN (0, 1))
    `).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name:\s*return_to_review/i.test(message)) throw error;
  }

  try {
    await env.DB.prepare(`
      ALTER TABLE telegram_proposal_sessions
      ADD COLUMN input_active INTEGER NOT NULL DEFAULT 0 CHECK (input_active IN (0, 1))
    `).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name:\s*input_active/i.test(message)) throw error;
  }

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS telegram_notification_search_state (
      user_telegram_id TEXT PRIMARY KEY,
      query TEXT NOT NULL DEFAULT '',
      page INTEGER NOT NULL DEFAULT 0,
      return_scope TEXT NOT NULL DEFAULT 'home'
        CHECK (return_scope IN ('home', 'mine', 'all')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_telegram_notification_search_expiry
    ON telegram_notification_search_state(expires_at)
  `).run();
}

export async function beginNotificationSearch(
  env: TelegramTextBotUxSchemaEnv,
  userTelegramId: string,
  returnScope: NotificationSearchReturn,
): Promise<void> {
  const userId = normalizeUserId(userTelegramId);
  const scope = normalizeReturnScope(returnScope);
  if (!userId) return;
  await env.DB.prepare(`
    INSERT INTO telegram_notification_search_state (
      user_telegram_id, query, page, return_scope, expires_at
    ) VALUES (?, ?, ?, ?, datetime(CURRENT_TIMESTAMP, '+10 minutes'))
    ON CONFLICT(user_telegram_id) DO UPDATE SET
      query = excluded.query,
      page = excluded.page,
      return_scope = excluded.return_scope,
      expires_at = excluded.expires_at,
      created_at = CURRENT_TIMESTAMP
  `).bind(userId, '', 0, scope).run();
}

export async function getNotificationSearchState(
  env: TelegramTextBotUxSchemaEnv,
  userTelegramId: string,
): Promise<NotificationSearchState | null> {
  const userId = normalizeUserId(userTelegramId);
  if (!userId) return null;
  const row = await env.DB.prepare(`
    SELECT query, page, return_scope
    FROM telegram_notification_search_state
    WHERE user_telegram_id = ?
      AND expires_at > CURRENT_TIMESTAMP
    LIMIT 1
  `).bind(userId).first<NotificationSearchStateRow>();
  if (!row) return null;
  return {
    query: String(row.query ?? ''),
    page: safePage(row.page),
    returnScope: normalizeReturnScope(row.return_scope),
  };
}

export async function saveNotificationSearchQuery(
  env: TelegramTextBotUxSchemaEnv,
  userTelegramId: string,
  query: string,
): Promise<void> {
  const userId = normalizeUserId(userTelegramId);
  if (!userId) return;
  await env.DB.prepare(`
    UPDATE telegram_notification_search_state
    SET query = ?,
        page = ?,
        expires_at = datetime(CURRENT_TIMESTAMP, '+10 minutes')
    WHERE user_telegram_id = ?
  `).bind(String(query ?? '').trim(), 0, userId).run();
}

export async function saveNotificationSearchPage(
  env: TelegramTextBotUxSchemaEnv,
  userTelegramId: string,
  page: number,
): Promise<void> {
  const userId = normalizeUserId(userTelegramId);
  if (!userId) return;
  await env.DB.prepare(`
    UPDATE telegram_notification_search_state
    SET page = ?,
        expires_at = datetime(CURRENT_TIMESTAMP, '+10 minutes')
    WHERE user_telegram_id = ?
  `).bind(safePage(page), userId).run();
}

export async function clearNotificationSearch(
  env: TelegramTextBotUxSchemaEnv,
  userTelegramId: string,
): Promise<void> {
  const userId = normalizeUserId(userTelegramId);
  if (!userId) return;
  await env.DB.prepare(`
    DELETE FROM telegram_notification_search_state
    WHERE user_telegram_id = ?
  `).bind(userId).run();
}

export async function setProposalInputActive(
  env: TelegramTextBotUxSchemaEnv,
  userTelegramId: string,
  inputActive: 0 | 1,
): Promise<void> {
  const userId = normalizeUserId(userTelegramId);
  if (!userId) return;
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions SET input_active=?,updated_at=CURRENT_TIMESTAMP WHERE user_telegram_id=?
  `).bind(inputActive, userId).run();
}

function normalizeUserId(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeReturnScope(value: unknown): NotificationSearchReturn {
  return value === 'mine' || value === 'all' ? value : 'home';
}

function safePage(value: unknown): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 0 ? Math.min(9999, page) : 0;
}
