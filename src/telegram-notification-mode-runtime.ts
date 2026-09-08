import {
  buildDeliveryModeNotificationCenter,
  buildTitleDeliveryModePanel,
  parseNotificationModeCallback,
} from './telegram-notification-controls.js';
import {
  beginNotificationCustomInput,
  clearNotificationCustomInput,
  ensureTelegramNotificationSettingsSchema,
  getGlobalDeliverySetting,
  getNotificationCustomInput,
  getTitleDeliverySetting,
  setGlobalDeliverySetting,
  setTitleDeliverySetting,
  clearTitleDeliverySetting,
  validateCustomStackSize,
  type DeliverySetting,
  type TelegramNotificationSettingsEnv,
} from './telegram-notification-settings.js';

type NotificationQueueProducerLike = {
  send(message: { kind: 'drain' }): Promise<unknown> | unknown;
};

export type TelegramNotificationModeEnv = TelegramNotificationSettingsEnv & {
  TELEGRAM_BOT_TOKEN?: string;
  NOTIFICATION_QUEUE?: NotificationQueueProducerLike;
};

type TelegramUser = {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
  language_code?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number; type?: string };
  from?: TelegramUser;
  text?: string;
};

type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    data?: string;
    message?: TelegramMessage;
  };
};

type TitleDetails = {
  ranobelib_id: number;
  book_ref: string;
  title: string;
  url: string;
};

type CountRow = { count?: number | string | null };
type AllTitlesRow = { all_titles?: number | string | null };

let schemaPromise: Promise<void> | null = null;

async function ensureModeSchema(env: TelegramNotificationModeEnv): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = ensureTelegramNotificationSettingsSchema(env).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

export async function handleTelegramNotificationModeUpdate(
  update: TelegramUpdate,
  env: TelegramNotificationModeEnv,
): Promise<boolean> {
  const callback = update.callback_query;
  if (!callback?.data) return false;
  if (!callback.message?.chat?.id || callback.message.chat.type !== 'private') return false;

  const data = callback.data;
  const parsed = parseNotificationModeCallback(data);
  const titleSettingsMatch = /^subs:notify:settings:(\d+)$/.exec(data);
  if (data !== 'subs:center' && !parsed && !titleSettingsMatch) return false;

  await ensureModeSchema(env);
  await upsertTelegramUser(env, callback.from);
  const userId = String(callback.from.id);
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;

  if (data === 'subs:center') {
    await editTelegramMessage(env, chatId, messageId, await notificationCenterPayload(env, userId));
    await answerCallback(env, callback.id);
    return true;
  }

  if (titleSettingsMatch) {
    const titleId = Number(titleSettingsMatch[1]);
    if (!Number.isSafeInteger(titleId) || titleId <= 0) return false;
    const title = await titleDetailsById(env, titleId);
    if (!title) {
      await answerCallback(env, callback.id, 'Тайтл больше не доступен.');
      return true;
    }
    await sendTelegramMessage(env, chatId, await titlePanelPayload(env, userId, title));
    await answerCallback(env, callback.id);
    return true;
  }

  if (!parsed) return false;

  if (parsed.scope === 'global') {
    if (parsed.action === 'custom') {
      await beginNotificationCustomInput(env, userId, { scope: 'global' });
      await sendTelegramMessage(env, chatId, customPrompt());
      await answerCallback(env, callback.id);
      return true;
    }

    await setGlobalDeliverySetting(env, userId, callbackSetting(parsed));
    await wakeNotificationDelivery(env);
    await editTelegramMessage(env, chatId, messageId, await notificationCenterPayload(env, userId));
    await answerCallback(env, callback.id);
    return true;
  }

  const title = await titleDetailsById(env, parsed.titleId);
  if (!title) {
    await answerCallback(env, callback.id, 'Тайтл больше не доступен.');
    return true;
  }

  if (parsed.action === 'custom') {
    await beginNotificationCustomInput(env, userId, { scope: 'title', bookRef: title.book_ref });
    await sendTelegramMessage(env, chatId, customPrompt());
    await answerCallback(env, callback.id);
    return true;
  }

  if (parsed.action === 'inherit') {
    await clearTitleDeliverySetting(env, userId, title.book_ref);
  } else {
    await setTitleDeliverySetting(env, userId, title.book_ref, callbackSetting(parsed));
  }
  await wakeNotificationDelivery(env);
  await editTelegramMessage(env, chatId, messageId, await titlePanelPayload(env, userId, title));
  await answerCallback(env, callback.id);
  return true;
}

export async function sendTelegramDeliveryModeCenter(
  env: TelegramNotificationModeEnv,
  user: TelegramUser,
  chatId: number,
): Promise<void> {
  await ensureModeSchema(env);
  await upsertTelegramUser(env, user);
  await sendTelegramMessage(env, chatId, await notificationCenterPayload(env, String(user.id)));
}

export async function handleNotificationCustomInput(
  update: TelegramUpdate,
  env: TelegramNotificationModeEnv,
): Promise<boolean> {
  const message = update.message;
  const text = message?.text?.trim() ?? '';
  if (!message?.from || !message.chat?.id || message.chat.type !== 'private' || !text) return false;
  if (text.startsWith('/')) return false;

  await ensureModeSchema(env);
  const userId = String(message.from.id);
  const state = await getNotificationCustomInput(env, userId);
  if (!state) return false;

  const size = validateCustomStackSize(text);
  if (size === null) {
    await sendTelegramMessage(env, message.chat.id, {
      text: 'Введите целое число от 2 до 100.',
      reply_markup: { inline_keyboard: [] },
    });
    return true;
  }

  const setting: DeliverySetting = { mode: 'stack', stackSize: size };
  if (state.scope === 'global') {
    await setGlobalDeliverySetting(env, userId, setting);
  } else {
    await setTitleDeliverySetting(env, userId, state.bookRef, setting);
  }
  await clearNotificationCustomInput(env, userId);
  await wakeNotificationDelivery(env);
  await sendTelegramMessage(env, message.chat.id, {
    text: [
      `✅ Уведомления будут приходить после накопления ${size} глав.`,
      'Если за 7 дней накопится меньше — бот отправит то, что есть.',
    ].join('\n'),
    reply_markup: { inline_keyboard: [] },
  });
  return true;
}

async function notificationCenterPayload(env: TelegramNotificationModeEnv, userId: string) {
  const [setting, allTitlesRow, explicitRow, exclusionRow, overrideRow] = await Promise.all([
    getGlobalDeliverySetting(env, userId),
    env.DB.prepare('SELECT all_titles FROM telegram_subscription_settings WHERE user_telegram_id = ?').bind(userId).first<AllTitlesRow>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM title_subscriptions WHERE user_telegram_id = ?').bind(userId).first<CountRow>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM title_subscription_exclusions WHERE user_telegram_id = ?').bind(userId).first<CountRow>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM telegram_title_delivery_settings WHERE user_telegram_id = ?').bind(userId).first<CountRow>(),
  ]);
  return buildDeliveryModeNotificationCenter({
    setting,
    allTitles: Number(allTitlesRow?.all_titles) === 1,
    explicitCount: positiveCount(explicitRow?.count),
    exclusionCount: positiveCount(exclusionRow?.count),
    overrideCount: positiveCount(overrideRow?.count),
  });
}

async function titlePanelPayload(env: TelegramNotificationModeEnv, userId: string, title: TitleDetails) {
  const [globalSetting, titleSetting, enabled] = await Promise.all([
    getGlobalDeliverySetting(env, userId),
    getTitleDeliverySetting(env, userId, title.book_ref),
    isEffectivelySubscribed(env, userId, title.book_ref),
  ]);
  return buildTitleDeliveryModePanel({
    title,
    enabled,
    effectiveSetting: titleSetting.setting,
    globalSetting,
    inherited: titleSetting.inherited,
  });
}

async function titleDetailsById(env: TelegramNotificationModeEnv, titleId: number): Promise<TitleDetails | null> {
  return env.DB.prepare(`
    SELECT ranobelib_id, book_ref, title, url
    FROM ranobelib_titles
    WHERE ranobelib_id = ?
  `).bind(titleId).first<TitleDetails>();
}

async function isEffectivelySubscribed(env: TelegramNotificationModeEnv, userId: string, bookRef: string): Promise<boolean> {
  const all = await env.DB.prepare('SELECT all_titles FROM telegram_subscription_settings WHERE user_telegram_id = ?')
    .bind(userId).first<AllTitlesRow>();
  if (Number(all?.all_titles) === 1) {
    const excluded = await env.DB.prepare(`
      SELECT 1 AS excluded
      FROM title_subscription_exclusions
      WHERE user_telegram_id = ? AND book_ref = ?
    `).bind(userId, bookRef).first<{ excluded?: number }>();
    return !excluded;
  }
  const subscribed = await env.DB.prepare(`
    SELECT 1 AS subscribed
    FROM title_subscriptions
    WHERE user_telegram_id = ? AND book_ref = ?
  `).bind(userId, bookRef).first<{ subscribed?: number }>();
  return Boolean(subscribed);
}

function callbackSetting(value: { action: 'instant' } | { action: 'stack'; stackSize: 5 | 10 | 20 }): DeliverySetting {
  return value.action === 'instant'
    ? { mode: 'instant', stackSize: null }
    : { mode: 'stack', stackSize: value.stackSize };
}

function customPrompt() {
  return {
    text: '📦 Введите размер стака от 2 до 100 глав.',
    reply_markup: { inline_keyboard: [] },
  };
}

async function wakeNotificationDelivery(env: TelegramNotificationModeEnv): Promise<void> {
  const send = env.NOTIFICATION_QUEUE?.send?.bind(env.NOTIFICATION_QUEUE);
  if (!send) return;
  try {
    await send({ kind: 'drain' });
  } catch (error) {
    console.error('Telegram notification Queue wake-up failed after delivery-mode change', error);
  }
}

async function upsertTelegramUser(env: TelegramNotificationModeEnv, user: TelegramUser): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, language_code)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      language_code = excluded.language_code,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    String(user.id),
    user.username ?? null,
    user.first_name ?? '',
    user.last_name ?? null,
    user.language_code ?? null,
  ).run();
}

async function sendTelegramMessage(
  env: TelegramNotificationModeEnv,
  chatId: number,
  payload: { text: string; parse_mode?: 'HTML'; reply_markup: { inline_keyboard: unknown[][] } },
): Promise<void> {
  await telegramCall(env, 'sendMessage', {
    chat_id: chatId,
    text: payload.text,
    ...(payload.parse_mode ? { parse_mode: payload.parse_mode } : {}),
    reply_markup: payload.reply_markup,
  });
}

async function editTelegramMessage(
  env: TelegramNotificationModeEnv,
  chatId: number,
  messageId: number,
  payload: { text: string; parse_mode?: 'HTML'; reply_markup: { inline_keyboard: unknown[][] } },
): Promise<void> {
  await telegramCall(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: payload.text,
    ...(payload.parse_mode ? { parse_mode: payload.parse_mode } : {}),
    reply_markup: payload.reply_markup,
  });
}

async function answerCallback(env: TelegramNotificationModeEnv, callbackId: string, text?: string): Promise<void> {
  await telegramCall(env, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  }).catch(() => undefined);
}

async function telegramCall<T>(env: TelegramNotificationModeEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  return body.result as T;
}

function positiveCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}
