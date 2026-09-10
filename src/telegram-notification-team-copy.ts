const PRIMARY_TEAM_NAME = 'Дом Некроманта';

export function normalizeNotificationTeamNames(teamNames: readonly string[] | null | undefined): string[] {
  const byKey = new Map<string, string>();
  for (const raw of teamNames ?? []) {
    const value = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!value) continue;
    const key = value.toLocaleLowerCase('ru-RU');
    if (!byKey.has(key)) byKey.set(key, value);
  }

  const names = [...byKey.values()];
  names.sort((a, b) => {
    const aPrimary = a.toLocaleLowerCase('ru-RU') === PRIMARY_TEAM_NAME.toLocaleLowerCase('ru-RU');
    const bPrimary = b.toLocaleLowerCase('ru-RU') === PRIMARY_TEAM_NAME.toLocaleLowerCase('ru-RU');
    if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
    return a.localeCompare(b, 'ru', { sensitivity: 'base', numeric: true });
  });
  return names;
}

export function notificationTranslatorLine(
  teamNames: readonly string[] | null | undefined,
  escapeHtml: (value: string) => string,
): string {
  const names = normalizeNotificationTeamNames(teamNames);
  // Legacy releases created before multi-team mappings existed belong to the primary team.
  if (names.length === 0) return `Перевод команды «${escapeHtml(PRIMARY_TEAM_NAME)}».`;
  if (names.length === 1) return `Перевод команды «${escapeHtml(names[0]!)}».`;
  return `Перевод команд: ${names.map((name) => `«${escapeHtml(name)}»`).join(', ')}.`;
}
