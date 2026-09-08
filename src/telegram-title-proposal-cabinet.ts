import { mainMenuButton, type TelegramButton, type TelegramPayload } from './telegram-bot-ui.js';

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
};
type D1Database = { prepare(query: string): D1PreparedStatement };

type TelegramUser = { id: number; first_name: string; username?: string };
type TelegramMessage = { message_id: number; chat: { id: number; type?: string } };
type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};
type TelegramUpdate = { callback_query?: TelegramCallbackQuery };

type ProposalCounts = {
  active_count: number | string | null;
  completed_count: number | string | null;
  all_count: number | string | null;
};
type ProposalRow = {
  id: string;
  user_telegram_id: string;
  title: string;
  source_kind?: string | null;
  ranobelib_book_ref?: string | null;
  source_url?: string | null;
  status: string;
  vote_count?: number | string | null;
  comment?: string | null;
  admin_note?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};
type CabinetFilter = 'a' | 'd' | 'x';

type ParsedView = { proposalId: string; filter: CabinetFilter | null; page: number };

export type TelegramTitleProposalCabinetEnv = {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
};

const PAGE_SIZE = 8;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const ACTIVE_STATUSES = new Set(['pending', 'approved', 'planned', 'in_progress']);

export async function handleTelegramTitleProposalCabinetWebhookRequest(
  request: Request,
  env: TelegramTitleProposalCabinetEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (secret && request.headers.get('x-telegram-bot-api-secret-token') !== secret) return null;

  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  const callback = update?.callback_query;
  if (!callback?.data || callback.message?.chat?.type !== 'private' || !callback.message.chat.id) return null;

  const data = callback.data;
  if (data === 'prop:mine') {
    const counts = await loadCounts(env, callback.from.id);
    await editCallbackMessage(env, callback, buildCabinetLanding(counts));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  const list = parseListCallback(data);
  if (list) {
    const rows = await loadList(env, callback.from.id, list.filter, list.page);
    await editCallbackMessage(env, callback, buildCabinetList(rows, list.filter, list.page));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  const view = parseViewCallback(data);
  if (view) {
    const row = await loadProposal(env, view.proposalId);
    if (!row || (row.status === 'rejected' && row.user_telegram_id !== String(callback.from.id))) {
      await answerCallback(env, callback.id, 'Заявка не найдена или недоступна.');
      return json({ ok: true });
    }
    await editCallbackMessage(env, callback, buildProposalCard(row, callback.from.id, view));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  return null;
}

async function loadCounts(env: TelegramTitleProposalCabinetEnv, userId: number): Promise<ProposalCounts> {
  return (await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('pending','approved','planned','in_progress') THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN status IN ('done','rejected') THEN 1 ELSE 0 END) AS completed_count,
      COUNT(*) AS all_count
    FROM chapter_proposals
    WHERE user_telegram_id=?
  `).bind(String(userId)).first<ProposalCounts>()) ?? {
    active_count: 0,
    completed_count: 0,
    all_count: 0,
  };
}

async function loadList(
  env: TelegramTitleProposalCabinetEnv,
  userId: number,
  filter: CabinetFilter,
  page: number,
): Promise<ProposalRow[]> {
  const where = filter === 'a'
    ? " AND status IN ('pending','approved','planned','in_progress')"
    : filter === 'd'
      ? " AND status IN ('done','rejected')"
      : '';
  return (await env.DB.prepare(`
    SELECT p.id,p.user_telegram_id,p.title,p.source_kind,p.ranobelib_book_ref,p.source_url,p.status,
           p.comment,p.admin_note,p.created_at,p.updated_at,
           (SELECT COUNT(*) FROM proposal_votes v WHERE v.proposal_id=p.id) AS vote_count
    FROM chapter_proposals p
    WHERE p.user_telegram_id=?${where}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(String(userId), PAGE_SIZE, page * PAGE_SIZE).all<ProposalRow>()).results;
}

async function loadProposal(env: TelegramTitleProposalCabinetEnv, proposalId: string): Promise<ProposalRow | null> {
  return env.DB.prepare(`
    SELECT p.id,p.user_telegram_id,p.title,p.source_kind,p.ranobelib_book_ref,p.source_url,p.status,
           p.comment,p.admin_note,p.created_at,p.updated_at,
           (SELECT COUNT(*) FROM proposal_votes v WHERE v.proposal_id=p.id) AS vote_count
    FROM chapter_proposals p
    WHERE id=?
    LIMIT 1
  `).bind(proposalId).first<ProposalRow>();
}

function buildCabinetLanding(counts: ProposalCounts): TelegramPayload {
  const active = numeric(counts.active_count);
  const completed = numeric(counts.completed_count);
  const all = numeric(counts.all_count);
  return {
    text: [
      '📚 <b>Мои заявки</b>',
      '',
      `Активные: <b>${active}</b>`,
      `Завершённые: <b>${completed}</b>`,
      `Всего: <b>${all}</b>`,
      '',
      'Выберите раздел:',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: `🟢 Активные · ${active}`, callback_data: 'prop:mine:a:0' }],
        [{ text: `✅ Завершённые · ${completed}`, callback_data: 'prop:mine:d:0' }],
        [{ text: `📋 Все · ${all}`, callback_data: 'prop:mine:x:0' }],
        [mainMenuButton()],
      ],
    },
  };
}

function buildCabinetList(rows: ProposalRow[], filter: CabinetFilter, page: number): TelegramPayload {
  const title = filter === 'a' ? 'Активные заявки' : filter === 'd' ? 'Завершённые заявки' : 'Все заявки';
  const lines = [`📚 <b>${title}</b>`, ''];
  const keyboard: TelegramButton[][] = [];

  if (!rows.length) {
    lines.push(page > 0 ? 'На этой странице заявок больше нет.' : 'Здесь пока нет заявок.');
  } else {
    rows.forEach((row, index) => {
      const ordinal = page * PAGE_SIZE + index + 1;
      lines.push(`${ordinal}. ${statusLabel(row.status)} · 👍 ${numeric(row.vote_count)}\n<b>${escapeHtml(row.title)}</b>`);
      keyboard.push([{
        text: `${statusIcon(row.status)} ${truncate(row.title, 42)} · 👍 ${numeric(row.vote_count)}`,
        callback_data: `prop:view:${row.id}:${filter}:${page}`,
      }]);
    });
  }

  const pager: TelegramButton[] = [];
  if (page > 0) pager.push({ text: '◀️', callback_data: `prop:mine:${filter}:${page - 1}` });
  pager.push({ text: `${page + 1}`, callback_data: 'prop:noop' });
  if (rows.length === PAGE_SIZE) pager.push({ text: '▶️', callback_data: `prop:mine:${filter}:${page + 1}` });
  if (pager.length > 1) keyboard.push(pager);
  keyboard.push([{ text: '↩️ К разделам', callback_data: 'prop:mine' }]);
  keyboard.push([mainMenuButton()]);

  return {
    text: lines.join('\n\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
  };
}

function buildProposalCard(row: ProposalRow, viewerId: number, context: ParsedView): TelegramPayload {
  const own = row.user_telegram_id === String(viewerId);
  const source = row.source_url?.trim() || '—';
  const lines = [
    `📚 <b>${escapeHtml(row.title)}</b>`,
    '',
    `Статус: <b>${statusLabel(row.status)}</b>`,
    `Поддержали: <b>${numeric(row.vote_count)}</b>`,
    `Источник: ${escapeHtml(source)}`,
  ];
  if (row.comment?.trim()) lines.push(`Комментарий: ${escapeHtml(row.comment.trim())}`);
  if (own && row.admin_note?.trim()) lines.push(`Ответ команды: ${escapeHtml(row.admin_note.trim())}`);
  if (row.created_at?.trim()) lines.push(`Создана: ${escapeHtml(datePart(row.created_at))}`);
  if (row.updated_at?.trim()) lines.push(`Обновлена: ${escapeHtml(datePart(row.updated_at))}`);

  const keyboard: TelegramButton[][] = [];
  if (!own && ACTIVE_STATUSES.has(row.status)) {
    keyboard.push([{ text: '👍 Поддержать', callback_data: `prop:support:${row.id}` }]);
  }
  const backData = context.filter ? `prop:mine:${context.filter}:${context.page}` : 'prop:mine';
  keyboard.push([{ text: '↩️ Назад', callback_data: backData }]);
  keyboard.push([mainMenuButton()]);

  return {
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
  };
}

function parseListCallback(data: string): { filter: CabinetFilter; page: number } | null {
  const match = data.match(/^prop:mine:([adx]):(\d{1,4})$/);
  if (!match) return null;
  const page = Math.min(9999, Number(match[2]));
  return { filter: match[1] as CabinetFilter, page: Number.isSafeInteger(page) ? page : 0 };
}

function parseViewCallback(data: string): ParsedView | null {
  if (!data.startsWith('prop:view:')) return null;
  const body = data.slice('prop:view:'.length);
  const contextual = body.match(/^([^:]+):([adx]):(\d{1,4})$/);
  if (contextual) {
    return {
      proposalId: contextual[1],
      filter: contextual[2] as CabinetFilter,
      page: Math.min(9999, Number(contextual[3]) || 0),
    };
  }
  if (!body || body.includes(':')) return null;
  return { proposalId: body, filter: null, page: 0 };
}

function statusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'На рассмотрении';
    case 'approved': return 'Одобрена';
    case 'planned': return 'В плане';
    case 'in_progress': return 'Перевод начат';
    case 'done': return 'Завершена';
    case 'rejected': return 'Отклонена';
    default: return 'Неизвестно';
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'pending': return '🕒';
    case 'approved': return '✅';
    case 'planned': return '📌';
    case 'in_progress': return '🟢';
    case 'done': return '🏁';
    case 'rejected': return '❌';
    default: return '•';
  }
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function datePart(value: string): string {
  return value.trim().slice(0, 10) || value.trim();
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function editCallbackMessage(
  env: TelegramTitleProposalCabinetEnv,
  callback: TelegramCallbackQuery,
  payload: TelegramPayload,
): Promise<void> {
  if (!callback.message?.chat.id) return;
  await telegramCall(env, 'editMessageText', {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    ...payload,
  });
}

async function answerCallback(env: TelegramTitleProposalCabinetEnv, callbackId: string, text?: string): Promise<void> {
  await telegramCall(env, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  }).catch(() => undefined);
}

async function telegramCall(
  env: TelegramTitleProposalCabinetEnv,
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
  if (!response.ok || !body?.ok) throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
}
