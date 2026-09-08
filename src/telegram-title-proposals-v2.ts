import { buildMainMenu, type TelegramPayload } from './telegram-bot-ui.js';
import { ensureTelegramTextBotUxSchema } from './telegram-text-bot-ux-schema.js';
import {
  buildProposalCommentPrompt,
  buildProposalDeleteConfirmation,
  buildProposalInputPrompt,
  buildProposalRanobeLibCandidates,
  buildProposalRanobeLibConfirmation,
  buildProposalRawAdded,
  buildProposalRawPrompt,
  buildProposalResume,
  buildProposalReview,
  buildProposalSourceChoice,
  type ProposalUiSession,
} from './telegram-title-proposal-ui.js';

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

type ProposalSession = ProposalUiSession & {
  user_telegram_id: string;
  chat_id: string;
  candidates_json: string;
  raw_file_unique_id: string | null;
  raw_mime_type: string | null;
  updated_at: string;
};

type RanobeLibTeam = { name?: string };
type RanobeLibCandidate = {
  id?: number;
  name?: string;
  rus_name?: string;
  eng_name?: string;
  slug?: string;
  slug_url?: string;
  status?: { label?: string };
  scanlateStatus?: { label?: string };
  items_count?: { uploaded?: number };
  teams?: RanobeLibTeam[];
};
type RanobeLibChapter = { number?: string | number; name?: string; index?: number };

export type TelegramTitleProposalV2Env = {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const RANOBELIB_API_BASE = 'https://api.cdnlibs.org/api';
const RANOBELIB_SITE_ID = '3';
const MAX_TELEGRAM_RAW_BYTES = 20 * 1024 * 1024;
const ALLOWED_RAW_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'txt', 'md', 'rtf', 'pdf', 'epub', 'doc', 'docx',
]);
const schemaPromises = new WeakMap<object, Promise<void>>();

export async function handleTelegramTitleProposalV2WebhookRequest(
  request: Request,
  env: TelegramTitleProposalV2Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return null;
  const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (expectedSecret && request.headers.get('x-telegram-bot-api-secret-token') !== expectedSecret) return null;

  const update = await request.json().catch(() => null) as TelegramUpdate | null;
  if (!update) return null;
  const origin = url.origin;

  const message = update.message;
  const text = message?.text?.trim() ?? '';
  if (message?.chat?.type === 'private' && message.from && isPlainCommand(text, 'start')) {
    await upsertTelegramUser(env, message.from);
    await sendMessage(env, message.chat.id, buildMainMenu(origin));
    return json({ ok: true });
  }

  if (message?.chat?.type === 'private' && message.from && isPlainCommand(text, 'propose')) {
    await ensureUxSchema(env);
    await upsertTelegramUser(env, message.from);
    const session = await loadProposalSession(env, message.from.id);
    if (session && isMeaningfulDraft(session)) {
      await sendMessage(env, message.chat.id, buildProposalResume(session));
    } else {
      await resetProposalSession(env, message.from, message.chat.id);
      await sendMessage(env, message.chat.id, buildProposalSourceChoice());
    }
    return json({ ok: true });
  }

  const callback = update.callback_query;
  if (callback?.message?.chat?.type === 'private' && callback.message.chat.id && callback.data) {
    const callbackResponse = await handleV2Callback(env, callback, origin);
    if (callbackResponse) return callbackResponse;
  }

  if (!message?.from || message.chat.type !== 'private') return null;
  if (!text && !message.document) return null;
  if (text.startsWith('/')) return null;

  await ensureUxSchema(env);
  const session = await loadProposalSession(env, message.from.id);
  if (!session) return null;
  return handleSessionMessage(env, message, session);
}

async function handleV2Callback(
  env: TelegramTitleProposalV2Env,
  callback: TelegramCallbackQuery,
  origin: string,
): Promise<Response | null> {
  const data = callback.data ?? '';
  const claimed = data === 'prop:new'
    || data === 'prop:home'
    || data === 'prop:resume'
    || data === 'prop:back'
    || data === 'prop:cancel'
    || data === 'prop:cancel:confirm'
    || data === 'prop:cancel:keep'
    || data === 'prop:source:ranobelib'
    || data === 'prop:source:external'
    || data === 'prop:confirm'
    || data === 'prop:raw:skip'
    || data === 'prop:raw:continue'
    || data === 'prop:raw:replace'
    || data === 'prop:comment:skip'
    || data === 'prop:query:again'
    || data === 'prop:noop'
    || data.startsWith('prop:pick:')
    || data.startsWith('prop:results:');
  if (!claimed) return null;

  await ensureUxSchema(env);
  await upsertTelegramUser(env, callback.from);

  if (data === 'prop:home') {
    await editCallbackMessage(env, callback, buildMainMenu(origin));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:new') {
    const session = await loadProposalSession(env, callback.from.id);
    if (session && isMeaningfulDraft(session)) {
      await editCallbackMessage(env, callback, buildProposalResume(session));
    } else {
      await resetProposalSession(env, callback.from, callback.message!.chat.id);
      await editCallbackMessage(env, callback, buildProposalSourceChoice());
    }
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:noop') {
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  const session = await loadProposalSession(env, callback.from.id);
  if (data === 'prop:cancel:confirm') {
    await deleteProposalSession(env, callback.from.id);
    await editCallbackMessage(env, callback, buildMainMenu(origin));
    await answerCallback(env, callback.id, 'Черновик удалён.');
    return json({ ok: true });
  }

  if (!session) return null;

  if (data === 'prop:resume' || data === 'prop:cancel:keep') {
    await editCallbackMessage(env, callback, renderSession(session));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:cancel') {
    if (isMeaningfulDraft(session)) {
      await editCallbackMessage(env, callback, buildProposalDeleteConfirmation());
    } else {
      await deleteProposalSession(env, callback.from.id);
      await editCallbackMessage(env, callback, buildMainMenu(origin));
    }
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:back') {
    const previous = previousStep(session);
    if (!previous) {
      await editCallbackMessage(env, callback, buildMainMenu(origin));
    } else {
      await setSessionStep(env, callback.from.id, previous);
      const updated = { ...session, step: previous };
      await editCallbackMessage(env, callback, renderSession(updated));
    }
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:source:ranobelib' || data === 'prop:source:external') {
    const sourceKind = data.endsWith(':ranobelib') ? 'ranobelib' : 'external';
    const step = sourceKind === 'ranobelib' ? 'ranobelib_query' : 'external_title';
    await env.DB.prepare(`
      UPDATE telegram_proposal_sessions
      SET step=?,source_kind=?,candidates_json='[]',updated_at=CURRENT_TIMESTAMP
      WHERE user_telegram_id=?
    `).bind(step, sourceKind, String(callback.from.id)).run();
    await editCallbackMessage(env, callback, buildProposalInputPrompt(step, { ...session, step, source_kind: sourceKind }));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:query:again') {
    await setSessionStep(env, callback.from.id, 'ranobelib_query');
    await editCallbackMessage(env, callback, buildProposalInputPrompt('ranobelib_query', { ...session, step: 'ranobelib_query' }));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data.startsWith('prop:results:')) {
    const page = Math.max(0, Number(data.slice('prop:results:'.length)) || 0);
    const candidates = parseCandidates(session.candidates_json);
    await editCallbackMessage(env, callback, candidatePayload(candidates, page));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data.startsWith('prop:pick:')) {
    const index = Number(data.slice('prop:pick:'.length));
    const candidates = parseCandidates(session.candidates_json);
    const candidate = Number.isInteger(index) && index >= 0 ? candidates[index] : undefined;
    const ref = candidate ? ranobeLibCandidateRef(candidate) : null;
    if (!candidate || !ref) {
      await answerCallback(env, callback.id, 'Этот вариант больше недоступен.');
      return json({ ok: true });
    }
    try {
      const [detail, chapters] = await Promise.all([fetchRanobeLibTitle(ref), fetchRanobeLibChapters(ref)]);
      await saveRanobeLibConfirmation(env, callback.from.id, detail, ref);
      await editCallbackMessage(env, callback, confirmationPayload(detail, ref, chapters));
      await answerCallback(env, callback.id);
    } catch {
      await answerCallback(env, callback.id, 'RanobeLib сейчас не отвечает. Попробуйте ещё раз.');
    }
    return json({ ok: true });
  }

  if (data === 'prop:confirm') {
    await setSessionStep(env, callback.from.id, 'raw');
    await editCallbackMessage(env, callback, buildProposalRawPrompt({ ...session, step: 'raw' }));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:raw:skip') {
    await env.DB.prepare(`
      UPDATE telegram_proposal_sessions
      SET step='comment',raw_file_id=NULL,raw_file_unique_id=NULL,raw_file_name=NULL,raw_file_size=NULL,
          raw_mime_type=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE user_telegram_id=?
    `).bind(String(callback.from.id)).run();
    await editCallbackMessage(env, callback, buildProposalCommentPrompt({ ...session, step: 'comment', raw_file_id: null, raw_file_name: null, raw_file_size: null }));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:raw:continue') {
    if (!session.raw_file_id) {
      await answerCallback(env, callback.id, 'Сначала отправьте RAW-файл или пропустите этот шаг.');
      return json({ ok: true });
    }
    await setSessionStep(env, callback.from.id, 'comment');
    await editCallbackMessage(env, callback, buildProposalCommentPrompt({ ...session, step: 'comment' }));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:raw:replace') {
    await env.DB.prepare(`
      UPDATE telegram_proposal_sessions
      SET raw_file_id=NULL,raw_file_unique_id=NULL,raw_file_name=NULL,raw_file_size=NULL,raw_mime_type=NULL,
          step='raw',updated_at=CURRENT_TIMESTAMP
      WHERE user_telegram_id=?
    `).bind(String(callback.from.id)).run();
    await editCallbackMessage(env, callback, buildProposalRawPrompt({ ...session, step: 'raw', raw_file_id: null, raw_file_name: null, raw_file_size: null }));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:comment:skip') {
    await env.DB.prepare(`
      UPDATE telegram_proposal_sessions
      SET step=?,comment='',updated_at=CURRENT_TIMESTAMP
      WHERE user_telegram_id=?
    `).bind('review', String(callback.from.id)).run();
    await editCallbackMessage(env, callback, buildProposalReview({ ...session, step: 'review', comment: '' }));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  return null;
}

async function handleSessionMessage(
  env: TelegramTitleProposalV2Env,
  message: TelegramMessage & { from: TelegramUser },
  session: ProposalSession,
): Promise<Response> {
  const text = message.text?.trim() ?? '';
  if (session.step === 'external_title') {
    if (text.length < 2 || text.length > 180) {
      await sendMessage(env, message.chat.id, buildProposalInputPrompt('external_title', session));
      return json({ ok: true });
    }
    await env.DB.prepare(`
      UPDATE telegram_proposal_sessions
      SET step=?,title=?,updated_at=CURRENT_TIMESTAMP
      WHERE user_telegram_id=?
    `).bind('external_url', text, String(message.from.id)).run();
    await sendMessage(env, message.chat.id, buildProposalInputPrompt('external_url', { ...session, step: 'external_url', title: text }));
    return json({ ok: true });
  }

  if (session.step === 'external_url') {
    if (!isHttpUrl(text) || text.length > 500) {
      await sendMessage(env, message.chat.id, buildProposalInputPrompt('external_url', session));
      return json({ ok: true });
    }
    await env.DB.prepare(`
      UPDATE telegram_proposal_sessions
      SET step=?,source_url=?,updated_at=CURRENT_TIMESTAMP
      WHERE user_telegram_id=?
    `).bind('raw', text, String(message.from.id)).run();
    await sendMessage(env, message.chat.id, buildProposalRawPrompt({ ...session, step: 'raw', source_url: text }));
    return json({ ok: true });
  }

  if (session.step === 'ranobelib_query' && text) {
    const directRef = parseRanobeLibBookRef(text);
    if (directRef) {
      try {
        const [detail, chapters] = await Promise.all([fetchRanobeLibTitle(directRef), fetchRanobeLibChapters(directRef)]);
        await saveRanobeLibConfirmation(env, message.from.id, detail, directRef);
        await sendMessage(env, message.chat.id, confirmationPayload(detail, directRef, chapters));
      } catch {
        await sendMessage(env, message.chat.id, buildProposalInputPrompt('ranobelib_query', session));
      }
      return json({ ok: true });
    }
    try {
      const candidates = await searchRanobeLib(text);
      if (!candidates.length) {
        await sendMessage(env, message.chat.id, buildProposalInputPrompt('ranobelib_query', session));
        return json({ ok: true });
      }
      await env.DB.prepare(`
        UPDATE telegram_proposal_sessions SET candidates_json=?,updated_at=CURRENT_TIMESTAMP
        WHERE user_telegram_id=?
      `).bind(JSON.stringify(candidates), String(message.from.id)).run();
      await sendMessage(env, message.chat.id, candidatePayload(candidates, 0));
    } catch {
      await sendMessage(env, message.chat.id, buildProposalInputPrompt('ranobelib_query', session));
    }
    return json({ ok: true });
  }

  if (session.step === 'raw') {
    const document = message.document;
    if (!document || !isAllowedRaw(document)) {
      await sendMessage(env, message.chat.id, buildProposalRawPrompt(session));
      return json({ ok: true });
    }
    await env.DB.prepare(`
      UPDATE telegram_proposal_sessions
      SET raw_file_id=?,raw_file_unique_id=?,raw_file_name=?,raw_file_size=?,raw_mime_type=?,updated_at=CURRENT_TIMESTAMP
      WHERE user_telegram_id=?
    `).bind(
      document.file_id,
      document.file_unique_id,
      document.file_name ?? 'raw.bin',
      document.file_size ?? null,
      document.mime_type ?? 'application/octet-stream',
      String(message.from.id),
    ).run();
    await sendMessage(env, message.chat.id, buildProposalRawAdded({
      ...session,
      raw_file_id: document.file_id,
      raw_file_name: document.file_name ?? 'raw.bin',
      raw_file_size: document.file_size ?? null,
    }));
    return json({ ok: true });
  }

  if (session.step === 'comment') {
    if (!text || text.length > 1500) {
      await sendMessage(env, message.chat.id, buildProposalCommentPrompt(session));
      return json({ ok: true });
    }
    await env.DB.prepare(`
      UPDATE telegram_proposal_sessions
      SET step=?,comment=?,updated_at=CURRENT_TIMESTAMP
      WHERE user_telegram_id=?
    `).bind('review', text, String(message.from.id)).run();
    await sendMessage(env, message.chat.id, buildProposalReview({ ...session, step: 'review', comment: text }));
    return json({ ok: true });
  }

  await sendMessage(env, message.chat.id, renderSession(session));
  return json({ ok: true });
}

function renderSession(session: ProposalSession): TelegramPayload {
  switch (session.step) {
    case 'choose_source': return buildProposalSourceChoice();
    case 'ranobelib_query':
    case 'external_title':
    case 'external_url': return buildProposalInputPrompt(session.step, session);
    case 'ranobelib_confirm': return buildProposalRanobeLibConfirmation({
      title: session.title || 'Тайтл RanobeLib',
      url: session.source_url || (session.ranobelib_book_ref ? ranobeLibBookUrl(session.ranobelib_book_ref) : ''),
      status: 'сохранено',
      teamNames: [],
      uploaded: 0,
      latestNumber: '—',
      latestName: null,
    });
    case 'raw': return session.raw_file_id ? buildProposalRawAdded(session) : buildProposalRawPrompt(session);
    case 'comment': return buildProposalCommentPrompt(session);
    case 'review': return buildProposalReview(session);
    default: return buildProposalSourceChoice();
  }
}

function previousStep(session: ProposalSession): string | null {
  switch (session.step) {
    case 'choose_source': return null;
    case 'ranobelib_query': return 'choose_source';
    case 'ranobelib_confirm': return 'ranobelib_query';
    case 'external_title': return 'choose_source';
    case 'external_url': return 'external_title';
    case 'raw': return session.source_kind === 'ranobelib' ? 'ranobelib_confirm' : 'external_url';
    case 'comment': return 'raw';
    case 'review': return 'comment';
    default: return null;
  }
}

function isMeaningfulDraft(session: ProposalSession): boolean {
  return session.step !== 'choose_source'
    || Boolean(session.source_kind)
    || Boolean(session.title.trim())
    || Boolean(session.source_url.trim())
    || Boolean(session.raw_file_id)
    || Boolean(session.comment.trim());
}

async function ensureUxSchema(env: TelegramTitleProposalV2Env): Promise<void> {
  const key = env.DB as unknown as object;
  let pending = schemaPromises.get(key);
  if (!pending) {
    pending = ensureTelegramTextBotUxSchema(env).catch((error) => {
      schemaPromises.delete(key);
      throw error;
    });
    schemaPromises.set(key, pending);
  }
  await pending;
}

async function upsertTelegramUser(env: TelegramTitleProposalV2Env, user: TelegramUser): Promise<void> {
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

async function resetProposalSession(env: TelegramTitleProposalV2Env, user: TelegramUser, chatId: number): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO telegram_proposal_sessions (
      user_telegram_id,chat_id,step,source_kind,ranobelib_book_ref,title,original_title,source_url,
      candidates_json,raw_file_id,raw_file_unique_id,raw_file_name,raw_file_size,raw_mime_type,comment,return_to_review,
      created_at,updated_at
    ) VALUES (?,?,?,NULL,NULL,'','','','[]',NULL,NULL,NULL,NULL,NULL,'',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(user_telegram_id) DO UPDATE SET
      chat_id=excluded.chat_id,step=excluded.step,source_kind=NULL,ranobelib_book_ref=NULL,title='',original_title='',
      source_url='',candidates_json='[]',raw_file_id=NULL,raw_file_unique_id=NULL,raw_file_name=NULL,raw_file_size=NULL,
      raw_mime_type=NULL,comment='',return_to_review=0,updated_at=CURRENT_TIMESTAMP
  `).bind(String(user.id), String(chatId), 'choose_source').run();
}

async function loadProposalSession(env: TelegramTitleProposalV2Env, userId: number): Promise<ProposalSession | null> {
  return env.DB.prepare(`
    SELECT user_telegram_id,chat_id,step,source_kind,ranobelib_book_ref,title,original_title,source_url,candidates_json,
           raw_file_id,raw_file_unique_id,raw_file_name,raw_file_size,raw_mime_type,comment,return_to_review,updated_at
    FROM telegram_proposal_sessions
    WHERE user_telegram_id=? AND updated_at >= datetime('now','-24 hours')
    LIMIT 1
  `).bind(String(userId)).first<ProposalSession>();
}

async function setSessionStep(env: TelegramTitleProposalV2Env, userId: number, step: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions SET step=?,updated_at=CURRENT_TIMESTAMP WHERE user_telegram_id=?
  `).bind(step, String(userId)).run();
}

async function deleteProposalSession(env: TelegramTitleProposalV2Env, userId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM telegram_proposal_sessions WHERE user_telegram_id=?').bind(String(userId)).run();
}

function parseCandidates(raw: string): RanobeLibCandidate[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function candidatePayload(candidates: RanobeLibCandidate[], page: number): TelegramPayload {
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(candidates.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * pageSize;
  return buildProposalRanobeLibCandidates(
    candidates.slice(start, start + pageSize).map((candidate, offset) => ({
      index: start + offset,
      title: ranobeLibDisplayTitle(candidate),
    })),
    safePage,
    totalPages,
  );
}

async function saveRanobeLibConfirmation(
  env: TelegramTitleProposalV2Env,
  userId: number,
  detail: RanobeLibCandidate,
  ref: string,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions
    SET step=?,ranobelib_book_ref=?,title=?,original_title=?,source_url=?,candidates_json='[]',updated_at=CURRENT_TIMESTAMP
    WHERE user_telegram_id=?
  `).bind(
    'ranobelib_confirm',
    ref,
    ranobeLibDisplayTitle(detail),
    ranobeLibOriginalTitle(detail),
    ranobeLibBookUrl(ref),
    String(userId),
  ).run();
}

function confirmationPayload(detail: RanobeLibCandidate, ref: string, chapters: RanobeLibChapter[]): TelegramPayload {
  const latest = latestRanobeLibChapter(chapters);
  return buildProposalRanobeLibConfirmation({
    title: ranobeLibDisplayTitle(detail),
    url: ranobeLibBookUrl(ref),
    status: detail.scanlateStatus?.label?.trim() || detail.status?.label?.trim() || 'неизвестно',
    teamNames: (detail.teams ?? []).map((team) => team.name?.trim()).filter((name): name is string => Boolean(name)),
    uploaded: Number(detail.items_count?.uploaded ?? chapters.length),
    latestNumber: latest?.number != null ? String(latest.number) : '—',
    latestName: latest?.name?.trim() || null,
  });
}

async function searchRanobeLib(query: string): Promise<RanobeLibCandidate[]> {
  const url = new URL(`${RANOBELIB_API_BASE}/manga`);
  url.searchParams.append('site_id[]', RANOBELIB_SITE_ID);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '10');
  const body = await fetchRanobeLib(url) as { data?: unknown } | null;
  return Array.isArray(body?.data) ? body.data.slice(0, 10) as RanobeLibCandidate[] : [];
}

async function fetchRanobeLibTitle(ref: string): Promise<RanobeLibCandidate> {
  const url = new URL(`${RANOBELIB_API_BASE}/manga/${encodeURIComponent(ref)}`);
  url.searchParams.append('site_id[]', RANOBELIB_SITE_ID);
  const body = await fetchRanobeLib(url) as { data?: unknown } | null;
  if (!body?.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new Error('RanobeLib title payload is missing');
  return body.data as RanobeLibCandidate;
}

async function fetchRanobeLibChapters(ref: string): Promise<RanobeLibChapter[]> {
  const url = new URL(`${RANOBELIB_API_BASE}/manga/${encodeURIComponent(ref)}/chapters`);
  url.searchParams.append('site_id[]', RANOBELIB_SITE_ID);
  const body = await fetchRanobeLib(url) as { data?: unknown } | null;
  return Array.isArray(body?.data) ? body.data as RanobeLibChapter[] : [];
}

async function fetchRanobeLib(url: URL): Promise<unknown> {
  const response = await fetch(url.toString(), { headers: { accept: 'application/json', 'site-id': RANOBELIB_SITE_ID } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`RanobeLib API HTTP ${response.status}`);
  return body;
}

function latestRanobeLibChapter(chapters: RanobeLibChapter[]): RanobeLibChapter | null {
  if (!chapters.length) return null;
  return chapters.reduce((latest, current) => {
    const latestIndex = typeof latest.index === 'number' ? latest.index : Number(latest.number) || 0;
    const currentIndex = typeof current.index === 'number' ? current.index : Number(current.number) || 0;
    return currentIndex >= latestIndex ? current : latest;
  });
}

function ranobeLibCandidateRef(candidate: RanobeLibCandidate): string | null {
  const slugUrl = candidate.slug_url?.trim() ?? '';
  if (/^\d+--[a-z0-9][a-z0-9-]*$/i.test(slugUrl)) return slugUrl;
  const slug = candidate.slug?.trim() ?? '';
  return Number.isSafeInteger(candidate.id) && candidate.id && slug ? `${candidate.id}--${slug}` : null;
}

function ranobeLibDisplayTitle(candidate: RanobeLibCandidate): string {
  return candidate.rus_name?.trim() || candidate.name?.trim() || candidate.eng_name?.trim() || ranobeLibCandidateRef(candidate) || 'Без названия';
}

function ranobeLibOriginalTitle(candidate: RanobeLibCandidate): string {
  return candidate.name?.trim() || candidate.eng_name?.trim() || candidate.rus_name?.trim() || ranobeLibDisplayTitle(candidate);
}

function ranobeLibBookUrl(ref: string): string {
  return `https://ranobelib.me/ru/book/${ref}`;
}

function parseRanobeLibBookRef(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d+--[a-z0-9][a-z0-9-]*$/i.test(trimmed)) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'ranobelib.me' && !url.hostname.endsWith('.ranobelib.me')) return null;
    return url.pathname.match(/\/(?:ru\/)?(?:book|manga)\/(\d+--[a-z0-9][a-z0-9-]*)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

function isAllowedRaw(document: TelegramDocument): boolean {
  if (document.file_size != null && document.file_size > MAX_TELEGRAM_RAW_BYTES) return false;
  const filename = document.file_name?.trim() ?? '';
  const extension = filename.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? '';
  return Boolean(extension && ALLOWED_RAW_EXTENSIONS.has(extension));
}

function isPlainCommand(text: string, command: string): boolean {
  return new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?$`, 'i').test(text.trim());
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function sendMessage(env: TelegramTitleProposalV2Env, chatId: number, payload: TelegramPayload): Promise<void> {
  await telegramCall(env, 'sendMessage', { chat_id: chatId, ...payload });
}

async function editCallbackMessage(env: TelegramTitleProposalV2Env, callback: TelegramCallbackQuery, payload: TelegramPayload): Promise<void> {
  if (!callback.message?.chat.id) return;
  await telegramCall(env, 'editMessageText', {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    ...payload,
  });
}

async function answerCallback(env: TelegramTitleProposalV2Env, callbackId: string, text?: string): Promise<void> {
  await telegramCall(env, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  }).catch(() => undefined);
}

async function telegramCall(env: TelegramTitleProposalV2Env, method: string, payload: Record<string, unknown>): Promise<void> {
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
