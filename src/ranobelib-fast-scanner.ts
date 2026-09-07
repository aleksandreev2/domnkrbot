export const FAST_SCAN_LIMIT = 6;

type D1AllResult<T> = { results: T[] };
type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<D1AllResult<T>>;
};

type ScannerEnv = {
  DB: {
    prepare(query: string): D1PreparedStatementLike;
  };
};

export type DueTitle = {
  book_ref: string;
  url: string;
  title: string | null;
  consecutive_no_change: number | string;
  last_change_at: string | null;
  next_check_at: string | null;
  scan_priority: number | string;
};

export type NextCheckInput = {
  changed: boolean;
  consecutiveNoChange: number;
  lastChangeAt?: string | null;
  failed?: boolean;
};

export function computeNextCheckDelayMinutes(input: NextCheckInput): number {
  if (input.failed) return 10;
  if (input.changed) return 1;

  const misses = Math.max(0, Math.floor(Number(input.consecutiveNoChange) || 0));
  if (misses <= 2) return 3;
  if (misses <= 5) return 10;
  if (misses <= 11) return 20;
  return 30;
}

export async function selectDueTitles(env: ScannerEnv, limit = FAST_SCAN_LIMIT): Promise<DueTitle[]> {
  const safeLimit = Math.max(1, Math.min(FAST_SCAN_LIMIT, Math.floor(Number(limit) || FAST_SCAN_LIMIT)));
  const { results } = await env.DB.prepare(`
    SELECT book_ref, url, title, consecutive_no_change, last_change_at, next_check_at, scan_priority
    FROM ranobelib_titles
    WHERE is_active = 1
      AND snapshot_ready = 1
      AND (next_check_at IS NULL OR next_check_at <= CURRENT_TIMESTAMP)
    ORDER BY next_check_at ASC, scan_priority DESC, book_ref ASC
    LIMIT ?
  `).bind(safeLimit).all<DueTitle>();
  return results.slice(0, safeLimit);
}
