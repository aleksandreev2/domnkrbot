type TelegramUser = {
  id: number;
  first_name: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number; type?: string };
  from?: TelegramUser;
  text?: string;
};

type TelegramUpdate = {
  message?: TelegramMessage;
};

export interface TelegramTitleProposalEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function isPlainCommand(text: string, command: string): boolean {
  return new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?$`, 'i').test(text.trim());
}

async function telegramCall(
  env: TelegramTitleProposalEnv,
  method: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !body?.ok) {
    throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
}

export function buildProposalMainMenu(origin: string): Record<string, unknown> {
  return {
    text: '<b>☠️ Дом Некроманта</b>\n\nЧто хотите сделать?',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📚 Предложить новеллу', callback_data: 'prop:new' }],
        [
          { text: '🔔 Уведомления', callback_data: 'prop:notifications' },
          { text: '🗂 Мои заявки', callback_data: 'prop:mine' },
        ],
        [{ text: '🌐 Сайт', url: `${origin.replace(/\/$/, '')}/` }],
      ],
    },
  };
}

export async function handleTelegramTitleProposalWebhookRequest(
  request: Request,
  env: TelegramTitleProposalEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;

  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
  if (!expected || request.headers.get('x-telegram-bot-api-secret-token') !== expected) return null;

  const update = await request.clone().json().catch(() => null) as TelegramUpdate | null;
  const message = update?.message;
  const text = (message?.text ?? '').trim();
  if (!message?.chat?.id || message.chat.type !== 'private') return null;
  if (!isPlainCommand(text, 'start')) return null;

  await telegramCall(env, 'sendMessage', {
    chat_id: message.chat.id,
    ...buildProposalMainMenu(url.origin),
  });
  return json({ ok: true });
}
