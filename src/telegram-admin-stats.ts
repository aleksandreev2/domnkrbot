import { renderTelegramScreen, type TelegramScreenExecutionContext } from './telegram-screen-renderer.js';

type D1Row = Record<string, unknown>;
type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<{ results: T[] }>;
};
type D1Database = {
  prepare(query: string): D1Statement;
  batch?<T = D1Row>(statements: D1Statement[]): Promise<Array<{ results?: T[] }>>;
};

export type TelegramAdminStatsEnv = {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  ADMIN_TELEGRAM_IDS?: string;
};

type StatsExecutionContext = TelegramScreenExecutionContext;
type StatsUpdate = {
  message?: {
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { id?: number };
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
    message?: { message_id?: number; chat?: { id?: number; type?: string } };
  };
};

type StatsSection = 'home' | 'users' | 'subscriptions' | 'translations' | 'delivery' | 'proposals' | 'publications' | 'access' | 'system';

type StatsSnapshot = {
  users: D1Row;
  subscriptions: D1Row;
  translations: D1Row;
  delivery: D1Row;
  proposals: D1Row;
  publications: D1Row;
  access: D1Row;
  system: D1Row;
  translationHealth: D1Row;
};

type TranslationProblem = {
  book_ref?: unknown;
  title?: unknown;
  unknown?: unknown;
  has_error?: unknown;
  sync_error?: unknown;
  failures?: unknown;
  delay_minutes?: unknown;
};

const SECTION_LABELS: Array<[Exclude<StatsSection, 'home'>, string]> = [
  ['users', '👥 Пользователи'],
  ['subscriptions', '🔔 Подписки'],
  ['translations', '📚 Переводы'],
  ['delivery', '📦 Доставка'],
  ['proposals', '📝 Заявки'],
  ['publications', '📖 Публикации'],
  ['access', '🛡 Доступ'],
  ['system', '⚙️ Система'],
];

export async function handleTelegramAdminStatsWebhook(
  request: Request,
  env: TelegramAdminStatsEnv,
  ctx?: StatsExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;

  const update = await request.clone().json().catch(() => null) as StatsUpdate | null;
  if (!update) return null;
  const command = update.message?.text?.trim() ?? '';
  const callbackData = update.callback_query?.data?.trim() ?? '';
  const isStatsCommand = /^\/stats(?:@[A-Za-z0-9_]+)?$/i.test(command);
  const isStatsCallback = /^stats:(?:home|refresh|users|subscriptions|translations|delivery|proposals|publications|access|system)$/.test(callbackData);
  if (!isStatsCommand && !isStatsCallback) return null;

  const userId = Number(update.callback_query?.from?.id ?? update.message?.from?.id);
  if (!Number.isSafeInteger(userId) || !isAdmin(env, userId)) {
    return new Response('ok');
  }

  const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id ?? userId;
  const chatType = update.callback_query?.message?.chat?.type ?? update.message?.chat?.type;
  if (chatType && chatType !== 'private') return new Response('ok');

  if (isStatsCallback && update.callback_query?.id) {
    await answerCallback(env, update.callback_query.id);
  }

  const section: StatsSection = callbackData === 'stats:refresh' || callbackData === 'stats:home'
    ? 'home'
    : callbackData.startsWith('stats:')
      ? callbackData.slice('stats:'.length) as StatsSection
      : 'home';
  const snapshot = await loadStatsSnapshot(env.DB);
  const payload = buildStatsScreen(section, snapshot);
  const messageId = update.callback_query?.message?.message_id;

  await renderTelegramScreen(
    env,
    { chatId, ...(messageId ? { messageId } : {}) },
    payload,
    { strategy: messageId ? 'edit' : 'send', ctx },
  );
  return new Response('ok');
}

async function loadStatsSnapshot(db: D1Database): Promise<StatsSnapshot> {
  const statements = [
    db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS new_24h,
      SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS new_7d,
      SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS new_30d
      FROM users`),
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM (
        SELECT user_telegram_id FROM telegram_subscription_settings WHERE all_titles=1
        UNION SELECT user_telegram_id FROM title_subscriptions
      )) AS users_enabled,
      (SELECT COUNT(*) FROM telegram_subscription_settings WHERE all_titles=1) AS all_titles_users,
      (SELECT COUNT(*) FROM title_subscriptions) AS explicit_subscriptions,
      (SELECT COUNT(*) FROM telegram_subscription_settings WHERE COALESCE(delivery_mode,'instant')='instant') AS instant_users,
      (SELECT COUNT(*) FROM telegram_subscription_settings WHERE delivery_mode='stack') AS stack_users,
      (SELECT COUNT(*) FROM telegram_title_delivery_settings) AS title_overrides`),
    db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN translation_is_completed=1 THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN translation_is_completed IS NULL THEN 1 ELSE 0 END) AS unknown_status,
      SUM(CASE WHEN snapshot_ready=1 THEN 1 ELSE 0 END) AS snapshot_ready,
      SUM(CASE WHEN sync_error IS NOT NULL AND TRIM(sync_error)<>'' THEN 1 ELSE 0 END) AS with_errors,
      SUM(CASE WHEN is_active=1 AND next_check_at IS NOT NULL AND next_check_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS due_now,
      SUM(CASE WHEN is_active=1 AND next_check_at IS NOT NULL AND next_check_at < datetime('now','-5 minutes') THEN 1 ELSE 0 END) AS late_5m,
      SUM(COALESCE(notification_subscriber_count,0)) AS subscribers
      FROM ranobelib_titles`),
    db.prepare(`SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='retry' THEN 1 ELSE 0 END) AS retry,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS disabled,
      SUM(CASE WHEN status='sent' AND delivered_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS sent_24h,
      SUM(CASE WHEN status='sent' AND delivered_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS sent_7d,
      SUM(CASE WHEN status IN ('pending','retry') AND available_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS due_now,
      CAST(COALESCE((julianday('now') - julianday(MIN(CASE WHEN status IN ('pending','retry') AND available_at <= CURRENT_TIMESTAMP THEN available_at END))) * 1440,0) AS INTEGER) AS oldest_due_minutes
      FROM ranobelib_notification_outbox`),
    db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN p.created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS new_24h,
      SUM(CASE WHEN p.created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS new_7d,
      SUM(CASE WHEN p.status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN p.status='approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN p.status='rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN p.status NOT IN ('pending','approved','rejected') THEN 1 ELSE 0 END) AS other,
      (SELECT COUNT(*) FROM proposal_votes) AS votes
      FROM chapter_proposals p`),
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM publications) AS publications,
      (SELECT COUNT(*) FROM publications WHERE status='published') AS published,
      (SELECT COUNT(*) FROM publication_deliveries) AS deliveries,
      (SELECT COUNT(*) FROM publication_deliveries WHERE status NOT IN ('sent','delivered') AND last_error IS NOT NULL) AS delivery_errors,
      (SELECT COUNT(DISTINCT user_telegram_id) FROM publication_reader_events WHERE user_telegram_id IS NOT NULL) AS unique_readers,
      (SELECT COUNT(*) FROM publication_reader_events) AS reader_events,
      (SELECT COUNT(*) FROM publication_thanks) AS thanks`),
    db.prepare(`SELECT
      COUNT(*) AS tracked,
      SUM(CASE WHEN a.last_status IN ('creator','administrator','member','restricted') THEN 1 ELSE 0 END) AS members,
      SUM(CASE WHEN a.left_at IS NOT NULL AND a.rejoined_at IS NULL THEN 1 ELSE 0 END) AS left_users,
      SUM(CASE WHEN a.blacklisted_at IS NOT NULL THEN 1 ELSE 0 END) AS blacklisted,
      (SELECT COUNT(*) FROM channel_telegram_bans WHERE banned_at IS NOT NULL) AS bans_done,
      (SELECT COUNT(*) FROM channel_telegram_bans WHERE banned_at IS NULL) AS bans_pending,
      (SELECT COUNT(*) FROM channel_membership_appeals WHERE status='pending') AS appeals_pending,
      (SELECT COUNT(*) FROM channel_membership_appeals WHERE status='approved') AS appeals_approved,
      (SELECT COUNT(*) FROM channel_membership_appeals WHERE status='rejected') AS appeals_rejected
      FROM channel_access_state a`),
    db.prepare(`SELECT
      SUM(CASE WHEN created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS releases_24h,
      SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS releases_7d,
      MAX(created_at) AS last_release_at,
      (SELECT MAX(last_synced_at) FROM ranobelib_titles) AS last_sync_at,
      (SELECT COUNT(*) FROM ranobelib_titles WHERE consecutive_failures>0 OR (sync_error IS NOT NULL AND TRIM(sync_error)<>'')) AS failures,
      (SELECT COUNT(*) FROM ranobelib_titles WHERE is_active=1 AND next_check_at IS NOT NULL AND next_check_at<=CURRENT_TIMESTAMP) AS due_scans
      FROM ranobelib_releases`),
    db.prepare(`SELECT COALESCE(json_group_array(json_object(
      'book_ref', book_ref,
      'title', title,
      'unknown', unknown,
      'has_error', has_error,
      'sync_error', sync_error,
      'failures', failures,
      'delay_minutes', delay_minutes
    )), '[]') AS items
    FROM (
      SELECT
        book_ref,
        COALESCE(NULLIF(TRIM(title), ''), book_ref) AS title,
        CASE WHEN translation_is_completed IS NULL THEN 1 ELSE 0 END AS unknown,
        CASE WHEN sync_error IS NOT NULL AND TRIM(sync_error)<>'' THEN 1 ELSE 0 END AS has_error,
        sync_error,
        COALESCE(consecutive_failures,0) AS failures,
        CASE
          WHEN is_active=1 AND next_check_at IS NOT NULL AND next_check_at < datetime('now','-5 minutes')
          THEN CAST(MAX(0, (julianday('now') - julianday(next_check_at)) * 1440) AS INTEGER)
          ELSE 0
        END AS delay_minutes
      FROM ranobelib_titles
      WHERE translation_is_completed IS NULL
         OR (sync_error IS NOT NULL AND TRIM(sync_error)<>'')
         OR (is_active=1 AND next_check_at IS NOT NULL AND next_check_at < datetime('now','-5 minutes'))
      ORDER BY
        CASE WHEN sync_error IS NOT NULL AND TRIM(sync_error)<>'' THEN 1 ELSE 0 END DESC,
        CASE WHEN translation_is_completed IS NULL THEN 1 ELSE 0 END DESC,
        next_check_at ASC
      LIMIT 6
    )`),
  ];

  const rows = await batchFirstRows(db, statements);
  return {
    users: rows[0] ?? {},
    subscriptions: rows[1] ?? {},
    translations: rows[2] ?? {},
    delivery: rows[3] ?? {},
    proposals: rows[4] ?? {},
    publications: rows[5] ?? {},
    access: rows[6] ?? {},
    system: rows[7] ?? {},
    translationHealth: rows[8] ?? {},
  };
}

async function batchFirstRows(db: D1Database, statements: D1Statement[]): Promise<D1Row[]> {
  if (typeof db.batch === 'function') {
    const results = await db.batch<D1Row>(statements);
    return statements.map((_, index) => results[index]?.results?.[0] ?? {});
  }
  return Promise.all(statements.map(async (statement) => await statement.first<D1Row>() ?? {}));
}

function buildStatsScreen(section: StatsSection, s: StatsSnapshot) {
  const back = [[{ text: '↩️ Сводка', callback_data: 'stats:home' }], [{ text: '🔄 Обновить', callback_data: section === 'home' ? 'stats:refresh' : `stats:${section}` }]];
  if (section === 'users') return screen('👥 Пользователи', [
    line('Всего', s.users.total), line('Новые за 24 ч', s.users.new_24h), line('Новые за 7 дней', s.users.new_7d), line('Новые за 30 дней', s.users.new_30d),
  ], back);
  if (section === 'subscriptions') return screen('🔔 Подписки', [
    line('Пользователей с уведомлениями', s.subscriptions.users_enabled), line('Подписаны на все тайтлы', s.subscriptions.all_titles_users),
    line('Явных подписок', s.subscriptions.explicit_subscriptions), line('Мгновенный режим', s.subscriptions.instant_users),
    line('Режим стака', s.subscriptions.stack_users), line('Индивидуальных режимов', s.subscriptions.title_overrides),
  ], back);
  if (section === 'translations') {
    const problems = renderTranslationProblems(s.translationHealth);
    return screen('📚 Переводы', [
      line('Всего', s.translations.total), line('Активные', s.translations.active), line('Завершённые', s.translations.completed),
      line('Без статуса', s.translations.unknown_status), line('Snapshot готов', s.translations.snapshot_ready), line('С ошибками', s.translations.with_errors),
      line('Ожидают сканирования', s.translations.due_now), line('Задержка &gt;5 мин', s.translations.late_5m),
      line('Суммарный спрос подписчиков', s.translations.subscribers),
      '', '<b>Проблемные тайтлы</b>', ...problems,
    ], back);
  }
  if (section === 'delivery') return screen('📦 Доставка уведомлений', [
    line('Pending', s.delivery.pending), line('Retry', s.delivery.retry), line('Sent', s.delivery.sent), line('Disabled', s.delivery.disabled),
    line('Отправлено за 24 ч', s.delivery.sent_24h), line('Отправлено за 7 дней', s.delivery.sent_7d), line('Готовы к отправке сейчас', s.delivery.due_now),
    `Старейшее ожидающее: ${duration(s.delivery.oldest_due_minutes)}`,
  ], back);
  if (section === 'proposals') return screen('📝 Заявки', [
    line('Всего', s.proposals.total), line('Новые за 24 ч', s.proposals.new_24h), line('Новые за 7 дней', s.proposals.new_7d),
    line('Pending', s.proposals.pending), line('Approved', s.proposals.approved), line('Rejected', s.proposals.rejected), line('Другие статусы', s.proposals.other), line('Голосов', s.proposals.votes),
  ], back);
  if (section === 'publications') return screen('📖 Публикации и читатели', [
    line('Публикаций', s.publications.publications), line('Опубликовано', s.publications.published), line('Выдач файлов', s.publications.deliveries),
    line('Ошибок выдачи', s.publications.delivery_errors), line('Уникальных читателей', s.publications.unique_readers), line('Reader events', s.publications.reader_events), line('Спасибо', s.publications.thanks),
  ], back);
  if (section === 'access') return screen('🛡 Доступ и модерация', [
    line('Отслеживается пользователей', s.access.tracked), line('Участников', s.access.members), line('Вышли', s.access.left_users), line('В blacklist', s.access.blacklisted),
    line('Банов выполнено', s.access.bans_done), line('Банов ожидают', s.access.bans_pending), line('Апелляций pending', s.access.appeals_pending),
    line('Апелляций approved', s.access.appeals_approved), line('Апелляций rejected', s.access.appeals_rejected),
  ], back);
  if (section === 'system') return screen('⚙️ Система', [
    line('Релизов за 24 ч', s.system.releases_24h), line('Релизов за 7 дней', s.system.releases_7d),
    `Последний релиз: ${formatDate(s.system.last_release_at)}`, `Последняя синхронизация: ${formatDate(s.system.last_sync_at)}`,
    line('Тайтлов с ошибками', s.system.failures), line('Сканов готовы сейчас', s.system.due_scans),
  ], back);

  const text = [
    '📊 <b>Статистика бота</b>', '',
    `👥 Пользователи: <b>${n(s.users.total)}</b>  (+${n(s.users.new_24h)} за 24 ч)`,
    `🔔 Получают уведомления: <b>${n(s.subscriptions.users_enabled)}</b>`,
    `📚 Переводы: <b>${n(s.translations.active)}</b> активных / <b>${n(s.translations.completed)}</b> завершённых`,
    `📦 Очередь: <b>${n(s.delivery.due_now)}</b> готово / <b>${n(s.delivery.retry)}</b> retry`,
    `📝 Заявки: <b>${n(s.proposals.total)}</b>  (+${n(s.proposals.new_24h)} за 24 ч)`,
    `📖 Уникальных читателей: <b>${n(s.publications.unique_readers)}</b>`,
    `🛡 Blacklist: <b>${n(s.access.blacklisted)}</b> / апелляций: <b>${n(s.access.appeals_pending)}</b>`,
    `⚙️ Ошибок синхронизации: <b>${n(s.system.failures)}</b>`, '',
    `Обновлено: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
  ].join('\n');
  const buttons = [];
  for (let i = 0; i < SECTION_LABELS.length; i += 2) {
    buttons.push(SECTION_LABELS.slice(i, i + 2).map(([key, label]) => ({ text: label, callback_data: `stats:${key}` })));
  }
  buttons.push([{ text: '🔄 Обновить', callback_data: 'stats:refresh' }]);
  return { text, parse_mode: 'HTML' as const, reply_markup: { inline_keyboard: buttons } };
}

function renderTranslationProblems(row: D1Row): string[] {
  const raw = String(row.items ?? '[]');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return ['Нет проблемных тайтлов.'];

  const lines: string[] = [];
  for (const item of parsed.slice(0, 6) as TranslationProblem[]) {
    const title = escapeHtml(String(item.title ?? item.book_ref ?? 'Без названия'));
    const reasons: string[] = [];
    if (n(item.unknown) > 0) reasons.push('без статуса');
    if (n(item.has_error) > 0) reasons.push(`ошибка ×${Math.max(1, n(item.failures))}`);
    if (n(item.delay_minutes) > 5) reasons.push(`задержка ${duration(item.delay_minutes)}`);
    if (reasons.length === 0) reasons.push('требует проверки');
    lines.push(`• <b>${title}</b> — ${reasons.join('; ')}`);

    const error = String(item.sync_error ?? '').trim();
    if (error) lines.push(`  ↳ <code>${escapeHtml(clip(error, 140))}</code>`);
  }
  return lines;
}

function screen(title: string, lines: string[], buttons: Array<Array<{ text: string; callback_data: string }>>) {
  return { text: [`<b>${title}</b>`, '', ...lines].join('\n'), parse_mode: 'HTML' as const, reply_markup: { inline_keyboard: buttons } };
}

function line(label: string, value: unknown): string { return `${label}: <b>${n(value)}</b>`; }
function n(value: unknown): number { const x = Number(value ?? 0); return Number.isFinite(x) ? Math.max(0, Math.trunc(x)) : 0; }
function duration(value: unknown): string { const minutes = n(value); return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`; }
function formatDate(value: unknown): string { const text = String(value ?? '').trim(); return text || 'нет данных'; }
function clip(value: string, maxLength: number): string { return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`; }
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function isAdmin(env: TelegramAdminStatsEnv, userId: number): boolean {
  return String(env.ADMIN_TELEGRAM_IDS ?? '').split(/[,\s]+/).some((value) => Number(value) === userId);
}

async function answerCallback(env: TelegramAdminStatsEnv, callbackId: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackId }),
  }).then(async (response) => {
    const body = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram answerCallbackQuery failed with HTTP ${response.status}`);
  });
}
