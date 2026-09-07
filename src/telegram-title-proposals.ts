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

type TelegramDocument = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number; type?: string };
  from?: TelegramUser;
  text?: string;
  document?: TelegramDocument;
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

type ProposalSession = {
  user_telegram_id: string;
  chat_id: string;
  step: string;
  source_kind: string | null;
  ranobelib_book_ref: string | null;
  title: string;
  original_title: string;
  source_url: string;
  candidates_json: string;
  raw_file_id: string | null;
  raw_file_unique_id: string | null;
  raw_file_name: string | null;
  raw_file_size: number | string | null;
  raw_mime_type: string | null;
  comment: string;
  updated_at: string;
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
const MAX_TELEGRAM_RAW_BYTES = 20 * 1024 * 1024;
const ALLOWED_RAW_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'txt', 'md', 'rtf', 'pdf', 'epub', 'doc', 'docx',
]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function isPlainCommand(text: string, command: string): boolean {
  return new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?$`, 'i').test(text.trim());
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function extensionFor(filename: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
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

async function sendMessage(
  env: TelegramTitleProposalEnv,
  chatId: number,
  payload: Record<string, unknown>,
): Promise<void> {
  await telegramCall(env, 'sendMessage', { chat_id: chatId, ...payload });
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

async function loadProposalSession(
  env: TelegramTitleProposalEnv,
  userId: number,
): Promise<ProposalSession | null> {
  return env.DB.prepare(`
    SELECT user_telegram_id,chat_id,step,source_kind,ranobelib_book_ref,title,original_title,source_url,
           candidates_json,raw_file_id,raw_file_unique_id,raw_file_name,raw_file_size,raw_mime_type,comment,updated_at
    FROM telegram_proposal_sessions
    WHERE user_telegram_id=? AND updated_at >= datetime('now','-24 hours')
    LIMIT 1
  `).bind(String(userId)).first<ProposalSession>();
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

async function setExternalTitle(env: TelegramTitleProposalEnv, userId: number, title: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions
    SET step=?,title=?,updated_at=CURRENT_TIMESTAMP
    WHERE user_telegram_id=?
  `).bind('external_url', title, String(userId)).run();
}

async function setExternalUrl(env: TelegramTitleProposalEnv, userId: number, sourceUrl: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions
    SET step=?,source_url=?,updated_at=CURRENT_TIMESTAMP
    WHERE user_telegram_id=?
  `).bind('raw', sourceUrl, String(userId)).run();
}

async function setRawDocument(
  env: TelegramTitleProposalEnv,
  userId: number,
  document: TelegramDocument,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions
    SET step=?,raw_file_id=?,raw_file_unique_id=?,raw_file_name=?,raw_file_size=?,raw_mime_type=?,updated_at=CURRENT_TIMESTAMP
    WHERE user_telegram_id=?
  `).bind(
    'comment',
    document.file_id,
    document.file_unique_id,
    document.file_name ?? 'raw.bin',
    document.file_size ?? null,
    document.mime_type ?? 'application/octet-stream',
    String(userId),
  ).run();
}

async function skipRaw(env: TelegramTitleProposalEnv, userId: number): Promise<void> {
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions
    SET step=?,raw_file_id=NULL,raw_file_unique_id=NULL,raw_file_name=NULL,raw_file_size=NULL,raw_mime_type=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE user_telegram_id=?
  `).bind('comment', String(userId)).run();
}

async function setComment(
  env: TelegramTitleProposalEnv,
  userId: number,
  comment: string,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions
    SET step=?,comment=?,updated_at=CURRENT_TIMESTAMP
    WHERE user_telegram_id=?
  `).bind('review', comment, String(userId)).run();
}

async function skipComment(env: TelegramTitleProposalEnv, userId: number): Promise<void> {
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions
    SET step=?,comment='',updated_at=CURRENT_TIMESTAMP
    WHERE user_telegram_id=?
  `).bind('review', String(userId)).run();
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

function buildRawPrompt(): Record<string, unknown> {
  return {
    text: '<b>RAW</b>\n\nЕсли есть RAW — отправь файл.\nДо 20 МБ. Ссылку вместо файла бот не принимает.',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Пропустить', callback_data: 'prop:raw:skip' }],
        [{ text: '❌ Отмена', callback_data: 'prop:cancel' }],
      ],
    },
  };
}

function buildCommentPrompt(): Record<string, unknown> {
  return {
    text: '<b>Комментарий</b>\n\nХочешь что-нибудь добавить?',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Без комментария', callback_data: 'prop:comment:skip' }],
        [{ text: '❌ Отмена', callback_data: 'prop:cancel' }],
      ],
    },
  };
}

function buildReview(session: ProposalSession): Record<string, unknown> {
  const hasRanobeLib = session.source_kind === 'ranobelib';
  const lines = [
    '<b>Проверь заявку</b>',
    '',
    `RanobeLib: ${hasRanobeLib ? '✅ есть' : '❌ нет'}`,
    `Тайтл: <b>${escapeHtml(session.title || '—')}</b>`,
    hasRanobeLib
      ? `Карточка: ${escapeHtml(session.source_url || '—')}`
      : `Источник: ${escapeHtml(session.source_url || '—')}`,
    `RAW: ${session.raw_file_id ? `📎 ${escapeHtml(session.raw_file_name || 'файл')}` : 'нет'}`,
    `Комментарий: ${escapeHtml(session.comment || 'без комментария')}`,
  ];
  if (hasRanobeLib) lines.push('⚪ Иммунитет: не удалось определить автоматически');
  return {
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📨 Отправить', callback_data: 'prop:submit' }],
        [{ text: '✏️ Изменить', callback_data: 'prop:edit' }],
        [{ text: '❌ Отмена', callback_data: 'prop:cancel' }],
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

async function answerCallback(env: TelegramTitleProposalEnv, callbackId: string, text?: string): Promise<void> {
  await telegramCall(env, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  });
}

async function handleProposalCallback(
  env: TelegramTitleProposalEnv,
  callback: TelegramCallbackQuery,
  origin: string,
): Promise<Response | null> {
  const data = callback.data ?? '';
  if (!data.startsWith('prop:') || callback.message?.chat?.type !== 'private' || !callback.message.chat.id) return null;

  if (data === 'prop:new') {
    await resetProposalSession(env, callback.from, callback.message.chat.id);
    await editCallbackMessage(env, callback, buildSourceChoice());
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:source:ranobelib' || data === 'prop:source:external') {
    const sourceKind = data.endsWith(':ranobelib') ? 'ranobelib' : 'external';
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

  if (data === 'prop:cancel') {
    await env.DB.prepare('DELETE FROM telegram_proposal_sessions WHERE user_telegram_id=?')
      .bind(String(callback.from.id)).run();
    await editCallbackMessage(env, callback, buildProposalMainMenu(origin));
    await answerCallback(env, callback.id, 'Заявка отменена.');
    return json({ ok: true });
  }

  if (data === 'prop:raw:skip') {
    const session = await loadProposalSession(env, callback.from.id);
    if (!session || session.step !== 'raw') {
      await answerCallback(env, callback.id, 'Начните заявку заново.');
      return json({ ok: true });
    }
    await skipRaw(env, callback.from.id);
    await editCallbackMessage(env, callback, buildCommentPrompt());
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:comment:skip') {
    const session = await loadProposalSession(env, callback.from.id);
    if (!session || session.step !== 'comment') {
      await answerCallback(env, callback.id, 'Начните заявку заново.');
      return json({ ok: true });
    }
    await skipComment(env, callback.from.id);
    await editCallbackMessage(env, callback, buildReview({ ...session, step: 'review', comment: '' }));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  return null;
}

async function handleSessionMessage(
  env: TelegramTitleProposalEnv,
  message: TelegramMessage,
  session: ProposalSession,
): Promise<Response> {
  const userId = message.from?.id;
  if (!userId) return json({ ok: true });
  const text = (message.text ?? '').trim();

  if (session.step === 'external_title') {
    if (text.length < 2 || text.length > 180) {
      await sendMessage(env, message.chat.id, {
        text: 'Название должно содержать от 2 до 180 символов. Напиши название новеллы ещё раз.',
      });
      return json({ ok: true });
    }
    await setExternalTitle(env, userId, text);
    await sendMessage(env, message.chat.id, {
      text: '<b>Источник</b>\n\nПришли ссылку на страницу оригинала или официальный источник произведения.',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'prop:cancel' }]] },
    });
    return json({ ok: true });
  }

  if (session.step === 'external_url') {
    if (!isHttpUrl(text) || text.length > 500) {
      await sendMessage(env, message.chat.id, {
        text: 'Нужна рабочая ссылка, начинающаяся с http:// или https://. Пришли ссылку на официальный источник ещё раз.',
      });
      return json({ ok: true });
    }
    await setExternalUrl(env, userId, text);
    await sendMessage(env, message.chat.id, buildRawPrompt());
    return json({ ok: true });
  }

  if (session.step === 'raw') {
    const document = message.document;
    if (!document) {
      await sendMessage(env, message.chat.id, {
        text: 'RAW нужно отправить именно файлом, не ссылкой и не текстом.',
        reply_markup: { inline_keyboard: [[{ text: 'Пропустить', callback_data: 'prop:raw:skip' }]] },
      });
      return json({ ok: true });
    }
    const filename = document.file_name?.trim() || '';
    const extension = extensionFor(filename);
    if (!ALLOWED_RAW_EXTENSIONS.has(extension)) {
      await sendMessage(env, message.chat.id, {
        text: 'Этот формат RAW не поддерживается. Подойдут ZIP/RAR/7Z/TAR/GZ/TGZ/TXT/MD/RTF/PDF/EPUB/DOC/DOCX.',
        reply_markup: { inline_keyboard: [[{ text: 'Пропустить', callback_data: 'prop:raw:skip' }]] },
      });
      return json({ ok: true });
    }
    if (typeof document.file_size === 'number' && document.file_size > MAX_TELEGRAM_RAW_BYTES) {
      await sendMessage(env, message.chat.id, {
        text: 'Файл слишком большой для загрузки через обычный Telegram Bot API. Максимум — 20 МБ.',
        reply_markup: { inline_keyboard: [[{ text: 'Пропустить', callback_data: 'prop:raw:skip' }]] },
      });
      return json({ ok: true });
    }
    await setRawDocument(env, userId, document);
    await sendMessage(env, message.chat.id, buildCommentPrompt());
    return json({ ok: true });
  }

  if (session.step === 'comment') {
    if (!text) {
      await sendMessage(env, message.chat.id, buildCommentPrompt());
      return json({ ok: true });
    }
    if (text.length > 1500) {
      await sendMessage(env, message.chat.id, { text: 'Комментарий слишком длинный. Максимум 1500 символов.' });
      return json({ ok: true });
    }
    await setComment(env, userId, text);
    await sendMessage(env, message.chat.id, buildReview({ ...session, step: 'review', comment: text }));
    return json({ ok: true });
  }

  return json({ ok: true });
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

  if (update.callback_query) {
    return handleProposalCallback(env, update.callback_query, url.origin);
  }

  const message = update.message;
  const text = (message?.text ?? '').trim();
  if (!message?.chat?.id || message.chat.type !== 'private') return null;

  if (isPlainCommand(text, 'start')) {
    await sendMessage(env, message.chat.id, buildProposalMainMenu(url.origin));
    return json({ ok: true });
  }

  if (message.from && isPlainCommand(text, 'propose')) {
    await resetProposalSession(env, message.from, message.chat.id);
    await sendMessage(env, message.chat.id, buildSourceChoice());
    return json({ ok: true });
  }

  if (!message.from) return null;
  const session = await loadProposalSession(env, message.from.id);
  if (!session) return null;
  return handleSessionMessage(env, message, session);
}
