# NekromantLib migration handoff

## Active work

- Branch: `feature/nekromantlib-parity-v1`
- PR: `#101 feat: NekromantLib parity v1`
- Base: `main`
- Program goal: independently implement the current RanobeLib UX/functionality under the **НекромантЛиб** brand while preserving the Dom Nekromanta bot/backend infrastructure.

## Phase 1 — shared shell + home

Design: `docs/superpowers/specs/2026-09-12-nekromantlib-shell-home-design.md`
Plan: `docs/superpowers/plans/2026-09-12-nekromantlib-shell-home.md`
Build marker: `domnkr-build-20260912-nekromantlib-home1`

Implemented:
- NekromantLib product branding on public home;
- compact application header/navigation/search/account shell;
- RanobeLib-like library composition instead of the old marketing hero;
- real recent-release feed from `/api/ranobelib`;
- real title discovery cards from existing synchronized catalog data;
- real side-rail activity derived from releases/titles, without invented ratings or popularity;
- existing Telegram login/logout/admin behavior retained;
- responsive 360–1440px layout rules, reserved cover aspect ratio, visible focus, reduced-motion behavior;
- isolated `public/nekromantlib.css` so legacy title/reader/propose pages are not accidentally restyled before their own migration phase;
- TDD contract: `tests/nekromantlib-shell-home.test.mjs`.

Verification evidence before this handoff:
- RED CI run `34699826955`: typecheck/static checks passed, tests failed on the new shell contract as expected.
- GREEN CI run `34700005532` / CI #1078 for HEAD `a9fa49f081d104c77527fdfce602046aa7f685d3`: conclusion `success`.
- Test Discovery Guard on the same HEAD: `success`.

## Constraints that remain authoritative

- Do not rewrite scanner, multi-team lifecycle, Telegram notification delivery, D1 ownership, or R2 publication flows for visual parity work.
- Preserve `/api/bootstrap`, `/api/ranobelib`, Telegram auth/logout, `/title/`, `/reader/`, `/admin/`, `/propose/` until a phase deliberately supersedes a route.
- Reconstruct layout/interaction from the user's saved RanobeLib captures with our own code/assets; do not import RanobeLib bundled application source or branded assets.
- Do not fabricate metrics/data that the backend does not actually have.
- Work in short TDD slices and keep the branch usable after every slice.

## Exact next phase

**Phase 2: catalog + collections shell.**

Primary reference: user-provided `02 — Каталог и коллекции.zip`.

Start by inventorying its catalog/filter/list/card/responsive states, then write a separate Phase 2 spec + implementation plan. Reuse `public/nekromantlib.css` and the shared header established in Phase 1. The first implementation slice should create a real `/catalog/` page over existing synchronized titles with URL-backed search/sort/filter state; metadata filters that cannot be supported honestly by current data must be disabled/omitted until their backend fields are added.
