import { RanobeLibAuthProvider, type RanobeLibAuthEnv, type RanobeLibTokenBundle } from './ranobelib-auth.js';
import { requireAdminSession, type WebAuthEnv } from './web-auth.js';

export type RanobeLibAuthAdminEnv = RanobeLibAuthEnv & WebAuthEnv;

type HandlerOptions = { fetchImpl?: typeof fetch };

const PATH = '/api/admin/ranobelib/auth';
const MAX_BODY_BYTES = 20_000;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export async function handleRanobeLibAuthAdmin(
  request: Request,
  env: RanobeLibAuthAdminEnv,
  options: HandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PATH) return null;

  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;
  const auth = new RanobeLibAuthProvider(env, { fetchImpl: options.fetchImpl });

  if (request.method === 'GET') return json({ auth: await auth.health() });

  if (request.method === 'DELETE') {
    await auth.remove();
    return json({ ok: true, auth: await auth.health() });
  }

  if (request.method === 'PUT') {
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ error: 'Credential payload is too large.' }, 413);
    }
    const raw = await request.text();
    if (encoder.encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: 'Credential payload is too large.' }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Invalid JSON body.' }, 400);
    }
    const bundle = parseBundle(body);
    if (!bundle) return json({ error: 'Invalid RanobeLib token bundle.' }, 400);
    if (!env.RANOBELIB_TOKEN_ENCRYPTION_KEY?.trim()) {
      return json({ error: 'RanobeLib dedicated credential encryption key is unavailable.' }, 503);
    }
    try {
      await auth.validateAndStore(bundle);
      return json({ ok: true, auth: await auth.health() });
    } catch (error) {
      return json({ error: safeValidationError(error) }, 400);
    }
  }

  return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, PUT, DELETE' });
}

function parseBundle(value: unknown): RanobeLibTokenBundle | null {
  if (!isRecord(value)) return null;
  const accessToken = stringValue(value.accessToken) || stringValue(value.access_token);
  const refreshToken = stringValue(value.refreshToken) || stringValue(value.refresh_token);
  const explicitExpiry = stringValue(value.expiresAt) || stringValue(value.expires_at);
  let expiresAtMs = Date.parse(explicitExpiry);
  if (!Number.isFinite(expiresAtMs)) {
    const expiresIn = Number(value.expiresIn ?? value.expires_in);
    const acquiredAt = Number(value.acquiredAt ?? value.acquired_at ?? value.created_at);
    if (Number.isFinite(expiresIn) && expiresIn > 0 && Number.isFinite(acquiredAt) && acquiredAt > 0) {
      const acquiredAtMs = acquiredAt < 10_000_000_000 ? acquiredAt * 1000 : acquiredAt;
      expiresAtMs = acquiredAtMs + expiresIn * 1000;
    }
  }
  if (!accessToken || !refreshToken || !Number.isFinite(expiresAtMs)) return null;
  return { accessToken, refreshToken, expiresAt: new Date(expiresAtMs).toISOString() };
}

function safeValidationError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/validation failed: \d{3}/i.test(message)) return message.slice(0, 120);
  if (/validation returned no account/i.test(message)) return 'RanobeLib validation returned no account.';
  if (/token bundle/i.test(message)) return 'Invalid RanobeLib token bundle.';
  if (/encryption key/i.test(message)) return 'RanobeLib dedicated credential encryption key is unavailable.';
  return 'RanobeLib credential validation failed.';
}

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const encoder = new TextEncoder();
