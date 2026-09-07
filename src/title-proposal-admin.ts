import { isSameOriginMutation, requireAdminSession, type WebAuthEnv } from './web-auth.js';

type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<unknown>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatement }
export interface TitleProposalAdminEnv extends WebAuthEnv { DB: D1DatabaseLike }

type ProposalStatus = 'pending' | 'approved' | 'planned' | 'in_progress' | 'done' | 'rejected';
type ProposalStatusRow = { id: string; user_telegram_id: string; title: string; status: ProposalStatus };
type ProposalLinkRow = {
  id: string;
  proposal_type: string;
  source_kind: string;
  ranobelib_book_ref: string | null;
  title: string;
  status: ProposalStatus;
};
type RanobeLibLinkRow = { book_ref: string; ranobelib_id: number | null; title: string | null; url: string | null };
type ProposalConflictRow = { id: string; status: ProposalStatus };
type RanobeLibCandidate = {
  id?: number;
  slug?: string;
  slug_url?: string;
  name?: string;
  rus_name?: string;
  eng_name?: string;
  items_count?: { uploaded?: number };
};
type AdminRanobeLibCandidate = {
  bookRef: string;
  ranobelibId: number;
  title: string;
  url: string;
  chapterCount: number;
  slug: string;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const NOTIFIED_STATUSES = new Set<ProposalStatus>(['planned', 'in_progress', 'done', 'rejected']);
const ALLOWED_STATUSES = new Set<ProposalStatus>(['pending', 'approved', 'planned', 'in_progress', 'done', 'rejected']);
const RANOBELIB_API_BASE = 'https://api.cdnlibs.org/api';
const RANOBELIB_SITE_ID = '3';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

function localizedStatus(status: ProposalStatus): string {
  switch (status) {
    case 'pending': return '🟡 На рассмотрении';
    case 'approved': return '🟣 Одобрено';
    case 'planned': return '🔵 В плане';
    case 'in_progress': return '🟢 Перевод начат';
    case 'done': return '✅ Готово';
    case 'rejected': return '🔴 Отклонено';
  }
}

function candidateRef(candidate: RanobeLibCandidate): string | null {
  const slugUrl = text(candidate.slug_url);
  if (/^\d+--[a-z0-9][a-z0-9-]*$/i.test(slugUrl)) return slugUrl;
  const slug = text(candidate.slug);
  if (Number.isSafeInteger(candidate.id) && Number(candidate.id) > 0 && slug) return `${candidate.id}--${slug}`;
  return null;
}

function candidateTitle(candidate: RanobeLibCandidate, fallback: string): string {
  return text(candidate.rus_name) || text(candidate.name) || text(candidate.eng_name) || fallback;
}

async function telegramCall(env: TitleProposalAdminEnv, method: string, payload: Record<string, unknown>): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
}

async function sendStatusNotification(
  env: TitleProposalAdminEnv,
  proposal: ProposalStatusRow,
  status: ProposalStatus,
  adminNote: string,
): Promise<void> {
  const lines = ['📚 Статус заявки изменился', '', `«${proposal.title}» → ${localizedStatus(status)}`];
  if (adminNote) lines.push(adminNote);
  await telegramCall(env, 'sendMessage', {
    chat_id: Number(proposal.user_telegram_id),
    text: lines.join('\n'),
    disable_web_page_preview: true,
  });
}

async function handleDetails(request: Request, env: TitleProposalAdminEnv): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const { results } = await env.DB.prepare(`
    SELECT p.id,p.title,p.source_url,p.comment,p.status,p.admin_note,p.created_at,p.updated_at,p.user_telegram_id,
           p.source_kind,p.ranobelib_book_ref,
           u.username,u.first_name,u.last_name,
           COALESCE(d.original_title,'') AS original_title,
           COALESCE(d.extra_url,'') AS extra_url,
           d.raw_upload_id,
           r.original_name AS raw_original_name,
           r.content_type AS raw_content_type,
           r.expected_size AS raw_size,
           r.object_key AS raw_object_key,
           r.status AS raw_status,
           r.completed_at AS raw_completed_at,
           rl.ranobelib_id,
           rl.title AS ranobelib_title,
           rl.url AS ranobelib_url,
           rl.cover_url AS ranobelib_cover_url,
           rl.chapter_count AS ranobelib_chapter_count,
           rl.latest_number AS ranobelib_latest_number,
           rl.latest_name AS ranobelib_latest_name,
           rl.last_synced_at AS ranobelib_last_synced_at,
           (SELECT COUNT(*) FROM proposal_votes v WHERE v.proposal_id=p.id) AS vote_count
    FROM chapter_proposals p
    JOIN users u ON u.telegram_id=p.user_telegram_id
    LEFT JOIN title_proposal_details d ON d.proposal_id=p.id
    LEFT JOIN proposal_raw_uploads r ON r.id=d.raw_upload_id
    LEFT JOIN ranobelib_titles rl ON rl.book_ref=p.ranobelib_book_ref
    WHERE p.proposal_type='title'
    ORDER BY p.created_at DESC
    LIMIT 220
  `).all();
  return json({
    proposals: results.map((row) => ({
      ...row,
      vote_count: Number(row.vote_count || 0),
      raw_size: row.raw_size == null ? null : Number(row.raw_size),
      ranobelib_chapter_count: row.ranobelib_chapter_count == null ? null : Number(row.ranobelib_chapter_count),
    })),
  });
}

async function handleRanobeLibSearch(request: Request, env: TitleProposalAdminEnv): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);

  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body)) return json({ error: 'Invalid JSON body.' }, 400);
  const query = text(body.query);
  if (query.length < 2 || query.length > 180) return json({ error: 'Поисковый запрос должен содержать от 2 до 180 символов.' }, 400);

  const url = new URL(`${RANOBELIB_API_BASE}/manga`);
  url.searchParams.append('site_id[]', RANOBELIB_SITE_ID);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '10');
  let payload: { data?: unknown } | null = null;
  try {
    const response = await fetch(url.toString(), { headers: { accept: 'application/json', 'site-id': RANOBELIB_SITE_ID } });
    payload = await response.json().catch(() => null) as { data?: unknown } | null;
    if (!response.ok) return json({ error: `RanobeLib API HTTP ${response.status}` }, 502);
  } catch (error) {
    console.error('Admin RanobeLib search failed', error);
    return json({ error: 'Не удалось связаться с RanobeLib.' }, 502);
  }

  const candidates: AdminRanobeLibCandidate[] = [];
  for (const raw of Array.isArray(payload?.data) ? payload.data.slice(0, 10) : []) {
    if (!isRecord(raw)) continue;
    const candidate = raw as RanobeLibCandidate;
    const bookRef = candidateRef(candidate);
    const ranobelibId = Number(candidate.id);
    if (!bookRef || !Number.isSafeInteger(ranobelibId) || ranobelibId <= 0) continue;
    const slug = text(candidate.slug) || bookRef.replace(/^\d+--/, '');
    const title = candidateTitle(candidate, bookRef);
    const chapterCount = Math.max(0, Number(candidate.items_count?.uploaded) || 0);
    const bookUrl = `https://ranobelib.me/ru/book/${bookRef}`;
    await env.DB.prepare(`
      INSERT INTO ranobelib_titles (book_ref,ranobelib_id,slug,url,title,chapter_count,is_active,snapshot_ready,last_synced_at)
      VALUES (?,?,?,?,?,?,0,0,CURRENT_TIMESTAMP)
      ON CONFLICT(book_ref) DO UPDATE SET
        ranobelib_id=excluded.ranobelib_id,
        slug=COALESCE(NULLIF(excluded.slug,''),ranobelib_titles.slug),
        url=excluded.url,
        title=COALESCE(NULLIF(excluded.title,''),ranobelib_titles.title),
        chapter_count=MAX(COALESCE(ranobelib_titles.chapter_count,0),COALESCE(excluded.chapter_count,0)),
        last_synced_at=CURRENT_TIMESTAMP
    `).bind(bookRef, ranobelibId, slug, bookUrl, title, chapterCount).run();
    candidates.push({ bookRef, ranobelibId, title, url: bookUrl, chapterCount, slug });
  }

  return json({ candidates: candidates.map(({ slug: _slug, ...candidate }) => candidate) });
}

async function handleStatusUpdate(request: Request, env: TitleProposalAdminEnv, proposalId: string): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);

  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body)) return json({ error: 'Invalid JSON body.' }, 400);
  const status = text(body.status) as ProposalStatus;
  if (!ALLOWED_STATUSES.has(status)) return json({ error: 'Invalid proposal status.' }, 400);
  const adminNote = text(body.adminNote);
  if (adminNote.length > 1500) return json({ error: 'Комментарий администратора слишком большой.' }, 413);

  const existing = await env.DB.prepare(`SELECT id,user_telegram_id,title,status FROM chapter_proposals WHERE id=? LIMIT 1`)
    .bind(proposalId).first<ProposalStatusRow>();
  if (!existing) return json({ error: 'Заявка не найдена.' }, 404);
  const previousStatus = existing.status;

  await env.DB.prepare(`UPDATE chapter_proposals SET status=?,admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(status, adminNote, proposalId).run();

  let notificationSent = false;
  if (previousStatus !== status && NOTIFIED_STATUSES.has(status)) {
    try {
      await sendStatusNotification(env, existing, status, adminNote);
      notificationSent = true;
    } catch (error) {
      console.error('Proposal status Telegram notification failed', {
        proposalId,
        userTelegramId: existing.user_telegram_id,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return json({ ok: true, id: proposalId, status, notificationSent });
}

async function handleRanobeLibLink(request: Request, env: TitleProposalAdminEnv, proposalId: string): Promise<Response> {
  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);

  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body)) return json({ error: 'Invalid JSON body.' }, 400);
  const bookRef = text(body.bookRef);
  if (!bookRef || bookRef.length > 240) return json({ error: 'Некорректный RanobeLib book_ref.' }, 400);

  const proposal = await env.DB.prepare(`
    SELECT id,proposal_type,source_kind,ranobelib_book_ref,title,status
    FROM chapter_proposals WHERE id=? LIMIT 1
  `).bind(proposalId).first<ProposalLinkRow>();
  if (!proposal || proposal.proposal_type !== 'title') return json({ error: 'Заявка не найдена.' }, 404);

  const ranobelib = await env.DB.prepare(`
    SELECT book_ref,ranobelib_id,title,url FROM ranobelib_titles WHERE book_ref=? LIMIT 1
  `).bind(bookRef).first<RanobeLibLinkRow>();
  if (!ranobelib) return json({ error: 'Карточка RanobeLib не найдена в синхронизированном каталоге.' }, 404);

  if (proposal.source_kind === 'ranobelib' && proposal.ranobelib_book_ref === bookRef) {
    return json({ ok: true, id: proposalId, bookRef, ranobelib });
  }

  const conflict = await env.DB.prepare(`
    SELECT id,status FROM chapter_proposals
    WHERE proposal_type='title' AND ranobelib_book_ref=? AND id<>?
      AND status IN ('pending','approved','planned','in_progress')
    ORDER BY created_at DESC LIMIT 1
  `).bind(bookRef, proposalId).first<ProposalConflictRow>();
  if (conflict) {
    return json({
      error: 'Этот тайтл уже связан с другой активной заявкой.',
      conflictId: conflict.id,
      conflictStatus: conflict.status,
    }, 409);
  }

  await env.DB.prepare(`
    UPDATE chapter_proposals SET source_kind='ranobelib',ranobelib_book_ref=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).bind(bookRef, proposalId).run();
  return json({ ok: true, id: proposalId, bookRef, ranobelib });
}

export async function handleTitleProposalAdminApi(request: Request, env: TitleProposalAdminEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/admin/title-proposal-details') return handleDetails(request, env);
  if (request.method === 'POST' && url.pathname === '/api/admin/title-proposals/ranobelib-search') {
    return handleRanobeLibSearch(request, env);
  }

  const linkMatch = url.pathname.match(/^\/api\/admin\/title-proposals\/([^/]+)\/link-ranobelib$/);
  const linkProposalId = linkMatch?.[1];
  if (request.method === 'POST' && linkProposalId) return handleRanobeLibLink(request, env, decodeURIComponent(linkProposalId));

  const statusMatch = url.pathname.match(/^\/api\/admin\/proposals\/([^/]+)\/status$/);
  const proposalId = statusMatch?.[1];
  if (request.method === 'POST' && proposalId) return handleStatusUpdate(request, env, decodeURIComponent(proposalId));

  return null;
}
