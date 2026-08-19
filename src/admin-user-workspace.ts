import { requireAdminSession, type WebAuthEnv } from './web-auth.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<unknown>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }

type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string };
type TelegramMessage = { message_id: number };

export interface AdminUserWorkspaceEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
}

type UserListOptions = {
  q: string;
  filter: 'all' | 'active' | 'downloaded' | 'proposals' | 'monitoring' | 'blacklisted' | 'inactive';
  sort: 'recent' | 'downloads' | 'proposals' | 'newest' | 'id';
  offset: number;
  limit: number;
};

type TimelineItem = {
  type: string;
  title: string;
  detail: string;
  at: string;
  tone?: 'danger' | 'success' | 'neutral';
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const MAX_MESSAGE = 3500;
const MAX_NOTES = 2000;
const MAX_TAGS = 12;
let schemaPromise: Promise<void> | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function parseUserListOptions(url: URL): UserListOptions {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
  const rawFilter = String(url.searchParams.get('filter') || 'all');
  const rawSort = String(url.searchParams.get('sort') || 'recent');
  const filters = new Set<UserListOptions['filter']>(['all', 'active', 'downloaded', 'proposals', 'monitoring', 'blacklisted', 'inactive']);
  const sorts = new Set<UserListOptions['sort']>(['recent', 'downloads', 'proposals', 'newest', 'id']);
  const offset = Math.max(0, Math.min(100_000, Number(url.searchParams.get('offset') || 0) || 0));
  const limit = Math.max(10, Math.min(50, Number(url.searchParams.get('limit') || 30) || 30));
  return {
    q,
    filter: filters.has(rawFilter as UserListOptions['filter']) ? rawFilter as UserListOptions['filter'] : 'all',
    sort: sorts.has(rawSort as UserListOptions['sort']) ? rawSort as UserListOptions['sort'] : 'recent',
    offset,
    limit,
  };
}

export function normalizeAdminTags(input: unknown): string[] {
  const source = Array.isArray(input) ? input : String(input || '').split(',');
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of source) {
    const value = String(item || '').trim().replace(/^#/, '').slice(0, 32);
    if (!value) continue;
    const key = value.toLocaleLowerCase('ru-RU');
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(value);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function parseTags(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return normalizeAdminTags(parsed);
  } catch {
    return [];
  }
}

export async function ensureAdminUserWorkspaceSchema(env: AdminUserWorkspaceEnv): Promise<void> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS admin_user_controls (
        user_telegram_id TEXT PRIMARY KEY,
        notes TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        updated_by TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS admin_user_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_telegram_id TEXT NOT NULL,
        admin_user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        telegram_message_id INTEGER,
        error_text TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS admin_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      'CREATE INDEX IF NOT EXISTS idx_admin_user_messages_user_created ON admin_user_messages(user_telegram_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_admin_audit_target_created ON admin_audit_log(target_type, target_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC)',
    ];
    for (const statement of statements) await env.DB.prepare(statement).run();
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

const BASE_CTES = `WITH
  delivery AS (
    SELECT user_telegram_id,
      COUNT(*) deliveries,
      COUNT(DISTINCT publication_id) releases,
      MAX(last_delivered_at) last_download_at,
      SUM(CASE WHEN attempts>1 THEN attempts-1 ELSE 0 END) repeat_deliveries
    FROM publication_deliveries
    WHERE first_delivered_at IS NOT NULL
    GROUP BY user_telegram_id
  ),
  proposal AS (
    SELECT user_telegram_id,
      COUNT(*) proposals,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending_proposals,
      MAX(created_at) last_proposal_at
    FROM chapter_proposals
    GROUP BY user_telegram_id
  ),
  event_stats AS (
    SELECT user_telegram_id,
      COUNT(*) events,
      SUM(CASE WHEN event_type='support_click' THEN 1 ELSE 0 END) support_clicks,
      SUM(CASE WHEN event_type='thank_you_click' THEN 1 ELSE 0 END) thanks,
      MAX(created_at) last_event_at
    FROM publication_reader_events
    WHERE user_telegram_id IS NOT NULL
    GROUP BY user_telegram_id
  )`;

const LAST_ACTIVITY_EXPR = `MAX(
  COALESCE(d.last_download_at,'1970-01-01T00:00:00Z'),
  COALESCE(p.last_proposal_at,'1970-01-01T00:00:00Z'),
  COALESCE(e.last_event_at,'1970-01-01T00:00:00Z'),
  COALESCE(u.updated_at,u.created_at,'1970-01-01T00:00:00Z')
)`;

async function listUsers(url: URL, env: AdminUserWorkspaceEnv): Promise<Response> {
  const options = parseUserListOptions(url);
  const where: string[] = ['1=1'];
  const binds: unknown[] = [];

  if (options.q) {
    const needle = `%${options.q.toLocaleLowerCase('ru-RU')}%`;
    where.push(`(
      LOWER(CAST(u.telegram_id AS TEXT)) LIKE ? OR
      LOWER(COALESCE(u.username,'')) LIKE ? OR
      LOWER(COALESCE(u.first_name,'')) LIKE ? OR
      LOWER(COALESCE(u.last_name,'')) LIKE ? OR
      LOWER(COALESCE(c.notes,'')) LIKE ? OR
      LOWER(COALESCE(c.tags_json,'')) LIKE ?
    )`);
    binds.push(needle, needle, needle, needle, needle, needle);
  }
  if (options.filter === 'active') where.push(`${LAST_ACTIVITY_EXPR} >= datetime('now','-7 days')`);
  if (options.filter === 'inactive') where.push(`${LAST_ACTIVITY_EXPR} < datetime('now','-30 days')`);
  if (options.filter === 'downloaded') where.push('COALESCE(d.deliveries,0)>0');
  if (options.filter === 'proposals') where.push('COALESCE(p.proposals,0)>0');
  if (options.filter === 'monitoring') where.push(`a.blacklisted_at IS NULL AND d.last_download_at >= datetime('now','-7 days')`);
  if (options.filter === 'blacklisted') where.push('a.blacklisted_at IS NOT NULL');

  const orderBy: Record<UserListOptions['sort'], string> = {
    recent: 'last_activity DESC,u.telegram_id DESC',
    downloads: 'deliveries DESC,last_activity DESC',
    proposals: 'proposals DESC,last_activity DESC',
    newest: 'u.created_at DESC,u.telegram_id DESC',
    id: 'u.telegram_id DESC',
  };

  const selectAndJoins = `
    FROM users u
    LEFT JOIN delivery d ON d.user_telegram_id=u.telegram_id
    LEFT JOIN proposal p ON p.user_telegram_id=u.telegram_id
    LEFT JOIN event_stats e ON e.user_telegram_id=u.telegram_id
    LEFT JOIN channel_access_state a ON a.user_telegram_id=u.telegram_id
    LEFT JOIN admin_user_controls c ON c.user_telegram_id=u.telegram_id
    WHERE ${where.join(' AND ')}`;

  const rows = await env.DB.prepare(`${BASE_CTES}
    SELECT u.telegram_id,u.username,u.first_name,u.last_name,u.language_code,u.created_at,u.updated_at,
      COALESCE(d.deliveries,0) deliveries,COALESCE(d.releases,0) releases,
      COALESCE(d.repeat_deliveries,0) repeat_deliveries,d.last_download_at,
      COALESCE(p.proposals,0) proposals,COALESCE(p.pending_proposals,0) pending_proposals,p.last_proposal_at,
      COALESCE(e.events,0) events,COALESCE(e.support_clicks,0) support_clicks,COALESCE(e.thanks,0) thanks,
      a.last_status,a.last_checked_at,a.left_at,a.rejoined_at,a.blacklisted_at,a.blacklist_reason,
      c.tags_json,${LAST_ACTIVITY_EXPR} last_activity
    ${selectAndJoins}
    ORDER BY ${orderBy[options.sort]}
    LIMIT ? OFFSET ?`)
    .bind(...binds, options.limit, options.offset).all<Record<string, unknown>>();

  const total = await env.DB.prepare(`${BASE_CTES}
    SELECT COUNT(*) count ${selectAndJoins}`)
    .bind(...binds).first<{ count: number | string }>();
  const count = Number(total?.count || 0);

  return json({
    users: rows.results.map((row) => ({ ...row, tags: parseTags(row.tags_json) })),
    total: count,
    offset: options.offset,
    limit: options.limit,
    hasMore: options.offset + rows.results.length < count,
    filter: options.filter,
    sort: options.sort,
  });
}

async function userExists(env: AdminUserWorkspaceEnv, userId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare('SELECT telegram_id FROM users WHERE telegram_id=?').bind(userId).first());
}

async function userDetail(userId: string, env: AdminUserWorkspaceEnv): Promise<Response> {
  const user = await env.DB.prepare(`SELECT u.telegram_id,u.username,u.first_name,u.last_name,u.language_code,u.created_at,u.updated_at,
      c.notes,c.tags_json,c.updated_by,c.updated_at control_updated_at,
      a.last_status,a.last_checked_at,a.left_at,a.rejoined_at,a.blacklisted_at,a.blacklist_reason
    FROM users u
    LEFT JOIN admin_user_controls c ON c.user_telegram_id=u.telegram_id
    LEFT JOIN channel_access_state a ON a.user_telegram_id=u.telegram_id
    WHERE u.telegram_id=?`).bind(userId).first<Record<string, unknown>>();
  if (!user) return json({ error: 'Пользователь не найден.' }, 404);

  const [stats, deliveries, proposals, events, messages, audit] = await Promise.all([
    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM publication_deliveries WHERE user_telegram_id=? AND first_delivered_at IS NOT NULL) deliveries,
      (SELECT COUNT(DISTINCT publication_id) FROM publication_deliveries WHERE user_telegram_id=? AND first_delivered_at IS NOT NULL) releases,
      (SELECT MAX(last_delivered_at) FROM publication_deliveries WHERE user_telegram_id=?) last_download_at,
      (SELECT COUNT(*) FROM chapter_proposals WHERE user_telegram_id=?) proposals,
      (SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) FROM chapter_proposals WHERE user_telegram_id=?) pending_proposals,
      (SELECT COUNT(*) FROM publication_reader_events WHERE user_telegram_id=? AND event_type='thank_you_click') thanks,
      (SELECT COUNT(*) FROM publication_reader_events WHERE user_telegram_id=? AND event_type='support_click') support_clicks`)
      .bind(userId, userId, userId, userId, userId, userId, userId).first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT d.publication_id,p.internal_title,COUNT(*) files,
        MIN(d.first_delivered_at) first_delivered_at,MAX(d.last_delivered_at) last_delivered_at,
        SUM(CASE WHEN d.attempts>1 THEN d.attempts-1 ELSE 0 END) repeats
      FROM publication_deliveries d
      LEFT JOIN publications p ON p.id=d.publication_id
      WHERE d.user_telegram_id=? AND d.first_delivered_at IS NOT NULL
      GROUP BY d.publication_id,p.internal_title
      ORDER BY MAX(d.last_delivered_at) DESC LIMIT 25`).bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id,proposal_type,title,source_url,status,admin_note,created_at,updated_at
      FROM chapter_proposals WHERE user_telegram_id=? ORDER BY created_at DESC LIMIT 25`).bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id,publication_id,event_type,source,success,repeat,details,created_at
      FROM publication_reader_events WHERE user_telegram_id=? ORDER BY created_at DESC LIMIT 40`).bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id,admin_user_id,text,status,telegram_message_id,error_text,created_at
      FROM admin_user_messages WHERE user_telegram_id=? ORDER BY created_at DESC LIMIT 20`).bind(userId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id,admin_user_id,action,details,created_at
      FROM admin_audit_log WHERE target_type='user' AND target_id=? ORDER BY created_at DESC LIMIT 30`).bind(userId).all<Record<string, unknown>>(),
  ]);

  return json({
    user: {
      ...user,
      notes: String(user.notes || ''),
      tags: parseTags(user.tags_json),
    },
    stats: stats || {},
    deliveries: deliveries.results,
    proposals: proposals.results,
    events: events.results,
    messages: messages.results,
    audit: audit.results,
    timeline: buildTimeline(user, deliveries.results, proposals.results, events.results, messages.results, audit.results),
  });
}

export function buildTimeline(
  user: Record<string, unknown>,
  deliveries: Record<string, unknown>[],
  proposals: Record<string, unknown>[],
  events: Record<string, unknown>[],
  messages: Record<string, unknown>[],
  audit: Record<string, unknown>[],
): TimelineItem[] {
  const result: TimelineItem[] = [];
  if (user.created_at) result.push({ type: 'created', title: 'Пользователь появился', detail: 'Первое сохранённое взаимодействие.', at: String(user.created_at) });
  if (user.blacklisted_at) result.push({ type: 'blacklist', title: 'Доступ к скачиваниям заблокирован', detail: String(user.blacklist_reason || 'Внутренний blacklist.'), at: String(user.blacklisted_at), tone: 'danger' });
  for (const row of deliveries) {
    if (!row.last_delivered_at) continue;
    result.push({ type: 'delivery', title: 'Получен релиз', detail: `${String(row.internal_title || `Публикация #${row.publication_id}`)} · ${Number(row.files || 0)} файл(ов)`, at: String(row.last_delivered_at), tone: 'success' });
  }
  for (const row of proposals) {
    result.push({ type: 'proposal', title: 'Заявка', detail: `${String(row.title || 'Без названия')} · ${String(row.status || 'pending')}`, at: String(row.created_at || row.updated_at || '') });
  }
  for (const row of events) {
    result.push({ type: String(row.event_type || 'event'), title: eventTitle(String(row.event_type || 'event')), detail: row.repeat ? 'Повторное действие' : String(row.source || 'bot'), at: String(row.created_at || ''), tone: Number(row.success) === 0 ? 'danger' : 'neutral' });
  }
  for (const row of messages) {
    result.push({ type: 'admin_message', title: row.status === 'sent' ? 'Сообщение администратора' : 'Ошибка сообщения', detail: String(row.text || '').slice(0, 180), at: String(row.created_at || ''), tone: row.status === 'sent' ? 'neutral' : 'danger' });
  }
  for (const row of audit) {
    result.push({ type: 'admin', title: auditTitle(String(row.action || 'admin')), detail: safeDetails(row.details), at: String(row.created_at || '') });
  }
  return result.filter((item) => item.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 60);
}

function eventTitle(type: string): string {
  return ({
    download_open: 'Открыто скачивание',
    delivery_success: 'Файл выдан',
    delivery_failed: 'Ошибка выдачи',
    thank_you_click: 'Сказал «Спасибо»',
    support_click: 'Переход на Boosty',
  } as Record<string, string>)[type] || type;
}

function auditTitle(action: string): string {
  return ({
    user_control_update: 'Обновлены внутренние данные',
    user_message: 'Отправлено сообщение',
    user_message_failed: 'Ошибка сообщения пользователю',
  } as Record<string, string>)[action] || action;
}

function safeDetails(value: unknown): string {
  if (!value) return '';
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object') {
      if ('message' in parsed) return String((parsed as { message?: unknown }).message || '').slice(0, 200);
      if ('tags' in parsed) return `Теги: ${normalizeAdminTags((parsed as { tags?: unknown }).tags).join(', ')}`;
    }
  } catch {}
  return String(value).slice(0, 200);
}

async function saveControl(request: Request, env: AdminUserWorkspaceEnv, userId: string, adminId: number): Promise<Response> {
  if (!(await userExists(env, userId))) return json({ error: 'Пользователь не найден.' }, 404);
  const body = await request.json().catch(() => null) as { notes?: unknown; tags?: unknown } | null;
  if (!body) return json({ error: 'Некорректный JSON.' }, 400);
  const notes = String(body.notes || '').trim().slice(0, MAX_NOTES);
  const tags = normalizeAdminTags(body.tags);
  await env.DB.prepare(`INSERT INTO admin_user_controls (user_telegram_id,notes,tags_json,updated_by,updated_at)
    VALUES (?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET notes=excluded.notes,tags_json=excluded.tags_json,
      updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
    .bind(userId, notes, JSON.stringify(tags), String(adminId)).run();
  await audit(env, adminId, 'user_control_update', userId, { tags, notesLength: notes.length });
  return userDetail(userId, env);
}

async function messageUser(request: Request, env: AdminUserWorkspaceEnv, userId: string, adminId: number): Promise<Response> {
  if (!(await userExists(env, userId))) return json({ error: 'Пользователь не найден.' }, 404);
  const body = await request.json().catch(() => null) as { text?: unknown } | null;
  const text = String(body?.text || '').trim();
  if (!text) return json({ error: 'Введите текст сообщения.' }, 400);
  if (text.length > MAX_MESSAGE) return json({ error: `Сообщение длиннее ${MAX_MESSAGE} символов.` }, 400);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return json({ error: 'TELEGRAM_BOT_TOKEN не настроен.' }, 503);

  let status = 'failed';
  let telegramMessageId: number | null = null;
  let errorText: string | null = null;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(userId), text, link_preview_options: { is_disabled: true } }),
    });
    const payload = await response.json().catch(() => null) as TelegramResponse<TelegramMessage> | null;
    if (!response.ok || !payload?.ok || !payload.result) throw new Error(payload?.description || `Telegram HTTP ${response.status}`);
    status = 'sent';
    telegramMessageId = payload.result.message_id;
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error);
  }

  await env.DB.prepare(`INSERT INTO admin_user_messages
    (user_telegram_id,admin_user_id,text,status,telegram_message_id,error_text,created_at)
    VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .bind(userId, String(adminId), text, status, telegramMessageId, errorText).run();
  await audit(env, adminId, status === 'sent' ? 'user_message' : 'user_message_failed', userId, {
    message: text.slice(0, 160),
    telegramMessageId,
    error: errorText,
  });

  if (status !== 'sent') return json({ error: `Telegram не доставил сообщение: ${errorText || 'unknown error'}` }, 502);
  return userDetail(userId, env);
}

async function audit(env: AdminUserWorkspaceEnv, adminId: number, action: string, targetId: string, details?: unknown): Promise<void> {
  await env.DB.prepare(`INSERT INTO admin_audit_log (admin_user_id,action,target_type,target_id,details,created_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .bind(String(adminId), action, 'user', targetId, details === undefined ? null : JSON.stringify(details).slice(0, 1600)).run();
}

async function cockpitSummary(env: AdminUserWorkspaceEnv): Promise<Response> {
  const row = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM users) users,
    (SELECT COUNT(DISTINCT user_telegram_id) FROM publication_deliveries WHERE last_delivered_at>=datetime('now','-7 days')) active_readers_7d,
    (SELECT COUNT(*) FROM chapter_proposals WHERE status='pending') pending_proposals,
    (SELECT COUNT(*) FROM channel_access_state WHERE blacklisted_at IS NOT NULL) blacklisted,
    (SELECT COUNT(DISTINCT user_telegram_id) FROM publication_deliveries d
      WHERE last_delivered_at>=datetime('now','-7 days')
      AND NOT EXISTS (SELECT 1 FROM channel_access_state a WHERE a.user_telegram_id=d.user_telegram_id AND a.blacklisted_at IS NOT NULL)) monitoring,
    (SELECT COUNT(*) FROM publication_reader_events WHERE event_type='delivery_failed' AND created_at>=datetime('now','-24 hours')) delivery_failures_24h,
    (SELECT COUNT(*) FROM publications WHERE status='published') published
  `).first<Record<string, unknown>>();
  return json({ summary: row || {} });
}

async function activity(env: AdminUserWorkspaceEnv, url: URL): Promise<Response> {
  const limit = Math.max(20, Math.min(150, Number(url.searchParams.get('limit') || 80) || 80));
  const result = await env.DB.prepare(`SELECT source,kind,subject,detail,success,created_at FROM (
      SELECT 'admin' source,action kind,target_id subject,COALESCE(details,'') detail,1 success,created_at FROM admin_audit_log
      UNION ALL
      SELECT 'publication' source,event kind,CAST(publication_id AS TEXT) subject,message detail,
        CASE WHEN level IN ('error','failed') THEN 0 ELSE 1 END success,created_at FROM publication_logs
      UNION ALL
      SELECT 'reader' source,event_type kind,COALESCE(user_telegram_id,'') subject,COALESCE(details,'') detail,success,created_at FROM publication_reader_events
      UNION ALL
      SELECT 'proposal' source,'proposal_'||status kind,user_telegram_id subject,title detail,1 success,created_at FROM chapter_proposals
    ) ORDER BY created_at DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
  return json({ events: result.results, limit });
}

export async function handleAdminUserWorkspace(request: Request, env: AdminUserWorkspaceEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const isWorkspacePath = url.pathname === '/api/admin/users'
    || url.pathname === '/api/admin/users/summary'
    || url.pathname === '/api/admin/activity'
    || /^\/api\/admin\/users\/\d+$/.test(url.pathname)
    || /^\/api\/admin\/users\/\d+\/(control|message)$/.test(url.pathname);
  if (!isWorkspacePath) return null;

  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  await ensureAdminUserWorkspaceSchema(env);

  if (request.method === 'GET' && url.pathname === '/api/admin/users') return listUsers(url, env);
  if (request.method === 'GET' && url.pathname === '/api/admin/users/summary') return cockpitSummary(env);
  if (request.method === 'GET' && url.pathname === '/api/admin/activity') return activity(env, url);

  const detailMatch = /^\/api\/admin\/users\/(\d+)$/.exec(url.pathname);
  if (request.method === 'GET' && detailMatch) return userDetail(detailMatch[1], env);

  const controlMatch = /^\/api\/admin\/users\/(\d+)\/control$/.exec(url.pathname);
  if (request.method === 'POST' && controlMatch) return saveControl(request, env, controlMatch[1], admin.id);

  const messageMatch = /^\/api\/admin\/users\/(\d+)\/message$/.exec(url.pathname);
  if (request.method === 'POST' && messageMatch) return messageUser(request, env, messageMatch[1], admin.id);

  return json({ error: 'Method not allowed.' }, 405);
}
