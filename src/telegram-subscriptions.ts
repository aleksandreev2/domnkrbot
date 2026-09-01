export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type TelegramMessagePayload = {
  text: string;
  parse_mode?: 'HTML';
  reply_markup: { inline_keyboard: TelegramInlineKeyboardButton[][] };
};

export type SubscriptionTitle = {
  ranobelib_id: number;
  book_ref: string;
  title: string;
};

export type SubscriptionCallback =
  | { kind: 'title'; titleId: number; page: number }
  | { kind: 'list'; page: number }
  | { kind: 'mine'; page: number }
  | { kind: 'all'; mode: 'on' | 'clear' }
  | { kind: 'noop' };

type D1AllResult<T> = { results: T[] };
type D1RunResult = { meta?: { changes?: number } };
type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1AllResult<T>>;
  run(): Promise<unknown>;
};
type D1Database = { prepare(query: string): D1PreparedStatement };

export type TelegramSubscriptionEnv = {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  BOT_USERNAME?: string;
};

type TelegramUser = {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
  language_code?: string;
};
type TelegramMessage = {
  message_id: number;
  chat: { id: number; type?: string };
  from?: TelegramUser;
  text?: string;
};
type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};
export type TelegramSubscriptionUpdate = {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type OutboxRow = {
  release_id: string;
  user_telegram_id: string;
  status: string;
  attempts: number | string;
  title: string;
  url: string;
  chapter_count: number | string;
  first_number: string | null;
  last_number: string | null;
  summary: string;
};

let schemaPromise: Promise<void> | null = null;

export function buildSubscriptionMenu(
  titles: SubscriptionTitle[],
  options: { page?: number; pageSize?: number; subscribedIds?: Set<number>; allTitles?: boolean } = {},
): TelegramMessagePayload {
  const pageSize = clampInt(options.pageSize ?? 8, 1, 20);
  const totalPages = Math.max(1, Math.ceil(titles.length / pageSize));
  const page = clampInt(options.page ?? 0, 0, totalPages - 1);
  const subscribed = options.subscribedIds ?? new Set<number>();
  const start = page * pageSize;
  const pageTitles = titles.slice(start, start + pageSize);
  const rows: TelegramInlineKeyboardButton[][] = pageTitles.map((title) => [{
    text: `${options.allTitles || subscribed.has(title.ranobelib_id) ? '✅' : '📖'} ${truncate(title.title, 42)}`,
    callback_data: `subs:title:${title.ranobelib_id}:${page}`,
  }]);

  const nav: TelegramInlineKeyboardButton[] = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: `subs:list:${page - 1}` });
  nav.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'subs:noop' });
  if (page + 1 < totalPages) nav.push({ text: '▶️', callback_data: `subs:list:${page + 1}` });
  rows.push(nav);
  rows.push([{ text: options.allTitles ? '✅ Все переводы включены' : '☠️ Подписаться на все', callback_data: 'subs:all:on' }]);
  rows.push([
    { text: '✅ Мои подписки', callback_data: 'subs:mine:0' },
    { text: '🔕 Отключить все', callback_data: 'subs:all:clear' },
  ]);

  return {
    text: titles.length
      ? '🔔 <b>Уведомления о новых главах</b>\n\nВыберите тайтл. Список синхронизируется с RanobeLib автоматически.'
      : '🔔 <b>Уведомления о новых главах</b>\n\nСписок тайтлов пока пуст. Попробуйте позже.',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function parseSubscriptionCallback(value: string): SubscriptionCallback | null {
  if (value === 'subs:noop') return { kind: 'noop' };
  let match = /^subs:title:(\d+):(\d+)$/.exec(value);
  if (match) {
    const titleId = Number(match[1]);
    const page = Number(match[2]);
    if (Number.isSafeInteger(titleId) && titleId > 0 && Number.isSafeInteger(page) && page >= 0) {
      return { kind: 'title', titleId, page };
    }
    return null;
  }
  match = /^subs:(list|mine):(\d+)$/.exec(value);
  if (match) {
    const page = Number(match[2]);
    if (!Number.isSafeInteger(page) || page < 0) return null;
    return match[1] === 'list' ? { kind: 'list', page } : { kind: 'mine', page };
  }
  match = /^subs:all:(on|clear)$/.exec(value);
  if (match?.[1] === 'on' || match?.[1] === 'clear') return { kind: 'all', mode: match[1] };
  return null;
}

export function formatReleaseNotification(release: {
  title: string;
  url: string;
  chapterCount: number;
  firstNumber: string | null;
  lastNumber: string | null;
  summary: string;
}): TelegramMessagePayload {
  const range = chapterRange(release.chapterCount, release.firstNumber, release.lastNumber);
  const text = [
    '📖 <b>Новые главы!</b>',
    '',
    `<b>${escapeHtml(release.title)}</b>`,
    range,
    '',
    'Перевод команды «Дом Некроманта».',
  ].filter(Boolean).join('\n');

  return {
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '📖 Читать на RanobeLib', url: release.url }]],
    },
  };
}

export async function ensureTelegramSubscriptionSchema(env: TelegramSubscriptionEnv): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = initializeSchema(env).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function initializeSchema(env: TelegramSubscriptionEnv): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS telegram_subscription_settings (
      user_telegram_id TEXT PRIMARY KEY,
      all_titles INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS title_subscriptions (
      user_telegram_id TEXT NOT NULL,
      book_ref TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_telegram_id, book_ref),
      FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
      FOREIGN KEY (book_ref) REFERENCES ranobelib_titles(book_ref) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ranobelib_notification_outbox (
      release_id TEXT NOT NULL,
      user_telegram_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delivered_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (release_id, user_telegram_id),
      FOREIGN KEY (release_id) REFERENCES ranobelib_releases(id) ON DELETE CASCADE,
      FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`,
    'CREATE INDEX IF NOT EXISTS idx_title_subscriptions_book ON title_subscriptions(book_ref, user_telegram_id)',
    'CREATE INDEX IF NOT EXISTS idx_ranobelib_notification_pending ON ranobelib_notification_outbox(status, available_at, created_at)',
  ];
  for (const statement of statements) await env.DB.prepare(statement).run();
}

export async function handleTelegramSubscriptionUpdate(
  update: TelegramSubscriptionUpdate,
  env: TelegramSubscriptionEnv,
): Promise<boolean> {
  const callback = update.callback_query;
  if (!callback?.data?.startsWith('subs:')) return false;
  const parsed = parseSubscriptionCallback(callback.data);
  if (!parsed) return false;

  if (parsed.kind === 'noop') {
    await telegramCall(env, 'answerCallbackQuery', { callback_query_id: callback.id }).catch(() => undefined);
    return true;
  }

  if (!callback.message?.chat?.id || callback.message.chat.type !== 'private') {
    await telegramCall(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Откройте подписки в личном чате с ботом.' }).catch(() => undefined);
    return true;
  }

  await ensureTelegramSubscriptionSchema(env);
  await upsertTelegramUser(env, callback.from);
  const userId = String(callback.from.id);
  let notice = '';

  if (parsed.kind === 'title') {
    const title = await env.DB.prepare('SELECT book_ref FROM ranobelib_titles WHERE ranobelib_id = ? AND is_active = 1 LIMIT 1')
      .bind(parsed.titleId).first<{ book_ref: string }>();
    if (!title?.book_ref) {
      notice = 'Тайтл больше не доступен.';
    } else if (await userSubscribesToAll(env, userId)) {
      notice = 'У вас уже включены уведомления обо всех переводах.';
    } else {
      const existing = await env.DB.prepare('SELECT 1 AS subscribed FROM title_subscriptions WHERE user_telegram_id = ? AND book_ref = ? LIMIT 1')
        .bind(userId, title.book_ref).first<{ subscribed: number }>();
      if (existing) {
        await env.DB.prepare('DELETE FROM title_subscriptions WHERE user_telegram_id = ? AND book_ref = ?')
          .bind(userId, title.book_ref).run();
        notice = 'Уведомления для тайтла отключены.';
      } else {
        await env.DB.prepare('INSERT OR IGNORE INTO title_subscriptions (user_telegram_id, book_ref) VALUES (?, ?)')
          .bind(userId, title.book_ref).run();
        notice = 'Уведомления для тайтла включены.';
      }
    }
  } else if (parsed.kind === 'all') {
    if (parsed.mode === 'on') {
      await setAllTitles(env, userId, true);
      notice = 'Уведомления обо всех переводах включены.';
    } else {
      await setAllTitles(env, userId, false);
      await env.DB.prepare('DELETE FROM title_subscriptions WHERE user_telegram_id = ?').bind(userId).run();
      notice = 'Все уведомления отключены.';
    }
  }

  const requestedPage = 'page' in parsed ? parsed.page : 0;
  const allTitles = await userSubscribesToAll(env, userId);
  const subscribedIds = await subscribedTitleIds(env, userId);
  const all = await listSubscriptionTitles(env);
  const visible = parsed.kind === 'mine' && !allTitles
    ? all.filter((title) => subscribedIds.has(title.ranobelib_id))
    : all;
  const menu = buildSubscriptionMenu(visible, { page: requestedPage, subscribedIds, allTitles });

  await telegramCall(env, 'editMessageText', {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    text: menu.text,
    parse_mode: menu.parse_mode,
    reply_markup: menu.reply_markup,
  }).catch(async (error) => {
    if (!/message is not modified/i.test(error instanceof Error ? error.message : String(error))) throw error;
  });
  await telegramCall(env, 'answerCallbackQuery', {
    callback_query_id: callback.id,
    ...(notice ? { text: notice } : {}),
  }).catch(() => undefined);
  return true;
}

export async function sendTelegramSubscriptionMenu(
  env: TelegramSubscriptionEnv,
  user: TelegramUser,
  chatId: number,
  page = 0,
): Promise<void> {
  await ensureTelegramSubscriptionSchema(env);
  await upsertTelegramUser(env, user);
  const userId = String(user.id);
  const [titles, allTitles, subscribedIds] = await Promise.all([
    listSubscriptionTitles(env),
    userSubscribesToAll(env, userId),
    subscribedTitleIds(env, userId),
  ]);
  const menu = buildSubscriptionMenu(titles, { page, allTitles, subscribedIds });
  await telegramCall(env, 'sendMessage', {
    chat_id: chatId,
    text: menu.text,
    parse_mode: menu.parse_mode,
    reply_markup: menu.reply_markup,
  });
}

export async function enqueueReleaseNotifications(
  env: TelegramSubscriptionEnv,
  releaseId: string,
  bookRef: string,
): Promise<number> {
  await ensureTelegramSubscriptionSchema(env);
  const [allUsers, titleUsers] = await Promise.all([
    env.DB.prepare('SELECT user_telegram_id FROM telegram_subscription_settings WHERE all_titles = 1')
      .all<{ user_telegram_id: string }>(),
    env.DB.prepare('SELECT user_telegram_id FROM title_subscriptions WHERE book_ref = ?')
      .bind(bookRef).all<{ user_telegram_id: string }>(),
  ]);
  const recipients = new Set<string>();
  for (const row of [...allUsers.results, ...titleUsers.results]) {
    const id = String(row.user_telegram_id ?? '').trim();
    if (id) recipients.add(id);
  }

  let created = 0;
  for (const userId of recipients) {
    const result = await env.DB.prepare(
      'INSERT OR IGNORE INTO ranobelib_notification_outbox (release_id, user_telegram_id) VALUES (?, ?)',
    ).bind(releaseId, userId).run();
    created += runChanges(result);
  }
  return created;
}

export async function deliverPendingReleaseNotifications(
  env: TelegramSubscriptionEnv,
  limit = 40,
): Promise<{ sent: number; retried: number; disabled: number }> {
  await ensureTelegramSubscriptionSchema(env);
  const safeLimit = clampInt(limit, 1, 100);
  const { results } = await env.DB.prepare(`
    SELECT o.release_id, o.user_telegram_id, o.status, o.attempts,
           COALESCE(t.title, r.title_snapshot) AS title, t.url,
           r.chapter_count, r.first_number, r.last_number, r.summary
    FROM ranobelib_notification_outbox o
    JOIN ranobelib_releases r ON r.id = o.release_id
    JOIN ranobelib_titles t ON t.book_ref = r.book_ref
    WHERE o.status IN ('pending','retry') AND o.available_at <= CURRENT_TIMESTAMP
    ORDER BY o.created_at ASC
    LIMIT ?
  `).bind(safeLimit).all<OutboxRow>();

  let sent = 0;
  let retried = 0;
  let disabled = 0;
  for (const row of results) {
    const payload = formatReleaseNotification({
      title: row.title,
      url: row.url,
      chapterCount: Number(row.chapter_count) || 1,
      firstNumber: row.first_number,
      lastNumber: row.last_number,
      summary: row.summary,
    });
    try {
      await telegramCall(env, 'sendMessage', {
        chat_id: row.user_telegram_id,
        text: payload.text,
        parse_mode: payload.parse_mode,
        reply_markup: payload.reply_markup,
      });
      await env.DB.prepare(`UPDATE ranobelib_notification_outbox SET status='sent', attempts=attempts+1,
          delivered_at=CURRENT_TIMESTAMP, last_error=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE release_id = ? AND user_telegram_id = ?`)
        .bind(row.release_id, row.user_telegram_id).run();
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TelegramApiError && (error.status === 403 || error.errorCode === 403)) {
        await env.DB.prepare(`UPDATE ranobelib_notification_outbox SET status='disabled', attempts=attempts+1,
            last_error=?, updated_at=CURRENT_TIMESTAMP WHERE release_id = ? AND user_telegram_id = ?`)
          .bind(message.slice(0, 800), row.release_id, row.user_telegram_id).run();
        disabled += 1;
      } else {
        await env.DB.prepare(`UPDATE ranobelib_notification_outbox SET status='retry', attempts=attempts+1,
            available_at=datetime('now', '+' || MIN(attempts + 1, 10) || ' minutes'),
            last_error=?, updated_at=CURRENT_TIMESTAMP WHERE release_id = ? AND user_telegram_id = ?`)
          .bind(message.slice(0, 800), row.release_id, row.user_telegram_id).run();
        retried += 1;
      }
    }
  }
  return { sent, retried, disabled };
}

async function listSubscriptionTitles(env: TelegramSubscriptionEnv): Promise<SubscriptionTitle[]> {
  const { results } = await env.DB.prepare(`
    SELECT ranobelib_id, book_ref, COALESCE(title, slug, book_ref) AS title
    FROM ranobelib_titles
    WHERE is_active = 1 AND snapshot_ready = 1 AND ranobelib_id IS NOT NULL
    ORDER BY COALESCE(title, slug, book_ref) COLLATE NOCASE ASC
  `).all<{ ranobelib_id: number | string; book_ref: string; title: string }>();
  return results
    .map((row) => ({ ranobelib_id: Number(row.ranobelib_id), book_ref: row.book_ref, title: row.title }))
    .filter((row) => Number.isSafeInteger(row.ranobelib_id) && row.ranobelib_id > 0 && Boolean(row.book_ref));
}

async function subscribedTitleIds(env: TelegramSubscriptionEnv, userId: string): Promise<Set<number>> {
  const { results } = await env.DB.prepare(`
    SELECT t.ranobelib_id
    FROM title_subscriptions s JOIN ranobelib_titles t ON t.book_ref = s.book_ref
    WHERE s.user_telegram_id = ? AND t.ranobelib_id IS NOT NULL
  `).bind(userId).all<{ ranobelib_id: number | string }>();
  return new Set(results.map((row) => Number(row.ranobelib_id)).filter((id) => Number.isSafeInteger(id) && id > 0));
}

async function userSubscribesToAll(env: TelegramSubscriptionEnv, userId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT all_titles FROM telegram_subscription_settings WHERE user_telegram_id = ?')
    .bind(userId).first<{ all_titles: number | string }>();
  return Number(row?.all_titles ?? 0) === 1;
}

async function setAllTitles(env: TelegramSubscriptionEnv, userId: string, enabled: boolean): Promise<void> {
  await env.DB.prepare(`INSERT INTO telegram_subscription_settings (user_telegram_id, all_titles, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET all_titles=excluded.all_titles, updated_at=CURRENT_TIMESTAMP`)
    .bind(userId, enabled ? 1 : 0).run();
}

async function upsertTelegramUser(env: TelegramSubscriptionEnv, user: TelegramUser): Promise<void> {
  await env.DB.prepare(`INSERT INTO users (telegram_id,username,first_name,last_name,language_code,updated_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,
      last_name=excluded.last_name,language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP`)
    .bind(String(user.id), user.username ?? null, user.first_name || 'Telegram', user.last_name ?? '', user.language_code ?? null).run();
}

class TelegramApiError extends Error {
  constructor(message: string, readonly status: number, readonly errorCode: number | null) {
    super(message);
  }
}

async function telegramCall<T>(env: TelegramSubscriptionEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string; error_code?: number } | null;
  if (!response.ok || !body?.ok) {
    const description = body?.description || `Telegram ${method} failed with HTTP ${response.status}`;
    throw new TelegramApiError(description, response.status, Number.isFinite(body?.error_code) ? Number(body?.error_code) : null);
  }
  return body.result as T;
}

function runChanges(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const meta = (result as D1RunResult).meta;
  return Number.isFinite(meta?.changes) ? Number(meta?.changes) : 0;
}

function chapterRange(count: number, first: string | null, last: string | null): string {
  if (first && last && first !== last) return `Главы ${escapeHtml(first)}–${escapeHtml(last)}`;
  if (first) return `Глава ${escapeHtml(first)}`;
  if (count > 1) return `${count} новых глав`;
  return 'Новая глава';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] || char));
}

function truncate(value: string, max: number): string {
  const text = String(value || '').trim() || 'Без названия';
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function clampInt(value: number, min: number, max: number): number {
  const int = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, int));
}
