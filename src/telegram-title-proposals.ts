type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
};

type D1Database = { prepare(query: string): D1PreparedStatement };

type R2PutResult = { etag?: string } | unknown;
type R2BucketLike = {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<R2PutResult>;
};

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

type ProposalRecord = {
  id: string;
  user_telegram_id: string;
  proposal_type?: string;
  title: string;
  source_url?: string;
  source_kind?: string;
  ranobelib_book_ref?: string | null;
  comment?: string;
  status: string;
  admin_note?: string;
  created_at?: string;
  updated_at?: string;
  vote_count?: number | string;
};

type RanobeLibTeam = {
  id?: number;
  name?: string;
  slug?: string;
  slug_url?: string;
};

type RanobeLibCandidate = {
  id?: number;
  name?: string;
  rus_name?: string;
  eng_name?: string;
  slug?: string;
  slug_url?: string;
  status?: { id?: number; label?: string };
  scanlateStatus?: { id?: number; label?: string };
  items_count?: { uploaded?: number; total?: number };
  teams?: RanobeLibTeam[];
};

type RanobeLibChapter = {
  id?: number;
  volume?: string | number;
  number?: string | number;
  name?: string;
  index?: number;
};

export interface TelegramTitleProposalEnv {
  DB: D1Database;
  FILES?: R2BucketLike;
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
const ACTIVE_PROPOSAL_STATUSES = new Set(['pending', 'approved', 'planned', 'in_progress']);
const RANOBELIB_API_BASE = 'https://api.cdnlibs.org/api';
const RANOBELIB_SITE_ID = '3';

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

function safeFilename(filename: string): string {
  return filename.replace(/[\r\n"\\/]/g, '_').slice(0, 180) || 'raw.bin';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}

function normalizeTitleKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeSourceKey(value: string): string {
  if (!value.trim()) return '';
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    let path = url.pathname.replace(/\/{2,}/g, '/');
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return `${host}${path || '/'}`;
  } catch {
    return '';
  }
}

function localizedStatus(status: string): string {
  switch (status) {
    case 'pending': return '🟡 На рассмотрении';
    case 'approved': return '🟣 Одобрено';
    case 'planned': return '🔵 В плане';
    case 'in_progress': return '🟢 Перевод начат';
    case 'done': return '✅ Готово';
    case 'rejected': return '🔴 Отклонено';
    default: return status || 'Неизвестно';
  }
}

function parseRanobeLibBookRef(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d+--[a-z0-9][a-z0-9-]*$/i.test(trimmed)) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'ranobelib.me' && !url.hostname.endsWith('.ranobelib.me')) return null;
    const match = url.pathname.match(/\/(?:ru\/)?(?:book|manga)\/(\d+--[a-z0-9][a-z0-9-]*)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function ranobeLibBookUrl(ref: string): string {
  return `https://ranobelib.me/ru/book/${ref}`;
}

function ranobeLibCandidateRef(candidate: RanobeLibCandidate): string | null {
  const slugUrl = candidate.slug_url?.trim() ?? '';
  if (/^\d+--[a-z0-9][a-z0-9-]*$/i.test(slugUrl)) return slugUrl;
  const slug = candidate.slug?.trim() ?? '';
  if (Number.isSafeInteger(candidate.id) && candidate.id && slug) return `${candidate.id}--${slug}`;
  return null;
}

function ranobeLibDisplayTitle(candidate: RanobeLibCandidate): string {
  return candidate.rus_name?.trim()
    || candidate.name?.trim()
    || candidate.eng_name?.trim()
    || ranobeLibCandidateRef(candidate)
    || 'Без названия';
}

function ranobeLibOriginalTitle(candidate: RanobeLibCandidate): string {
  return candidate.name?.trim()
    || candidate.eng_name?.trim()
    || candidate.rus_name?.trim()
    || ranobeLibDisplayTitle(candidate);
}

async function fetchRanobeLib(url: URL): Promise<unknown> {
  const response = await fetch(url.toString(), {
    headers: {
      accept: 'application/json',
      'site-id': RANOBELIB_SITE_ID,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`RanobeLib API HTTP ${response.status}`);
  return body;
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
  if (!body?.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    throw new Error('RanobeLib title payload is missing');
  }
  return body.data as RanobeLibCandidate;
}

async function fetchRanobeLibChapters(ref: string): Promise<RanobeLibChapter[]> {
  const url = new URL(`${RANOBELIB_API_BASE}/manga/${encodeURIComponent(ref)}/chapters`);
  url.searchParams.append('site_id[]', RANOBELIB_SITE_ID);
  const body = await fetchRanobeLib(url) as { data?: unknown } | null;
  return Array.isArray(body?.data) ? body.data as RanobeLibChapter[] : [];
}

function latestRanobeLibChapter(chapters: RanobeLibChapter[]): RanobeLibChapter | null {
  if (!chapters.length) return null;
  return chapters.reduce((latest, current) => {
    const latestIndex = typeof latest.index === 'number' ? latest.index : Number(latest.number) || 0;
    const currentIndex = typeof current.index === 'number' ? current.index : Number(current.number) || 0;
    return currentIndex >= latestIndex ? current : latest;
  });
}

function buildRanobeLibCandidates(candidates: RanobeLibCandidate[]): Record<string, unknown> {
  return {
    text: '<b>Нашла несколько вариантов</b>\n\nВыбери тайтл:',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        ...candidates.map((candidate, index) => [{
          text: ranobeLibDisplayTitle(candidate).slice(0, 60),
          callback_data: `prop:pick:${index}`,
        }]),
        [{ text: '❌ Отмена', callback_data: 'prop:cancel' }],
      ],
    },
  };
}

function buildRanobeLibConfirmation(
  detail: RanobeLibCandidate,
  ref: string,
  chapters: RanobeLibChapter[],
): Record<string, unknown> {
  const title = ranobeLibDisplayTitle(detail);
  const teamNames = (detail.teams ?? []).map((team) => team.name?.trim()).filter(Boolean) as string[];
  const translationStatus = detail.scanlateStatus?.label?.trim() || detail.status?.label?.trim() || 'неизвестно';
  const uploaded = detail.items_count?.uploaded ?? chapters.length;
  const latest = latestRanobeLibChapter(chapters);
  const latestNumber = latest?.number != null ? String(latest.number) : '—';
  const latestName = latest?.name?.trim();
  const lines = [
    `<b>${escapeHtml(title)}</b>`,
    '',
    `RanobeLib: ${escapeHtml(ranobeLibBookUrl(ref))}`,
    `Статус перевода: ${escapeHtml(translationStatus)}`,
    `Команда: ${escapeHtml(teamNames.length ? teamNames.join(', ') : 'не указана')}`,
    `Глав загружено: ${escapeHtml(uploaded)}`,
    `Последняя глава: Глава ${escapeHtml(latestNumber)}${latestName ? ` — ${escapeHtml(latestName)}` : ''}`,
    '⚪ Иммунитет: не удалось определить автоматически',
    '',
    'Это нужный тайтл?',
  ];
  return {
    text: lines.join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Да, продолжить', callback_data: 'prop:confirm' }],
        [{ text: '↩️ Искать заново', callback_data: 'prop:source:ranobelib' }],
        [{ text: '❌ Отмена', callback_data: 'prop:cancel' }],
      ],
    },
  };
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

async function telegramGetFilePath(env: TelegramTitleProposalEnv, fileId: string): Promise<string> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    description?: string;
    result?: { file_path?: string };
  } | null;
  const path = body?.result?.file_path?.trim();
  if (!response.ok || !body?.ok || !path) {
    throw new Error(body?.description || `Telegram getFile failed with HTTP ${response.status}`);
  }
  return path;
}

async function downloadTelegramFile(env: TelegramTitleProposalEnv, filePath: string): Promise<ArrayBuffer> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath.replace(/^\/+/, '')}`);
  if (!response.ok) throw new Error(`Telegram file download failed with HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_TELEGRAM_RAW_BYTES) throw new Error('Telegram RAW exceeded 20 MiB after download');
  return bytes;
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
    SET step=?,source_kind=?,candidates_json='[]',updated_at=CURRENT_TIMESTAMP
    WHERE user_telegram_id=?
  `).bind(step, sourceKind, String(userId)).run();
  return step;
}

async function setRanobeLibCandidates(
  env: TelegramTitleProposalEnv,
  userId: number,
  candidates: RanobeLibCandidate[],
): Promise<void> {
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions
    SET candidates_json=?,updated_at=CURRENT_TIMESTAMP
    WHERE user_telegram_id=?
  `).bind(JSON.stringify(candidates), String(userId)).run();
}

async function setRanobeLibConfirmation(
  env: TelegramTitleProposalEnv,
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

async function confirmRanobeLib(env: TelegramTitleProposalEnv, userId: number): Promise<void> {
  await env.DB.prepare(`
    UPDATE telegram_proposal_sessions
    SET step=?,updated_at=CURRENT_TIMESTAMP
    WHERE user_telegram_id=?
  `).bind('raw', String(userId)).run();
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

async function findActiveDuplicate(
  env: TelegramTitleProposalEnv,
  session: ProposalSession,
): Promise<ProposalRecord | null> {
  if (session.source_kind === 'ranobelib' && session.ranobelib_book_ref) {
    return env.DB.prepare(`
      SELECT id,user_telegram_id,title,source_url,status,
             (SELECT COUNT(*) FROM proposal_votes WHERE proposal_id=chapter_proposals.id) AS vote_count
      FROM chapter_proposals
      WHERE ranobelib_book_ref=? AND status IN ('pending','approved','planned','in_progress')
      ORDER BY created_at ASC LIMIT 1
    `).bind(session.ranobelib_book_ref).first<ProposalRecord>();
  }

  const titleKey = normalizeTitleKey(session.title);
  const sourceKey = normalizeSourceKey(session.source_url);
  const { results } = await env.DB.prepare(`
    SELECT id,user_telegram_id,title,source_url,status,
           (SELECT COUNT(*) FROM proposal_votes WHERE proposal_id=chapter_proposals.id) AS vote_count
    FROM chapter_proposals
    WHERE proposal_type='title' AND status IN ('pending','approved','planned','in_progress')
    ORDER BY created_at ASC LIMIT 80
  `).all<ProposalRecord>();
  for (const candidate of results) {
    if (normalizeTitleKey(candidate.title) !== titleKey) continue;
    const candidateSourceKey = normalizeSourceKey(candidate.source_url ?? '');
    if (sourceKey && candidateSourceKey && sourceKey !== candidateSourceKey) continue;
    if (sourceKey && !candidateSourceKey) continue;
    return candidate;
  }
  return null;
}

function buildDuplicateMessage(duplicate: ProposalRecord, currentUserId: number): Record<string, unknown> {
  const votes = Number(duplicate.vote_count || 0);
  const buttons: Record<string, string>[][] = [];
  const canSupport = duplicate.user_telegram_id !== String(currentUserId);
  if (canSupport) {
    buttons.push([{ text: '👍 Поддержать заявку', callback_data: `prop:support:${duplicate.id}` }]);
  }
  buttons.push([{ text: '👁 Посмотреть', callback_data: `prop:view:${duplicate.id}` }]);
  buttons.push([{ text: '📚 Предложить ещё', callback_data: 'prop:start:again' }]);
  buttons.push([{ text: '🏠 Главное меню', callback_data: 'prop:home' }]);
  return {
    text: [
      '<b>Этот тайтл уже предлагали.</b>',
      '',
      `«${escapeHtml(duplicate.title)}»`,
      `Сейчас у заявки голосов: <b>${votes}</b>.`,
      ...(canSupport ? ['', 'Кнопка «Поддержать» показывает команде, сколько читателей ждут этот тайтл.'] : []),
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  };
}

async function persistTelegramRawToR2(
  env: TelegramTitleProposalEnv,
  userId: number,
  session: ProposalSession,
): Promise<{ id: string; objectKey: string; bytes: number; etag: string | null } | null> {
  if (!session.raw_file_id) return null;
  if (!env.FILES) throw new Error('FILES binding is unavailable');
  const filePath = await telegramGetFilePath(env, session.raw_file_id);
  const bytes = await downloadTelegramFile(env, filePath);
  const rawId = `tgraw-${crypto.randomUUID()}`;
  const objectKey = `proposal-raw/${userId}/${crypto.randomUUID()}/${safeFilename(session.raw_file_name || 'raw.bin')}`;
  const result = await env.FILES.put(objectKey, bytes, {
    httpMetadata: { contentType: session.raw_mime_type || 'application/octet-stream' },
  });
  const etag = typeof result === 'object' && result !== null && 'etag' in result
    ? String((result as { etag?: unknown }).etag ?? '') || null
    : null;
  return { id: rawId, objectKey, bytes: bytes.byteLength, etag };
}

async function createProposalFromSession(
  env: TelegramTitleProposalEnv,
  user: TelegramUser,
  session: ProposalSession,
  forceNoRaw: boolean,
): Promise<{ kind: 'duplicate'; duplicate: ProposalRecord } | { kind: 'created'; id: string }> {
  await upsertTelegramUser(env, user);
  const duplicate = await findActiveDuplicate(env, session);
  if (duplicate) return { kind: 'duplicate', duplicate };

  const useRaw = Boolean(session.raw_file_id) && !forceNoRaw;
  if (useRaw && !env.FILES) throw new Error('RAW_STORAGE_UNAVAILABLE');

  const raw = useRaw ? await persistTelegramRawToR2(env, user.id, session) : null;
  const proposalId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO chapter_proposals (
      id,user_telegram_id,proposal_type,title,source_url,chapter_from,chapter_to,comment,source_kind,ranobelib_book_ref
    ) VALUES (?,?,?,?,?,NULL,NULL,?,?,?)
  `).bind(
    proposalId,
    String(user.id),
    'title',
    session.title.trim(),
    session.source_url.trim(),
    session.comment.trim(),
    session.source_kind || 'external',
    session.ranobelib_book_ref,
  ).run();

  if (raw) {
    await env.DB.prepare(`
      INSERT INTO proposal_raw_uploads (
        id,user_telegram_id,object_key,original_name,content_type,expected_size,part_size,r2_upload_id,status,etag,
        attached_proposal_id,completed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    `).bind(
      raw.id,
      String(user.id),
      raw.objectKey,
      safeFilename(session.raw_file_name || 'raw.bin'),
      session.raw_mime_type || 'application/octet-stream',
      raw.bytes,
      Math.max(1, raw.bytes),
      `telegram:${session.raw_file_unique_id || session.raw_file_id}`,
      'ready',
      raw.etag,
      proposalId,
    ).run();
  }

  await env.DB.prepare(`
    INSERT INTO title_proposal_details (proposal_id,original_title,extra_url,raw_upload_id)
    VALUES (?,?,?,?)
    ON CONFLICT(proposal_id) DO UPDATE SET
      original_title=excluded.original_title,extra_url=excluded.extra_url,raw_upload_id=excluded.raw_upload_id
  `).bind(
    proposalId,
    (session.original_title || session.title).trim(),
    session.source_kind === 'external' ? session.source_url.trim() : '',
    raw?.id ?? null,
  ).run();

  await env.DB.prepare('DELETE FROM telegram_proposal_sessions WHERE user_telegram_id=?')
    .bind(String(user.id)).run();
  return { kind: 'created', id: proposalId };
}

function buildProposalCreated(id: string): Record<string, unknown> {
  return {
    text: '<b>✅ Заявка принята</b>\n\nОна добавлена в общую очередь «Дома Некроманта». За изменениями статуса можно следить в разделе «Мои заявки».',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '👁 Посмотреть заявку', callback_data: `prop:view:${id}` }],
        [{ text: '📚 Предложить ещё', callback_data: 'prop:start:again' }],
        [{ text: '🏠 Главное меню', callback_data: 'prop:home' }],
      ],
    },
  };
}

function buildRawStorageUnavailable(): Record<string, unknown> {
  return {
    text: '<b>RAW не удалось сохранить.</b>\n\nХранилище файлов сейчас недоступно. Я не буду молча выбрасывать приложенный файл. Можно отправить заявку без RAW или повторить позже.',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📨 Отправить без RAW', callback_data: 'prop:submit:no-raw' }],
        [{ text: '↩️ Вернуться к проверке', callback_data: 'prop:resume' }],
        [{ text: '🏠 Главное меню', callback_data: 'prop:home' }],
      ],
    },
  };
}

async function listMyProposals(env: TelegramTitleProposalEnv, userId: number): Promise<ProposalRecord[]> {
  const { results } = await env.DB.prepare(`
    SELECT chapter_proposals.id,chapter_proposals.title,chapter_proposals.status,chapter_proposals.created_at,
           (SELECT COUNT(*) FROM proposal_votes WHERE proposal_id=chapter_proposals.id) AS vote_count
    FROM chapter_proposals
    WHERE user_telegram_id=?
    ORDER BY created_at DESC LIMIT 10
  `).bind(String(userId)).all<ProposalRecord>();
  return results;
}

function buildMyProposals(rows: ProposalRecord[]): Record<string, unknown> {
  if (!rows.length) {
    return {
      text: '<b>🗂 Мои заявки</b>\n\nПока заявок нет.',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '📚 Предложить новеллу', callback_data: 'prop:new' }]] },
    };
  }
  const lines = ['<b>🗂 Мои заявки</b>', ''];
  for (const row of rows) {
    lines.push(`${localizedStatus(row.status)} · <b>${escapeHtml(row.title)}</b> · 👍 ${Number(row.vote_count || 0)}`);
  }
  return {
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        ...rows.map((row) => [{ text: row.title.slice(0, 55), callback_data: `prop:view:${row.id}` }]),
        [{ text: '🏠 Главное меню', callback_data: 'prop:home' }],
      ],
    },
  };
}

async function loadProposal(env: TelegramTitleProposalEnv, id: string): Promise<ProposalRecord | null> {
  return env.DB.prepare(`
    SELECT chapter_proposals.*,
           (SELECT COUNT(*) FROM proposal_votes WHERE proposal_id=chapter_proposals.id) AS vote_count
    FROM chapter_proposals WHERE id=? LIMIT 1
  `).bind(id).first<ProposalRecord>();
}

function buildProposalView(row: ProposalRecord, viewerId: number): Record<string, unknown> {
  const lines = [
    `<b>${escapeHtml(row.title)}</b>`,
    '',
    `Статус: ${localizedStatus(row.status)}`,
    `Голосов: <b>${Number(row.vote_count || 0)}</b>`,
    `Источник: ${row.source_kind === 'ranobelib' ? 'RanobeLib' : 'внешний'}`,
  ];
  if (row.source_url) lines.push(`Ссылка: ${escapeHtml(row.source_url)}`);
  if (row.comment) lines.push(`Комментарий: ${escapeHtml(row.comment)}`);
  if (row.admin_note && row.user_telegram_id === String(viewerId)) {
    lines.push(`Комментарий команды: ${escapeHtml(row.admin_note)}`);
  }
  if (row.created_at) lines.push(`Подана: ${escapeHtml(row.created_at)}`);
  const buttons: Record<string, string>[][] = [];
  if (ACTIVE_PROPOSAL_STATUSES.has(row.status) && row.user_telegram_id !== String(viewerId)) {
    buttons.push([{ text: '👍 Поддержать', callback_data: `prop:support:${row.id}` }]);
  }
  buttons.push([{ text: '🗂 Мои заявки', callback_data: 'prop:mine' }]);
  return { text: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } };
}

export function buildProposalMainMenu(origin: string): Record<string, unknown> {
  return {
    text: '<b>Дом Некроманта</b>\n\nЧто хотите сделать?',
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
        [{ text: '✏️ Изменить название', callback_data: 'prop:edit:title' }],
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

async function showRanobeLibConfirmation(
  env: TelegramTitleProposalEnv,
  userId: number,
  ref: string,
  deliver: (payload: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const [detail, chapters] = await Promise.all([
    fetchRanobeLibTitle(ref),
    fetchRanobeLibChapters(ref),
  ]);
  await setRanobeLibConfirmation(env, userId, detail, ref);
  await deliver(buildRanobeLibConfirmation(detail, ref, chapters));
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

  if (data.startsWith('prop:pick:')) {
    const session = await loadProposalSession(env, callback.from.id);
    const index = Number(data.slice('prop:pick:'.length));
    if (!session || session.step !== 'ranobelib_query' || !Number.isInteger(index) || index < 0) {
      await answerCallback(env, callback.id, 'Поиск устарел. Начните заново.');
      return json({ ok: true });
    }
    let candidates: RanobeLibCandidate[] = [];
    try {
      const parsed = JSON.parse(session.candidates_json);
      if (Array.isArray(parsed)) candidates = parsed;
    } catch {
      candidates = [];
    }
    const candidate = candidates[index];
    const ref = candidate ? ranobeLibCandidateRef(candidate) : null;
    if (!ref) {
      await answerCallback(env, callback.id, 'Этот вариант больше недоступен.');
      return json({ ok: true });
    }
    try {
      await showRanobeLibConfirmation(env, callback.from.id, ref, (payload) => editCallbackMessage(env, callback, payload));
      await answerCallback(env, callback.id);
    } catch {
      await answerCallback(env, callback.id, 'RanobeLib сейчас не отвечает. Попробуйте ещё раз.');
    }
    return json({ ok: true });
  }

  if (data === 'prop:confirm') {
    const session = await loadProposalSession(env, callback.from.id);
    if (!session || session.step !== 'ranobelib_confirm' || !session.ranobelib_book_ref) {
      await answerCallback(env, callback.id, 'Начните заявку заново.');
      return json({ ok: true });
    }
    await confirmRanobeLib(env, callback.from.id);
    await editCallbackMessage(env, callback, buildRawPrompt());
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data === 'prop:submit' || data === 'prop:submit:no-raw') {
    const session = await loadProposalSession(env, callback.from.id);
    if (!session || session.step !== 'review') {
      await answerCallback(env, callback.id, 'Начните заявку заново.');
      return json({ ok: true });
    }
    try {
      const result = await createProposalFromSession(env, callback.from, session, data === 'prop:submit:no-raw');
      if (result.kind === 'duplicate') {
        await editCallbackMessage(env, callback, buildDuplicateMessage(result.duplicate, callback.from.id));
      } else {
        await editCallbackMessage(env, callback, buildProposalCreated(result.id));
      }
      await answerCallback(env, callback.id);
    } catch (error) {
      if (error instanceof Error && error.message === 'RAW_STORAGE_UNAVAILABLE') {
        await editCallbackMessage(env, callback, buildRawStorageUnavailable());
        await answerCallback(env, callback.id, 'RAW не сохранён.');
      } else {
        await answerCallback(env, callback.id, 'Не удалось отправить заявку. Попробуйте ещё раз.');
      }
    }
    return json({ ok: true });
  }

  if (data === 'prop:mine') {
    await upsertTelegramUser(env, callback.from);
    const rows = await listMyProposals(env, callback.from.id);
    await editCallbackMessage(env, callback, buildMyProposals(rows));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data.startsWith('prop:view:')) {
    const proposalId = data.slice('prop:view:'.length);
    const row = proposalId ? await loadProposal(env, proposalId) : null;
    if (!row || (row.status === 'rejected' && row.user_telegram_id !== String(callback.from.id))) {
      await answerCallback(env, callback.id, 'Заявка не найдена или недоступна.');
      return json({ ok: true });
    }
    await editCallbackMessage(env, callback, buildProposalView(row, callback.from.id));
    await answerCallback(env, callback.id);
    return json({ ok: true });
  }

  if (data.startsWith('prop:support:')) {
    const proposalId = data.slice('prop:support:'.length);
    const proposal = proposalId
      ? await env.DB.prepare('SELECT id,user_telegram_id,title,status FROM chapter_proposals WHERE id=? LIMIT 1')
          .bind(proposalId).first<ProposalRecord>()
      : null;
    if (!proposal || !ACTIVE_PROPOSAL_STATUSES.has(proposal.status)) {
      await answerCallback(env, callback.id, 'Заявка не найдена или голосование закрыто.');
      return json({ ok: true });
    }
    if (proposal.user_telegram_id === String(callback.from.id)) {
      await answerCallback(env, callback.id, 'Автор заявки уже считается сторонником своей заявки.');
      return json({ ok: true });
    }
    await upsertTelegramUser(env, callback.from);
    const existing = await env.DB.prepare('SELECT proposal_id FROM proposal_votes WHERE proposal_id=? AND user_telegram_id=?')
      .bind(proposalId, String(callback.from.id)).first<{ proposal_id: string }>();
    if (existing) {
      await answerCallback(env, callback.id, 'Вы уже поддержали эту заявку.');
      return json({ ok: true });
    }
    await env.DB.prepare('INSERT INTO proposal_votes (proposal_id,user_telegram_id) VALUES (?,?)')
      .bind(proposalId, String(callback.from.id)).run();
    await answerCallback(env, callback.id, 'Спасибо! Поддержка учтена.');
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

  if (session.step === 'ranobelib_query') {
    if (!text) {
      await sendMessage(env, message.chat.id, {
        text: 'Пришли ссылку на карточку RanobeLib или напиши название тайтла.',
      });
      return json({ ok: true });
    }
    const exactRef = parseRanobeLibBookRef(text);
    if (exactRef) {
      try {
        await showRanobeLibConfirmation(env, userId, exactRef, (payload) => sendMessage(env, message.chat.id, payload));
      } catch {
        await sendMessage(env, message.chat.id, {
          text: 'Не удалось получить карточку RanobeLib. Проверь ссылку и попробуй ещё раз.',
        });
      }
      return json({ ok: true });
    }
    if (text.length < 2 || text.length > 180) {
      await sendMessage(env, message.chat.id, {
        text: 'Для поиска введи название от 2 до 180 символов или пришли ссылку RanobeLib.',
      });
      return json({ ok: true });
    }
    try {
      const candidates = await searchRanobeLib(text);
      if (!candidates.length) {
        await sendMessage(env, message.chat.id, {
          text: 'На RanobeLib ничего не найдено. Попробуй другое название или пришли прямую ссылку.',
        });
        return json({ ok: true });
      }
      await setRanobeLibCandidates(env, userId, candidates);
      await sendMessage(env, message.chat.id, buildRanobeLibCandidates(candidates));
    } catch {
      await sendMessage(env, message.chat.id, {
        text: 'RanobeLib сейчас не отвечает. Попробуй поиск ещё раз чуть позже.',
      });
    }
    return json({ ok: true });
  }

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