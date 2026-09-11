import { RanobeLibAuthProvider, type RanobeLibAuthEnv, type RanobeLibAuthHealth } from './ranobelib-auth.js';
import type { TelegramSubscriptionUpdate } from './telegram-subscriptions.js';

export type TelegramRanobeLibAuthEnv = RanobeLibAuthEnv & {
  ADMIN_TELEGRAM_IDS?: string;
};

type OAuthOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
};

type OAuthStatePayload = {
  v: 1;
  uid: string;
  exp: number;
  nonce: string;
};

type TelegramResponse<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
};

const AUTHORIZE_URL = 'https://auth.lib.social/auth/oauth/authorize';
const TOKEN_URL = 'https://api.cdnlibs.org/api/auth/oauth/token';
const REDIRECT_URI = 'https://ranobelib.me/ru/front/auth/oauth/callback';
const STATE_TTL_MS = 15 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createRanobeLibAuthorizationRequest(
  env: TelegramRanobeLibAuthEnv,
  userId: string,
  options: OAuthOptions = {},
): Promise<{ authorizeUrl: string; state: string }> {
  const uid = requiredUserId(userId);
  const now = options.now?.() ?? new Date();
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  const nonce = base64UrlEncode(randomBytes(24));
  const payload: OAuthStatePayload = {
    v: 1,
    uid,
    exp: now.getTime() + STATE_TTL_MS,
    nonce,
  };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await signWithBotSecret(env, 'domnkrbot:ranobelib-oauth-state:v1', body));
  const state = `${body}.${signature}`;
  const verifier = await codeVerifier(env, nonce);
  const challenge = base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('scope', '');
  url.searchParams.set('client_id', '1');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'consent');
  return { authorizeUrl: url.toString(), state };
}

export async function completeRanobeLibAuthorizationFromCallback(
  env: TelegramRanobeLibAuthEnv,
  userId: string,
  callbackUrl: string,
  options: OAuthOptions = {},
): Promise<RanobeLibAuthHealth> {
  const uid = requiredUserId(userId);
  const now = options.now?.() ?? new Date();
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const callback = parseOfficialCallback(callbackUrl);
  const code = callback.searchParams.get('code')?.trim() ?? '';
  const state = callback.searchParams.get('state')?.trim() ?? '';
  if (!code || !state) throw new Error('RanobeLib OAuth callback is missing code or state.');

  const payload = await verifyState(env, uid, state, now);
  const verifier = await codeVerifier(env, payload.nonce);
  const tokenResponse = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: 1,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      code,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`RanobeLib OAuth token exchange failed: ${tokenResponse.status}`);

  const tokenBody = await tokenResponse.json().catch(() => null) as Record<string, unknown> | null;
  const accessToken = stringValue(tokenBody?.access_token);
  const refreshToken = stringValue(tokenBody?.refresh_token);
  const expiresIn = Number(tokenBody?.expires_in);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('RanobeLib OAuth returned an invalid token bundle.');
  }

  const auth = new RanobeLibAuthProvider(env, { fetchImpl, now: () => now });
  await auth.validateAndStore({
    accessToken,
    refreshToken,
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
  });
  await wakeRanobeLibTitles(env);
  return auth.health();
}

export async function importRanobeLibTokenBundle(
  env: TelegramRanobeLibAuthEnv,
  input: unknown,
  options: OAuthOptions = {},
): Promise<RanobeLibAuthHealth> {
  const now = options.now?.() ?? new Date();
  const fetchImpl = options.fetchImpl ?? ((request, init) => fetch(request, init));
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('RanobeLib token bundle is invalid.');
  }

  const payload = input as Record<string, unknown>;
  const accessToken = stringValue(payload.access_token);
  const refreshToken = stringValue(payload.refresh_token);
  const expiresIn = Number(payload.expires_in);
  const timestamp = Number(payload.timestamp);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('RanobeLib token bundle is invalid.');
  }

  const baseTime = Number.isFinite(timestamp) && timestamp > 0
    ? normalizeTimestampMilliseconds(timestamp)
    : now.getTime();
  const expiresAt = new Date(baseTime + expiresIn * 1000);
  if (Number.isNaN(expiresAt.getTime())) throw new Error('RanobeLib token bundle is invalid.');

  const auth = new RanobeLibAuthProvider(env, { fetchImpl, now: () => now });
  await auth.validateAndStore({
    accessToken,
    refreshToken,
    expiresAt: expiresAt.toISOString(),
  });
  await wakeRanobeLibTitles(env);
  return auth.health();
}

export async function handleTelegramRanobeLibAuthWebhook(
  request: Request,
  env: TelegramRanobeLibAuthEnv,
  options: OAuthOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;

  const update = await request.clone().json().catch(() => null) as TelegramSubscriptionUpdate | null;
  const message = update?.message;
  const user = message?.from;
  const text = message?.text?.trim() ?? '';
  const chatId = message?.chat?.id;
  if (!message || !user || !chatId || message.chat.type !== 'private') return null;

  const command = /^\/ranobelib_auth(?:@[A-Za-z0-9_]+)?$/i.test(text);
  const importMatch = /^\/ranobelib_import(?:@[A-Za-z0-9_]+)?\s+([\s\S]+)$/i.exec(text);
  const callback = isRanobeLibOAuthCallbackText(text);
  if (!command && !importMatch && !callback) return null;
  if (!isAdmin(env, user.id)) return new Response('ok');

  if (command) {
    try {
      const authorization = await createRanobeLibAuthorizationRequest(env, String(user.id), options);
      await sendTelegramMessage(env, chatId, {
        text: [
          '🔐 <b>Авторизация RanobeLib</b>',
          '',
          '1. Нажмите «Войти в RanobeLib» и авторизуйтесь.',
          '2. После возврата на RanobeLib скопируйте адрес страницы целиком и пришлите его сюда.',
          '',
          'Ссылка действует 15 минут.',
        ].join('\n'),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: 'Войти в RanobeLib', url: authorization.authorizeUrl }]],
        },
      }, options.fetchImpl);
    } catch (error) {
      console.error('RanobeLib OAuth start failed', safeOAuthError(error));
      await sendTelegramMessage(env, chatId, {
        text: '❌ Не удалось начать авторизацию RanobeLib. Попробуйте /ranobelib_auth ещё раз.',
      }, options.fetchImpl).catch(() => undefined);
    }
    return new Response('ok');
  }

  if (importMatch) {
    try {
      const bundle = JSON.parse(importMatch[1]!) as unknown;
      await importRanobeLibTokenBundle(env, bundle, options);
      await sendTelegramMessage(env, chatId, {
        text: '✅ RanobeLib-токены импортированы и проверены. Скрытые тайтлы поставлены на немедленное сканирование.',
      }, options.fetchImpl);
    } catch (error) {
      console.error('RanobeLib token import failed', safeOAuthError(error));
      await sendTelegramMessage(env, chatId, {
        text: '❌ Не удалось импортировать RanobeLib-токены. Проверьте JSON bundle и отправьте команду ещё раз.',
      }, options.fetchImpl).catch(() => undefined);
    }
    return new Response('ok');
  }

  try {
    await completeRanobeLibAuthorizationFromCallback(env, String(user.id), text, options);
    await sendTelegramMessage(env, chatId, {
      text: '✅ RanobeLib авторизован. Скрытые тайтлы поставлены на немедленное сканирование.',
    }, options.fetchImpl);
  } catch (error) {
    console.error('RanobeLib OAuth completion failed', safeOAuthError(error));
    await sendTelegramMessage(env, chatId, {
      text: '❌ Авторизация RanobeLib не завершилась. Запустите /ranobelib_auth ещё раз и пришлите новый callback URL.',
    }, options.fetchImpl).catch(() => undefined);
  }
  return new Response('ok');
}

export function isRanobeLibOAuthCallbackText(value: string): boolean {
  try {
    const url = parseOfficialCallback(value);
    return Boolean(url.searchParams.get('code')?.trim() && url.searchParams.get('state')?.trim());
  } catch {
    return false;
  }
}

async function wakeRanobeLibTitles(env: TelegramRanobeLibAuthEnv): Promise<void> {
  await env.DB.prepare(`
    UPDATE ranobelib_titles
    SET next_check_at = CURRENT_TIMESTAMP,
        scan_priority = scan_priority + 20
    WHERE EXISTS (
      SELECT 1
      FROM ranobelib_team_translations tt
      JOIN ranobelib_teams team ON team.id = tt.team_id
      WHERE tt.book_ref = ranobelib_titles.book_ref
        AND tt.presence_state = 'active'
        AND team.lifecycle_state IN ('hidden','published')
    )
  `).run();
}

async function verifyState(
  env: TelegramRanobeLibAuthEnv,
  userId: string,
  state: string,
  now: Date,
): Promise<OAuthStatePayload> {
  const [body, signature, extra] = state.split('.');
  if (!body || !signature || extra) throw new Error('Invalid RanobeLib OAuth state.');
  const expected = await signWithBotSecret(env, 'domnkrbot:ranobelib-oauth-state:v1', body);
  const supplied = base64UrlDecode(signature);
  if (!supplied || !constantTimeBytesEqual(expected, supplied)) throw new Error('Invalid RanobeLib OAuth state signature.');

  const decoded = base64UrlDecode(body);
  if (!decoded) throw new Error('Invalid RanobeLib OAuth state payload.');
  let payload: Partial<OAuthStatePayload>;
  try {
    payload = JSON.parse(decoder.decode(decoded)) as Partial<OAuthStatePayload>;
  } catch {
    throw new Error('Invalid RanobeLib OAuth state payload.');
  }
  if (payload.v !== 1 || typeof payload.uid !== 'string' || typeof payload.nonce !== 'string' || !Number.isFinite(payload.exp)) {
    throw new Error('Invalid RanobeLib OAuth state payload.');
  }
  if (payload.uid !== userId) throw new Error('RanobeLib OAuth state does not belong to this admin user.');
  if (Number(payload.exp) < now.getTime()) throw new Error('RanobeLib OAuth state has expired.');
  if (!/^[A-Za-z0-9_-]{16,}$/.test(payload.nonce)) throw new Error('Invalid RanobeLib OAuth state nonce.');
  return payload as OAuthStatePayload;
}

async function codeVerifier(env: TelegramRanobeLibAuthEnv, nonce: string): Promise<string> {
  return base64UrlEncode(await signWithBotSecret(env, 'domnkrbot:ranobelib-oauth-pkce:v1', nonce));
}

async function signWithBotSecret(
  env: TelegramRanobeLibAuthEnv,
  namespace: string,
  value: string,
): Promise<Uint8Array> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`${namespace}\n${token}`));
  const key = await crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function parseOfficialCallback(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Invalid RanobeLib OAuth callback URL.');
  }
  if (url.origin !== 'https://ranobelib.me' || url.pathname.replace(/\/+$/g, '') !== '/ru/front/auth/oauth/callback') {
    throw new Error('Invalid RanobeLib OAuth callback URL.');
  }
  return url;
}

function requiredUserId(value: string): string {
  const userId = String(value ?? '').trim();
  if (!/^\d+$/.test(userId)) throw new Error('RanobeLib OAuth admin user id is invalid.');
  return userId;
}

function isAdmin(env: TelegramRanobeLibAuthEnv, userId: number): boolean {
  return new Set(
    String(env.ADMIN_TELEGRAM_IDS ?? '')
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  ).has(String(userId));
}

async function sendTelegramMessage(
  env: TelegramRanobeLibAuthEnv,
  chatId: number,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, ...payload }),
  });
  const body = await response.json().catch(() => null) as TelegramResponse<unknown> | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram sendMessage failed: ${response.status}`);
}

function safeOAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/state/i.test(message)) return 'oauth_state_invalid';
  const status = /(?:failed|exchange|validation)\D+(\d{3})/i.exec(message)?.[1];
  if (status) return `oauth_http_${status}`;
  if (/token bundle/i.test(message)) return 'oauth_token_bundle_invalid';
  if (/callback/i.test(message)) return 'oauth_callback_invalid';
  return 'oauth_failed';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTimestampMilliseconds(value: number): number {
  return value < 100_000_000_000 ? value * 1000 : value;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
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
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index]! ^ right[index]!;
  return diff === 0;
}
