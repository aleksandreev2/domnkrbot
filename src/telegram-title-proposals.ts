type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
};

type D1Database = { prepare(query: string): D1PreparedStatement };

type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number; type?: string };
  from?: TelegramUser;
  text?: string;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};

type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export interface TelegramTitleProposalEnv {
  DB: D1Database;
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

async function upsertTelegramUser(env: TelegramTitleProposalEnv, user: TelegramUser): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id,username,first_name,last_name,language_code,updated_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name,
      last_name=excluded.last_name,
      language_code=excluded.language_code,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    String(user.id),
    user.username ?? null,
    user.first_name,
    user.last_name ?? '',
    user.language_code ?? null,
  ).run();
}

async function resetProposalSession(
  env: TelegramTitleProposalEnv,
  user: TelegramUser,
  chatId: number,
): Promise<void> {
  await upsertTelegramUser(env, user);
  await env.DB.prepare(`
    INSERT INTO telegram_proposal_sessions (
      user_telegram_id,chat_id,step,source_kind,ranobelib_book_ref,title,original_title,source_url,
      candidates_json,raw_file_id,raw_file_unique_id,raw_file_name,raw_file_size,raw_mime_type,comment,
      created_at,updated_at
    ) VALUES (?,?,?,NULL,NULL,'','','','[]',NULL,NULL,NULL,NULL,NULL,'',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET
      chat_id=excluded.chat_id,
      step=excluded.step,
      source_kind=NULL,
      ranobelib_book_ref=NULL,
      title='',
      original_title='',
      source_url='',
      candidates_json='[]',
      raw_file_id=NULL,
      raw_file_unique_id=NULL,
      raw_file_name=NULL,
      raw_file_size=NULL,
      raw_mime_type=NULL,
      comment='',
      updated_at=CURRENT_TIMESTAMP
  `).bind(String(user.id), String(chatId), 'choose_source').run();
}

async function advanceSourceChoice(
  env: TelegramTitleProposalEnv,
  userId: number,
  sourceKind: 'ranobelib' | 'external',
): Promise<string> {
  const step = sourceKind === 'ranobelib' ? 'ranobelib_query' : 'external_title';
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions
    SET step=?,source_kind=?,updated_at=CURRENT_TIMESTAMP
    WHERE user_telegram_id=?
  `).bind(step, sourceKind, String(userId)).run();
  return step;
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

function buildSourceChoice(): Record<string, unknown> {
  return {
    text: '<b>Предложить новеллу</b>\n\nЕсть ли эта новелла на RanobeLib?',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Есть на RanobeLib', callback_data: 'prop:source:ranobelib' }],
        [{ text: '❌ Нет на RanobeLib', callback_data: 'prop:source:external' }],
        [{ text: '↩️ Назад', callback_data: 'prop:cancel' }],
      ],
    },
  };
}

async function editCallbackMessage(
  env: TelegramTitleProposalEnv,
  callback: TelegramCallbackQuery,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!callback.message?.chat?.id) return;
  await telegramCall(env, 'editMessageText', {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    ...payload,
  });
}

async function answerCallback(env: TelegramTitleProposalEnv, callbackId: string): Promise<void> {
  await telegramCall(env, 'answerCallbackQuery', { callback_query_id: callbackId });
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
  if (!update) return null;

  const callback = update.callback_query;
  if (callback?.data?.startsWith('prop:') && callback.message?.chat?.type === 'private') {
    if (callback.data === 'prop:new') {
      await resetProposalSession(env, callback.from, callback.message.chat.id);
      await editCallbackMessage(env, callback, buildSourceChoice());
      await answerCallback(env, callback.id);
      return json({ ok: true });
    }

    if (callback.data === 'prop:source:ranobelib' || callback.data === 'prop:source:external') {
      const sourceKind = callback.data.endsWith(':ranobelib') ? 'ranobelib' : 'external';
      await advanceSourceChoice(env, callback.from.id, sourceKind);
      await editCallbackMessage(env, callback, sourceKind === 'ranobelib'
        ? {
            text: '<b>Есть на RanobeLib</b>\n\nПришли ссылку на карточку RanobeLib или напиши название.',
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'prop:cancel' }]] },
          }
        : {
            text: '<b>Нет на RanobeLib</b>\n\nНапиши название новеллы.',
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'prop:cancel' }]] },
          });
      await answerCallback(env, callback.id);
      return json({ ok: true });
    }

    return null;
  }

  const message = update.message;
  const text = (message?.text ?? '').trim();
  if (!message?.chat?.id || message.chat.type !== 'private') return null;

  if (isPlainCommand(text, 'start')) {
    await telegramCall(env, 'sendMessage', {
      chat_id: message.chat.id,
      ...buildProposalMainMenu(url.origin),
    });
    return json({ ok: true });
  }

  if (message.from && isPlainCommand(text, 'propose')) {
    await resetProposalSession(env, message.from, message.chat.id);
    await telegramCall(env, 'sendMessage', {
      chat_id: message.chat.id,
      ...buildSourceChoice(),
    });
    return json({ ok: true });
  }

  return null;
}
