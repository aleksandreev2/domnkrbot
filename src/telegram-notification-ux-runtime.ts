import { refreshAllNotificationDemand, refreshTitleNotificationDemand } from './notification-demand.js';
import {
  getGlobalDeliverySetting,
  getTitleDeliverySetting,
  ensureTelegramNotificationSettingsSchema,
  clearNotificationCustomInput,
  type DeliverySetting,
} from './telegram-notification-settings.js';
import {
  ensureTelegramSubscriptionSchema,
  isEffectivelySubscribed,
  setEffectiveTitleSubscription,
  type TelegramSubscriptionEnv,
  type TelegramSubscriptionUpdate,
} from './telegram-subscriptions.js';
import {
  beginNotificationSearch,
  clearNotificationSearch,
  getNotificationSearchState,
  saveNotificationSearchPage,
  saveNotificationSearchQuery,
  setProposalInputActive,
  ensureTelegramTextBotUxSchema,
  type NotificationSearchReturn,
} from './telegram-text-bot-ux-schema.js';
import {
  buildNotificationDashboard,
  buildNotificationDisableAllConfirmation,
  buildNotificationGlobalModeScreen,
  buildNotificationSearchPrompt,
  buildNotificationSearchResults,
  buildNotificationTitleCard,
  buildNotificationTitleList,
  buildNotificationTitleModeScreen,
  parseNotificationUxCallback,
  type NotificationReturnContext,
  type NotificationUiTitle,
  type NotificationDeliverySetting,
} from './telegram-notification-ux.js';
import { startCallbackAck, type ExecutionContextLike } from './telegram-fast-ack.js';
import type { TelegramLatencyTiming } from './telegram-latency-timing.js';
import { notificationRenderStrategy } from './telegram-notification-render-strategy.js';
import { renderTelegramScreen } from './telegram-screen-renderer.js';

type CountRow = { count: number | string | null };
type AllTitlesRow = { all_titles: number | string | null };
type D1PreparedStatement = ReturnType<TelegramSubscriptionEnv['DB']['prepare']>;
type NotificationExecutionContext = ExecutionContextLike & {
  telegramLatencyTiming?: TelegramLatencyTiming;
};

export type TelegramNotificationUxEnv = TelegramSubscriptionEnv;

export async function handleTelegramNotificationUxUpdate(
  update: TelegramSubscriptionUpdate,
  env: TelegramNotificationUxEnv,
  ctx?: NotificationExecutionContext,
): Promise<boolean> {
  const callback = update.callback_query;
  if (!callback?.data) return false;
  const parsed = parseNotificationUxCallback(callback.data);
  if (!parsed) return false;

  const chatId = callback.message?.chat?.id ?? callback.from.id;
  if (callback.message?.chat?.type && callback.message.chat.type !== 'private') {
    await answerCallback(env, callback.id, 'Откройте уведомления в личном чате с ботом.');
    return true;
  }

  startCallbackAck(env, callback.id, ctx);
  const userId = String(callback.from.id);
  await ensureNotificationUxSchema(env);

  if (parsed.kind === 'dashboard') {
    await Promise.all([
      clearNotificationSearch(env, userId),
      setProposalInputActive(env, userId, 0),
      clearNotificationCustomInput(env, userId),
    ]);
    await respond(env, callback, chatId, await dashboardPayload(env, userId), ctx);
    return true;
  }

  if (parsed.kind === 'mine' || parsed.kind === 'all-list') {
    await clearNotificationSearch(env, userId);
    const kind = parsed.kind === 'mine' ? 'mine' : 'all';
    const rows = kind === 'mine'
      ? await listMyTitles(env, userId, parsed.page)
      : await listAllTitles(env, parsed.page);
    await respond(env, callback, chatId, buildNotificationTitleList({ kind, rows, page: parsed.page }), ctx);
    return true;
  }

  if (parsed.kind === 'search-start') {
    await Promise.all([
      setProposalInputActive(env, userId, 0),
      clearNotificationCustomInput(env, userId),
      beginNotificationSearch(env, userId, parsed.returnScope),
    ]);
    await respond(env, callback, chatId, buildNotificationSearchPrompt(parsed.returnScope), ctx);
    return true;
  }

  if (parsed.kind === 'search-again') {
    const state = await getNotificationSearchState(env, userId);
    const returnScope = state?.returnScope ?? 'home';
    await Promise.all([
      setProposalInputActive(env, userId, 0),
      clearNotificationCustomInput(env, userId),
      beginNotificationSearch(env, userId, returnScope),
    ]);
    await respond(env, callback, chatId, buildNotificationSearchPrompt(returnScope), ctx);
    return true;
  }

  if (parsed.kind === 'search-page') {
    const state = await getNotificationSearchState(env, userId);
    if (!state?.query) {
      await beginNotificationSearch(env, userId, state?.returnScope ?? 'home');
      await respond(env, callback, chatId, buildNotificationSearchPrompt(state?.returnScope ?? 'home'), ctx);
      return true;
    }
    await saveNotificationSearchPage(env, userId, parsed.page);
    const rows = await searchLocalTitles(env, state.query, parsed.page);
    await respond(env, callback, chatId, buildNotificationSearchResults({
      query: state.query,
      rows,
      page: parsed.page,
      returnScope: state.returnScope,
    }), ctx);
    return true;
  }

  if (parsed.kind === 'clear-confirm') {
    await respond(env, callback, chatId, buildNotificationDisableAllConfirmation(), ctx);
    return true;
  }

  if (parsed.kind === 'clear-yes') {
    await upsertTelegramUser(env, callback.from);
    await clearAllSubscriptions(env, userId);
    const refresh = refreshAllNotificationDemand(env).catch((error) => {
      console.error('Global notification demand refresh failed', error);
    });
    if (ctx) ctx.waitUntil(refresh);
    else await refresh;
    await respond(env, callback, chatId, await dashboardPayload(env, userId), ctx);
    return true;
  }

  if (parsed.kind === 'mode-home') {
    await respond(env, callback, chatId, buildNotificationGlobalModeScreen(asUiSetting(await getGlobalDeliverySetting(env, userId))), ctx);
    return true;
  }

  if (parsed.kind === 'title' || parsed.kind === 'toggle' || parsed.kind === 'title-mode') {
    const title = await titleById(env, parsed.titleId);
    if (!title) return true;
    const context: NotificationReturnContext = { origin: parsed.origin, page: parsed.page };

    if (parsed.kind === 'toggle') {
      await upsertTelegramUser(env, callback.from);
      const before = await isEffectivelySubscribed(env, userId, title.book_ref);
      await setEffectiveTitleSubscription(env, userId, title.book_ref, !before);
      const refresh = refreshTitleNotificationDemand(env, title.book_ref).catch((error) => {
        console.error('Notification title demand refresh failed', error);
      });
      if (ctx) ctx.waitUntil(refresh);
      else await refresh;
    }

    if (parsed.kind === 'title-mode') {
      await respond(env, callback, chatId, await titleModePayload(env, userId, title, context), ctx);
      return true;
    }

    const payload = await titleCardPayload(env, userId, title, context);
    await respond(env, callback, chatId, payload, ctx);
    return true;
  }

  return false;
}

export async function handleNotificationSearchInput(
  update: TelegramSubscriptionUpdate,
  env: TelegramNotificationUxEnv,
): Promise<boolean> {
  const message = update.message;
  const text = message?.text?.trim() ?? '';
  if (!message?.from || !message.chat?.id || message.chat.type !== 'private' || !text || text.startsWith('/')) return false;

  await ensureTelegramTextBotUxSchema(env);
  const userId = String(message.from.id);
  const state = await getNotificationSearchState(env, userId);
  if (!state || state.query) return false;

  await saveNotificationSearchQuery(env, userId, text);
  const rows = await searchLocalTitles(env, text, 0);
  await telegramCall(env, 'sendMessage', {
    chat_id: message.chat.id,
    ...buildNotificationSearchResults({
      query: text,
      rows,
      page: 0,
      returnScope: state.returnScope,
    }),
  });
  return true;
}

export async function sendTelegramNotificationDashboard(
  env: TelegramNotificationUxEnv,
  user: { id: number; username?: string; first_name: string; last_name?: string; language_code?: string },
  chatId: number,
): Promise<void> {
  await ensureNotificationUxSchema(env);
  await upsertTelegramUser(env, user);
  const userId = String(user.id);
  await setProposalInputActive(env, userId, 0);
  await clearNotificationSearch(env, userId);
  await clearNotificationCustomInput(env, userId);
  await telegramCall(env, 'sendMessage', {
    chat_id: chatId,
    ...(await dashboardPayload(env, userId)),
  });
}

async function dashboardPayload(env: TelegramNotificationUxEnv, userId: string) {
  const [allTitles, globalSetting, overrideCount] = await Promise.all([
    userSubscribesToAll(env, userId),
    getGlobalDeliverySetting(env, userId),
    count(env.DB.prepare('SELECT COUNT(*) AS count FROM telegram_title_delivery_settings WHERE user_telegram_id = ?').bind(userId)),
  ]);
  let effectiveCount: number;
  if (allTitles) {
    const [activeCount, exclusionCount] = await Promise.all([
      count(env.DB.prepare('SELECT COUNT(*) AS count FROM ranobelib_titles WHERE is_active = 1 AND snapshot_ready = 1')),
      count(env.DB.prepare('SELECT COUNT(*) AS count FROM title_subscription_exclusions WHERE user_telegram_id = ?').bind(userId)),
    ]);
    effectiveCount = Math.max(0, activeCount - exclusionCount);
  } else {
    effectiveCount = await count(env.DB.prepare('SELECT COUNT(*) AS count FROM title_subscriptions WHERE user_telegram_id = ?').bind(userId));
  }
  return buildNotificationDashboard({
    effectiveCount,
    allTitles,
    globalSetting: asUiSetting(globalSetting),
    overrideCount,
  });
}

async function listMyTitles(env: TelegramNotificationUxEnv, userId: string, page: number): Promise<NotificationUiTitle[]> {
  const offset = safePage(page) * 8;
  if (await userSubscribesToAll(env, userId)) {
    return (await env.DB.prepare(`
      SELECT t.ranobelib_id,t.book_ref,t.title,t.url
      FROM ranobelib_titles t
      LEFT JOIN title_subscription_exclusions e
        ON e.user_telegram_id = ? AND e.book_ref = t.book_ref
      WHERE t.is_active = 1 AND t.snapshot_ready = 1 AND e.book_ref IS NULL
      ORDER BY t.title COLLATE NOCASE ASC, t.ranobelib_id ASC
      LIMIT ? OFFSET ?
    `).bind(userId, 8, offset).all<NotificationUiTitle>()).results;
  }
  return (await env.DB.prepare(`
    SELECT t.ranobelib_id,t.book_ref,t.title,t.url
    FROM ranobelib_titles t
    JOIN title_subscriptions s ON s.book_ref = t.book_ref
    WHERE s.user_telegram_id = ? AND t.is_active = 1 AND t.snapshot_ready = 1
    ORDER BY t.title COLLATE NOCASE ASC, t.ranobelib_id ASC
    LIMIT ? OFFSET ?
  `).bind(userId, 8, offset).all<NotificationUiTitle>()).results;
}

async function listAllTitles(env: TelegramNotificationUxEnv, page: number): Promise<NotificationUiTitle[]> {
  return (await env.DB.prepare(`
    SELECT ranobelib_id,book_ref,title,url
    FROM ranobelib_titles
    WHERE is_active = 1 AND snapshot_ready = 1
    ORDER BY title COLLATE NOCASE ASC, ranobelib_id ASC
    LIMIT ? OFFSET ?
  `).bind(8, safePage(page) * 8).all<NotificationUiTitle>()).results;
}

async function searchLocalTitles(
  env: TelegramNotificationUxEnv,
  query: string,
  page: number,
): Promise<NotificationUiTitle[]> {
  const clean = String(query ?? '').trim();
  if (!clean) return [];
  return (await env.DB.prepare(`
    SELECT ranobelib_id,book_ref,title,url
    FROM ranobelib_titles
    WHERE is_active = 1
      AND snapshot_ready = 1
      AND title LIKE ? COLLATE NOCASE
    ORDER BY title COLLATE NOCASE ASC, ranobelib_id ASC
    LIMIT ? OFFSET ?
  `).bind(`%${clean}%`, 8, safePage(page) * 8).all<NotificationUiTitle>()).results;
}

async function titleById(env: TelegramNotificationUxEnv, titleId: number): Promise<NotificationUiTitle | null> {
  return env.DB.prepare(`
    SELECT ranobelib_id,book_ref,title,url
    FROM ranobelib_titles
    WHERE ranobelib_id = ? AND is_active = 1
    LIMIT 1
  `).bind(titleId).first<NotificationUiTitle>();
}

async function titleCardPayload(
  env: TelegramNotificationUxEnv,
  userId: string,
  title: NotificationUiTitle,
  returnContext: NotificationReturnContext,
) {
  const [enabled, globalSetting, titleSetting] = await Promise.all([
    isEffectivelySubscribed(env, userId, title.book_ref),
    getGlobalDeliverySetting(env, userId),
    getTitleDeliverySetting(env, userId, title.book_ref),
  ]);
  const effective = titleSetting.setting;
  const pendingChapterCount = effective.mode === 'stack'
    ? await pendingStackChapterCount(env, userId, title.book_ref)
    : null;
  return buildNotificationTitleCard({
    title,
    enabled,
    inherited: titleSetting.inherited,
    effectiveSetting: asUiSetting(effective),
    globalSetting: asUiSetting(globalSetting),
    pendingChapterCount,
    returnContext,
  });
}

async function titleModePayload(
  env: TelegramNotificationUxEnv,
  userId: string,
  title: NotificationUiTitle,
  returnContext: NotificationReturnContext,
) {
  const [enabled, globalSetting, titleSetting] = await Promise.all([
    isEffectivelySubscribed(env, userId, title.book_ref),
    getGlobalDeliverySetting(env, userId),
    getTitleDeliverySetting(env, userId, title.book_ref),
  ]);
  return buildNotificationTitleModeScreen({
    title,
    enabled,
    inherited: titleSetting.inherited,
    effectiveSetting: asUiSetting(titleSetting.setting),
    globalSetting: asUiSetting(globalSetting),
    returnContext,
  });
}

async function pendingStackChapterCount(
  env: TelegramNotificationUxEnv,
  userId: string,
  bookRef: string,
): Promise<number> {
  return count(env.DB.prepare(`
    SELECT COALESCE(SUM(r.chapter_count), 0) AS count
    FROM ranobelib_notification_outbox o
    JOIN ranobelib_releases r ON r.id = o.release_id
    WHERE o.user_telegram_id = ?
      AND r.book_ref = ?
      AND o.status IN ('pending','retry')
  `).bind(userId, bookRef));
}

async function clearAllSubscriptions(env: TelegramNotificationUxEnv, userId: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO telegram_subscription_settings (user_telegram_id,all_titles,updated_at)
    VALUES (?,0,CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET all_titles=0,updated_at=CURRENT_TIMESTAMP
  `).bind(userId).run();
  await Promise.all([
    env.DB.prepare('DELETE FROM title_subscriptions WHERE user_telegram_id = ?').bind(userId).run(),
    env.DB.prepare('DELETE FROM title_subscription_exclusions WHERE user_telegram_id = ?').bind(userId).run(),
  ]);
}

async function userSubscribesToAll(env: TelegramNotificationUxEnv, userId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT all_titles FROM telegram_subscription_settings WHERE user_telegram_id = ? LIMIT 1')
    .bind(userId).first<AllTitlesRow>();
  return Number(row?.all_titles ?? 0) === 1;
}

async function count(statement: D1PreparedStatement): Promise<number> {
  const row = await statement.first<CountRow>();
  const value = Number(row?.count ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

async function ensureNotificationUxSchema(env: TelegramNotificationUxEnv): Promise<void> {
  await ensureTelegramSubscriptionSchema(env);
  await ensureTelegramNotificationSettingsSchema(env);
  await ensureTelegramTextBotUxSchema(env);
}

function asUiSetting(setting: DeliverySetting): NotificationDeliverySetting {
  return { mode: setting.mode, stackSize: setting.stackSize };
}

function safePage(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(9999, value) : 0;
}

async function upsertTelegramUser(
  env: TelegramNotificationUxEnv,
  user: { id: number; username?: string; first_name: string; last_name?: string; language_code?: string },
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id,username,first_name,last_name,language_code,updated_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,
      language_code=excluded.language_code,updated_at=CURRENT_TIMESTAMP
  `).bind(String(user.id), user.username ?? null, user.first_name, user.last_name ?? '', user.language_code ?? null).run();
}

async function respond(
  env: TelegramNotificationUxEnv,
  callback: NonNullable<TelegramSubscriptionUpdate['callback_query']>,
  chatId: number,
  payload: { text: string; parse_mode?: 'HTML'; reply_markup: { inline_keyboard: unknown[][] } },
  ctx?: NotificationExecutionContext,
): Promise<void> {
  const messageId = callback.message?.message_id;
  if (!messageId) {
    await renderTelegramScreen(env, {
      strategy: 'send',
      chatId,
      payload,
      ctx,
      timing: ctx?.telegramLatencyTiming,
    });
    return;
  }

  await renderTelegramScreen(env, {
    strategy: notificationRenderStrategy(callback.data ?? '', callback.message?.text ?? ''),
    chatId,
    messageId,
    payload,
    ctx,
    timing: ctx?.telegramLatencyTiming,
  });
}

async function answerCallback(env: TelegramNotificationUxEnv, callbackId: string, text?: string): Promise<void> {
  if (!callbackId) return;
  await telegramCall(env, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  }).catch(() => undefined);
}

async function telegramCall(env: TelegramNotificationUxEnv, method: string, payload: Record<string, unknown>): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
}
