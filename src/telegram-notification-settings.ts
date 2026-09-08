export type DeliverySetting =
  | { mode: 'instant'; stackSize: null }
  | { mode: 'stack'; stackSize: number };

export type NotificationCustomInputState =
  | { scope: 'global'; bookRef: null }
  | { scope: 'title'; bookRef: string };

type D1FirstResult<T> = Promise<T | null>;
type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): D1FirstResult<T>;
  run(): Promise<unknown>;
};

type D1Database = { prepare(query: string): D1PreparedStatement };

export type TelegramNotificationSettingsEnv = { DB: D1Database };

type DeliverySettingRow = {
  delivery_mode?: unknown;
  stack_size?: unknown;
};

type CustomInputRow = {
  scope?: unknown;
  book_ref?: unknown;
};

export function normalizeDeliverySetting(mode: unknown, stackSize: unknown): DeliverySetting {
  if (mode !== 'stack') return { mode: 'instant', stackSize: null };
  const size = typeof stackSize === 'number'
    ? stackSize
    : (typeof stackSize === 'string' && stackSize.trim() ? Number(stackSize) : Number.NaN);
  if (!Number.isInteger(size) || size < 2 || size > 100) return { mode: 'instant', stackSize: null };
  return { mode: 'stack', stackSize: size };
}

export function validateCustomStackSize(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 2 || number > 100) return null;
  return number;
}

export function deliverySettingLabel(setting: DeliverySetting): string {
  return setting.mode === 'instant' ? '⚡ Мгновенно' : `📦 По ${setting.stackSize}`;
}

export async function getGlobalDeliverySetting(
  env: TelegramNotificationSettingsEnv,
  userId: string,
): Promise<DeliverySetting> {
  const row = await env.DB.prepare(`
    SELECT delivery_mode, stack_size
    FROM telegram_subscription_settings
    WHERE user_telegram_id = ?
  `).bind(userId).first<DeliverySettingRow>();
  return normalizeDeliverySetting(row?.delivery_mode, row?.stack_size);
}

export async function getTitleDeliverySetting(
  env: TelegramNotificationSettingsEnv,
  userId: string,
  bookRef: string,
): Promise<{ setting: DeliverySetting; inherited: boolean }> {
  const row = await env.DB.prepare(`
    SELECT delivery_mode, stack_size
    FROM telegram_title_delivery_settings
    WHERE user_telegram_id = ? AND book_ref = ?
  `).bind(userId, bookRef).first<DeliverySettingRow>();
  if (!row) return { setting: await getGlobalDeliverySetting(env, userId), inherited: true };
  return { setting: normalizeDeliverySetting(row.delivery_mode, row.stack_size), inherited: false };
}

export async function setGlobalDeliverySetting(
  env: TelegramNotificationSettingsEnv,
  userId: string,
  setting: DeliverySetting,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO telegram_subscription_settings (
      user_telegram_id, all_titles, delivery_mode, stack_size, updated_at
    ) VALUES (?, 0, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET
      delivery_mode = excluded.delivery_mode,
      stack_size = excluded.stack_size,
      updated_at = CURRENT_TIMESTAMP
  `).bind(userId, setting.mode, setting.stackSize).run();
}

export async function setTitleDeliverySetting(
  env: TelegramNotificationSettingsEnv,
  userId: string,
  bookRef: string,
  setting: DeliverySetting,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO telegram_title_delivery_settings (
      user_telegram_id, book_ref, delivery_mode, stack_size, updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id, book_ref) DO UPDATE SET
      delivery_mode = excluded.delivery_mode,
      stack_size = excluded.stack_size,
      updated_at = CURRENT_TIMESTAMP
  `).bind(userId, bookRef, setting.mode, setting.stackSize).run();
}

export async function clearTitleDeliverySetting(
  env: TelegramNotificationSettingsEnv,
  userId: string,
  bookRef: string,
): Promise<void> {
  await env.DB.prepare(`
    DELETE FROM telegram_title_delivery_settings
    WHERE user_telegram_id = ? AND book_ref = ?
  `).bind(userId, bookRef).run();
}

export async function beginNotificationCustomInput(
  env: TelegramNotificationSettingsEnv,
  userId: string,
  state: { scope: 'global' } | { scope: 'title'; bookRef: string },
): Promise<void> {
  const scope = state.scope;
  const bookRef = scope === 'title' ? state.bookRef.trim() : null;
  if (scope === 'title' && !bookRef) throw new Error('Title custom input requires bookRef');
  await env.DB.prepare(`
    INSERT INTO telegram_notification_input_state (
      user_telegram_id, scope, book_ref, expires_at, created_at
    ) VALUES (?, ?, ?, datetime('now','+10 minutes'), CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET
      scope = excluded.scope,
      book_ref = excluded.book_ref,
      expires_at = excluded.expires_at,
      created_at = CURRENT_TIMESTAMP
  `).bind(userId, scope, bookRef).run();
}

export async function getNotificationCustomInput(
  env: TelegramNotificationSettingsEnv,
  userId: string,
): Promise<NotificationCustomInputState | null> {
  await env.DB.prepare(`
    DELETE FROM telegram_notification_input_state
    WHERE user_telegram_id = ? AND expires_at <= CURRENT_TIMESTAMP
  `).bind(userId).run();

  const row = await env.DB.prepare(`
    SELECT scope, book_ref
    FROM telegram_notification_input_state
    WHERE user_telegram_id = ? AND expires_at > CURRENT_TIMESTAMP
  `).bind(userId).first<CustomInputRow>();
  if (!row) return null;
  if (row.scope === 'global') return { scope: 'global', bookRef: null };
  if (row.scope === 'title' && typeof row.book_ref === 'string' && row.book_ref.trim()) {
    return { scope: 'title', bookRef: row.book_ref.trim() };
  }
  return null;
}

export async function clearNotificationCustomInput(
  env: TelegramNotificationSettingsEnv,
  userId: string,
): Promise<void> {
  await env.DB.prepare(`
    DELETE FROM telegram_notification_input_state
    WHERE user_telegram_id = ?
  `).bind(userId).run();
}

export async function ensureTelegramNotificationSettingsSchema(
  env: TelegramNotificationSettingsEnv,
): Promise<void> {
  try {
    await env.DB.prepare('ALTER TABLE telegram_subscription_settings ADD COLUMN stack_size INTEGER').run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name:\s*stack_size/i.test(message)) throw error;
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS telegram_title_delivery_settings (
      user_telegram_id TEXT NOT NULL,
      book_ref TEXT NOT NULL,
      delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('instant','stack')),
      stack_size INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_telegram_id, book_ref),
      FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
      FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE,
      CHECK (
        (delivery_mode = 'instant' AND stack_size IS NULL)
        OR
        (delivery_mode = 'stack' AND stack_size BETWEEN 2 AND 100)
      )
    )`,
    `CREATE TABLE IF NOT EXISTS telegram_notification_input_state (
      user_telegram_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('global','title')),
      book_ref TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
      FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE,
      CHECK (
        (scope = 'global' AND book_ref IS NULL)
        OR
        (scope = 'title' AND book_ref IS NOT NULL)
      )
    )`,
    'CREATE INDEX IF NOT EXISTS idx_telegram_title_delivery_book ON telegram_title_delivery_settings(book_ref, user_telegram_id)',
    'CREATE INDEX IF NOT EXISTS idx_telegram_notification_input_expiry ON telegram_notification_input_state(expires_at)',
  ];
  for (const statement of statements) await env.DB.prepare(statement).run();
}