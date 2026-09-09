export type TelegramLatencyStage = 'ack_started' | 'schema_done' | 'db_done' | 'telegram_done';

export type TelegramLatencySnapshot = {
  route: string;
  kind?: string;
  ack_started_ms?: number;
  schema_ms?: number;
  db_ms?: number;
  telegram_ms?: number;
  total_ms: number;
};

export type TelegramLatencyTiming = {
  mark(stage: TelegramLatencyStage): void;
  snapshot(route: string, kind?: string): TelegramLatencySnapshot;
};

const snapshotFields: Record<TelegramLatencyStage, keyof TelegramLatencySnapshot> = {
  ack_started: 'ack_started_ms',
  schema_done: 'schema_ms',
  db_done: 'db_ms',
  telegram_done: 'telegram_ms',
};

function normalizeMetadata(value: string | undefined): string | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || undefined;
}

export function createTelegramLatencyTiming(startedAt = Date.now()): TelegramLatencyTiming {
  const marks: Partial<Record<TelegramLatencyStage, number>> = {};
  let latestElapsed = 0;

  function elapsed(): number {
    const current = Math.max(0, Date.now() - startedAt);
    latestElapsed = Math.max(latestElapsed, current);
    return latestElapsed;
  }

  return {
    mark(stage) {
      marks[stage] = elapsed();
    },

    snapshot(route, kind) {
      const snapshot: TelegramLatencySnapshot = {
        route: normalizeMetadata(route) ?? 'unknown',
        total_ms: 0,
      };
      const normalizedKind = normalizeMetadata(kind);
      if (normalizedKind) snapshot.kind = normalizedKind;

      for (const stage of Object.keys(snapshotFields) as TelegramLatencyStage[]) {
        const value = marks[stage];
        if (value !== undefined) {
          const field = snapshotFields[stage];
          (snapshot as Record<string, unknown>)[field] = value;
        }
      }
      snapshot.total_ms = elapsed();
      return snapshot;
    },
  };
}
