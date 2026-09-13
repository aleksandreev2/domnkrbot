import type { RanobeLibChapterBranch } from './integrations/ranobelib/types.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './ranobelib-runtime.js';
import { reconcileReleaseOutboxRecipients } from './multi-team-notification-demand.js';
import type { TeamScopedCompletionPlan } from './multi-team-scan-plan.js';

export type MultiTeamPersistenceEnv = {
  DB: D1DatabaseLike;
  RANOBELIB_TOKEN_ENCRYPTION_KEY?: string;
};

export type MultiTeamPersistenceWork = {
  book_ref: string;
  slug: string | null;
  title: string | null;
};

export type MultiTeamPersistenceTranslationRow = {
  internal_team_id: number | string;
  completion_revision: number | string;
};

export type MultiTeamPersistenceReleaseCandidate = {
  branchKey: string;
  deliveryScopeKey: string;
  teamIds: number[];
  chapters: RanobeLibChapterBranch[];
};

export async function persistBranchRelease(
  env: MultiTeamPersistenceEnv,
  work: MultiTeamPersistenceWork,
  candidate: MultiTeamPersistenceReleaseCandidate,
): Promise<boolean> {
  if (candidate.chapters.length === 0 || candidate.teamIds.length === 0) return false;
  const first = candidate.chapters[0]!;
  const last = candidate.chapters[candidate.chapters.length - 1]!;
  const releaseId = multiTeamReleaseIdentity(
    work.book_ref,
    candidate.branchKey,
    candidate.chapters.map((row) => row.chapterId),
  );
  const title = work.title?.trim() || work.slug?.trim() || work.book_ref;
  const summary = candidate.chapters.length === 1
    ? `Chapter ${first.number}`
    : `Chapters ${first.number}–${last.number}`;

  const insertRelease = env.DB.prepare(`
    INSERT OR IGNORE INTO ranobelib_releases (
      id, book_ref, title_snapshot, chapter_count,
      first_chapter_id, first_volume, first_number,
      last_chapter_id, last_volume, last_number,
      summary, release_kind, delivery_scope_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'chapters', ?, CURRENT_TIMESTAMP)
  `).bind(
    releaseId,
    work.book_ref,
    title,
    candidate.chapters.length,
    first.chapterId,
    first.volume,
    first.number,
    last.chapterId,
    last.volume,
    last.number,
    summary,
    candidate.deliveryScopeKey,
  );
  const teamStatements = candidate.teamIds.map((teamId) => env.DB.prepare(`
    INSERT OR IGNORE INTO ranobelib_release_teams (release_id, team_id)
    VALUES (?, ?)
  `).bind(releaseId, teamId));

  let inserted = false;
  if (env.DB.batch) {
    const results = await env.DB.batch([insertRelease, ...teamStatements]);
    inserted = runChanges(results[0]) > 0;
  } else {
    inserted = runChanges(await insertRelease.run()) > 0;
    for (const statement of teamStatements) await statement.run();
  }

  await reconcileReleaseOutboxRecipients(env, releaseId);
  return inserted;
}

export async function finalizeTeamCompletions(
  env: MultiTeamPersistenceEnv,
  work: MultiTeamPersistenceWork,
  translations: readonly MultiTeamPersistenceTranslationRow[],
  plan: TeamScopedCompletionPlan,
  mode: 'baseline' | 'shadow' | 'live',
): Promise<boolean> {
  if (plan.finalizations.length === 0) return false;

  const finalizationStatements = plan.finalizations.map((row) => env.DB.prepare(`
    UPDATE ranobelib_team_translations
    SET semantic_status = 'completed',
        completion_pending = 0,
        completion_evidence = ?,
        last_synced_at = CURRENT_TIMESTAMP,
        sync_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE book_ref = ?
      AND team_id = ?
      AND completion_pending = 1
  `).bind(`team-branch-finalized:${row.branchKey}`, work.book_ref, row.teamId));

  if (mode === 'live' && plan.notifyTeamIds.length > 0) {
    const revisions = new Map<number, number>();
    for (const row of translations) {
      const teamId = Number(row.internal_team_id);
      const revision = Number(row.completion_revision);
      if (Number.isSafeInteger(teamId) && teamId > 0) {
        revisions.set(teamId, Number.isSafeInteger(revision) && revision >= 0 ? revision : 0);
      }
    }
    return persistTeamCompletionRelease(
      env,
      work,
      plan.notifyTeamIds,
      revisions,
      finalizationStatements,
    );
  }

  await runStatements(env.DB, finalizationStatements);
  return false;
}

async function persistTeamCompletionRelease(
  env: MultiTeamPersistenceEnv,
  work: MultiTeamPersistenceWork,
  notifyTeamIds: readonly number[],
  revisions: ReadonlyMap<number, number>,
  finalizationStatements: D1PreparedStatementLike[],
): Promise<boolean> {
  const teamIds = [...new Set(notifyTeamIds.filter((id) => Number.isSafeInteger(id) && id > 0))]
    .sort((a, b) => a - b);
  if (teamIds.length === 0) {
    await runStatements(env.DB, finalizationStatements);
    return false;
  }

  const revisionScope = teamIds.map((teamId) => `${teamId}@${revisions.get(teamId) ?? 0}`).join(',');
  const releaseId = `translation-completed:v2:${work.book_ref}:${revisionScope}`;
  const title = work.title?.trim() || work.slug?.trim() || work.book_ref;
  const deliveryScopeKey = `completion:v2:teams:${teamIds.join(',')}`;
  const insertRelease = env.DB.prepare(`
    INSERT OR IGNORE INTO ranobelib_releases (
      id, book_ref, title_snapshot, chapter_count,
      first_chapter_id, first_volume, first_number,
      last_chapter_id, last_volume, last_number,
      summary, release_kind, delivery_scope_key, created_at
    ) VALUES (?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL,
              'Перевод завершён', 'translation_completed', ?, CURRENT_TIMESTAMP)
  `).bind(releaseId, work.book_ref, title, deliveryScopeKey);
  const teamStatements = teamIds.map((teamId) => env.DB.prepare(`
    INSERT OR IGNORE INTO ranobelib_release_teams (release_id, team_id)
    VALUES (?, ?)
  `).bind(releaseId, teamId));

  let inserted = false;
  if (env.DB.batch) {
    const results = await env.DB.batch([insertRelease, ...teamStatements, ...finalizationStatements]);
    inserted = runChanges(results[0]) > 0;
  } else {
    inserted = runChanges(await insertRelease.run()) > 0;
    for (const statement of teamStatements) await statement.run();
    for (const statement of finalizationStatements) await statement.run();
  }

  await reconcileReleaseOutboxRecipients(env, releaseId);
  return inserted;
}

export type BranchSnapshotWriteStats = {
  branchWrites: number;
  mappingInserts: number;
  mappingDeletes: number;
};

type StoredSnapshotBranchRow = {
  chapter_id: number | string;
  branch_key: string;
  native_branch_id: number | string | null;
  identity_confidence: string;
  volume: string;
  number: string;
  name: string | null;
  released_at: string | null;
};

type StoredSnapshotMappingRow = {
  chapter_id: number | string;
  branch_key: string;
  team_id: number | string;
};

/**
 * Persists a fetched branch snapshot by diffing it against the stored state in the Worker.
 *
 * An identical snapshot sends no mutation statement to D1, and a real delta sends only the changed
 * branch rows and mapping tuples. Mappings are reconciled only for branches present in the payload,
 * so a branch omitted by an incomplete upstream response keeps its history.
 */
export async function persistBranchSnapshot(
  db: D1DatabaseLike,
  bookRef: string,
  values: Array<{ branch: RanobeLibChapterBranch; teamIds: number[] }>,
): Promise<BranchSnapshotWriteStats> {
  const stats: BranchSnapshotWriteStats = { branchWrites: 0, mappingInserts: 0, mappingDeletes: 0 };
  if (values.length === 0) return stats;

  const incoming = new Map<string, { branch: RanobeLibChapterBranch; teamIds: Set<number> }>();
  for (const { branch, teamIds } of values) {
    incoming.set(snapshotKey(branch.chapterId, branch.branchKey), {
      branch,
      teamIds: new Set(teamIds.filter((id) => Number.isSafeInteger(id) && id > 0)),
    });
  }

  const [{ results: storedBranches }, { results: storedMappings }] = await Promise.all([
    db.prepare(`
      SELECT chapter_id, branch_key, native_branch_id, identity_confidence,
             volume, number, name, released_at
      FROM ranobelib_chapter_branches
      WHERE book_ref = ?
    `).bind(bookRef).all<StoredSnapshotBranchRow>(),
    db.prepare(`
      SELECT chapter_id, branch_key, team_id
      FROM ranobelib_chapter_branch_teams
      WHERE book_ref = ?
    `).bind(bookRef).all<StoredSnapshotMappingRow>(),
  ]);

  const storedBranchByKey = new Map(storedBranches.map((row) => [
    snapshotKey(Number(row.chapter_id), row.branch_key),
    row,
  ]));
  const storedTeamsByKey = new Map<string, Set<number>>();
  for (const row of storedMappings) {
    const key = snapshotKey(Number(row.chapter_id), row.branch_key);
    const teams = storedTeamsByKey.get(key) ?? new Set<number>();
    teams.add(Number(row.team_id));
    storedTeamsByKey.set(key, teams);
  }

  const branchesToWrite: RanobeLibChapterBranch[] = [];
  const mappingsToInsert: Array<[number, string, number]> = [];
  const mappingsToDelete: Array<[number, string, number]> = [];
  for (const [key, { branch, teamIds }] of incoming) {
    const stored = storedBranchByKey.get(key);
    if (!stored || branchMateriallyChanged(stored, branch)) branchesToWrite.push(branch);

    const storedTeams = storedTeamsByKey.get(key) ?? new Set<number>();
    for (const teamId of teamIds) {
      if (!storedTeams.has(teamId)) mappingsToInsert.push([branch.chapterId, branch.branchKey, teamId]);
    }
    for (const teamId of storedTeams) {
      if (!teamIds.has(teamId)) mappingsToDelete.push([branch.chapterId, branch.branchKey, teamId]);
    }
  }

  const statements: D1PreparedStatementLike[] = [];
  if (branchesToWrite.length > 0) statements.push(upsertSnapshotBranches(db, bookRef, branchesToWrite));
  if (mappingsToInsert.length > 0) {
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO ranobelib_chapter_branch_teams (
        book_ref, chapter_id, branch_key, team_id
      )
      SELECT ?,
        CAST(json_extract(j.value, '$[0]') AS INTEGER),
        CAST(json_extract(j.value, '$[1]') AS TEXT),
        CAST(json_extract(j.value, '$[2]') AS INTEGER)
      FROM json_each(?) AS j
    `).bind(bookRef, JSON.stringify(mappingsToInsert)));
  }
  if (mappingsToDelete.length > 0) {
    statements.push(db.prepare(`
      DELETE FROM ranobelib_chapter_branch_teams
      WHERE book_ref = ?
        AND (chapter_id, branch_key, team_id) IN (
          SELECT
            CAST(json_extract(j.value, '$[0]') AS INTEGER),
            CAST(json_extract(j.value, '$[1]') AS TEXT),
            CAST(json_extract(j.value, '$[2]') AS INTEGER)
          FROM json_each(?) AS j
        )
    `).bind(bookRef, JSON.stringify(mappingsToDelete)));
  }

  await runStatements(db, statements);
  stats.branchWrites = branchesToWrite.length;
  stats.mappingInserts = mappingsToInsert.length;
  stats.mappingDeletes = mappingsToDelete.length;
  return stats;
}

function snapshotKey(chapterId: number, branchKey: string): string {
  return `${chapterId}\u0000${branchKey}`;
}

/** Mirrors the COALESCE semantics of the branch upsert so unchanged rows are never sent to D1. */
function branchMateriallyChanged(stored: StoredSnapshotBranchRow, branch: RanobeLibChapterBranch): boolean {
  return sqlText(branch.nativeBranchId ?? stored.native_branch_id) !== sqlText(stored.native_branch_id)
    || sqlText(branch.identityConfidence) !== sqlText(stored.identity_confidence)
    || sqlText(branch.volume) !== sqlText(stored.volume)
    || sqlText(branch.number) !== sqlText(stored.number)
    || sqlText(branch.name ?? stored.name) !== sqlText(stored.name)
    || sqlText(branch.releasedAt ?? stored.released_at) !== sqlText(stored.released_at);
}

function sqlText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function upsertSnapshotBranches(
  db: D1DatabaseLike,
  bookRef: string,
  branches: RanobeLibChapterBranch[],
): D1PreparedStatementLike {
  const payload = JSON.stringify(branches.map((branch) => ({
    chapterId: branch.chapterId,
    branchKey: branch.branchKey,
    nativeBranchId: branch.nativeBranchId,
    confidence: branch.identityConfidence,
    volume: branch.volume,
    number: branch.number,
    name: branch.name,
    releasedAt: branch.releasedAt,
  })));

  return db.prepare(`
    WITH incoming AS (
      SELECT
        CAST(json_extract(j.value, '$.chapterId') AS INTEGER) AS chapter_id,
        CAST(json_extract(j.value, '$.branchKey') AS TEXT) AS branch_key,
        CAST(json_extract(j.value, '$.nativeBranchId') AS INTEGER) AS native_branch_id,
        CAST(json_extract(j.value, '$.confidence') AS TEXT) AS identity_confidence,
        CAST(json_extract(j.value, '$.volume') AS TEXT) AS volume,
        CAST(json_extract(j.value, '$.number') AS TEXT) AS number,
        json_extract(j.value, '$.name') AS name,
        json_extract(j.value, '$.releasedAt') AS released_at
      FROM json_each(?) AS j
    )
    INSERT INTO ranobelib_chapter_branches (
      book_ref, chapter_id, branch_key, native_branch_id, identity_confidence,
      volume, number, name, released_at, first_seen_at, last_seen_at
    )
    SELECT ?, chapter_id, branch_key, native_branch_id, identity_confidence,
           volume, number, name, released_at, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM incoming
    WHERE 1 = 1
    ON CONFLICT(book_ref, chapter_id, branch_key) DO UPDATE SET
      native_branch_id = COALESCE(excluded.native_branch_id, ranobelib_chapter_branches.native_branch_id),
      identity_confidence = excluded.identity_confidence,
      volume = excluded.volume,
      number = excluded.number,
      name = COALESCE(excluded.name, ranobelib_chapter_branches.name),
      released_at = COALESCE(excluded.released_at, ranobelib_chapter_branches.released_at),
      last_seen_at = CURRENT_TIMESTAMP
    WHERE COALESCE(excluded.native_branch_id, ranobelib_chapter_branches.native_branch_id)
            IS NOT ranobelib_chapter_branches.native_branch_id
       OR excluded.identity_confidence IS NOT ranobelib_chapter_branches.identity_confidence
       OR excluded.volume IS NOT ranobelib_chapter_branches.volume
       OR excluded.number IS NOT ranobelib_chapter_branches.number
       OR COALESCE(excluded.name, ranobelib_chapter_branches.name)
            IS NOT ranobelib_chapter_branches.name
       OR COALESCE(excluded.released_at, ranobelib_chapter_branches.released_at)
            IS NOT ranobelib_chapter_branches.released_at
  `).bind(payload, bookRef);
}

export async function markTranslationsBaselined(
  db: D1DatabaseLike,
  bookRef: string,
  teamIds: number[],
): Promise<void> {
  const ids = [...new Set(teamIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return;
  await db.prepare(`
    UPDATE ranobelib_team_translations
    SET baseline_ready = 1,
        last_synced_at = CURRENT_TIMESTAMP,
        sync_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE book_ref = ?
      AND team_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
  `).bind(bookRef, JSON.stringify(ids)).run();
}

async function runStatements(db: D1DatabaseLike, statements: D1PreparedStatementLike[]): Promise<void> {
  if (statements.length === 0) return;
  if (db.batch) {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

export function multiTeamReleaseIdentity(bookRef: string, branchKey: string, chapterIds: readonly number[]): string {
  const ids = [...new Set(chapterIds.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
  return `branch-release:v1:${bookRef}:${encodeURIComponent(branchKey)}:${ids.join(',')}`;
}

function runChanges(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const object = result as { meta?: { changes?: unknown }; changes?: unknown };
  const value = object.meta?.changes ?? object.changes ?? 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
