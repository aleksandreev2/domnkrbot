# NekromantLib migration handoff

## Active work

- Branch: `feature/nekromantlib-parity-v1`
- PR: `#101 feat: NekromantLib parity v1`
- Base: `main`
- Program goal: independently reproduce the user-provided RanobeLib reference **one-for-one in structure, geometry, interaction and responsive behavior** under the **НекромантЛиб** brand, while using our own code/assets and preserving the Dom Nekromanta backend infrastructure.
- Saved user captures are the visual/interaction source of truth. Do not reinterpret the target as merely “inspired by” or “in the style of” RanobeLib.

## Phase 1 — shared shell + home

Implemented and verified:
- NekromantLib product branding and compact application shell;
- real recent-release feed from `/api/ranobelib`;
- real title discovery cards;
- Telegram login/logout/admin behavior preserved;
- responsive layout, focus-visible and reduced-motion support;
- isolated shared stylesheet `public/nekromantlib.css`.

Primary artifacts:
- `docs/superpowers/specs/2026-09-12-nekromantlib-shell-home-design.md`
- `docs/superpowers/plans/2026-09-12-nekromantlib-shell-home.md`
- `tests/nekromantlib-shell-home.test.mjs`

## Phase 2 — catalog + collections

Implemented:
- real `/catalog/` over synchronized titles;
- URL-backed search/sort/chapter-count filters;
- additive primary-team translation-status projection and honest active/completed/unknown filter;
- responsive desktop/mobile catalog UI;
- real `/collections/` index with Telegram session state;
- owner-scoped D1 collection CRUD;
- collection items/groups persistence and API;
- collection detail page with grouped title cards;
- owner edit/delete controls for collections and items;
- public collection comments with authenticated posting;
- comment deletion by comment author or collection owner;
- comments UI bound to Telegram session state and backend `canDelete` permissions.

Primary artifacts:
- `docs/superpowers/specs/2026-09-12-nekromantlib-catalog-design.md`
- `docs/superpowers/specs/2026-09-12-nekromantlib-catalog-status-design.md`
- `docs/superpowers/specs/2026-09-12-nekromantlib-collections-shell-design.md`
- matching plans and collection tests under `docs/superpowers/plans/` and `tests/`.

## Phase 3A — title detail + chapters

Implemented and verified from `03 — Тайтлы и главы.zip`:
- `/title/?ref=...` moved onto the NekromantLib shell;
- real translation status, chapter count, latest chapter, update time, source and reader availability;
- completed primary-team translations remain visible through `/api/title`;
- flat chapter list matching the captured RanobeLib title tab rather than custom volume cards;
- captured-style compact chapter sort menu;
- real search, read-state, source/reader links and responsive mobile layout;
- no fabricated download action on title detail.

Primary artifacts:
- `tests/nekromantlib-title-detail.test.mjs`
- `tests/nekromantlib-title-metadata.test.mjs`
- `public/title/index.html`
- `public/title.js`
- `public/title.css`
- `src/reader-runtime.ts`

Verified checkpoints:
- CI #1154 / Test Discovery Guard #132 for flat chapter-list parity;
- CI #1150 / Test Discovery Guard #128 for corrected title metadata regression scope.

## Phase 3B — reader parity

Implemented and verified from the three saved reader states in `03 — Тайтлы и главы.zip` (normal, chapter-list popup, settings popup):
- full-screen reader surface uses the captured default background `#434751`; the former beige paper/card shell is removed;
- sticky reader header is 48px and follows the captured back/title/previous-contents-next/action grouping;
- default reader typography variables match the saved page: 24px font size, 1.7 line height, 47% desktop container width, 5px paragraph block offset, `.875em` indent, left alignment;
- chapter-list popup is a left-side overlay panel up to 440px with `rgba(0,0,0,.6)` backdrop;
- settings popup is a right-side overlay panel up to 440px;
- real title chapters are loaded lazily through `/api/title`; unavailable chapter text is not fabricated;
- chapter rows match the captured 40px density and 74px right-side date column;
- six captured theme presets are reproduced with their exact saved foreground/background color pairs;
- settings include background/text colors, indent, alignment, font selector, image/heading toggles, font size, line height, paragraph spacing and container width;
- existing reader content blocks, previous/next navigation, local read progress and preference persistence are preserved;
- bookmark is functional locally; currently unsupported notes/report/download controls remain visually present but disabled instead of pretending to work;
- completed primary-team translations remain readable through `/api/reader/chapter`, not just visible on title detail.

Primary artifacts:
- `tests/nekromantlib-reader-parity.test.mjs`
- `tests/nekromantlib-title-metadata.test.mjs`
- `public/reader/index.html`
- `public/reader.js`
- `public/reader.css`
- `src/reader-runtime.ts`

Latest verified functional checkpoint:
- HEAD `71105f45a7c1ff2cb84e509667bb552998577d6c`;
- CI #1164: `success`;
- Test Discovery Guard #142: `success`.

Related completed-reader availability checkpoint:
- HEAD `df47f5d95a0366e9b340bce8ca924ecc717c8392`;
- CI #1160: `success`;
- Test Discovery Guard #138: `success`.

Build marker added after verification:
- `domnkr-build-20260912-nekromantlib-reader1`.

## Constraints that remain authoritative

- Saved RanobeLib captures supplied by the user are the parity source of truth. Match measurable layout, spacing, colors, controls, ordering and responsive behavior as literally as practical; do not replace that requirement with a generic redesign.
- Reimplement independently with our code/assets/backend; do not import RanobeLib bundled application source or branded assets.
- Do not rewrite scanner, multi-team lifecycle, Telegram notification delivery, D1 ownership, or R2 publication flows solely for visual parity.
- Preserve existing `/api/bootstrap`, `/api/ranobelib`, Telegram auth/logout, `/admin/` and `/propose/` contracts unless a dedicated phase deliberately extends them.
- Do not fabricate ratings, counters, metadata, teams or social data that the backend does not actually have. Unsupported actions may keep their reference position only when clearly disabled.
- Every functional production slice follows RED -> GREEN -> full regression verification.

## Exact next phase

Continue inventorying `03 — Тайтлы и главы.zip` below the reader text and across remaining title-detail states. The next slice should reproduce the captured lower-reader/title social/comment surface only where data can be backed by a real NekromantLib model; where RanobeLib-specific social data has no backend equivalent, first add an explicit native data contract rather than hard-coded placeholders.
