type D1Row = Record<string, unknown>;
interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = D1Row>(): Promise<T | null>;
}
interface D1DatabaseLike { prepare(query: string): D1PreparedStatementLike }

export interface TelegramTitleProposalAdminAlertEnv {
  DB: D1DatabaseLike;
  TELEGRAM_BOT_TOKEN?: string;
  ADMIN_TELEGRAM_IDS?: string;
}

type TelegramUser = { id: number; username?: string; first_name?: string; last_name?: string };
type TelegramCallback = { from?: TelegramUser; data?: string };
type TelegramUpdate = { callback_query?: TelegramCallback };
type ProposalRow = {
  id: string;
  title: string;
  source_url: string | null;
  comment: string | null;
  source_kind: string | null;
  ranobelib_book_ref: string | null;
  created_at: string | null;
};
type TelegramResponse<T> = { ok?: boolean; result?: T; description?: string };

export type ProposalSubmissionAlertContext = {
  user: TelegramUser;
  previousProposalId: string | null;
};

function adminTelegramIds(env: TelegramTitleProposalAdminAlertEnv): number[] {
  const values = String(env.ADMIN_TELEGRAM_IDS ?? '')
    .split(/[,\s]+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return [...new Set(values)];
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

async function telegramCall<T>(env: TelegramTitleProposalAdminAlertEnv, method: string, payload: Record<string, unknown>): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  return body.result as T;
}

async function latestProposal(env: TelegramTitleProposalAdminAlertEnv, userId: number): Promise<ProposalRow | null> {
  return env.DB.prepare(`SELECT id,title,source_url,comment,source_kind,ranobelib_book_ref,created_at
    FROM chapter_proposals WHERE user_telegram_id=? ORDER BY created_at DESC LIMIT 1`)
    .bind(String(userId)).first<ProposalRow>();
}

export async function captureTitleProposalSubmission(
  request: Request,
  env: TelegramTitleProposalAdminAlertEnv,
): Promise<ProposalSubmissionAlertContext | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;
  const update = await request.clone().json().catch(() => null) as TelegramUpdate | null;
  const callback = update?.callback_query;
  if (!callback?.from || (callback.data !== 'prop:submit' && callback.data !== 'prop:submit:no-raw')) return null;
  const previous = await latestProposal(env, callback.from.id).catch(() => null);
  return { user: callback.from, previousProposalId: previous?.id || null };
}

function userLabel(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || `ID ${user.id}`;
}

function sourceLabel(row: ProposalRow): string {
  if (row.source_kind === 'ranobelib' && row.ranobelib_book_ref) {
    return `RanobeLib: ${row.ranobelib_book_ref}`;
  }
  return row.source_url?.trim() || 'не указан';
}

export async function notifyAdminsForCreatedTitleProposal(
  env: TelegramTitleProposalAdminAlertEnv,
  context: ProposalSubmissionAlertContext,
): Promise<boolean> {
  const row = await latestProposal(env, context.user.id).catch((error) => {
    console.error('Proposal admin alert lookup failed', errorText(error));
    return null;
  });
  if (!row || row.id === context.previousProposalId) return false;
  const admins = adminTelegramIds(env);
  if (!admins.length) return false;
  const text = [
    '📚 Новая заявка на перевод',
    '',
    `Название: ${row.title}`,
    `От: ${userLabel(context.user)} (${context.user.id})`,
    `Источник: ${sourceLabel(row)}`,
    '',
    'Комментарий:',
    row.comment?.trim() || 'Без комментария',
  ].join('\n');
  const replyMarkup = {
    inline_keyboard: [[{ text: '👁 Открыть заявку', callback_data: `prop:view:${row.id}` }]],
  };
  for (const adminId of admins) {
    await telegramCall(env, 'sendMessage', { chat_id: adminId, text, reply_markup: replyMarkup }).catch((error) => {
      console.error('Proposal admin Telegram alert failed', { adminId, error: errorText(error) });
    });
  }
  return true;
}
