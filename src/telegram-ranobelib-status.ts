import type { RanobeLibOpsStatusEnv } from './ranobelib-ops-status.js';
import { renderRanobeLibOperationalStatus } from './ranobelib-ops-status.js';

export type TelegramRanobeLibStatusEnv = RanobeLibOpsStatusEnv & {
  ADMIN_TELEGRAM_IDS?: string;
  TELEGRAM_BOT_TOKEN?: string;
};

type StatusUpdate = {
  message?: {
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { id?: number };
  };
};

export async function handleTelegramRanobeLibStatusWebhook(
  request: Request,
  env: TelegramRanobeLibStatusEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;
  const update = await request.clone().json().catch(() => null) as StatusUpdate | null;
  const message = update?.message;
  const text = message?.text?.trim() ?? '';
  const match = /^\/ranobelib_status(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i.exec(text);
  if (!match || !message?.from?.id || !message.chat?.id || message.chat.type !== 'private') return null;
  if (!isAdmin(env, message.from.id)) return new Response('ok');

  const target = match[1]?.trim() ?? '';
  if (!target) {
    await send(env, message.chat.id, 'Использование: <code>/ranobelib_status 247881</code>', fetchImpl);
    return new Response('ok');
  }

  try {
    const status = await renderRanobeLibOperationalStatus(env, target);
    await send(
      env,
      message.chat.id,
      status ?? `❌ RanobeLib-тайтл <code>${escapeHtml(target)}</code> не найден в локальном каталоге.`,
      fetchImpl,
    );
  } catch (error) {
    console.error('RanobeLib operational status failed', safeError(error));
    await send(env, message.chat.id, '❌ Не удалось собрать RanobeLib status. Проверьте логи и состояние D1.', fetchImpl)
      .catch(() => undefined);
  }
  return new Response('ok');
}

function isAdmin(env: TelegramRanobeLibStatusEnv, userId: number): boolean {
  return new Set(
    String(env.ADMIN_TELEGRAM_IDS ?? '').split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean),
  ).has(String(userId));
}

async function send(env: TelegramRanobeLibStatusEnv, chatId: number, text: string, fetchImpl: typeof fetch): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram sendMessage failed: ${response.status}`);
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 180);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
