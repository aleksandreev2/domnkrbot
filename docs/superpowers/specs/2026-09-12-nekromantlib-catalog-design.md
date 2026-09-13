# NekromantLib Catalog + Collections Shell Design

## Purpose

Phase 2 recreates the saved RanobeLib catalog experience under the НекромантЛиб brand while continuing to use the existing synchronized Dom Nekromanta title data. The first deliverable is a real `/catalog/` page; collections are the second deliverable once the catalog shell is stable.

## Reference inventory

Primary source: user-provided `02 — Каталог и коллекции.zip` captured from RanobeLib on 2026-09-08.

The captured catalog contains:
- compact shared application header: Каталог / Поиск / Форум;
- page title `Каталог`;
- a dense responsive cover-card grid;
- title search (`Поиск по названию`);
- sort popover with: По популярности, По рейтингу, По просмотрам, Количеству глав, Дате релиза, Дате обновления, Дате добавления, По названию (A-Z), По названию (А-Я), plus ascending/descending direction;
- filter drawer/sheet with Жанры, Теги;
- numeric ranges: Количество глав, Год релиза, Оценка, Количество оценок;
- age: 6+, 12+, 16+, 18+;
- type/origin: Япония, Корея, Китай, Английский, Авторский, Фанфик;
- title status: Онгоинг, Завершён, Анонс, Приостановлен, Выпуск прекращён;
- translation status: Продолжается, Завершён, Заморожен, Заброшен;
- extra flags and user-list filters;
- reset/apply actions.

The captured collection index shows a dense list/grid of user collections with `Коллекции`, `Создать`, a `Новые` sorting state, title and activity counters. A collection detail contains owner/activity metadata, description, grouped title lists, and comments.

## Current data boundary

`/api/ranobelib` currently exposes real title fields: `book_ref`, `url`, `title`, `summary`, `cover_url`, `chapter_count`, latest chapter fields, `last_synced_at`, `last_release_at`. It does **not** currently expose genres, tags, age rating, origin/type, title status, rating, view count, or user lists.

Therefore Phase 2 is split deliberately:

### Catalog v1 — real-data parity shell

Must implement now:
- `/catalog/` with the shared NekromantLib header;
- RanobeLib-like card density and filter/sort shell;
- working title search;
- working chapter-count range;
- working sort by update date, chapter count, and title;
- ascending/descending direction;
- URL-backed state (`q`, `sort`, `dir`, `chaptersMin`, `chaptersMax`) so links are shareable and reload-stable;
- result count, reset/apply, desktop sidebar and mobile filter sheet;
- no fabricated ratings/countries/statuses.

Unsupported captured filter groups should be visibly present only as disabled `metadata not synced yet` groups if that improves visual parity; they must never pretend to filter.

### Catalog metadata v2 — later backend enrichment

After catalog v1 is stable, extend the RanobeLib integration and storage with real upstream metadata, then activate the remaining filter groups. This is a separate TDD slice because it changes scanner/storage contracts and must not be smuggled into a visual task.

### Collections shell

After catalog v1, add `/collections/` and collection-detail structure. Until NekromantLib has native user-created collections, the index may honestly show an empty onboarding state plus the exact structural shell; it must not copy RanobeLib user collections into our product as if they belonged to our users.

## Catalog information architecture

Desktop:
- page header row: `Каталог`, result count, sort control;
- left filter column ~250–280 px;
- right result grid using the same cover card primitive as home but denser;
- search at top of filter column;
- Apply/Reset controls remain visible near the filter actions.

Mobile <=720 px:
- title + result count;
- toolbar with Search / Filter / Sort;
- filter controls become a modal-like fixed sheet/drawer;
- cards 2 columns around 360–390 px, 3 columns when room allows;
- URL state remains the source of truth.

## Data flow

1. page loads `/api/ranobelib` and `/api/bootstrap` in parallel;
2. normalize `titles[]` into a local catalog model;
3. hydrate controls from `location.search`;
4. apply query + chapter range + sort entirely client-side for current scale (<=80 synchronized titles from home API);
5. render cards and result count;
6. control changes update in-memory draft; Apply writes URL with `history.replaceState` and rerenders; Reset clears supported parameters;
7. back/forward (`popstate`) rehydrates state and rerenders.

No catalog write API is introduced in v1.

## Shared-shell rule

Do not copy/paste a divergent header design. Reuse the NekromantLib class system introduced in Phase 1 (`nl-header`, `nl-shell`, `nl-brand`, search/account primitives). Markup may be repeated temporarily because there is no templating layer, but IDs and behavior must stay compatible.

## Files

Expected v1 files:
- `public/catalog/index.html` — catalog structure;
- `public/catalog.js` — state parsing, filtering, sorting, URL sync, session rendering;
- `public/catalog.css` — catalog-specific layout only; shared tokens remain in `nekromantlib.css`;
- `public/index.html` — change Catalog links to `/catalog/`;
- `tests/nekromantlib-catalog.test.mjs` — structural and behavior source-contract tests.

No D1 migration or backend TypeScript modification in catalog v1.

## Acceptance criteria for catalog v1

- `/catalog/` is a real page, not an anchor into home;
- current synchronized titles render from `/api/ranobelib`;
- query, chapter range, three honest sort dimensions and direction work;
- supported state survives reload through URL params;
- reset removes supported params;
- mobile filter sheet is keyboard-dismissable and does not cause horizontal overflow;
- the visual composition matches the captured catalog hierarchy closely;
- unsupported metadata is not fabricated;
- existing backend lifecycle files are untouched;
- full CI and test-discovery guard pass.
