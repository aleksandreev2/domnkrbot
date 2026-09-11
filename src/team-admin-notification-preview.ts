import { RanobeLibClient } from './integrations/ranobelib/client.js';
import type { RanobeLibChapterBranch } from './integrations/ranobelib/types.js';
import type { D1DatabaseLike } from './ranobelib-runtime.js';
import type { RanobeLibTeamRecord } from './ranobelib-team-registry.js';

export type TeamAdminNotificationPreview = {
  titleId?: number;
  title: string;
  readUrl: string;
  volume: string;
  number: string;
  chapterName: string | null;
  teamNames: string[];
};

type CandidateRow = {
  book_ref: string;
  ranobelib_id: number | string | null;
  title: string | null;
  last_seen_at: string | null;
};

type TeamNameRow = {
  ranobelib_team_id: number | string;
  display_name: string;
  is_primary: number | string;
};

type PreviewCandidate = {
  row: CandidateRow;
  branch: RanobeLibChapterBranch;
  releaseMs: number | null;
  candidateOrder: number;
};

export async function loadTeamAdminNotificationPreview(
  db: D1DatabaseLike,
  team: RanobeLibTeamRecord,
  client: Pick<RanobeLibClient, 'getChapterBranches' | 'getTitle'> = new RanobeLibClient(),
): Promise<TeamAdminNotificationPreview> {
  const { results } = await db.prepare(`
    SELECT
      tt.book_ref,
      t.ranobelib_id,
      t.title,
      tt.last_seen_at
    FROM ranobelib_team_translations tt
    JOIN ranobelib_titles t ON t.book_ref = tt.book_ref
    WHERE tt.team_id = ?
      AND tt.presence_state = 'active'
    ORDER BY
      CASE WHEN tt.last_seen_at IS NULL THEN 1 ELSE 0 END,
      tt.last_seen_at DESC,
      tt.book_ref ASC
    LIMIT 12
  `).bind(team.id).all<CandidateRow>();

  if (results.length === 0) {
    throw new Error('у команды нет активных переводов для теста');
  }

  let winner: PreviewCandidate | null = null;
  let candidateOrder = 0;
  for (const row of results) {
    let branches: RanobeLibChapterBranch[];
    try {
      branches = await client.getChapterBranches(row.book_ref);
    } catch {
      candidateOrder += 1;
      continue;
    }
    const matching = branches.filter((branch) => branch.teamIds.includes(team.ranobelibTeamId));
    if (matching.length === 0) {
      candidateOrder += 1;
      continue;
    }

    // getChapterBranches() is stable-sorted by chapter position. If upstream omitted created_at,
    // the last matching chapter is the safest real preview for that work.
    const branch = matching.reduce((best, current) => {
      const bestMs = releaseTimestamp(best.releasedAt);
      const currentMs = releaseTimestamp(current.releasedAt);
      if (currentMs !== null && (bestMs === null || currentMs > bestMs)) return current;
      if (currentMs === null && bestMs === null) return current;
      return best;
    });
    const candidate: PreviewCandidate = {
      row,
      branch,
      releaseMs: releaseTimestamp(branch.releasedAt),
      candidateOrder,
    };
    if (!winner || previewCandidateIsNewer(candidate, winner)) winner = candidate;
    candidateOrder += 1;
  }

  if (!winner) {
    throw new Error('не нашлось ни одной опубликованной главы этой команды');
  }

  const titleDetail = (!winner.row.title || !positiveIntOrNull(winner.row.ranobelib_id))
    ? await client.getTitle(winner.row.book_ref).catch(() => null)
    : null;
  const title = cleanText(winner.row.title) ?? cleanText(titleDetail?.title) ?? winner.row.book_ref;
  const titleId = positiveIntOrNull(winner.row.ranobelib_id) ?? positiveIntOrNull(titleDetail?.id);
  const teamNames = await loadPreviewTeamNames(db, winner.branch.teamIds, team);

  return {
    ...(titleId ? { titleId } : {}),
    title,
    readUrl: chapterReadUrl(winner.row.book_ref, winner.branch.volume, winner.branch.number),
    volume: winner.branch.volume,
    number: winner.branch.number,
    chapterName: winner.branch.name,
    teamNames,
  };
}

function previewCandidateIsNewer(candidate: PreviewCandidate, current: PreviewCandidate): boolean {
  if (candidate.releaseMs !== null && current.releaseMs !== null) return candidate.releaseMs > current.releaseMs;
  if (candidate.releaseMs !== null) return true;
  if (current.releaseMs !== null) return false;
  return candidate.candidateOrder < current.candidateOrder;
}

async function loadPreviewTeamNames(
  db: D1DatabaseLike,
  branchTeamIds: readonly number[],
  selectedTeam: RanobeLibTeamRecord,
): Promise<string[]> {
  const ids = [...new Set(branchTeamIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.includes(selectedTeam.ranobelibTeamId)) ids.push(selectedTeam.ranobelibTeamId);
  if (ids.length === 0) return [selectedTeam.displayName];

  const { results } = await db.prepare(`
    SELECT ranobelib_team_id, display_name, is_primary
    FROM ranobelib_teams
    WHERE ranobelib_team_id IN (
      SELECT CAST(value AS INTEGER) FROM json_each(?)
    )
    ORDER BY is_primary DESC, display_name COLLATE NOCASE ASC
  `).bind(JSON.stringify(ids)).all<TeamNameRow>();

  const names = results.map((row) => cleanText(row.display_name)).filter((value): value is string => Boolean(value));
  if (!names.some((name) => name.toLocaleLowerCase('ru') === selectedTeam.displayName.toLocaleLowerCase('ru'))) {
    names.push(selectedTeam.displayName);
  }
  return [...new Set(names)];
}

function chapterReadUrl(bookRef: string, volume: string, chapter: string): string {
  const base = `https://ranobelib.me/ru/${encodeURIComponent(bookRef)}/read`;
  const normalizedVolume = cleanText(volume);
  const normalizedChapter = cleanText(chapter);
  if (!normalizedVolume || !normalizedChapter) return base;
  return `${base}/v${encodeURIComponent(normalizedVolume)}/c${encodeURIComponent(normalizedChapter)}`;
}

function releaseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveIntOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
