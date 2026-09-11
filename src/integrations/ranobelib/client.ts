import { buildRanobeLibBranchIdentity, normalizeRanobeLibTeamIds } from './branch-identity.js';
import { sortChapters } from './release-detector.js';
import { discoverTeamBooksFromHtml } from './team-discovery.js';
import type { RanobeLibChapter, RanobeLibChapterBranch, RanobeLibTeamBookRef, RanobeLibTitle } from './types.js';

export interface RanobeLibClientOptions {
  apiBaseUrl?: string;
  siteBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  authProvider?: RanobeLibAuthorizationProvider;
}

export interface RanobeLibAuthorizationProvider {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string | null>;
}

export interface RanobeLibChapterOptions {
  teamRef?: string;
}

export interface RanobeLibTranslationStatus {
  id: number | null;
  label: string | null;
}

const TEAM_CHAPTER_HISTORY_PAGE_LIMIT = 30;

export class RanobeLibClient {
  private readonly apiBaseUrl: string;
  private readonly siteBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly authProvider: RanobeLibAuthorizationProvider | null;
  private discoveredTeamRef: string | null = null;

  constructor(options: RanobeLibClientOptions = {}) {
    this.apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? 'https://api.cdnlibs.org/api');
    this.siteBaseUrl = stripTrailingSlash(options.siteBaseUrl ?? 'https://ranobelib.me');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.authProvider = options.authProvider ?? null;
  }

  async discoverTeamBooks(teamRef: string): Promise<RanobeLibTeamBookRef[]> {
    const normalizedTeamRef = teamRef.trim();
    this.discoveredTeamRef = normalizedTeamRef || null;
    const teamId = ranobeLibTeamIdFromRef(normalizedTeamRef);
    if (teamId === null) throw new Error(`Invalid RanobeLib team ref: ${teamRef}`);

    const books: RanobeLibTeamBookRef[] = [];
    const seen = new Set<string>();
    let page = 1;

    for (;;) {
      // The live team-listing endpoint rejects fields[]=status_id with HTTP 422. Translation
      // status is therefore refreshed separately from the detail endpoint.
      const response = await this.getJson<ApiEnvelope<unknown[]>>(
        `${this.apiBaseUrl}/manga?site_id[]=3&target_id=${teamId}&target_model=team&page=${page}`,
      );

      for (const raw of Array.isArray(response.data) ? response.data : []) {
        const book = normalizeTeamBook(raw, this.siteBaseUrl);
        if (!book || seen.has(book.ref)) continue;
        seen.add(book.ref);
        books.push(book);
      }

      if (response.meta?.has_next_page !== true) break;
      page += 1;
    }

    return books;
  }

  /**
   * Secondary discovery surface for RanobeLib team history. The target_model=team catalog can omit
   * older/completed relations that are still present on the public team page, so callers may use
   * these links only as candidates and verify new relations through getTeamAttributedBook().
   */
  async discoverTeamPageBooks(teamRef: string): Promise<RanobeLibTeamBookRef[]> {
    const normalizedTeamRef = teamRef.trim();
    const teamId = ranobeLibTeamIdFromRef(normalizedTeamRef);
    if (teamId === null) throw new Error(`Invalid RanobeLib team ref: ${teamRef}`);

    const response = await this.request(
      `${this.siteBaseUrl}/ru/team/${encodeURIComponent(normalizedTeamRef)}`,
      'text/html,application/xhtml+xml',
    );
    const html = await response.text();
    return discoverTeamBooksFromHtml(html, this.siteBaseUrl);
  }

  /**
   * Discovers titles from the public team chapter history. Unlike target_model=team and the
   * anonymous team page, this endpoint includes some titles hidden from signed-out catalogs.
   * Every result is accepted only when the history row explicitly attributes the requested team.
   */
  async discoverTeamHistoryBooks(teamRef: string): Promise<RanobeLibTeamBookRef[]> {
    const normalizedTeamRef = teamRef.trim();
    const teamId = ranobeLibTeamIdFromRef(normalizedTeamRef);
    if (teamId === null) throw new Error(`Invalid RanobeLib team ref: ${teamRef}`);

    const books: RanobeLibTeamBookRef[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= TEAM_CHAPTER_HISTORY_PAGE_LIMIT; page += 1) {
      const response = await this.getJson<ApiEnvelope<unknown[]>>(
        `${this.apiBaseUrl}/teams/${teamId}/chapters?page=${page}`,
      );

      for (const raw of Array.isArray(response.data) ? response.data : []) {
        if (!isRecord(raw)) continue;
        const chapters = Array.isArray(raw.chapters) ? raw.chapters : [];
        const attributed = chapters.some((chapter) => {
          if (!isRecord(chapter)) return false;
          const teams = Array.isArray(chapter.teams) ? chapter.teams : [];
          return teams.some((rawTeam) => (
            isRecord(rawTeam) && teamRecordMatchesRef(rawTeam, normalizedTeamRef, teamId)
          ));
        });
        if (!attributed) continue;

        const media = isRecord(raw.manga) ? raw.manga : (isRecord(raw.media) ? raw.media : null);
        const book = normalizeTeamBook(media, this.siteBaseUrl);
        if (!book || seen.has(book.ref)) continue;
        seen.add(book.ref);
        books.push(book);
      }

      if (response.meta?.has_next_page !== true) break;
    }

    return books;
  }

  /** Returns book metadata only when the title detail explicitly attributes this exact team. */
  async getTeamAttributedBook(teamRef: string, bookRef: string): Promise<RanobeLibTeamBookRef | null> {
    const normalizedTeamRef = teamRef.trim();
    const teamId = ranobeLibTeamIdFromRef(normalizedTeamRef);
    if (teamId === null) throw new Error(`Invalid RanobeLib team ref: ${teamRef}`);

    const response = await this.getJson<ApiEnvelope<Record<string, unknown>>>(
      `${this.apiBaseUrl}/manga/${encodeURIComponent(bookRef)}?fields[]=teams`,
    );
    const data = isRecord(response.data) ? response.data : {};
    const teams = Array.isArray(data.teams) ? data.teams : [];
    const attributed = teams.some((rawTeam) => (
      isRecord(rawTeam) && teamRecordMatchesRef(rawTeam, normalizedTeamRef, teamId)
    ));
    if (!attributed) return null;
    return normalizeTeamBook(data, this.siteBaseUrl);
  }

  async getTeamDisplayName(teamRef: string, bookRefs: readonly string[]): Promise<string | null> {
    const normalizedTeamRef = teamRef.trim();
    const teamId = ranobeLibTeamIdFromRef(normalizedTeamRef);
    if (teamId === null) throw new Error(`Invalid RanobeLib team ref: ${teamRef}`);

    const refs = [...new Set(bookRefs.map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, 3);
    for (const bookRef of refs) {
      try {
        const response = await this.getJson<ApiEnvelope<Record<string, unknown>>>(
          `${this.apiBaseUrl}/manga/${encodeURIComponent(bookRef)}?fields[]=teams`,
        );
        const data = isRecord(response.data) ? response.data : {};
        const teams = Array.isArray(data.teams) ? data.teams : [];
        for (const rawTeam of teams) {
          if (!isRecord(rawTeam) || !teamRecordMatchesRef(rawTeam, normalizedTeamRef, teamId)) continue;
          const name = stringOrNull(rawTeam.name);
          if (name) return name;
        }
      } catch {
        // Team display metadata is best-effort. Catalog discovery must keep working even if one
        // title detail request is temporarily unavailable.
      }
    }
    return null;
  }

  async getTranslationStatus(bookRef: string): Promise<RanobeLibTranslationStatus> {
    const response = await this.getJson<ApiEnvelope<Record<string, unknown>>>(
      `${this.apiBaseUrl}/manga/${encodeURIComponent(bookRef)}?fields[]=status_id`,
    );
    const data = isRecord(response.data) ? response.data : {};
    const scanlateStatus = isRecord(data.scanlateStatus) ? data.scanlateStatus : null;
    return {
      id: scanlateStatus ? numberOrNull(scanlateStatus.id) : null,
      label: scanlateStatus ? stringOrNull(scanlateStatus.label) : null,
    };
  }

  async getTitle(bookRef: string): Promise<RanobeLibTitle> {
    const response = await this.getJson<ApiEnvelope<Record<string, unknown>>>(
      `${this.apiBaseUrl}/manga/${encodeURIComponent(bookRef)}?fields[]=summary`,
    );
    return normalizeTitle(response.data ?? {}, bookRef);
  }

  /**
   * Compatibility projection used by the existing single-team scanner. New multi-team code should
   * call getChapterBranches so two translations of the same chapter do not collapse to chapter.id.
   */
  async getChapters(bookRef: string, options: RanobeLibChapterOptions = {}): Promise<RanobeLibChapter[]> {
    const response = await this.getChapterPayload(bookRef);
    const teamRef = options.teamRef ?? this.discoveredTeamRef ?? undefined;
    const nowMs = Date.now();

    const chapters = Array.isArray(response.data)
      ? response.data
          .map((value) => normalizeChapter(value, teamRef, nowMs))
          .filter((value): value is RanobeLibChapter => value !== null)
      : [];

    return sortChapters(chapters);
  }

  /** Returns every currently released chapter branch with stable/conservative identity metadata. */
  async getChapterBranches(bookRef: string): Promise<RanobeLibChapterBranch[]> {
    const response = await this.getChapterPayload(bookRef);
    const nowMs = Date.now();
    const branches: RanobeLibChapterBranch[] = [];
    for (const value of Array.isArray(response.data) ? response.data : []) {
      branches.push(...normalizeChapterBranches(value, bookRef, nowMs));
    }
    return branches.sort(compareChapterBranches);
  }

  private getChapterPayload(bookRef: string): Promise<ApiEnvelope<unknown[]>> {
    return this.getJson<ApiEnvelope<unknown[]>>(
      `${this.apiBaseUrl}/manga/${encodeURIComponent(bookRef)}/chapters`,
    );
  }

  private async getJson<T>(url: string): Promise<T> {
    const response = await this.request(url, 'application/json');
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      const preview = (await response.text()).slice(0, 180);
      throw new Error(`RanobeLib returned non-JSON content for ${url}: ${preview}`);
    }
    return (await response.json()) as T;
  }

  private async request(url: string, accept: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const canAuthorize = new URL(url).origin === 'https://api.cdnlibs.org';
      const accessToken = canAuthorize
        ? await this.authProvider?.getAccessToken().catch(() => null) ?? null
        : null;
      let response = await this.fetchRead(url, accept, controller.signal, accessToken);

      if (response.status === 401 && accessToken && this.authProvider) {
        const refreshedToken = await this.authProvider.getAccessToken({ forceRefresh: true });
        if (refreshedToken) response = await this.fetchRead(url, accept, controller.signal, refreshedToken);
      }

      if (!response.ok) {
        throw new Error(`RanobeLib request failed: ${response.status} ${response.statusText} (${url})`);
      }

      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  private fetchRead(url: string, accept: string, signal: AbortSignal, accessToken: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      accept,
      'accept-language': 'ru,en;q=0.7',
      'Site-Id': '3',
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return this.fetchImpl(url, {
      method: 'GET',
      headers,
      ...(accessToken ? { redirect: 'manual' as const } : {}),
      signal,
    });
  }
}

interface ApiEnvelope<T> {
  data?: T;
  meta?: {
    has_next_page?: boolean;
  };
}

function normalizeTeamBook(raw: unknown, siteBaseUrl: string): RanobeLibTeamBookRef | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  const explicitRef = stringOrNull(raw.slug_url);
  const explicitSlug = stringOrNull(raw.slug);
  if (id === null) return null;

  const ref = explicitRef ?? (explicitSlug ? `${id}--${explicitSlug}` : null);
  if (!ref) return null;
  const slug = explicitSlug ?? (ref.includes('--') ? ref.split('--').slice(1).join('--') : null);
  if (!slug) return null;
  const title = extractTitle(raw);
  const cover = isRecord(raw.cover) ? raw.cover : {};
  const coverUrl = stringOrNull(cover.default) ?? stringOrNull(cover.thumbnail);
  // Some responses may already include scanlateStatus; it is safe and authoritative. Generic
  // status/status_id are deliberately ignored because they can describe the work itself.
  const scanlateStatus = isRecord(raw.scanlateStatus) ? raw.scanlateStatus : null;
  const translationStatusId = scanlateStatus ? numberOrNull(scanlateStatus.id) : null;
  const translationStatusLabel = scanlateStatus ? stringOrNull(scanlateStatus.label) : null;

  return {
    id,
    slug,
    ref,
    url: `${siteBaseUrl}/ru/book/${ref}`,
    ...(title ? { title } : {}),
    ...(coverUrl ? { coverUrl } : {}),
    ...(translationStatusId !== null ? { translationStatusId } : {}),
    ...(translationStatusLabel ? { translationStatusLabel } : {}),
  };
}

function normalizeTitle(raw: Record<string, unknown>, bookRef: string): RanobeLibTitle {
  const cover = isRecord(raw.cover) ? raw.cover : {};
  const slugFromRef = bookRef.includes('--') ? bookRef.split('--').slice(1).join('--') : null;

  return {
    id: numberOrNull(raw.id),
    slug: stringOrNull(raw.slug) ?? slugFromRef,
    title: extractTitle(raw),
    summary: stringOrNull(raw.summary),
    coverUrl: stringOrNull(cover.default) ?? stringOrNull(cover.thumbnail),
    raw,
  };
}

function normalizeChapter(raw: unknown, teamRef: string | undefined, nowMs: number): RanobeLibChapter | null {
  if (!isRecord(raw)) return null;
  const matchingBranch = teamRef ? releasedTeamBranch(raw, teamRef, nowMs) : null;
  if (teamRef && !matchingBranch) return null;
  const id = numberOrNull(raw.id);
  const volume = tokenOrNull(raw.volume);
  const number = tokenOrNull(raw.number);
  if (id === null || volume === null || number === null) return null;

  return {
    id,
    volume,
    number,
    name: stringOrNull(raw.name),
    ...(matchingBranch ? { releasedAt: stringOrNull(matchingBranch.created_at) } : {}),
  };
}

function normalizeChapterBranches(raw: unknown, bookRef: string, nowMs: number): RanobeLibChapterBranch[] {
  if (!isRecord(raw)) return [];
  const chapterId = numberOrNull(raw.id);
  const volume = tokenOrNull(raw.volume);
  const number = tokenOrNull(raw.number);
  if (chapterId === null || volume === null || number === null) return [];

  const chapterName = stringOrNull(raw.name);
  const rawBranches = Array.isArray(raw.branches) ? raw.branches : [];
  const normalized: RanobeLibChapterBranch[] = [];

  for (let index = 0; index < rawBranches.length; index += 1) {
    const branch = rawBranches[index];
    if (!isRecord(branch) || !branchIsReleased(branch, nowMs)) continue;
    const releasedAt = stringOrNull(branch.created_at);
    const teamIds = branchTeamIds(branch);
    const nativeBranchId = numberOrNull(branch.branch_id) ?? numberOrNull(branch.id);
    const stableBranchRef = stringOrNull(branch.slug_url)
      ?? stringOrNull(branch.ref)
      ?? stringOrNull(branch.slug)
      ?? stringOrNull(branch.uuid);
    const identity = buildRanobeLibBranchIdentity({
      bookRef,
      chapterId,
      nativeBranchId,
      teamIds,
      releasedAt,
      stableBranchRef,
      branchOrdinal: index,
    });

    normalized.push({
      chapterId,
      volume,
      number,
      name: chapterName,
      branchKey: identity.key,
      nativeBranchId: identity.nativeBranchId,
      identityConfidence: identity.confidence,
      teamIds,
      releasedAt,
    });
  }

  return normalized;
}

function releasedTeamBranch(raw: Record<string, unknown>, teamRef: string, nowMs: number): Record<string, unknown> | null {
  const branches = Array.isArray(raw.branches) ? raw.branches : [];
  for (const branch of branches) {
    if (!isRecord(branch) || !branchHasTeam(branch, teamRef) || !branchIsReleased(branch, nowMs)) continue;
    return branch;
  }
  return null;
}

function branchIsReleased(branch: Record<string, unknown>, nowMs: number): boolean {
  const createdAt = stringOrNull(branch.created_at);
  if (!createdAt) return true;
  const releaseMs = Date.parse(createdAt);
  return !Number.isFinite(releaseMs) || releaseMs <= nowMs;
}

function branchHasTeam(branch: Record<string, unknown>, teamRef: string): boolean {
  const teamId = ranobeLibTeamIdFromRef(teamRef);
  const teams = Array.isArray(branch.teams) ? branch.teams : [];
  return teams.some((team) => {
    if (!isRecord(team)) return false;
    if (teamId !== null && numberOrNull(team.id) === teamId) return true;
    const refs = [team.slug_url, team.slug, team.ref].map(stringOrNull).filter((value): value is string => Boolean(value));
    return refs.some((value) => value === teamRef || `${teamId ?? ''}--${value}` === teamRef);
  });
}

function teamRecordMatchesRef(team: Record<string, unknown>, teamRef: string, teamId: number): boolean {
  if (numberOrNull(team.id) === teamId) return true;
  const refs = [team.slug_url, team.ref].map(stringOrNull).filter((value): value is string => Boolean(value));
  if (refs.includes(teamRef)) return true;
  const slug = stringOrNull(team.slug);
  return Boolean(slug && `${teamId}--${slug}` === teamRef);
}

function branchTeamIds(branch: Record<string, unknown>): number[] {
  const teams = Array.isArray(branch.teams) ? branch.teams : [];
  return normalizeRanobeLibTeamIds(teams.map((team) => isRecord(team) ? team.id : null));
}

export function ranobeLibTeamIdFromRef(teamRef: string): number | null {
  const match = /^(\d+)(?:--|$)/.exec(teamRef.trim());
  return match?.[1] ? Number(match[1]) : null;
}

function compareChapterBranches(a: RanobeLibChapterBranch, b: RanobeLibChapterBranch): number {
  const projected = sortChapters([
    { id: a.chapterId, volume: a.volume, number: a.number, name: a.name },
    { id: b.chapterId, volume: b.volume, number: b.number, name: b.name },
  ]);
  if (projected[0]?.id === a.chapterId && projected[1]?.id === b.chapterId) {
    if (a.chapterId !== b.chapterId || a.volume !== b.volume || a.number !== b.number) return -1;
  }
  if (projected[0]?.id === b.chapterId && projected[1]?.id === a.chapterId) {
    if (a.chapterId !== b.chapterId || a.volume !== b.volume || a.number !== b.number) return 1;
  }
  return a.branchKey.localeCompare(b.branchKey);
}

function extractTitle(raw: Record<string, unknown>): string | null {
  const rusName = stringOrNull(raw.rus_name);
  const name = stringOrNull(raw.name);
  if (rusName) return rusName;
  if (name) return name;

  const nameObject = isRecord(raw.name) ? raw.name : null;
  if (nameObject) {
    return stringOrNull(nameObject.rus) ?? stringOrNull(nameObject.ru) ?? stringOrNull(nameObject.main);
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function tokenOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
