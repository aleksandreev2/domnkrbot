# NekromantLib migration handoff

## Active work

- Branch: `feature/nekromantlib-parity-v1`
- PR: `#101 feat: NekromantLib parity v1`
- Base: `main`
- Program goal: independently implement the useful RanobeLib UX/functionality under the **НекромантЛиб** brand while preserving the Dom Nekromanta bot/backend infrastructure.

## Phase 1 — shared shell + home

Implemented and verified:
- NekromantLib product branding and compact application shell;
- real recent-release feed from `/api/ranobelib`;
- real title discovery cards;
- Telegram login/logout/admin behavior preserved;
- responsive 360–1440px layout, focus-visible and reduced-motion support;
- isolated shared parity stylesheet `public/nekromantlib.css`.

Primary artifacts:
- `docs/superpowers/specs/2026-09-12-nekromantlib-shell-home-design.md`
- `docs/superpowers/plans/2026-09-12-nekromantlib-shell-home.md`
- `tests/nekromantlib-shell-home.test.mjs`

## Phase 2 — catalog + collections

Implemented:
- real `/catalog/` shell over synchronized titles;
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
- `docs/superpowers/plans/2026-09-12-nekromantlib-catalog.md`
- `docs/superpowers/plans/2026-09-12-nekromantlib-catalog-status.md`
- `docs/superpowers/plans/2026-09-12-nekromantlib-collections-shell.md`
- `docs/superpowers/plans/2026-09-12-nekromantlib-collections-crud.md`
- `tests/nekromantlib-catalog.test.mjs`
- `tests/nekromantlib-catalog-status.test.mjs`
- `tests/nekromantlib-collections-shell.test.mjs`
- `tests/nekromantlib-collections-crud.test.mjs`
- `tests/nekromantlib-collection-items-api.test.mjs`
- `tests/nekromantlib-collection-detail-ui.test.mjs`
- `tests/nekromantlib-collection-owner-editor.test.mjs`
- `tests/nekromantlib-collection-comments.test.mjs`

Latest verified functional checkpoint before this handoff update:
- HEAD `eedc2c68406859661671ba464015fa6619d3dabc`;
- CI run `34703118209` / CI #1139: `success`;
- Test Discovery Guard run `34703118210` / #117: `success`.
- Build marker added after verification: `domnkr-build-20260912-nekromantlib-collection-comments1`.

## Constraints that remain authoritative

- Do not rewrite scanner, multi-team lifecycle, Telegram notification delivery, D1 ownership, or R2 publication flows for visual parity work.
- Preserve existing `/api/bootstrap`, `/api/ranobelib`, Telegram auth/logout, `/admin/` and `/propose/` contracts unless a dedicated phase deliberately extends them.
- Reconstruct layout/interaction from the user's saved RanobeLib captures with our own code/assets; do not import RanobeLib bundled application source or branded assets.
- Do not fabricate ratings, counters, metadata or social data that the backend does not actually have.
- Every production slice follows RED -> GREEN -> full regression verification.

## Exact next phase

**Phase 3: title detail + chapters.**

Primary reference: user-provided `03 — Тайтлы и главы.zip`.

The existing `/title/?ref=...` route and title API remain the starting point. Before implementation, inventory the saved RanobeLib title/detail states against the current `public/title.*` and `/api/title` response, then design the smallest additive parity slice. Expected order: title hero/metadata and actions -> chapter/volume list -> reading-list/notification state -> only then ratings/social elements if real backend fields exist. The reader itself should be handled as its own follow-up slice after title detail is stable.
