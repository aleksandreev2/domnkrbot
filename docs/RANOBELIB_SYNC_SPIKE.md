# RanobeLib synchronization spike

## Goal

Prove the no-manual-duplication workflow for «Дом Некроманта»:

1. discover the team's RanobeLib titles;
2. fetch title metadata and chapter lists;
3. keep a local snapshot;
4. detect only chapters added after the previous successful snapshot;
5. later replace the JSON snapshot with D1 and route detected releases into Mini App/Telegram notifications.

Default team: `11969--dom-nekromanta`.

## Read strategy

The spike intentionally separates two read paths:

- team discovery: fetch the public team page and extract canonical `/ru/book/{id}--{slug}` links;
- title/chapter state: use the currently observed `api2.mangalib.me/api/manga/{book}` and `/chapters` JSON endpoints.

The team-page parser is deliberately small and isolated. If RanobeLib exposes or changes a dedicated team endpoint later, only the discovery adapter needs to change.

## Safety properties

- The first run is bootstrap-only. It records existing chapters and emits no historical release storm.
- Chapters are compared by RanobeLib chapter ID, not just displayed chapter number.
- Removed/replaced chapters are reported as state changes but are not treated as new releases.
- One book failing does not discard successful snapshots for the rest of the team.
- API/site base URLs and `fetch` are injectable, so this can be tested without live RanobeLib calls.

## Run

```bash
npm install
npm test
npm run sync:ranobelib:spike -- --team 11969--dom-nekromanta --limit 3
```

The first successful live run creates `.ranobelib-sync-state.json`. Run the same command again after new chapters are published; added chapters will be shown as detected releases.

## Production follow-up

After importing the Dollar TL platform snapshot:

- move snapshot persistence to D1 (`projects`, `project_sources`, `releases`, `sync_state`);
- run sync from Cloudflare Cron;
- coalesce chapter additions into a short notification debounce window;
- enqueue Following notifications instead of sending inside the sync transaction;
- expose sync health and manual `Sync now` in Admin;
- keep RanobeLib read failures non-destructive: never erase last-known-good catalog state.
