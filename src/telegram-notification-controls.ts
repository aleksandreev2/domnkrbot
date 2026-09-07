import {
  beginNotificationCustomInput,
  clearNotificationCustomInput,
  deliverySettingLabel,
  getGlobalDeliverySetting,
  getNotificationCustomInput,
  getTitleDeliverySetting,
  setGlobalDeliverySetting,
  setTitleDeliverySetting,
  clearTitleDeliverySetting,
  validateCustomStackSize,
  type DeliverySetting,
} from './telegram-notification-settings.js';
import {
  isEffectivelySubscribed,
  setEffectiveTitleSubscription,
  type TelegramSubscriptionEnv,
  type TelegramSubscriptionUpdate,
} from './telegram-subscriptions.js';

export type NotificationModeCallback =
  | { scope: 'global'; action: 'instant' }
  | { scope: 'global'; action: 'stack'; stackSize: 5 | 10 | 20 }
  | { scope: 'global'; action: 'custom' }
  | { scope: 'title'; titleId: number; action: 'instant' }
  | { scope: 'title'; titleId: number; action: 'stack'; stackSize: 5 | 10 | 20 }
  | { scope: 'title'; titleId: number; action: 'custom' }
  | { scope: 'title'; titleId: number; action: 'inherit' };

export type NotificationButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type NotificationPayload = {
  text: string;
  parse_mode: 'HTML';
  reply_markup: { inline_keyboard: NotificationButton[][] };
};

export type NotificationTitle = {
  ranobelib_id: number;
  book_ref: string;
  title: string;
  url: string;
};

type TelegramUser = {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
  language_code?: string;
};

export function parseNotificationModeCallback(value: string): NotificationModeCallback | null {
  let match = /^subs:mode:g:(i|5|10|20|c)$/.exec(value);
  if (match) {
    const action = match[1];
    if (action === 'i') return { scope: 'global', action: 'instant' };
    if (action === 'c') return { scope: 'global', action: 'custom' };
    const stackSize = Number(action) as 5 | 10 | 20;
    return { scope: 'global', action: 'stack', stackSize };
  }

  match = /^subs:mode:t:(\d+):(i|5|10|20|c|inherit)$/.exec(value);
  if (!match) return null;
  const titleId = Number(match[1]);
  if (!Number.isSafeInteger(titleId) || titleId <= 0) return null;
  const action = match[2];
  if (action === 'i') return { scope: 'title', titleId, action: 'instant' };
  if (action === 'c') return { scope: 'title', titleId, action: 'custom' };
  if (action === 'inherit') return { scope: 'title', titleId, action: 'inherit' };
  const stackSize = Number(action) as 5 | 10 | 20;
  return { scope: 'title', titleId, action: 'stack', stackSize };
}

export function buildDeliveryModeNotificationCenter(state: {
  setting: DeliverySetting;
  allTitles: boolean;
  explicitCount: number;
  exclusionCount: number;
  overrideCount: number;
}): NotificationPayload {
  const scope = state.allTitles
    ? (state.exclusionCount > 0 ? `Все переводы, кроме ${state.exclusionCount}` : 'Все переводы')
    : (state.explicitCount > 0 ? `${state.explicitCount} ${pluralTitles(state.explicitCount)}` : 'Отключены');
  return {
    text: [
      '🔔 <b>Уведомления</b>',
      '',
      `Режим по умолчанию: ${deliverySettingLabel(state.setting)}`,
      `Подписки: ${scope}`,
      `Индивидуальные настройки: ${Math.max(0, Math.trunc(state.overrideCount || 0))}`,
      '',
      'Стаки считаются отдельно для каждого тайтла. Если порог не набрался за 7 дней, бот отправит накопившиеся главы.',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: state.setting.mode === 'instant' ? '✅ ⚡ Мгновенно' : '⚡ Мгновенно', callback_data: 'subs:mode:g:i' }],
        [
          presetButton('global', null, 5, state.setting),
          presetButton('global', null, 10, state.setting),
          presetButton('global', null, 20, state.setting),
        ],
        [{ text: '⚙️ Кастомный', callback_data: 'subs:mode:g:c' }],
        [{ text: '📚 Управлять тайтлами', callback_data: 'subs:list:0' }],
        [{ text: '🔕 Отключить все', callback_data: 'subs:all:clear' }],
      ],
    },
  };
}

export function buildTitleDeliveryModePanel(state: {
  title: NotificationTitle;
  enabled: boolean;
  effectiveSetting: DeliverySetting;
  globalSetting: DeliverySetting;
  inherited: boolean;
}): NotificationPayload {
  const { title } = state;
  const inheritance = state.inherited
    ? 'Для этого тайтла используется общий режим.'
    : `Общий режим: ${deliverySettingLabel(state.globalSetting)}`;
  const rows: NotificationButton[][] = [
    [{ text: state.enabled ? '🔕 Не уведомлять' : '🔔 Уведомлять', callback_data: `subs:notify:panel-toggle:${title.ranobelib_id}` }],
    [{ text: state.effectiveSetting.mode === 'instant' && !state.inherited ? '✅ ⚡ Мгновенно' : '⚡ Мгновенно', callback_data: `subs:mode:t:${title.ranobelib_id}:i` }],
    [
      presetButton('title', title.ranobelib_id, 5, state.effectiveSetting, state.inherited),
      presetButton('title', title.ranobelib_id, 10, state.effectiveSetting, state.inherited),
      presetButton('title', title.ranobelib_id, 20, state.effectiveSetting, state.inherited),
    ],
    [{ text: '⚙️ Кастомный', callback_data: `subs:mode:t:${title.ranobelib_id}:c` }],
  ];
  if (!state.inherited) {
    rows.push([{ text: '↩️ Использовать общий режим', callback_data: `subs:mode:t:${title.ranobelib_id}:inherit` }]);
  }
  rows.push([{ text: '📖 Читать', url: title.url }]);
  rows.push([{ text: '📚 Все подписки', callback_data: 'subs:list:0' }]);

  return {
    text: [
      `⚙️ <b>${escapeHtml(title.title)}</b>`,
      '',
      `Уведомления: ${state.enabled ? '✅ включены' : '🔕 отключены'}`,
      `Режим: ${deliverySettingLabel(state.effectiveSetting)}`,
      inheritance,
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export async function sendTelegramDeliveryModeCenter(
  env: TelegramSubscriptionEnv,
  user: TelegramUser,
  chatId: number,
): Promise<void> {
  await upsertTelegramUser(env, user);
  const payload = await buildCenterForUser(env, String(user.id));
  await telegramCall(env, 'sendMessage', {
    chat_id: chatId,
    text: payload.text,
    parse_mode: payload.parse_mode,
    reply_markup: payload.reply_markup,
  });
}

export async function handleTelegramNotificationControlsUpdate(
  update: TelegramSubscriptionUpdate,
  env: TelegramSubscriptionEnv,
): Promise<boolean> {
  const callback = update.callback_query;
  const data = callback?.data ?? '';
  if (!callback || !data.startsWith('subs:')) return false;

  const mode = parseNotificationModeCallback(data);
  const center = data === 'subs:center';
  const titleSettings = /^subs:notify:settings:(\d+)$/.exec(data);
  const titleToggle = /^subs:notify:panel-toggle:(\d+)$/.exec(data);
  if (!mode && !center && !titleSettings && !titleToggle) return false;

  const message = callback.message;
  if (!message?.chat?.id || message.chat.type !== 'private') {
    await answerCallback(env, callback.id, 'Откройте настройки в личном чате с ботом.');
    return true;
  }

  await upsertTelegramUser(env, callback.from as TelegramUser);
  const userId = String(callback.from.id);

  if (center) {
    await editTelegramMessage(env, message.chat.id, message.message_id, await buildCenterForUser(env, userId));
    await answerCallback(env, callback.id);
    return true;
  }

  if (titleSettings || titleToggle) {
    const titleId = Number((titleSettings || titleToggle)?.[1]);
    const title = await titleById(env, titleId);
    if (!title) {
      await answerCallback(env, callback.id, 'Тайтл больше не доступен.');
      return true;
    }
    let enabled = await isEffectivelySubscribed(env, userId, title.book_ref);
    if (titleToggle) {
      enabled = !enabled;
      await setEffectiveTitleSubscription(env, userId, title.book_ref, enabled);
    }
    const panel = await buildPanelForTitle(env, userId, title, enabled);
    if (titleSettings) {
      await telegramCall(env, 'sendMessage', {
        chat_id: message.chat.id,
        text: panel.text,
        parse_mode: panel.parse_mode,
        reply_markup: panel.reply_markup,
      });
    } else {
      await editTelegramMessage(env, message.chat.id, message.message_id, panel);
    }
    await answerCallback(env, callback.id, enabled ? 'Уведомления включены.' : 'Уведомления отключены.');
    return true;
  }

  if (!mode) return false;
  if (mode.scope === 'global') {
    if (mode.action === 'custom') {
      await beginNotificationCustomInput(env, userId, { scope: 'global' });
      await sendCustomPrompt(env, message.chat.id);
      await answerCallback(env, callback.id);
      return true;
    }
    const setting: DeliverySetting = mode.action === 'instant'
      ? { mode: 'instant', stackSize: null }
      : { mode: 'stack', stackSize: mode.stackSize };
    await setGlobalDeliverySetting(env, userId, setting);
    await editTelegramMessage(env, message.chat.id, message.message_id, await buildCenterForUser(env, userId));
    await answerCallback(env, callback.id, 'Режим обновлён.');
    return true;
  }

  const title = await titleById(env, mode.titleId);
  if (!title) {
    await answerCallback(env, callback.id, 'Тайтл больше не доступен.');
    return true;
  }
  if (mode.action === 'custom') {
    await beginNotificationCustomInput(env, userId, { scope: 'title', bookRef: title.book_ref });
    await sendCustomPrompt(env, message.chat.id);
    await answerCallback(env, callback.id);
    return true;
  }
  if (mode.action === 'inherit') {
    await clearTitleDeliverySetting(env, userId, title.book_ref);
  } else {
    const setting: DeliverySetting = mode.action === 'instant'
      ? { mode: 'instant', stackSize: null }
      : { mode: 'stack', stackSize: mode.stackSize };
    await setTitleDeliverySetting(env, userId, title.book_ref, setting);
  }
  const enabled = await isEffectivelySubscribed(env, userId, title.book_ref);
  await editTelegramMessage(env, message.chat.id, message.message_id, await buildPanelForTitle(env, userId, title, enabled));
  await answerCallback(env, callback.id, mode.action === 'inherit' ? 'Используется общий режим.' : 'Режим тайтла обновлён.');
  return true;
}

export async function handleNotificationCustomInput(
  update: TelegramSubscriptionUpdate,
  env: TelegramSubscriptionEnv,
): Promise<boolean> {
  const message = update.message;
  const text = message?.text?.trim() ?? '';
  if (!message?.chat?.id || message.chat.type !== 'private' || !message.from || !text || text.startsWith('/')) return false;

  const userId = String(message.from.id);
  const state = await getNotificationCustomInput(env, userId);
  if (!state) return false;

  const stackSize = validateCustomStackSize(text);
  if (stackSize === null) {
    await telegramCall(env, 'sendMessage', {
      chat_id: message.chat.id,
      text: 'Введите целое число от 2 до 100.',
    });
    return true;
  }

  await upsertTelegramUser(env, message.from as TelegramUser);
  const setting: DeliverySetting = { mode: 'stack', stackSize };
  if (state.scope === 'global') {
    await setGlobalDeliverySetting(env, userId, setting);
  } else {
    await setTitleDeliverySetting(env, userId, state.bookRef, setting);
  }
  await clearNotificationCustomInput(env, userId);
  await telegramCall(env, 'sendMessage', {
    chat_id: message.chat.id,
    text: `✅ Уведомления будут приходить после накопления ${stackSize} глав.\nЕсли за 7 дней накопится меньше — бот отправит то, что есть.`,
  });
  return true;
}

async function buildCenterForUser(env: TelegramSubscriptionEnv, userId: string): Promise<NotificationPayload> {
  const [setting, allTitlesRow, explicitRow, exclusionRow, overrideRow] = await Promise.all([
    getGlobalDeliverySetting(env, userId),
    env.DB.prepare('SELECT all_titles FROM telegram_subscription_settings WHERE user_telegram_id = ?')
      .bind(userId).first<{ all_titles: number | string }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM title_subscriptions WHERE user_telegram_id = ?')
      .bind(userId).first<{ count: number | string }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM title_subscription_exclusions WHERE user_telegram_id = ?')
      .bind(userId).first<{ count: number | string }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM telegram_title_delivery_settings WHERE user_telegram_id = ?')
      .bind(userId).first<{ count: number | string }>(),
  ]);
  return buildDeliveryModeNotificationCenter({
    setting,
    allTitles: Number(allTitlesRow?.all_titles ?? 0) === 1,
    explicitCount: nonNegativeCount(explicitRow?.count),
    exclusionCount: nonNegativeCount(exclusionRow?.count),
    overrideCount: nonNegativeCount(overrideRow?.count),
  });
}

async function buildPanelForTitle(
  env: TelegramSubscriptionEnv,
  userId: string,
  title: NotificationTitle,
  enabled: boolean,
): Promise<NotificationPayload> {
  const [titleSetting, globalSetting] = await Promise.all([
    getTitleDeliverySetting(env, userId, title.book_ref),
    getGlobalDeliverySetting(env, userId),
  ]);
  return buildTitleDeliveryModePanel({
    title,
    enabled,
    effectiveSetting: titleSetting.setting,
    globalSetting,
    inherited: titleSetting.inherited,
  });
}

async function titleById(env: TelegramSubscriptionEnv, titleId: number): Promise<NotificationTitle | null> {
  if (!Number.isSafeInteger(titleId) || titleId <= 0) return null;
  const row = await env.DB.prepare(`
    SELECT ranobelib_id, book_ref, COALESCE(title, slug, book_ref) AS title, url
    FROM ranobelib_titles WHERE ranobelib_id = ? AND is_active = 1 LIMIT 1
  `).bind(titleId).first<{ ranobelib_id: number | string; book_ref: string; title: string; url: string }>();
  if (!row?.book_ref) return null;
  const id = Number(row.ranobelib_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { ranobelib_id: id, book_ref: row.book_ref, title: row.title, url: row.url };
}

async function upsertTelegramUser(env: TelegramSubscriptionEnv, user: TelegramUser): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, language_code, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      language_code = excluded.language_code,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    String(user.id),
    user.username ?? null,
    user.first_name || 'Telegram',
    user.last_name ?? '',
    user.language_code ?? null,
  ).run();
}

async function sendCustomPrompt(env: TelegramSubscriptionEnv, chatId: number): Promise<void> {
  await telegramCall(env, 'sendMessage', {
    chat_id: chatId,
    text: '📦 Введите размер стака от 2 до 100 глав.',
  });
}

async function editTelegramMessage(
  env: TelegramSubscriptionEnv,
  chatId: number,
  messageId: number,
  payload: NotificationPayload,
): Promise<void> {
  try {
    await telegramCall(env, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: payload.text,
      parse_mode: payload.parse_mode,
      reply_markup: payload.reply_markup,
    });
  } catch (error) {
    if (!/message is not modified/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
}

async function answerCallback(env: TelegramSubscriptionEnv, callbackId: string, text = ''): Promise<void> {
  await telegramCall(env, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  }).catch(() => undefined);
}

async function telegramCall<T>(env: TelegramSubscriptionEnv, method: string, payload: Record<string, unknown>): Promise<T> {
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

function presetButton(
  scope: 'global' | 'title',
  titleId: number | null,
  stackSize: 5 | 10 | 20,
  setting: DeliverySetting,
  inherited = false,
): NotificationButton {
  const active = !inherited && setting.mode === 'stack' && setting.stackSize === stackSize;
  const prefix = active ? '✅ ' : '';
  const callback = scope === 'global'
    ? `subs:mode:g:${stackSize}`
    : `subs:mode:t:${titleId}:${stackSize}`;
  return { text: `${prefix}📦 ${stackSize}`, callback_data: callback };
}

function nonNegativeCount(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function pluralTitles(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'тайтлов';
  if (mod10 === 1) return 'тайтл';
  if (mod10 >= 2 && mod10 <= 4) return 'тайтла';
  return 'тайтлов';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] || char));
}
