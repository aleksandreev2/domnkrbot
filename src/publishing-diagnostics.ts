import { configurePublishingSettings, ensurePublishingDefaults } from './publishing-settings-guard.js';
import { requireAdminSession, type WebAuthEnv } from './web-auth.js';

type D1Row = Record<string, unknown>;
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }
interface R2ObjectLike {
  size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

interface DiagnosticsEnv extends WebAuthEnv {
  DB: D1DatabaseLike;
  FILES?: R2BucketLike;
  PUBLISH_CHANNEL_ID?: string;
}

type TelegramMessage = {
  message_id: number;
  document?: { file_id?: string; file_name?: string };
};

type TelegramResponse<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function setting(env: DiagnosticsEnv, key: string): Promise<string> {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>();
  return String(row?.value ?? '').trim();
}

async function r2RoundTrip(env: DiagnosticsEnv): Promise<{ bytes: number }> {
  if (!env.FILES) throw new Error('R2 FILES binding is not configured');
  const key = `diagnostics/${crypto.randomUUID()}.txt`;
  const payload = new TextEncoder().encode(`domnkrbot publishing self-test ${new Date().toISOString()}`);
  try {
    await env.FILES.put(key, payload, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
    const stored = await env.FILES.get(key);
    if (!stored) throw new Error('R2 test object was not readable after put');
    const actual = new Uint8Array(await stored.arrayBuffer());
    if (actual.byteLength !== payload.byteLength) throw new Error('R2 round-trip byte length mismatch');
    for (let index = 0; index < payload.byteLength; index += 1) {
      if (actual[index] !== payload[index]) throw new Error('R2 round-trip content mismatch');
    }
    return { bytes: payload.byteLength };
  } finally {
    await env.FILES.delete(key).catch(() => undefined);
  }
}

async function telegramUpload<T>(env: DiagnosticsEnv, method: string, form: FormData): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form });
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok || body.result === undefined) {
    throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return body.result;
}

async function sendPrivateProbe(env: DiagnosticsEnv, adminId: number): Promise<TelegramMessage> {
  const form = new FormData();
  form.set('chat_id', String(adminId));
  form.set('caption', 'Дом Некроманта · Publishing Self-Test\nR2 и Telegram upload path работают. В канал ничего не отправлено.');
  const probe = new Blob([
    `domnkrbot publishing self-test\n${new Date().toISOString()}\nchannel=${env.PUBLISH_CHANNEL_ID || 'configured-in-d1'}\n`,
  ], { type: 'text/plain; charset=utf-8' });
  form.set('document', probe, 'domnkr-publishing-self-test.txt');
  return telegramUpload<TelegramMessage>(env, 'sendDocument', form);
}

export async function handlePublishingDiagnostics(request: Request, env: DiagnosticsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/api/admin/publishing/diagnostics') return null;

  const admin = await requireAdminSession(request, env);
  if (admin instanceof Response) return admin;

  const startedAt = Date.now();
  const checks: Record<string, unknown> = {
    storage: { ok: false },
    telegramTarget: { ok: false },
    telegramUpload: { ok: false },
  };

  try {
    const storage = await r2RoundTrip(env);
    checks.storage = { ok: true, bytes: storage.bytes };

    await ensurePublishingDefaults(env);
    const [channelId, discussionId] = await Promise.all([
      setting(env, 'publish_channel_id'),
      setting(env, 'discussion_chat_id'),
    ]);
    if (!channelId) throw new Error('Publishing channel is not configured');

    const target = await configurePublishingSettings(env, channelId, discussionId);
    checks.telegramTarget = {
      ok: true,
      channelReady: Boolean(target.settings.publishChannelId),
      discussionReady: Boolean(target.settings.discussionChatId),
      channelTitle: target.telegram?.channel.title || null,
      channelUsername: target.telegram?.channel.username || null,
      botStatus: target.telegram?.channel.botStatus || null,
      discussionTitle: target.telegram?.discussion?.title || null,
    };

    const sent = await sendPrivateProbe(env, admin.id);
    checks.telegramUpload = {
      ok: true,
      messageId: sent.message_id,
      fileIdReady: Boolean(sent.document?.file_id),
    };

    return json({
      ok: true,
      channelPublished: false,
      checks,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return json({
      ok: false,
      channelPublished: false,
      checks,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    }, 502);
  }
}
