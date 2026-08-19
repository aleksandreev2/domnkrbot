export type WebTelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export interface WebAuthEnv {
  TELEGRAM_BOT_TOKEN?: string;
  ADMIN_TELEGRAM_IDS?: string;
  BOT_USERNAME?: string;
}

type SessionPayload = WebTelegramUser & {
  v: 1;
  exp: number;
};

const COOKIE_NAME = '__Host-domnkr_session';
const LOGIN_MAX_AGE_SECONDS = 15 * 60;
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function adminIds(env: WebAuthEnv): Set<string> {
  return new Set(
    String(env.ADMIN_TELEGRAM_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isAdminUser(env: WebAuthEnv, user: Pick<WebTelegramUser, 'id'> | null): boolean {
  return Boolean(user && adminIds(env).has(String(user.id)));
}

export function firstAdminId(env: WebAuthEnv): number | null {
  for (const value of adminIds(env)) {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  return null;
}

async function verifyTelegramLogin(url: URL, env: WebAuthEnv): Promise<WebTelegramUser | null> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;

  const expectedHash = (url.searchParams.get('hash') ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return null;

  const fields = Array.from(url.searchParams.entries())
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left.localeCompare(right));
  const dataCheckString = fields.map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = await sha256(token);
  const calculated = bytesToHex(new Uint8Array(await hmac(secret, dataCheckString)));
  if (!constantTimeEqual(calculated, expectedHash)) return null;

  const authDate = Number(url.searchParams.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate <= 0 || Math.abs(now - authDate) > LOGIN_MAX_AGE_SECONDS) return null;

  const id = Number(url.searchParams.get('id'));
  const firstName = (url.searchParams.get('first_name') ?? '').trim();
  if (!Number.isSafeInteger(id) || id <= 0 || !firstName) return null;

  return {
    id,
    first_name: firstName.slice(0, 128),
    last_name: (url.searchParams.get('last_name') ?? '').trim().slice(0, 128) || undefined,
    username: (url.searchParams.get('username') ?? '').trim().slice(0, 64) || undefined,
  };
}

async function sessionKey(env: WebAuthEnv): Promise<ArrayBuffer> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return sha256(`domnkrbot:web-session:v1\n${token}`);
}

async function createSession(user: WebTelegramUser, env: WebAuthEnv): Promise<string> {
  const payload: SessionPayload = {
    v: 1,
    id: user.id,
    first_name: user.first_name,
    last_name: user.last_name,
    username: user.username,
    language_code: user.language_code,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(new Uint8Array(await hmac(await sessionKey(env), body)));
  return `${body}.${signature}`;
}

function cookieValue(request: Request): string {
  const raw = request.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=');
  }
  return '';
}

export async function getSessionUser(request: Request, env: WebAuthEnv): Promise<WebTelegramUser | null> {
  const value = cookieValue(request);
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra) return null;

  const expected = base64UrlEncode(new Uint8Array(await hmac(await sessionKey(env), body)));
  if (!constantTimeEqual(expected, signature)) return null;

  const bytes = base64UrlDecode(body);
  if (!bytes) return null;
  try {
    const payload = JSON.parse(decoder.decode(bytes)) as Partial<SessionPayload>;
    if (payload.v !== 1 || !Number.isSafeInteger(payload.id) || Number(payload.id) <= 0) return null;
    if (typeof payload.first_name !== 'string' || !payload.first_name) return null;
    if (!Number.isFinite(payload.exp) || Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null;
    return {
      id: Number(payload.id),
      first_name: payload.first_name,
      last_name: typeof payload.last_name === 'string' ? payload.last_name : undefined,
      username: typeof payload.username === 'string' ? payload.username : undefined,
      language_code: typeof payload.language_code === 'string' ? payload.language_code : undefined,
    };
  } catch {
    return null;
  }
}

export function isSameOriginMutation(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return true;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}

export async function requireAdminSession(request: Request, env: WebAuthEnv): Promise<WebTelegramUser | Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Authentication required.' }, 401);
  if (!isAdminUser(env, user)) return json({ error: 'Admin access required.' }, 403);
  if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
  return user;
}

export async function handleWebAuth(request: Request, env: WebAuthEnv): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/api/auth/session') {
    const user = await getSessionUser(request, env);
    return json({
      user: user ? {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name ?? '',
        username: user.username ?? null,
      } : null,
      isAdmin: isAdminUser(env, user),
      botUsername: env.BOT_USERNAME?.replace(/^@/, '') || null,
    });
  }

  if (request.method === 'GET' && url.pathname === '/auth/telegram/callback') {
    const user = await verifyTelegramLogin(url, env);
    if (!user) {
      return new Response('Telegram authentication failed.', {
        status: 401,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const session = await createSession(user, env);
    const target = isAdminUser(env, user) ? '/admin/' : '/';
    return new Response(null, {
      status: 303,
      headers: {
        location: target,
        'cache-control': 'no-store',
        'set-cookie': `${COOKIE_NAME}=${session}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  if (request.method === 'POST' && url.pathname === '/auth/logout') {
    if (!isSameOriginMutation(request)) return json({ error: 'Cross-origin request rejected.' }, 403);
    return json({ ok: true }, 200, {
      'set-cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  return null;
}
