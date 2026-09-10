export type ShadowParityRow = { bookRef: string; chapterCount: number };

export type ShadowParityResult = {
  ok: boolean;
  missingInMultiTeam: string[];
  extraInMultiTeam: string[];
  chapterCountMismatches: Array<{ bookRef: string; legacy: number; multiTeam: number }>;
};

export function comparePrimaryTeamParity(input: {
  legacy: readonly ShadowParityRow[];
  multiTeam: readonly ShadowParityRow[];
}): ShadowParityResult {
  const legacy = normalize(input.legacy);
  const multiTeam = normalize(input.multiTeam);
  const missingInMultiTeam = [...legacy.keys()].filter((bookRef) => !multiTeam.has(bookRef)).sort();
  const extraInMultiTeam = [...multiTeam.keys()].filter((bookRef) => !legacy.has(bookRef)).sort();
  const chapterCountMismatches: ShadowParityResult['chapterCountMismatches'] = [];
  for (const [bookRef, legacyCount] of legacy) {
    const multiTeamCount = multiTeam.get(bookRef);
    if (multiTeamCount !== undefined && multiTeamCount !== legacyCount) {
      chapterCountMismatches.push({ bookRef, legacy: legacyCount, multiTeam: multiTeamCount });
    }
  }
  chapterCountMismatches.sort((a, b) => a.bookRef.localeCompare(b.bookRef));
  return {
    ok: missingInMultiTeam.length === 0 && extraInMultiTeam.length === 0 && chapterCountMismatches.length === 0,
    missingInMultiTeam,
    extraInMultiTeam,
    chapterCountMismatches,
  };
}

function normalize(rows: readonly ShadowParityRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const bookRef = String(row.bookRef ?? '').trim();
    if (!bookRef) continue;
    const count = Number(row.chapterCount);
    map.set(bookRef, Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0);
  }
  return map;
}
