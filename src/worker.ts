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
interface Env {
  DB: D1DatabaseLike;
  ASSETS: AssetFetcher;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_TELEGRAM_IDS?: string;
}

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};
type TelegramMessage = { message_id: number; chat: { id: number; type: string }; from?: TelegramUser; text?: string };
type TelegramUpdate = { update_id: number; message?: TelegramMessage };
type ProposalStatus = 'pending' | 'approved' | 'planned' | 'in_progress' | 'done' | 'rejected';
type ProposalType = 'title' | 'chapters';
type PublicProposal = {
  id: string;
  proposal_type: ProposalType;
  title: string;
  source_url: string;
  chapter_from: number | null;
  chapter_to: number | null;
  comment: string;
  status: ProposalStatus;
  created_at: string;
  username: string | null;
  first_name: string;
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

function isAdmin(env: Env, telegramId: number): boolean {
  return String(env.ADMIN_TELEGRAM_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean).includes(String(telegramId));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: ArrayBuffer, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value));
}

async function verifyMiniAppUser(initData: string, botToken: string): Promise<TelegramUser | null> {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const expectedHash = params.get('hash')?.toLowerCase() ?? '';
  if (!expectedHash) return null;
  params.delete('hash');

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const webAppDataKey = new TextEncoder().encode('WebAppData').buffer;
  const secretKey = await hmacSha256(webAppDataKey, botToken);
  const calculatedHash = bytesToHex(new Uint8Array(await hmacSha256(secretKey, dataCheckString)));
  if (calculatedHash !== expectedHash) return null;

  const authDate = Number(params.get('auth_date'));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate <= 0 || Math.abs(nowSeconds - authDate) > 86_400) return null;

  const rawUser = params.get('user');
  if (!rawUser) return null;
  try {
    const parsed = JSON.parse(rawUser) as unknown;
    if (!isRecord(parsed) || typeof parsed.id !== 'number' || typeof parsed.first_name !== 'string') return null;
    return {
      id: parsed.id,
      is_bot: typeof parsed.is_bot === 'boolean' ? parsed.is_bot : undefined,
      first_name: parsed.first_name,
      last_name: typeof parsed.last_name === 'string' ? parsed.last_name : undefined,
      username: typeof parsed.username === 'string' ? parsed.username : undefined,
      language_code: typeof parsed.language_code === 'string' ? parsed.language_code : undefined,
    };
  } catch {
    return null;
  }
}

async function optionalRequestUser(request: Request, env: Env): Promise<TelegramUser | null> {
  return verifyMiniAppUser(request.headers.get('x-telegram-init-data') ?? '', env.TELEGRAM_BOT_TOKEN ?? '');
}
async function requireRequestUser(request: Request, env: Env): Promise<TelegramUser | Response> {
  return (await optionalRequestUser(request, env)) ?? json({ error: 'Open this Mini App through @domnekromanta_bot to continue.' }, 401);
}

async function upsertUser(env: Env, user: TelegramUser): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, language_code, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
      last_name = excluded.last_name, language_code = excluded.language_code, updated_at = CURRENT_TIMESTAMP
  `).bind(String(user.id), user.username ?? null, user.first_name, user.last_name ?? '', user.language_code ?? null).run();
}

async function listPublicProposals(env: Env, limit = 40): Promise<PublicProposal[]> {
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.proposal_type, p.title, p.source_url, p.chapter_from, p.chapter_to, p.comment,
           p.status, p.created_at, u.username, u.first_name
    FROM chapter_proposals p JOIN users u ON u.telegram_id = p.user_telegram_id
    WHERE p.status != 'rejected'
    ORDER BY CASE p.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 WHEN 'approved' THEN 2
      WHEN 'pending' THEN 3 WHEN 'done' THEN 4 ELSE 5 END, p.created_at DESC
    LIMIT ?
  `).bind(limit).all<PublicProposal>();
  return results;
}

async function handleBootstrap(request: Request, env: Env): Promise<Response> {
  const user = await optionalRequestUser(request, env);
  if (user) await upsertUser(env, user);
  return json({
    user: user ? { id: user.id, firstName: user.first_name, lastName: user.last_name ?? '', username: user.username ?? null, languageCode: user.language_code ?? null } : null,
    isAdmin: user ? isAdmin(env, user.id) : false,
    proposals: await listPublicProposals(env, 24),
  });
}

async function handleCreateProposal(request: Request, env: Env): Promise<Response> {
  const auth = await requireRequestUser(request, env);
  if (auth instanceof Response) return auth;
  await upsertUser(env, auth);

  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body)) return json({ error: 'Invalid JSON body.' }, 400);
  const proposalType = stringValue(body.proposalType) as ProposalType;
  if (proposalType !== 'title' && proposalType !== 'chapters') return json({ error: 'Choose title or chapters.' }, 400);

  const title = stringValue(body.title);
  const sourceUrl = stringValue(body.sourceUrl);
  const comment = stringValue(body.comment);
  if (title.length < 2 || title.length > 180) return json({ error: 'Title must be between 2 and 180 characters.' }, 400);
  if (sourceUrl.length > 500 || comment.length > 1500) return json({ error: 'Proposal is too large.' }, 413);
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) return json({ error: 'Source link must start with http:// or https://.' }, 400);

  let chapterFrom: number | null = null;
  let chapterTo: number | null = null;
  if (proposalType === 'chapters') {
    chapterFrom = finiteNumber(body.chapterFrom);
    chapterTo = finiteNumber(body.chapterTo);
    if (chapterFrom === null || chapterTo === null || chapterFrom < 0 || chapterTo < chapterFrom || chapterTo - chapterFrom > 1000) {
      return json({ error: 'Enter a valid chapter range.' }, 400);
    }
  }

  const duplicate = await env.DB.prepare(`
    SELECT id FROM chapter_proposals WHERE user_telegram_id = ? AND proposal_type = ? AND lower(title) = lower(?)
      AND COALESCE(chapter_from, -1) = COALESCE(?, -1) AND COALESCE(chapter_to, -1) = COALESCE(?, -1)
      AND status IN ('pending', 'approved', 'planned', 'in_progress') LIMIT 1
  `).bind(String(auth.id), proposalType, title, chapterFrom, chapterTo).first<{ id: string }>();
  if (duplicate) return json({ error: 'You already have an active proposal for this title/chapter range.', id: duplicate.id }, 409);

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO chapter_proposals (id, user_telegram_id, proposal_type, title, source_url, chapter_from, chapter_to, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, String(auth.id), proposalType, title, sourceUrl, chapterFrom, chapterTo, comment).run();
  return json({ id, status: 'pending' }, 201);
}

async function handleMyProposals(request: Request, env: Env): Promise<Response> {
  const auth = await requireRequestUser(request, env);
  if (auth instanceof Response) return auth;
  await upsertUser(env, auth);
  const { results } = await env.DB.prepare(`
    SELECT id, proposal_type, title, source_url, chapter_from, chapter_to, comment, status, admin_note, created_at, updated_at
    FROM chapter_proposals WHERE user_telegram_id = ? ORDER BY created_at DESC LIMIT 100
  `).bind(String(auth.id)).all();
  return json({ proposals: results });
}

async function requireAdmin(request: Request, env: Env): Promise<TelegramUser | Response> {
  const auth = await requireRequestUser(request, env);
  if (auth instanceof Response) return auth;
  if (!isAdmin(env, auth.id)) return json({ error: 'Admin access required.' }, 403);
  await upsertUser(env, auth);
  return auth;
}

async function handleAdminProposals(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.proposal_type, p.title, p.source_url, p.chapter_from, p.chapter_to, p.comment, p.status,
           p.admin_note, p.created_at, p.updated_at, u.telegram_id, u.username, u.first_name, u.last_name
    FROM chapter_proposals p JOIN users u ON u.telegram_id = p.user_telegram_id
    ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END, p.created_at DESC LIMIT 200
  `).all();
  return json({ proposals: results });
}

async function handleAdminStatus(request: Request, env: Env, proposalId: string): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body)) return json({ error: 'Invalid JSON body.' }, 400);

  const status = stringValue(body.status) as ProposalStatus;
  const allowed = new Set<ProposalStatus>(['pending', 'approved', 'planned', 'in_progress', 'done', 'rejected']);
  if (!allowed.has(status)) return json({ error: 'Invalid proposal status.' }, 400);
  const adminNote = stringValue(body.adminNote);
  if (adminNote.length > 1500) return json({ error: 'Admin note is too large.' }, 413);
  if (!await env.DB.prepare('SELECT id FROM chapter_proposals WHERE id = ?').bind(proposalId).first<{ id: string }>()) {
    return json({ error: 'Proposal not found.' }, 404);
  }
  await env.DB.prepare('UPDATE chapter_proposals SET status = ?, admin_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(status, adminNote, proposalId).run();
  return json({ ok: true, id: proposalId, status });
}

async function telegramCall(env: Env, method: string, payload: Record<string, unknown>): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
}

async function sendAppButton(env: Env, chatId: number, origin: string, text: string): Promise<void> {
  await telegramCall(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '☠️ Открыть Дом Некроманта', web_app: { url: origin } }]] },
  });
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const expected = env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (!expected || request.headers.get('x-telegram-bot-api-secret-token') !== expected) return json({ error: 'Forbidden' }, 403);
  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  const message = update?.message;
  if (!message?.chat?.id || message.chat.type !== 'private') return json({ ok: true });

  const text = (message.text ?? '').trim();
  const origin = new URL(request.url).origin;
  if (text.startsWith('/help')) {
    await sendAppButton(env, message.chat.id, origin, 'Основные функции находятся в Mini App. Там можно предложить новый тайтл или конкретные главы.');
  } else if (text.startsWith('/start') || text.startsWith('/app') || text.startsWith('/propose')) {
    await sendAppButton(env, message.chat.id, origin, '<b>Дом Некроманта</b>\n\nПереводы, новые главы и предложения сообщества — в одном приложении.');
  } else {
    await sendAppButton(env, message.chat.id, origin, 'Откройте Mini App, чтобы пользоваться «Домом Некроманта».');
  }
  return json({ ok: true });
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'domnkrbot', time: new Date().toISOString() });
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') return handleBootstrap(request, env);
  if (request.method === 'GET' && url.pathname === '/api/proposals') return json({ proposals: await listPublicProposals(env) });
  if (request.method === 'POST' && url.pathname === '/api/proposals') return handleCreateProposal(request, env);
  if (request.method === 'GET' && url.pathname === '/api/me/proposals') return handleMyProposals(request, env);
  if (request.method === 'GET' && url.pathname === '/api/admin/proposals') return handleAdminProposals(request, env);

  const statusMatch = url.pathname.match(/^\/api\/admin\/proposals\/([^/]+)\/status$/);
  if (request.method === 'POST' && statusMatch?.[1]) return handleAdminStatus(request, env, decodeURIComponent(statusMatch[1]));
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/telegram/webhook' && request.method === 'POST') return await handleTelegramWebhook(request, env);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('Unhandled request error', error);
      return json({ error: 'Internal server error' }, 500);
    }
  },
};
