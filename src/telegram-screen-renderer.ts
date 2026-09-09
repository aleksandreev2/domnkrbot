import type { TelegramLatencyTiming } from './telegram-latency-timing.js';

export type TelegramRenderStrategy = 'edit' | 'replace' | 'send';

export type TelegramScreenEnv = {
  TELEGRAM_BOT_TOKEN?: string;
};

export type TelegramScreenTarget = {
  chatId: number | string;
  messageId?: number;
};

export type TelegramScreenPayload = {
  text: string;
  parse_mode?: 'HTML';
  reply_markup?: unknown;
};

export type TelegramScreenExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  telegramLatencyTiming?: Pick<TelegramLatencyTiming, 'mark' | 'describeRender' | 'recordTelegramApi'>;
};

export type TelegramScreenRenderOptions = {
  strategy: TelegramRenderStrategy;
  ctx?: TelegramScreenExecutionContext;
};

export type TelegramScreenRenderResult = {
  messageId?: number;
};

type TelegramApiResponse = {
  ok?: boolean;
  result?: boolean | { message_id?: number };
  description?: string;
};

export async function renderTelegramScreen(
  env: TelegramScreenEnv,
  target: TelegramScreenTarget,
  payload: TelegramScreenPayload,
  options: TelegramScreenRenderOptions,
): Promise<TelegramScreenRenderResult> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('Telegram bot token is missing');

  if (options.strategy === 'edit') {
    if (!target.messageId) throw new Error('Telegram edit requires message id');
    try {
      const result = await visibleTelegramCall(token, 'editMessageText', options.strategy, {
        chat_id: target.chatId,
        message_id: target.messageId,
        ...payload,
      }, options.ctx);
      return { messageId: resultMessageId(result) ?? target.messageId };
    } catch (error) {
      if (!isMessageNotModified(error)) throw error;
      options.ctx?.telegramLatencyTiming?.mark('screen_ready');
      return { messageId: target.messageId };
    }
  }

  const sent = await visibleTelegramCall(token, 'sendMessage', options.strategy, {
    chat_id: target.chatId,
    ...payload,
  }, options.ctx);
  const messageId = resultMessageId(sent);

  if (options.strategy === 'replace' && target.messageId) {
    const cleanup = telegramCall(token, 'deleteMessage', {
      chat_id: target.chatId,
      message_id: target.messageId,
    }).then(() => undefined).catch((error) => {
      console.error('Telegram old-screen cleanup failed', compactError(error));
    });
    if (options.ctx) options.ctx.waitUntil(cleanup);
    else void cleanup;
  }

  return { messageId };
}

async function visibleTelegramCall(
  token: string,
  method: string,
  strategy: TelegramRenderStrategy,
  body: Record<string, unknown>,
  ctx?: TelegramScreenExecutionContext,
): Promise<TelegramApiResponse> {
  const timing = ctx?.telegramLatencyTiming;
  timing?.describeRender(strategy, method);
  timing?.mark('telegram_started');
  const startedAt = Date.now();
  try {
    const response = await telegramCall(token, method, body);
    timing?.recordTelegramApi(Math.max(0, Date.now() - startedAt));
    timing?.mark('screen_ready');
    return response;
  } catch (error) {
    timing?.recordTelegramApi(Math.max(0, Date.now() - startedAt));
    throw error;
  }
}

async function telegramCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramApiResponse> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null) as TelegramApiResponse | null;
  if (!response.ok || !parsed?.ok) {
    throw new Error(parsed?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return parsed;
}

function resultMessageId(response: TelegramApiResponse): number | undefined {
  if (!response.result || typeof response.result !== 'object') return undefined;
  const value = Number(response.result.message_id);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isMessageNotModified(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /message is not modified/i.test(message);
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 180);
}
