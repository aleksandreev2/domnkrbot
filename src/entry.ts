import baseWorker from './worker';

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
  BOT_USERNAME?: string;
  WEBHOOK_URL?: string;
}

type TelegramBotInfo = { id: number; username?: string; first_name: string };
type TelegramWebhookInfo = {
  url?: string;
  pending_update_count?: number;
  last_error_message?: string;
};
type SetupResult = {
  bot: TelegramBotInfo;
  webhook: TelegramWebhookInfo;
  appUrl: string;
};

let schemaPromise: Promise<void> | null = null;
let telegramSetupPromise: Promise<void> | null = null;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function appUrl(request: Request, env: Env): string {
  const configured = env.WEBHOOK_URL?.trim().replace(/\/+$/, '');
  if (configured && /^https:\/\//i.test(configured)) return configured;
  return new URL(request.url).origin;
}

async function initializeSchema(env: Env): Promise<void> {
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
    'CREATE INDEX IF NOT EXISTS idx_chapter_proposals_status_created ON chapter_proposals(status, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_chapter_proposals_user_created ON chapter_proposals(user_telegram_id, created_at DESC)',
    `CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  ];

  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}

async function ensureSchema(env: Env): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = initializeSchema(env).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function telegramCall<T = unknown>(
  env: Env,
  method: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    result?: T;
    description?: string;
  } | null;

  if (!response.ok || !body?.ok) {
    throw new Error(`Telegram ${method}: ${body?.description ?? `HTTP ${response.status}`}`);
  }
  return body.result as T;
}

async function configureTelegram(request: Request, env: Env): Promise<SetupResult> {
  const target = appUrl(request, env);
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET is not configured');

  const bot = await telegramCall<TelegramBotInfo>(env, 'getMe');
  await telegramCall(env, 'setMyName', { name: 'Дом Некроманта' });
  await telegramCall(env, 'setMyDescription', {
    description: 'Переводы, новые главы и предложения сообщества. Откройте Mini App, чтобы следить за проектами и предложить новый тайтл или главы.',
  });
  await telegramCall(env, 'setMyShortDescription', {
    short_description: 'Переводы и предложения сообщества «Дом Некроманта».',
  });
  await telegramCall(env, 'setMyCommands', {
    commands: [
      { command: 'start', description: 'Открыть Дом Некроманта' },
      { command: 'app', description: 'Открыть Mini App' },
      { command: 'propose', description: 'Предложить перевод' },
      { command: 'help', description: 'Помощь' },
    ],
  });
  await telegramCall(env, 'setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Дом Некроманта',
      web_app: { url: target },
    },
  });
  await telegramCall(env, 'setWebhook', {
    url: `${target}/telegram/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });

  const webhook = await telegramCall<TelegramWebhookInfo>(env, 'getWebhookInfo');
  return { bot, webhook, appUrl: target };
}

async function setupFingerprint(request: Request, env: Env): Promise<string> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!token || !secret) throw new Error('Telegram credentials are not configured');
  return sha256Hex(`${appUrl(request, env)}\n${token}\n${secret}`);
}

async function autoConfigureTelegram(request: Request, env: Env): Promise<void> {
  if (telegramSetupPromise) return telegramSetupPromise;

  telegramSetupPromise = (async () => {
    const fingerprint = await setupFingerprint(request, env);
    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'telegram_setup_fingerprint'",
    ).first<{ value: string }>();

    if (row?.value === fingerprint) return;

    await configureTelegram(request, env);
    await env.DB.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('telegram_setup_fingerprint', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).bind(fingerprint).run();
  })().catch((error) => {
    telegramSetupPromise = null;
    throw error;
  });

  return telegramSetupPromise;
}

function setupPage(result: SetupResult): Response {
  const botName = result.bot.username ? `@${result.bot.username}` : result.bot.first_name;
  const webhookUrl = result.webhook.url || `${result.appUrl}/telegram/webhook`;
  const pending = result.webhook.pending_update_count ?? 0;
  const warning = result.webhook.last_error_message
    ? `<p style="color:#ff9b8f"><b>Telegram:</b> ${escapeHtml(result.webhook.last_error_message)}</p>`
    : '';

  return new Response(`<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Дом Некроманта — setup</title>
<body style="margin:0;background:#10100f;color:#f5f1e8;font:16px/1.5 system-ui;padding:32px">
<main style="max-width:680px;margin:auto;background:#171716;border:1px solid #34312b;border-radius:20px;padding:28px">
<div style="color:#c99b43;font-weight:800;letter-spacing:.12em;font-size:12px">ГОТОВО</div>
<h1 style="font:36px Georgia,serif;margin:8px 0 12px">Telegram подключён</h1>
<p><b>Бот:</b> ${escapeHtml(botName)}</p>
<p><b>Mini App:</b> ${escapeHtml(result.appUrl)}</p>
<p><b>Webhook:</b> ${escapeHtml(webhookUrl)}</p>
<p><b>Pending updates:</b> ${pending}</p>
${warning}
<p style="color:#a8a195">Можно закрыть страницу и отправить боту <b>/start</b>.</p>
<a href="${escapeHtml(result.appUrl)}" style="display:inline-block;margin-top:8px;color:#17120a;background:#c99b43;padding:12px 16px;border-radius:12px;text-decoration:none;font-weight:800">Открыть Mini App</a>
</main></body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function setupError(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Unknown setup error';
  return new Response(`<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Дом Некроманта — setup</title>
<body style="margin:0;background:#10100f;color:#f5f1e8;font:16px/1.5 system-ui;padding:32px">
<main style="max-width:680px;margin:auto;background:#171716;border:1px solid #5a302b;border-radius:20px;padding:28px">
<div style="color:#ff9b8f;font-weight:800;letter-spacing:.12em;font-size:12px">ОШИБКА</div>
<h1 style="font:36px Georgia,serif;margin:8px 0 12px">Telegram не подключён</h1>
<p>${escapeHtml(message)}</p>
<p style="color:#a8a195">Секреты остаются внутри Cloudflare и на этой странице не выводятся.</p>
</main></body></html>`, {
    status: 500,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/setup' && request.method === 'GET') {
      try {
        await ensureSchema(env);
        const result = await configureTelegram(request, env);
        const fingerprint = await setupFingerprint(request, env);
        await env.DB.prepare(`
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ('telegram_setup_fingerprint', ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).bind(fingerprint).run();
        return setupPage(result);
      } catch (error) {
        console.error('Telegram setup failed', error);
        return setupError(error);
      }
    }

    if (url.pathname.startsWith('/api/')) {
      await ensureSchema(env);
      if (url.pathname === '/api/bootstrap') {
        try {
          await autoConfigureTelegram(request, env);
        } catch (error) {
          console.warn('Automatic Telegram setup failed', error);
        }
      }
    }

    return baseWorker.fetch(request, env);
  },
};
