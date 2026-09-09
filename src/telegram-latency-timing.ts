export type TelegramLatencyStage =
  | 'ack_started'
  | 'schema_done'
  | 'db_started'
  | 'db_done'
  | 'telegram_started'
  | 'screen_ready'
  | 'telegram_done';

export type TelegramLatencySnapshot = {
  route: string;
  kind?: string;
  ack_started_ms?: number;
  schema_ms?: number;
  db_started_ms?: number;
  db_ms?: number;
  telegram_started_ms?: number;
  screen_ready_ms?: number;
  telegram_ms?: number;
  render_strategy?: string;
  telegram_method?: string;
  telegram_api_ms?: number;
  total_ms: number;
};

export type TelegramLatencyTiming = {
  mark(stage: TelegramLatencyStage): void;
  describeRender(strategy: string, method: string): void;
  recordTelegramApi(durationMs: number): void;
  snapshot(route: string, kind?: string): TelegramLatencySnapshot;
};

const snapshotFields: Record<TelegramLatencyStage, keyof TelegramLatencySnapshot> = {
  ack_started: 'ack_started_ms',
  schema_done: 'schema_ms',
  db_started: 'db_started_ms',
  db_done: 'db_ms',
  telegram_started: 'telegram_started_ms',
  screen_ready: 'screen_ready_ms',
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

function normalizeDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

export function createTelegramLatencyTiming(startedAt = Date.now()): TelegramLatencyTiming {
  const marks: Partial<Record<TelegramLatencyStage, number>> = {};
  let latestElapsed = 0;
  let renderStrategy: string | undefined;
  let telegramMethod: string | undefined;
  let telegramApiMs: number | undefined;

  function elapsed(): number {
    const current = Math.max(0, Date.now() - startedAt);
    latestElapsed = Math.max(latestElapsed, current);
    return latestElapsed;
  }

  return {
    mark(stage) {
      marks[stage] = elapsed();
    },

    describeRender(strategy, method) {
      renderStrategy = normalizeMetadata(strategy);
      telegramMethod = normalizeMetadata(method);
    },

    recordTelegramApi(durationMs) {
      telegramApiMs = normalizeDuration(durationMs);
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
      if (renderStrategy) snapshot.render_strategy = renderStrategy;
      if (telegramMethod) snapshot.telegram_method = telegramMethod;
      if (telegramApiMs !== undefined) snapshot.telegram_api_ms = telegramApiMs;
      snapshot.total_ms = elapsed();
      return snapshot;
    },
  };
}
