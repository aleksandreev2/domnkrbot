import { sortChapters } from './release-detector.js';
import type { RanobeLibChapter, RanobeLibTeamBookRef, RanobeLibTitle } from './types.js';

export interface RanobeLibClientOptions {
  apiBaseUrl?: string;
  siteBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RanobeLibChapterOptions {
  teamRef?: string;
}

export class RanobeLibClient {
  private readonly apiBaseUrl: string;
  private readonly siteBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private discoveredTeamRef: string | null = null;

  constructor(options: RanobeLibClientOptions = {}) {
    this.apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? 'https://api.cdnlibs.org/api');
    this.siteBaseUrl = stripTrailingSlash(options.siteBaseUrl ?? 'https://ranobelib.me');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async discoverTeamBooks(teamRef: string): Promise<RanobeLibTeamBookRef[]> {
    const normalizedTeamRef = teamRef.trim();
    this.discoveredTeamRef = normalizedTeamRef || null;
    const teamId = teamIdFromRef(normalizedTeamRef);
    if (teamId === null) throw new Error(`Invalid RanobeLib team ref: ${teamRef}`);

    const books: RanobeLibTeamBookRef[] = [];
    const seen = new Set<string>();
    let page = 1;

    for (;;) {
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

  async getTitle(bookRef: string): Promise<RanobeLibTitle> {
    const response = await this.getJson<ApiEnvelope<Record<string, unknown>>>(
      `${this.apiBaseUrl}/manga/${encodeURIComponent(bookRef)}?fields[]=summary`,
    );
    return normalizeTitle(response.data ?? {}, bookRef);
  }

  async getChapters(bookRef: string, options: RanobeLibChapterOptions = {}): Promise<RanobeLibChapter[]> {
    const response = await this.getJson<ApiEnvelope<unknown[]>>(
      `${this.apiBaseUrl}/manga/${encodeURIComponent(bookRef)}/chapters`,
    );
    const teamRef = options.teamRef ?? this.discoveredTeamRef ?? undefined;

    const chapters = Array.isArray(response.data)
      ? response.data
          .map((value) => normalizeChapter(value, teamRef))
          .filter((value): value is RanobeLibChapter => value !== null)
      : [];

    return sortChapters(chapters);
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
      const response = await this.fetchImpl(url, {
        headers: {
          accept,
          'accept-language': 'ru,en;q=0.7',
          'Site-Id': '3',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`RanobeLib request failed: ${response.status} ${response.statusText} (${url})`);
      }

      return response;
    } finally {
      clearTimeout(timer);
    }
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

  return {
    id,
    slug,
    ref,
    url: `${siteBaseUrl}/ru/book/${ref}`,
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

function normalizeChapter(raw: unknown, teamRef?: string): RanobeLibChapter | null {
  if (!isRecord(raw)) return null;
  if (teamRef && !chapterHasTeam(raw, teamRef)) return null;
  const id = numberOrNull(raw.id);
  const volume = tokenOrNull(raw.volume);
  const number = tokenOrNull(raw.number);
  if (id === null || volume === null || number === null) return null;

  return {
    id,
    volume,
    number,
    name: stringOrNull(raw.name),
  };
}

function chapterHasTeam(raw: Record<string, unknown>, teamRef: string): boolean {
  const teamId = teamIdFromRef(teamRef);
  const branches = Array.isArray(raw.branches) ? raw.branches : [];
  return branches.some((branch) => {
    if (!isRecord(branch)) return false;
    const teams = Array.isArray(branch.teams) ? branch.teams : [];
    return teams.some((team) => {
      if (!isRecord(team)) return false;
      if (teamId !== null && numberOrNull(team.id) === teamId) return true;
      const refs = [team.slug_url, team.slug, team.ref].map(stringOrNull).filter((value): value is string => Boolean(value));
      return refs.some((value) => value === teamRef || `${teamId ?? ''}--${value}` === teamRef);
    });
  });
}

function teamIdFromRef(teamRef: string): number | null {
  const match = /^(\d+)(?:--|$)/.exec(teamRef.trim());
  return match?.[1] ? Number(match[1]) : null;
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
