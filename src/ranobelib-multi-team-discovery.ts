import { RanobeLibClient } from './integrations/ranobelib/client.js';
import type { RanobeLibTeamBookRef } from './integrations/ranobelib/types.js';
import type { D1DatabaseLike } from './ranobelib-runtime.js';
import {
  listRunnableRanobeLibTeams,
  recordRanobeLibTeamSyncFailure,
  recordRanobeLibTeamSyncSuccess,
  type RanobeLibTeamRecord,
} from './ranobelib-team-registry.js';

export type MultiTeamDiscoveryEnv = { DB: D1DatabaseLike };

export type TeamDiscoveryResult = {
  teamId: number;
  discovered: number;
  activated: number;
  dormant: number;
  created: number;
};

export type MultiTeamDiscoveryResult = {
  teamsSelected: number;
  teamsSucceeded: number;
  teamsFailed: number;
  discoveredRelationships: number;
  errors: string[];
};

export type TeamDiscoveryClient = Pick<RanobeLibClient, 'discoverTeamBooks'> &
  Partial<Pick<RanobeLibClient,
    'getTeamDisplayName' | 'discoverTeamHistoryBooks' | 'discoverTeamPageBooks' | 'getTeamAttributedBook'
  >>;

export type MultiTeamDiscoveryOptions = {
  clientFactory?: (team: RanobeLibTeamRecord) => TeamDiscoveryClient;
};

export type StoredRelationRow = {
  book_ref: string;
  presence_state: 'active' | 'dormant';
};

export type TeamDiscoveryReconciliation = {
  activate: string[];
  makeDormant: string[];
  unchangedActive: string[];
};

const SECONDARY_TEAM_VERIFY_LIMIT = 24;

export function computeTeamDiscoveryReconciliation(
  stored: readonly StoredRelationRow[],
  discoveredRefs: readonly string[],
  preservedRefs: readonly string[] = [],
): TeamDiscoveryReconciliation {
  const discovered = new Set(discoveredRefs.map(cleanRef).filter(Boolean));
  const preserved = new Set(preservedRefs.map(cleanRef).filter(Boolean));
  const activate: string[] = [];
  const makeDormant: string[] = [];
  const unchangedActive: string[] = [];

  for (const row of stored) {
    const ref = cleanRef(row.book_ref);
    if (!ref) continue;
    if (discovered.has(ref)) {
      if (row.presence_state === 'active') unchangedActive.push(ref);
      else activate.push(ref);
      discovered.delete(ref);
    } else if (row.presence_state === 'active') {
      if (preserved.has(ref)) unchangedActive.push(ref);
      else makeDormant.push(ref);
    }
  }

  // Brand-new refs are activations from the catalog point of view; callers can separately count
  // them as created by comparing to stored keys.
  activate.push(...discovered);
  return {
    activate: sortedUnique(activate),
    makeDormant: sortedUnique(makeDormant),
    unchangedActive: sortedUnique(unchangedActive),
  };
}

export async function discoverRegisteredRanobeLibTeams(
  env: MultiTeamDiscoveryEnv,
  options: MultiTeamDiscoveryOptions = {},
): Promise<MultiTeamDiscoveryResult> {
  const teams = await listRunnableRanobeLibTeams(env);
  let teamsSucceeded = 0;
  let teamsFailed = 0;
  let discoveredRelationships = 0;
  const errors: string[] = [];

  // Team catalog discovery is deliberately isolated per team. A transient failure in one team
  // cannot prevent the remaining teams from refreshing.
  for (const team of teams) {
    try {
      const client = options.clientFactory?.(team) ?? new RanobeLibClient();
      const result = await discoverOneRegisteredTeam(env, team, client);
      teamsSucceeded += 1;
      discoveredRelationships += result.discovered;
    } catch (error) {
      teamsFailed += 1;
      const message = `${team.ranobelibTeamRef}: ${compactError(error)}`;
      errors.push(message);
      await recordRanobeLibTeamSyncFailure(env, team.id, error).catch(() => undefined);
    }
  }

  return {
    teamsSelected: teams.length,
    teamsSucceeded,
    teamsFailed,
    discoveredRelationships,
    errors,
  };
}

export async function discoverOneRegisteredTeam(
  env: MultiTeamDiscoveryEnv,
  team: RanobeLibTeamRecord,
  client: TeamDiscoveryClient = new RanobeLibClient(),
): Promise<TeamDiscoveryResult> {
  if (team.lifecycleState === 'paused') {
    return { teamId: team.id, discovered: 0, activated: 0, dormant: 0, created: 0 };
  }

  const catalogBooks = await client.discoverTeamBooks(team.ranobelibTeamRef);
  // An empty catalog is treated as upstream/parser failure, exactly like the legacy discovery path:
  // never collapse a previously valid team because one request unexpectedly returned zero items.
  if (catalogBooks.length === 0) {
    throw new Error(`RanobeLib team ${team.ranobelibTeamRef} returned no book links`);
  }

  const upstreamDisplayName = client.getTeamDisplayName
    ? await client.getTeamDisplayName(team.ranobelibTeamRef, catalogBooks.map((book) => book.ref)).catch(() => null)
    : null;
  if (upstreamDisplayName && upstreamDisplayName !== team.displayName) {
    await env.DB.prepare(`
      UPDATE ranobelib_teams
      SET display_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(upstreamDisplayName, team.id).run();
  }

  const { results: existingRows } = await env.DB.prepare(`
    SELECT book_ref, presence_state
    FROM ranobelib_team_translations
    WHERE team_id = ?
  `).bind(team.id).all<StoredRelationRow>();
  const existing = new Set(existingRows.map((row) => cleanRef(row.book_ref)).filter(Boolean));

  const supplemented = await supplementPartnerHistory(team, client, catalogBooks, existingRows);
  const books = supplemented.books;
  const reconciliation = computeTeamDiscoveryReconciliation(
    existingRows,
    books.map((book) => book.ref),
    supplemented.preservedRefs,
  );

  await upsertWorkRows(env.DB, books);
  await upsertTeamTranslationRows(env.DB, team.id, books);
  if (reconciliation.makeDormant.length > 0) {
    await markTeamTranslationsDormant(env.DB, team.id, reconciliation.makeDormant);
  }
  await recordRanobeLibTeamSyncSuccess(env, team.id);

  const created = books.reduce((count, book) => count + (existing.has(book.ref) ? 0 : 1), 0);
  const reactivated = reconciliation.activate.length - created;
  return {
    teamId: team.id,
    discovered: books.length,
    activated: Math.max(0, reactivated),
    dormant: reconciliation.makeDormant.length,
    created,
  };
}

export async function supplementPartnerHistory(
  team: RanobeLibTeamRecord,
  client: TeamDiscoveryClient,
  catalogBooks: readonly RanobeLibTeamBookRef[],
  existingRows: readonly StoredRelationRow[],
): Promise<{ books: RanobeLibTeamBookRef[]; preservedRefs: string[] }> {
  const booksByRef = new Map(catalogBooks.map((book) => [cleanRef(book.ref), book]));
  const preserved = new Set<string>();

  if (client.discoverTeamHistoryBooks) {
    try {
      const historyBooks = await client.discoverTeamHistoryBooks(team.ranobelibTeamRef);
      // History rows already carry an explicit teams[] attribution checked by the client, so they
      // remain authoritative even when the anonymous title detail endpoint returns 404.
      for (const book of historyBooks) booksByRef.set(cleanRef(book.ref), book);
    } catch (error) {
      console.error('RanobeLib partner chapter history fallback failed', team.ranobelibTeamRef, compactError(error));
    }
  }

  // Exact chapter-team attribution is safe for every team and covers titles hidden from the
  // anonymous catalog. Keep the less authoritative HTML/detail fallback partner-only.
  if (team.isPrimary) {
    return { books: [...booksByRef.values()], preservedRefs: [] };
  }

  if (!client.discoverTeamPageBooks || !client.getTeamAttributedBook) {
    return { books: [...booksByRef.values()], preservedRefs: [] };
  }

  const existingByRef = new Map(existingRows.map((row) => [cleanRef(row.book_ref), row]));
  let pageBooks: RanobeLibTeamBookRef[];
  try {
    pageBooks = await client.discoverTeamPageBooks(team.ranobelibTeamRef);
  } catch (error) {
    // Secondary discovery is deliberately fail-open. A broken/blocked HTML page must not turn
    // previously known partner translations dormant merely because the API catalog is incomplete.
    for (const row of existingRows) {
      const ref = cleanRef(row.book_ref);
      if (ref && row.presence_state === 'active' && !booksByRef.has(ref)) preserved.add(ref);
    }
    console.error('RanobeLib partner history page fallback failed', team.ranobelibTeamRef, compactError(error));
    return { books: [...booksByRef.values()], preservedRefs: [...preserved] };
  }

  const pageRefs = new Set(pageBooks.map((book) => cleanRef(book.ref)).filter(Boolean));
  const candidates: string[] = [];

  for (const pageBook of pageBooks) {
    const ref = cleanRef(pageBook.ref);
    if (!ref || booksByRef.has(ref)) continue;
    const stored = existingByRef.get(ref);
    if (stored?.presence_state === 'active') {
      // This is already-known state and the public team page still asserts it. Avoid an N+1 detail
      // request on every sync; exact verification is mandatory only before creating/reactivating.
      preserved.add(ref);
      continue;
    }
    candidates.push(ref);
  }

  // Existing active relations missing from both the API catalog and HTML page get one exact-detail
  // chance before dormancy. This handles different RanobeLib views lagging each other.
  for (const row of existingRows) {
    const ref = cleanRef(row.book_ref);
    if (!ref || row.presence_state !== 'active' || booksByRef.has(ref) || pageRefs.has(ref)) continue;
    candidates.push(ref);
  }

  const uniqueCandidates = [...new Set(candidates)];
  let verified = 0;
  for (const ref of uniqueCandidates) {
    if (verified >= SECONDARY_TEAM_VERIFY_LIMIT) {
      if (existingByRef.get(ref)?.presence_state === 'active') preserved.add(ref);
      continue;
    }
    verified += 1;
    try {
      const book = await client.getTeamAttributedBook(team.ranobelibTeamRef, ref);
      if (book) booksByRef.set(cleanRef(book.ref), book);
    } catch (error) {
      // Exact lookup failures are inconclusive, not negative evidence. Preserve only existing active
      // rows; brand-new candidates can safely wait for the next sync instead of being guessed in.
      if (existingByRef.get(ref)?.presence_state === 'active') preserved.add(ref);
      console.error('RanobeLib partner title attribution check failed', team.ranobelibTeamRef, ref, compactError(error));
    }
  }

  return { books: [...booksByRef.values()], preservedRefs: [...preserved] };
}

async function upsertWorkRows(db: D1DatabaseLike, books: RanobeLibTeamBookRef[]): Promise<void> {
  const payload = JSON.stringify(books.map((book) => ({
    ref: book.ref,
    id: book.id,
    slug: book.slug,
    url: book.url,
    title: book.title ?? null,
    coverUrl: normalizeCoverUrl(book.coverUrl ?? null),
  })));

  // New work rows are inserted dormant from the legacy single-team scanner's perspective. The new
  // multi-team scheduler uses ranobelib_team_translations and can still bootstrap them safely.
  await db.prepare(`
    WITH incoming AS (
      SELECT
        CAST(json_extract(j.value, '$.ref') AS TEXT) AS book_ref,
        CAST(json_extract(j.value, '$.id') AS INTEGER) AS ranobelib_id,
        CAST(json_extract(j.value, '$.slug') AS TEXT) AS slug,
        CAST(json_extract(j.value, '$.url') AS TEXT) AS url,
        json_extract(j.value, '$.title') AS title,
        json_extract(j.value, '$.coverUrl') AS cover_url
      FROM json_each(?) AS j
    )
    INSERT INTO ranobelib_titles (
      book_ref, ranobelib_id, slug, url, title, cover_url, is_active, snapshot_ready
    )
    SELECT book_ref, ranobelib_id, slug, url, title, cover_url, 0, 0
    FROM incoming
    WHERE book_ref IS NOT NULL AND book_ref != ''
    ON CONFLICT(book_ref) DO UPDATE SET
      ranobelib_id = COALESCE(excluded.ranobelib_id, ranobelib_titles.ranobelib_id),
      slug = COALESCE(excluded.slug, ranobelib_titles.slug),
      url = excluded.url,
      title = COALESCE(excluded.title, ranobelib_titles.title),
      cover_url = COALESCE(excluded.cover_url, ranobelib_titles.cover_url)
  `).bind(payload).run();
}

async function upsertTeamTranslationRows(
  db: D1DatabaseLike,
  teamId: number,
  books: RanobeLibTeamBookRef[],
): Promise<void> {
  const refsJson = JSON.stringify(books.map((book) => book.ref));
  await db.prepare(`
    WITH incoming AS (
      SELECT CAST(value AS TEXT) AS book_ref
      FROM json_each(?)
    )
    INSERT INTO ranobelib_team_translations (
      team_id, book_ref, presence_state, semantic_status, baseline_ready,
      notification_subscriber_count, last_seen_at, last_synced_at, sync_error, updated_at
    )
    SELECT ?, book_ref, 'active', 'active', 0, 0,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP
    FROM incoming
    WHERE book_ref IS NOT NULL AND book_ref != ''
    ON CONFLICT(team_id, book_ref) DO UPDATE SET
      presence_state = 'active',
      -- Current membership in this exact team's RanobeLib catalog is attributable team evidence
      -- that the relationship is actionable. It is not completion evidence: a previously confirmed
      -- completion remains final until a stronger team-specific signal explicitly reopens it.
      semantic_status = CASE
        WHEN ranobelib_team_translations.semantic_status = 'completed' THEN 'completed'
        ELSE 'active'
      END,
      last_seen_at = CURRENT_TIMESTAMP,
      last_synced_at = CURRENT_TIMESTAMP,
      sync_error = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).bind(refsJson, teamId).run();
}

async function markTeamTranslationsDormant(
  db: D1DatabaseLike,
  teamId: number,
  refs: string[],
): Promise<void> {
  const refsJson = JSON.stringify(refs);
  await db.prepare(`
    UPDATE ranobelib_team_translations
    SET presence_state = 'dormant',
        notification_subscriber_count = 0,
        last_synced_at = CURRENT_TIMESTAMP,
        sync_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE team_id = ?
      AND book_ref IN (SELECT CAST(value AS TEXT) FROM json_each(?))
  `).bind(teamId, refsJson).run();
}

function cleanRef(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizeCoverUrl(value: string | null): string | null {
  if (!value) return null;
  if (/^https:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://cover.imglib.info${value}`;
  if (value.startsWith('uploads/')) return `https://cover.imglib.info/${value}`;
  return null;
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
