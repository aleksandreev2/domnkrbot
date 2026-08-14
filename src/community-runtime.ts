type D1Row = Record<string, unknown>;
type D1AllResult<T> = { results: T[] };

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<D1AllResult<T>>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface CommunityEnv {
  DB: D1DatabaseLike;
  TELEGRAM_BOT_TOKEN?: string;
  ADMIN_TELEGRAM_IDS?: string;
}

type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

type CommunityProposalRow = {
  id: string;
  user_telegram_id: string;
  proposal_type: string;
  title: string;
  source_url: string;
  chapter_from: number | null;
  chapter_to: number | null;
  comment: string;
  status: string;
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

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

let schemaPromise: Promise<void> | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: ArrayBuffer, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
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
    const parsed = JSON.parse(rawUser) as Record<string, unknown>;
    if (!parsed || typeof parsed.id !== 'number' || typeof parsed.first_name !== 'string') return null;
    return {
      id: parsed.id,
      first_name: parsed.first_name,
      last_name: typeof parsed.last_name === 'string' ? parsed.last_name : undefined,
      username: typeof parsed.username === 'string' ? parsed.username : undefined,
      language_code: typeof parsed.language_code === 'string' ? parsed.language_code : undefined,
    };
  } catch {
    return null;
  }
}

function adminIds(env: CommunityEnv): Set<string> {
  return new Set(
    String(env.ADMIN_TELEGRAM_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function isAdmin(env: CommunityEnv, telegramId: number): boolean {
  return adminIds(env).has(String(telegramId));
}

async function optionalUser(request: Request, env: CommunityEnv): Promise<TelegramUser | null> {
  return verifyMiniAppUser(
    request.headers.get('x-telegram-init-data') ?? '',
    env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
  );
}

async function upsertUser(env: CommunityEnv, user: TelegramUser): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, language_code, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      language_code = excluded.language_code,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    String(user.id),
    user.username ?? null,
    user.first_name,
    user.last_name ?? '',
    user.language_code ?? null,
  ).run();
}

export async function ensureCommunitySchema(env: CommunityEnv): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = initializeSchema(env).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function initializeSchema(env: CommunityEnv): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      language_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS chapter_proposals (
      id TEXT PRIMARY KEY,
      user_telegram_id TEXT NOT NULL,
      proposal_type TEXT NOT NULL,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      chapter_from REAL,
      chapter_to REAL,
      comment TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS proposal_votes (
      proposal_id TEXT NOT NULL,
      user_telegram_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (proposal_id, user_telegram_id),
      FOREIGN KEY (proposal_id) REFERENCES chapter_proposals(id) ON DELETE CASCADE,
      FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`,
    'CREATE INDEX IF NOT EXISTS idx_proposal_votes_proposal ON proposal_votes(proposal_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_proposal_votes_user ON proposal_votes(user_telegram_id, created_at DESC)',
  ];
  for (const statement of statements) await env.DB.prepare(statement).run();
}

function normalizeProposal(row: CommunityProposalRow) {
  return {
    ...row,
    vote_count: Number(row.vote_count || 0),
    viewer_voted: Number(row.viewer_voted || 0) === 1,
    is_owner: Number(row.is_owner || 0) === 1,
  };
}

async function listCommunityProposals(
  env: CommunityEnv,
  viewer: TelegramUser | null,
  options: { includeRejected?: boolean; limit?: number } = {},
) {
  const viewerId = viewer ? String(viewer.id) : '';
  const where = options.includeRejected ? '' : "WHERE p.status != 'rejected'";
  const limit = Math.max(1, Math.min(options.limit ?? 120, 300));
  const { results } = await env.DB.prepare(`
    SELECT
      p.id, p.user_telegram_id, p.proposal_type, p.title, p.source_url,
      p.chapter_from, p.chapter_to, p.comment, p.status, p.admin_note,
      p.created_at, p.updated_at,
      u.username, u.first_name, u.last_name,
      COUNT(v.user_telegram_id) AS vote_count,
      MAX(CASE WHEN v.user_telegram_id = ? THEN 1 ELSE 0 END) AS viewer_voted,
      CASE WHEN p.user_telegram_id = ? THEN 1 ELSE 0 END AS is_owner
    FROM chapter_proposals p
    JOIN users u ON u.telegram_id = p.user_telegram_id
    LEFT JOIN proposal_votes v ON v.proposal_id = p.id
    ${where}
    GROUP BY p.id
    ORDER BY
      CASE p.status
        WHEN 'in_progress' THEN 0
        WHEN 'planned' THEN 1
        WHEN 'approved' THEN 2
        WHEN 'pending' THEN 3
        WHEN 'done' THEN 4
        ELSE 5
      END,
      vote_count DESC,
      p.created_at DESC
    LIMIT ?
  `).bind(viewerId, viewerId, limit).all<CommunityProposalRow>();
  return results.map(normalizeProposal);
}

async function communityStats(env: CommunityEnv) {
  const [proposalRow, voteRow] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(*) AS proposals,
        SUM(CASE WHEN status IN ('pending','approved','planned','in_progress') THEN 1 ELSE 0 END) AS active
      FROM chapter_proposals
      WHERE status != 'rejected'
    `).first<{ proposals: number | string; active: number | string }>(),
    env.DB.prepare(`
      SELECT COUNT(*) AS votes, COUNT(DISTINCT user_telegram_id) AS voters
      FROM proposal_votes
    `).first<{ votes: number | string; voters: number | string }>(),
  ]);
  return {
    proposals: Number(proposalRow?.proposals || 0),
    active: Number(proposalRow?.active || 0),
    votes: Number(voteRow?.votes || 0),
    voters: Number(voteRow?.voters || 0),
  };
}

async function handleFeed(request: Request, env: CommunityEnv): Promise<Response> {
  const viewer = await optionalUser(request, env);
  if (viewer) await upsertUser(env, viewer);
  const [proposals, stats] = await Promise.all([
    listCommunityProposals(env, viewer),
    communityStats(env),
  ]);
  return json({
    user: viewer ? {
      id: viewer.id,
      firstName: viewer.first_name,
      lastName: viewer.last_name ?? '',
      username: viewer.username ?? null,
    } : null,
    isAdmin: viewer ? isAdmin(env, viewer.id) : false,
    proposals,
    stats,
  });
}

async function handleVote(request: Request, env: CommunityEnv, proposalId: string): Promise<Response> {
  const user = await optionalUser(request, env);
  if (!user) return json({ error: 'Откройте Mini App через Telegram, чтобы голосовать.' }, 401);
  await upsertUser(env, user);

  const proposal = await env.DB.prepare(`
    SELECT id, user_telegram_id, status
    FROM chapter_proposals
    WHERE id = ?
  `).bind(proposalId).first<{ id: string; user_telegram_id: string; status: string }>();
  if (!proposal) return json({ error: 'Заявка не найдена.' }, 404);
  if (proposal.user_telegram_id === String(user.id)) {
    return json({ error: 'Автор заявки уже считается её сторонником.' }, 409);
  }
  if (proposal.status === 'rejected' || proposal.status === 'done') {
    return json({ error: 'Голосование по этой заявке уже закрыто.' }, 409);
  }

  const existing = await env.DB.prepare(`
    SELECT proposal_id FROM proposal_votes
    WHERE proposal_id = ? AND user_telegram_id = ?
  `).bind(proposalId, String(user.id)).first<{ proposal_id: string }>();

  let voted: boolean;
  if (existing) {
    await env.DB.prepare('DELETE FROM proposal_votes WHERE proposal_id = ? AND user_telegram_id = ?')
      .bind(proposalId, String(user.id)).run();
    voted = false;
  } else {
    await env.DB.prepare(`
      INSERT INTO proposal_votes (proposal_id, user_telegram_id)
      VALUES (?, ?)
    `).bind(proposalId, String(user.id)).run();
    voted = true;
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS count FROM proposal_votes WHERE proposal_id = ?')
    .bind(proposalId).first<{ count: number | string }>();
  return json({ ok: true, id: proposalId, voted, voteCount: Number(countRow?.count || 0) });
}

async function getSetting(env: CommunityEnv, key: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?')
      .bind(key).first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function handleAdminDashboard(request: Request, env: CommunityEnv): Promise<Response> {
  const admin = await authorizeAdminRequest(request, env);
  if (!admin) return json({ error: 'Admin access required.' }, 403);
  await upsertUser(env, admin);

  const [statusRow, voteRow, userRow, ranobeRow, releaseRow, proposals, lastSyncAt, lastSyncError] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN status = 'planned' THEN 1 ELSE 0 END) AS planned,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM chapter_proposals
    `).first<Record<string, number | string>>(),
    env.DB.prepare(`
      SELECT COUNT(*) AS votes, COUNT(DISTINCT user_telegram_id) AS voters
      FROM proposal_votes
    `).first<{ votes: number | string; voters: number | string }>(),
    env.DB.prepare('SELECT COUNT(*) AS users FROM users').first<{ users: number | string }>(),
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_titles,
        SUM(CASE WHEN is_active = 1 AND snapshot_ready = 1 THEN 1 ELSE 0 END) AS synced_titles
      FROM ranobelib_titles
    `).first<{ active_titles: number | string; synced_titles: number | string }>().catch(() => null),
    env.DB.prepare('SELECT COUNT(*) AS releases FROM ranobelib_releases')
      .first<{ releases: number | string }>().catch(() => null),
    listCommunityProposals(env, admin, { includeRejected: true, limit: 220 }),
    getSetting(env, 'ranobelib_last_sync_at'),
    getSetting(env, 'ranobelib_last_sync_error'),
  ]);

  const numberValue = (value: unknown) => Number(value || 0);
  return json({
    summary: {
      proposals: {
        total: numberValue(statusRow?.total),
        pending: numberValue(statusRow?.pending),
        approved: numberValue(statusRow?.approved),
        planned: numberValue(statusRow?.planned),
        inProgress: numberValue(statusRow?.in_progress),
        done: numberValue(statusRow?.done),
        rejected: numberValue(statusRow?.rejected),
      },
      votes: numberValue(voteRow?.votes),
      voters: numberValue(voteRow?.voters),
      users: numberValue(userRow?.users),
      ranobelib: {
        activeTitles: numberValue(ranobeRow?.active_titles),
        syncedTitles: numberValue(ranobeRow?.synced_titles),
        releases: numberValue(releaseRow?.releases),
        lastSyncAt,
        lastError: lastSyncError || null,
      },
    },
    proposals,
  });
}

export async function authorizeAdminRequest(
  request: Request,
  env: CommunityEnv,
): Promise<TelegramUser | null> {
  const user = await optionalUser(request, env);
  return user && isAdmin(env, user.id) ? user : null;
}

export async function handleCommunityApi(
  request: Request,
  env: CommunityEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/community')) return null;
  await ensureCommunitySchema(env);

  if (url.pathname === '/api/community' && request.method === 'GET') {
    return handleFeed(request, env);
  }
  if (url.pathname === '/api/community/admin' && request.method === 'GET') {
    return handleAdminDashboard(request, env);
  }

  const voteMatch = url.pathname.match(/^\/api\/community\/proposals\/([^/]+)\/vote$/);
  if (voteMatch?.[1] && request.method === 'POST') {
    return handleVote(request, env, decodeURIComponent(voteMatch[1]));
  }

  if (url.pathname === '/api/community/admin/ranobelib/sync') return null;
  return json({ error: 'Not found' }, 404);
}
