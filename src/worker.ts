import {
  getSessionUser,
  handleWebAuth,
  isAdminUser,
  isSameOriginMutation,
  requireAdminSession,
  type WebTelegramUser,
} from './web-auth.js';
import {
  handlePublicationDiscussionForward,
  handlePublishingApi,
  type PublishingTelegramMessage,
} from './publishing-runtime.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<unknown>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatement }
interface AssetFetcher { fetch(request: Request): Promise<Response> }
interface R2ObjectLike { size?: number; httpMetadata?: { contentType?: string }; arrayBuffer(): Promise<ArrayBuffer> }
interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}
interface Env {
  DB: D1DatabaseLike;
  ASSETS: AssetFetcher;
  FILES?: R2BucketLike;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_TELEGRAM_IDS?: string;
  BOT_USERNAME?: string;
}

type TelegramMessage = PublishingTelegramMessage & {
  message_id: number;
  chat: { id: number; type: string };
  from?: WebTelegramUser;
  text?: string;
};
type TelegramUpdate = { update_id: number; message?: TelegramMessage };
type ProposalStatus = 'pending' | 'approved' | 'planned' | 'in_progress' | 'done' | 'rejected';
type ProposalType = 'title' | 'chapters';
type ProposalRow = {
  id: string;
  user_telegram_id: string;
  proposal_type: ProposalType;
  title: string;
  source_url: string;
  chapter_from: number | null;
  chapter_to: number | null;
  comment: string;
  status: ProposalStatus;
  admin_note?: string;
  created_at: string;
  updated_at?: string;
  username: string | null;
  first_name: string;
  last_name?: string;
  vote_count: number | string;
  viewer_voted: number | string;
  is_owner: number | string;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringValue = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const finiteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};

async function upsertUser(env: Env, user: WebTelegramUser): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id,username,first_name,last_name,language_code,updated_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,
      language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP
  `).bind(String(user.id), user.username ?? null, user.first_name, user.last_name ?? '', user.language_code ?? null).run();
}

async function requireUser(request: Request, env: Env): Promise<WebTelegramUser | Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Войдите через Telegram на сайте.' }, 401);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  await upsertUser(env, user);
  return user;
}

async function listProposals(env: Env, viewer: WebTelegramUser | null, includeRejected = false, limit = 120): Promise<Record<string, unknown>[]> {
  const viewerId = viewer ? String(viewer.id) : '';
  const where = includeRejected ? '' : "WHERE p.status != 'rejected'";
  const { results } = await env.DB.prepare(`
    SELECT p.id,p.user_telegram_id,p.proposal_type,p.title,p.source_url,p.chapter_from,p.chapter_to,p.comment,
           p.status,p.admin_note,p.created_at,p.updated_at,u.username,u.first_name,u.last_name,
           COUNT(v.user_telegram_id) AS vote_count,
           MAX(CASE WHEN v.user_telegram_id=? THEN 1 ELSE 0 END) AS viewer_voted,
           CASE WHEN p.user_telegram_id=? THEN 1 ELSE 0 END AS is_owner
    FROM chapter_proposals p
    JOIN users u ON u.telegram_id=p.user_telegram_id
    LEFT JOIN proposal_votes v ON v.proposal_id=p.id
    ${where}
    GROUP BY p.id
    ORDER BY CASE p.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 WHEN 'approved' THEN 2 WHEN 'pending' THEN 3 WHEN 'done' THEN 4 ELSE 5 END,
             vote_count DESC,p.created_at DESC
    LIMIT ?
  `).bind(viewerId, viewerId, Math.max(1, Math.min(limit, 300))).all<ProposalRow>();
  return results.map((row) => ({
    ...row,
    vote_count: Number(row.vote_count || 0),
    viewer_voted: Number(row.viewer_voted || 0) === 1,
    is_owner: Number(row.is_owner || 0) === 1,
  }));
}

async function handleBootstrap(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (user) await upsertUser(env, user);
  return json({
    user: user ? { id: user.id, firstName: user.first_name, lastName: user.last_name ?? '', username: user.username ?? null } : null,
    isAdmin: isAdminUser(env, user),
    botUsername: env.BOT_USERNAME?.replace(/^@/, '') || null,
    proposals: await listProposals(env, user, false, 40),
  });
}

async function handleCreateProposal(request: Request, env: Env): Promise<Response> {
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body)) return json({ error: 'Invalid JSON body.' }, 400);
  const proposalType = stringValue(body.proposalType) as ProposalType;
  if (proposalType !== 'title' && proposalType !== 'chapters') return json({ error: 'Выберите тайтл или главы.' }, 400);
  const title = stringValue(body.title);
  const sourceUrl = stringValue(body.sourceUrl);
  const comment = stringValue(body.comment);
  if (title.length < 2 || title.length > 180) return json({ error: 'Название должно содержать от 2 до 180 символов.' }, 400);
  if (sourceUrl.length > 500 || comment.length > 1500) return json({ error: 'Заявка слишком большая.' }, 413);
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) return json({ error: 'Ссылка должна начинаться с http:// или https://.' }, 400);

  let chapterFrom: number | null = null;
  let chapterTo: number | null = null;
  if (proposalType === 'chapters') {
    chapterFrom = finiteNumber(body.chapterFrom);
    chapterTo = finiteNumber(body.chapterTo);
    if (chapterFrom === null || chapterTo === null || chapterFrom < 0 || chapterTo < chapterFrom || chapterTo - chapterFrom > 1000) {
      return json({ error: 'Введите корректный диапазон глав.' }, 400);
    }
  }

  const duplicate = await env.DB.prepare(`
    SELECT id FROM chapter_proposals WHERE user_telegram_id=? AND proposal_type=? AND lower(title)=lower(?)
      AND COALESCE(chapter_from,-1)=COALESCE(?,-1) AND COALESCE(chapter_to,-1)=COALESCE(?,-1)
      AND status IN ('pending','approved','planned','in_progress') LIMIT 1
  `).bind(String(auth.id), proposalType, title, chapterFrom, chapterTo).first<{ id: string }>();
  if (duplicate) return json({ error: 'У вас уже есть активная заявка на этот тайтл/диапазон.', id: duplicate.id }, 409);

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO chapter_proposals (id,user_telegram_id,proposal_type,title,source_url,chapter_from,chapter_to,comment)
    VALUES (?,?,?,?,?,?,?,?)
  `).bind(id, String(auth.id), proposalType, title, sourceUrl, chapterFrom, chapterTo, comment).run();
  return json({ id, status: 'pending' }, 201);
}

async function handleVote(request: Request, env: Env, proposalId: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const proposal = await env.DB.prepare('SELECT id,user_telegram_id,status FROM chapter_proposals WHERE id=?')
    .bind(proposalId).first<{ id: string; user_telegram_id: string; status: string }>();
  if (!proposal) return json({ error: 'Заявка не найдена.' }, 404);
  if (proposal.user_telegram_id === String(user.id)) return json({ error: 'Автор заявки уже считается сторонником.' }, 409);
  if (proposal.status === 'rejected' || proposal.status === 'done') return json({ error: 'Голосование закрыто.' }, 409);
  const existing = await env.DB.prepare('SELECT proposal_id FROM proposal_votes WHERE proposal_id=? AND user_telegram_id=?')
    .bind(proposalId, String(user.id)).first<{ proposal_id: string }>();
  if (existing) {
    await env.DB.prepare('DELETE FROM proposal_votes WHERE proposal_id=? AND user_telegram_id=?').bind(proposalId, String(user.id)).run();
  } else {
    await env.DB.prepare('INSERT INTO proposal_votes (proposal_id,user_telegram_id) VALUES (?,?)').bind(proposalId, String(user.id)).run();
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM proposal_votes WHERE proposal_id=?')
    .bind(proposalId).first<{ count: number | string }>();
  return json({ ok: true, voted: !existing, voteCount: Number(count?.count || 0) });
}

async function handleMyProposals(request: Request, env: Env): Promise<Response> {
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  const { results } = await env.DB.prepare(`
    SELECT id,proposal_type,title,source_url,chapter_from,chapter_to,comment,status,admin_note,created_at,updated_at
    FROM chapter_proposals WHERE user_telegram_id=? ORDER BY created_at DESC LIMIT 100
  `).bind(String(auth.id)).all();
  return json({ proposals: results });
}

async function handleAdminDashboard(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  await upsertUser(env, admin);
  const [proposals, stats, users, files, publications] = await Promise.all([
    listProposals(env, admin, true, 220),
    env.DB.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
      SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) in_progress,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done FROM chapter_proposals`).first<Record<string, number | string>>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number | string }>(),
    env.DB.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM publication_assets').first<{ count: number | string; bytes: number | string }>().catch(() => null),
    env.DB.prepare(`SELECT COUNT(*) AS count,SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published FROM publications`).first<{ count: number | string; published: number | string }>().catch(() => null),
  ]);
  return json({
    summary: {
      proposals: {
        total: Number(stats?.total || 0),
        pending: Number(stats?.pending || 0),
        inProgress: Number(stats?.in_progress || 0),
        done: Number(stats?.done || 0),
      },
      users: Number(users?.count || 0),
      files: Number(files?.count || 0),
      fileBytes: Number(files?.bytes || 0),
      publications: Number(publications?.count || 0),
      published: Number(publications?.published || 0),
    },
    proposals,
  });
}

async function handleAdminStatus(request: Request, env: Env, proposalId: string): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body)) return json({ error: 'Invalid JSON body.' }, 400);
  const status = stringValue(body.status) as ProposalStatus;
  const allowed = new Set<ProposalStatus>(['pending', 'approved', 'planned', 'in_progress', 'done', 'rejected']);
  if (!allowed.has(status)) return json({ error: 'Invalid proposal status.' }, 400);
  const adminNote = stringValue(body.adminNote);
  if (adminNote.length > 1500) return json({ error: 'Комментарий администратора слишком большой.' }, 413);
  const existing = await env.DB.prepare('SELECT id FROM chapter_proposals WHERE id=?').bind(proposalId).first<{ id: string }>();
  if (!existing) return json({ error: 'Заявка не найдена.' }, 404);
  await env.DB.prepare('UPDATE chapter_proposals SET status=?,admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(status, adminNote, proposalId).run();
  return json({ ok: true, id: proposalId, status });
}

async function telegramCall(env: Env, method: string, payload: Record<string, unknown>): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
}

async function sendSiteButton(env: Env, chatId: number, origin: string, text: string): Promise<void> {
  await telegramCall(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '☠️ Открыть сайт', url: origin }]] },
  });
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const expected = env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (!expected || request.headers.get('x-telegram-bot-api-secret-token') !== expected) return json({ error: 'Forbidden' }, 403);
  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  const message = update?.message;
  if (!message?.chat?.id) return json({ ok: true });

  if (await handlePublicationDiscussionForward(message, env)) return json({ ok: true });
  if (message.chat.type !== 'private') return json({ ok: true });

  const text = (message.text ?? '').trim();
  const origin = new URL(request.url).origin;
  if (text.startsWith('/help')) {
    await sendSiteButton(env, message.chat.id, origin, 'Каталог, предложения и управление теперь находятся на обычном сайте.');
  } else if (text.startsWith('/start') || text.startsWith('/site') || text.startsWith('/propose')) {
    await sendSiteButton(env, message.chat.id, origin, '<b>Дом Некроманта</b>\n\nПереводы, новые главы и предложения сообщества — на сайте.');
  } else {
    await sendSiteButton(env, message.chat.id, origin, 'Откройте сайт «Дома Некроманта».');
  }
  return json({ ok: true });
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'domnkrbot', time: new Date().toISOString() });
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') return handleBootstrap(request, env);
  if (request.method === 'GET' && url.pathname === '/api/proposals') return json({ proposals: await listProposals(env, await getSessionUser(request, env)) });
  if (request.method === 'POST' && url.pathname === '/api/proposals') return handleCreateProposal(request, env);
  if (request.method === 'GET' && url.pathname === '/api/me/proposals') return handleMyProposals(request, env);
  if (request.method === 'GET' && url.pathname === '/api/admin/dashboard') return handleAdminDashboard(request, env);
  if (request.method === 'GET' && url.pathname === '/api/admin/proposals') {
    const admin = await requireAdminSession(request, env);
    if (admin instanceof Response) return admin;
    return json({ proposals: await listProposals(env, admin, true, 220) });
  }
  const vote = /^\/api\/proposals\/([^/]+)\/vote$/.exec(url.pathname);
  if (request.method === 'POST' && vote?.[1]) return handleVote(request, env, decodeURIComponent(vote[1]));
  const status = /^\/api\/admin\/proposals\/([^/]+)\/status$/.exec(url.pathname);
  if (request.method === 'POST' && status?.[1]) return handleAdminStatus(request, env, decodeURIComponent(status[1]));
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      const authResponse = await handleWebAuth(request, env);
      if (authResponse) return authResponse;

      const publishingResponse = await handlePublishingApi(request, env);
      if (publishingResponse) return publishingResponse;

      if (url.pathname === '/telegram/webhook' && request.method === 'POST') return handleTelegramWebhook(request, env);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('Unhandled request error', error);
      return json({ error: 'Internal server error' }, 500);
    }
  },
};
