# NekromantLib Shell + Home Design

## Purpose

Phase 1 of the NekromantLib migration replaces the current public-site visual shell and home page with an independent implementation that matches the current RanobeLib user experience as closely as practical while using the NekromantLib brand and the existing Dom Nekromanta backend.

This phase deliberately does **not** redesign backend scanning, Telegram delivery, RanobeLib discovery, D1 data ownership, R2 storage, or publication workflows. Those systems remain authoritative and unchanged unless a small read-only API adaptation is required to render the new UI.

## Program context

The broader NekromantLib migration is split into independent vertical phases so every implementation window can end in a working, reviewable state:

1. shared visual shell + home page;
2. catalog + search/filtering;
3. title page + chapters;
4. reader;
5. account + server-side library/progress;
6. collections, ratings, comments, moderation;
7. content-management/admin parity;
8. Telegram/site integration parity pass;
9. desktop/mobile visual parity and performance pass.

Each phase receives its own spec and implementation plan. This document covers phase 1 only.

## Visual source of truth

Primary reference material is the user-provided Google Drive capture set, especially `01 — Главная.zip`. The remaining archives (`02 — Каталог и коллекции.zip`, `03 — Тайтлы и главы.zip`, `04 — Управление контентом.zip`, `05 — Пользовательский аккаунт.zip`) define later phases and must not expand phase 1 scope.

The target is recognizable RanobeLib-like layout and interaction parity, not a loose inspiration pass. Measurements, spacing, component proportions, responsive behavior, navigation placement, card density, typography hierarchy, hover/active states, loading states, and mobile structure should be reconstructed from the saved reference rather than improvised.

Implementation must use our own HTML/CSS/JavaScript and our own branding/assets. Do not copy proprietary RanobeLib application source code, bundled scripts, logos, or hosted decorative assets.

## Brand rules

- Product name: **НекромантЛиб**.
- Team identity remains **Дом Некроманта** where the translation team itself is referenced.
- Existing `public/brand/team-logo.webp` may continue to represent the translation team, but the product shell must present the site as NekromantLib rather than “Дом Некроманта · Переводы и читалка”.
- No RanobeLib wordmark, logo, or identifying brand asset should appear in production UI.
- Copy should be concise and product-like. Avoid the current marketing-style hero copy when the reference uses library/catalog language.

## Existing architecture to preserve

The current project already serves the site from Cloudflare Assets with Worker API routes. Existing infrastructure includes D1, R2, Queue delivery, Telegram login, RanobeLib synchronization, title pages, and a reader.

Phase 1 must preserve these contracts:

- `/api/bootstrap` remains the session/proposal bootstrap endpoint used by the home page.
- `/api/ranobelib` remains the home/catalog read endpoint for existing title/release data.
- `/auth/telegram/callback` remains the Telegram login callback.
- `/auth/logout` remains logout.
- `/title/?ref=...` and `/reader/?ref=...&chapter=...` remain valid destinations.
- `/admin/` remains available to authorized admins.
- `/propose/` remains available until a later phase explicitly replaces or relocates it.

No schema migration is required for phase 1.

## Shared shell

### Header

Replace the current custom marketing header with a reusable NekromantLib application header modeled on the captured RanobeLib shell.

Required behavior:

- desktop navigation with NekromantLib brand, catalog-oriented navigation, search entry, and account entry;
- mobile menu with compact header behavior matching the reference hierarchy;
- account state must continue to reflect `/api/bootstrap` session data;
- admin entry remains hidden for non-admin users;
- search remains keyboard-usable and should preserve current direct title navigation;
- active/hover/focus states must be visible and consistent;
- header layout must not shift after asynchronous bootstrap data arrives.

### Global primitives

Create a small reusable visual layer rather than page-specific one-off rules. Phase 1 needs at minimum:

- page/container widths;
- color tokens;
- typography tokens;
- surface/card styles;
- small badges/chips;
- icon-button style;
- dropdown/popover surface;
- loading skeleton;
- empty/error state;
- book-card primitive;
- section heading primitive.

Existing Lucide loading may remain in phase 1. Introducing a frontend framework or bundler is out of scope.

## Home page

The current hero-led landing page should be replaced by a library-style home page organized like the saved RanobeLib reference.

Required sections:

1. application header;
2. primary discovery/update area using current title/release data;
3. latest updates/recent chapters area;
4. title discovery/recommendation area using available catalog data;
5. concise footer/site utilities.

The home page must not depend on fabricated data. When an exact RanobeLib section has no corresponding backend data yet, use an honest reduced state or omit the block for phase 1 rather than inventing ratings, genres, users, or popularity metrics.

### Data mapping

Use existing `/api/ranobelib` fields already consumed by `public/site.js`:

- `titles[]` for title cards and discovery sections;
- `releases[]` for recent chapter/update cards;
- title fields such as `book_ref`, `title`, `cover_url`, `summary`, `chapter_count`, `latest_chapter_id`, `latest_volume`, `latest_number`, `last_release_at`, and `last_synced_at` when present.

Use `/api/bootstrap` only for session/admin/proposal data. Do not make the home page write data during initial render.

## Responsive requirements

The home page must be designed mobile-first but preserve desktop parity.

Required checks:

- 360 px viewport: no horizontal scrolling, readable header, cards retain usable cover proportions;
- 390–430 px viewport: primary Android/mobile target;
- 768 px viewport: tablet layout does not look like stretched mobile;
- 1280 px viewport: desktop density approximates the reference;
- 1440 px viewport: container remains bounded and composition does not become overly sparse.

The UI must remain usable with slow image loading. Cards reserve cover aspect-ratio space before images complete.

## Accessibility and behavior

- interactive controls must be keyboard reachable;
- visible focus state must not be removed;
- icon-only buttons require accessible labels;
- search results must remain readable and navigable without pointer precision;
- empty/error/loading states must not cause large layout jumps;
- images use descriptive or intentionally empty alt text according to context;
- reduced-motion users should not receive decorative motion that is required for comprehension.

## File boundaries

Phase 1 should prefer modifying the existing lightweight frontend rather than introducing a new app stack.

Expected files:

- `public/index.html` — page structure only;
- `public/site.css` — shared shell/home tokens and component styles;
- `public/site.js` — bootstrap, data mapping, search, session rendering, and home rendering;
- `public/ui-icons.js` — change only if an icon mapping required by the new shell is missing;
- `tests/...` — add or extend frontend/static-route tests to lock required structure and behavior.

If `public/site.css` or `public/site.js` becomes difficult to reason about during implementation, split by responsibility only when the split is directly needed by this phase. Do not perform unrelated frontend refactors.

## Testing strategy

Phase 1 is complete only when all of the following pass:

1. existing project typecheck and test suite remains green;
2. structural tests verify the NekromantLib brand, expected home regions, and absence of the removed legacy hero-specific copy/structure;
3. JS behavior tests verify session/admin state, title/release rendering, search navigation, and graceful API failure behavior;
4. existing `/title/`, `/reader/`, `/propose/`, `/admin/`, Telegram login, and logout links remain valid from the new shell;
5. responsive CSS includes explicit rules that prevent horizontal overflow and preserves cover aspect ratios;
6. a final diff review confirms there are no changes to scanner, notification-delivery, D1 migration, or Telegram webhook logic.

## Acceptance criteria

Phase 1 can be merged when:

- the site identifies itself as NekromantLib;
- the global shell and home-page composition are visibly based on the saved RanobeLib reference rather than the old Dom Nekromanta marketing design;
- real synchronized titles and releases render successfully using existing APIs;
- Telegram session/admin behavior continues to work;
- title and reader navigation continues to work;
- desktop and mobile layouts are both intentionally designed;
- tests pass;
- no backend migration or notification regression is introduced.

## 26-minute execution discipline

Implementation is intentionally divided into small reviewable slices. A typical work window should complete only one of these outcomes:

1. structural tests + semantic home/header markup;
2. shared design tokens + desktop shell;
3. mobile shell + search/account states;
4. home data sections + loading/error states;
5. parity polish + full regression verification.

Every window ends with tests, diff review, a commit, and an updated handoff note. A slice that cannot be left working should be reduced before implementation rather than committed half-functional.
