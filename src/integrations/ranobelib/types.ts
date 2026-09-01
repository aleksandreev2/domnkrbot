export interface RanobeLibTeamBookRef {
  id: number;
  slug: string;
  ref: string;
  url: string;
  title: string | null;
}

export interface RanobeLibTitle {
  id: number | null;
  slug: string | null;
  title: string | null;
  summary: string | null;
  coverUrl: string | null;
  raw: unknown;
}

export interface RanobeLibChapter {
  id: number;
  volume: string;
  number: string;
  name: string | null;
}

export interface RanobeLibReleaseDelta {
  bookRef: string;
  added: RanobeLibChapter[];
  removed: RanobeLibChapter[];
  summary: string;
}

export interface RanobeLibSyncBookState {
  bookRef: string;
  url: string;
  title: string | null;
  coverUrl: string | null;
  chapters: RanobeLibChapter[];
  syncedAt: string;
}

export interface RanobeLibSyncState {
  version: 1;
  teamRef: string;
  books: Record<string, RanobeLibSyncBookState>;
  syncedAt: string;
}
