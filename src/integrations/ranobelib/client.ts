import { sortChapters } from './release-detector.js';
import type {
  RanobeLibChapter,
  RanobeLibTeam,
  RanobeLibTeamBookRef,
  RanobeLibTeamCatalog,
  RanobeLibTitle,
} from './types.js';

export interface RanobeLibClientOptions {
  apiBaseUrl?: string;
  siteBaseUrl?: string;
  siteId?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class RanobeLibClient {
  private readonly apiBaseUrl: string;
  private readonly siteBaseUrl: string;
  private readonly siteId: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RanobeLibClientOptions = {}) {
    this.apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? 'https://api.cdnlibs.org/api');
    this.siteBaseUrl = stripTrailingSlash(options.siteBaseUrl ?? 'https://ranobelib.me');
    this.siteId = options.siteId ?? 3;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getTeam(teamRef: string): Promise<RanobeLibTeam> {
    const response = await this.getJson<ApiEnvelope<unknown>>(
      `${this.apiBaseUrl}/teams/${encodeURIComponent(teamRef)}`,
    );
    if (!isRecord(response.data)) {
      throw new Error(`RanobeLib returned an invalid team payload for ${teamRef}`);
    }

    const raw = response.data;
    const id = numberOrNull(raw.id);
    const slug = stringOrNull(raw.slug);
    const name = stringOrNull(raw.name);
    if (id === null || !slug || !name) {
      throw new Error(`RanobeLib team payload is missing id/slug/name for ${teamRef}`);
    }

    const countDetails = isRecord(raw.titles_count_details) ? raw.titles_count_details : {};
    const totalTitleCount = extractStatValue(raw.stats, 'titles');

    return {
      id,
      slug,
      ref: stringOrNull(raw.slug_url) ?? `${id}--${slug}`,
      name,
      ranobeTitleCount: numberOrNull(countDetails[String(this.siteId)]),
      totalTitleCount,
      raw,
    };
  }

  async getTeamCatalog(teamRef: string): Promise<RanobeLibTeamCatalog> {
    const team = await this.getTeam(teamRef);
    const books: RanobeLibTeamBookRef[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= 100; page += 1) {
      const params = new URLSearchParams({
        target_id: String(team.id),
        target_model: 'team',
        page: String(page),
      });
      const response = await this.getJson<ApiListEnvelope<unknown>>(
        `${this.apiBaseUrl}/manga?${params.toString()}`,
      );
      const items = Array.isArray(response.data) ? response.data : [];

      for (const item of items) {
        const book = normalizeTeamBook(item, this.siteBaseUrl);
        if (!book || seen.has(book.ref)) continue;
        seen.add(book.ref);
        books.push(book);
      }

      const hasNextPage = response.meta?.has_next_page === true || Boolean(response.links?.next);
      if (!hasNextPage) break;
    }

    if (books.length === 0) {
      throw new Error(`RanobeLib public catalog returned zero titles for team ${team.ref}`);
    }

    return { team, books };
  }

  async discoverTeamBooks(teamRef: string): Promise<RanobeLibTeamBookRef[]> {
    return (await this.getTeamCatalog(teamRef)).books;
  }

  async getTitle(bookRef: string): Promise<RanobeLibTitle> {
    const response = await this.getJson<ApiEnvelope<unknown>>(
      `${this.apiBaseUrl}/manga/${encodeURIComponent(bookRef)}?fields[]=summary`,
    );
    const raw = isRecord(response.data) ? response.data : {};
    return normalizeTitle(raw, bookRef);
  }

  async getChapters(bookRef: string, teamId: number): Promise<RanobeLibChapter[]> {
    const response = await this.getJson<ApiEnvelope<unknown[]>>(
      `${this.apiBaseUrl}/manga/${encodeURIComponent(bookRef)}/chapters`,
    );

    const chapters = Array.isArray(response.data)
      ? response.data.flatMap((item) => normalizeOwnedChapters(item, teamId))
      : [];

    return sortChapters(chapters);
  }

  private async getJson<T>(url: string): Promise<T> {
    const response = await this.request(url);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      const preview = (await response.text()).slice(0, 180);
      throw new Error(`RanobeLib returned non-JSON content for ${url}: ${preview}`);
    }
    return (await response.json()) as T;
  }

  private async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        headers: {
          accept: 'application/json',
          'accept-language': 'ru,en;q=0.7',
          'content-type': 'application/json',
          'Site-Id': String(this.siteId),
          'Client-Time-Zone': 'UTC',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const preview = (await response.clone().text()).slice(0, 180);
        throw new Error(
          `RanobeLib request failed: ${response.status} ${response.statusText} (${url})${preview ? ` — ${preview}` : ''}`,
        );
      }

      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface ApiEnvelope<T> {
  data?: T;
}

interface ApiListEnvelope<T> extends ApiEnvelope<T[]> {
  meta?: {
    has_next_page?: boolean;
  };
  links?: {
    next?: string | null;
  };
}

function normalizeTeamBook(raw: unknown, siteBaseUrl: string): RanobeLibTeamBookRef | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  const slug = stringOrNull(raw.slug);
  const ref = stringOrNull(raw.slug_url) ?? (id !== null && slug ? `${id}--${slug}` : null);
  if (id === null || !slug || !ref) return null;

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

function normalizeOwnedChapters(raw: unknown, teamId: number): RanobeLibChapter[] {
  if (!isRecord(raw)) return [];
  const volume = tokenOrNull(raw.volume);
  const number = tokenOrNull(raw.number);
  if (volume === null || number === null) return [];

  const name = stringOrNull(raw.name);
  const branches = Array.isArray(raw.branches) ? raw.branches : [];
  const owned = branches
    .filter(isRecord)
    .filter((branch) => branchBelongsToTeam(branch, teamId))
    .map((branch): RanobeLibChapter | null => {
      const id = numberOrNull(branch.id);
      if (id === null) return null;
      return {
        id,
        volume,
        number,
        name,
        createdAt: stringOrNull(branch.created_at),
      };
    })
    .filter((chapter): chapter is RanobeLibChapter => chapter !== null);

  if (owned.length > 0) return owned;

  // Some API shapes may expose a single branch directly instead of a branches array.
  if (branchBelongsToTeam(raw, teamId)) {
    const id = numberOrNull(raw.id);
    if (id !== null) {
      return [{ id, volume, number, name, createdAt: stringOrNull(raw.created_at) }];
    }
  }

  return [];
}

function branchBelongsToTeam(branch: Record<string, unknown>, teamId: number): boolean {
  if (!Array.isArray(branch.teams)) return false;
  return branch.teams.some((team) => isRecord(team) && numberOrNull(team.id) === teamId);
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

function extractStatValue(raw: unknown, tag: string): number | null {
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (!isRecord(item) || stringOrNull(item.tag) !== tag) continue;
    return numberOrNull(item.value);
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
