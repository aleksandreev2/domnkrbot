# RanobeLib synchronization spike

## Goal

Prove the no-manual-duplication workflow for «Дом Некроманта»:

1. discover the team's RanobeLib titles;
2. fetch title metadata and only the chapter branches published by this team;
3. keep a local last-known-good snapshot;
4. detect only chapters added after the previous successful snapshot;
5. later replace the JSON snapshot with D1 and route detected releases into Mini App/Telegram notifications.

Default team: `11969--dom-nekromanta` (team id `11969`).

## Current RanobeLib read API

Live reverse-engineering against the current RanobeLib frontend on 2026-08-12 established that the old `api2.mangalib.me` host is no longer suitable for cloud sync. The current frontend client uses:

- base URL: `https://api.cdnlibs.org/api`;
- required `Site-Id: 3` header for RanobeLib;
- team: `GET /teams/{teamSlug}`;
- team title catalog: `GET /manga?target_id={teamId}&target_model=team&page={page}`;
- title: `GET /manga/{bookSlug}`;
- chapter list: `GET /manga/{bookSlug}/chapters`;
- team update feed: `GET /teams/{teamId}/chapters`.

The raw `ranobelib.me/ru/team/...` HTML is now an SPA shell and contains no title links. `team-discovery.ts` therefore remains only as an offline/import fallback for saved rendered HTML; live discovery uses the JSON API.

## Important chapter ownership rule

A RanobeLib title may contain branches from several translation teams. The sync must **not** treat the title's whole chapter list as «Дом Некроманта» releases.

For every chapter item, the client inspects `branches[]` and keeps only branches whose `teams[]` contains team id `11969`. The branch publication id is used as the stable local chapter id. This prevents another team's upload from creating a false Dom Nekromanta release/notification.

A live Pokémon probe demonstrated the difference clearly: the title contained hundreds of chapter items from multiple branches, while only a subset belonged to team `11969`.

## Catalog count discrepancy

At the time of the live probe, the team endpoint reported 37 RanobeLib titles in `titles_count_details[3]`, while the unauthenticated public `/manga?target_id=11969&target_model=team` catalog exposed 33. The sync therefore:

- accepts a non-empty public catalog as usable;
- logs a count mismatch visibly;
- never deletes last-known-good local projects merely because a later unauthenticated catalog response omits them;
- treats a zero-title catalog as a hard discovery failure rather than a successful empty sync.

This is intentionally conservative: transient visibility/auth/moderation changes must not wipe the local catalog.

## Safety properties

- The first run is bootstrap-only. It records existing chapters and emits no historical release storm.
- Chapters are compared by the team's RanobeLib branch publication ID, not just displayed chapter number.
- Removed/replaced branches are reported as state changes but are not treated as new releases.
- One book failing does not discard successful snapshots for the rest of the team.
- Team discovery failing or returning zero books prevents an empty catalog from replacing known-good state.
- API/site base URLs, site id and `fetch` are injectable for deterministic tests.

## Run

```bash
npm install
npm test
npm run sync:ranobelib:spike -- --team 11969--dom-nekromanta --limit 3
```

The first successful live run creates `.ranobelib-sync-state.json`. Run the same command again after new chapters are published; only newly added Dom Nekromanta branches are emitted as releases.

## Production follow-up

After importing the Dollar TL platform snapshot:

- move snapshot persistence to D1 (`projects`, `project_sources`, `releases`, `sync_state`);
- use the team chapter feed as the cheap frequent release probe and title-level branch lists for reconciliation;
- run sync from Cloudflare Cron;
- coalesce chapter additions into a short notification debounce window;
- enqueue Following notifications instead of sending inside the sync transaction;
- expose sync health, catalog mismatch and manual `Sync now` in Admin;
- keep RanobeLib read failures non-destructive: never erase last-known-good catalog state.
