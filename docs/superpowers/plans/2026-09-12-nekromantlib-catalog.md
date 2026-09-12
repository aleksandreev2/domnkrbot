# NekromantLib Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a RanobeLib-like `/catalog/` page with real synchronized NekromantLib data, honest filters, URL-backed state and mobile/desktop layouts.

**Architecture:** Keep catalog v1 entirely on the existing static frontend and `/api/ranobelib`. Filter/sort the <=80 synchronized title cards client-side; do not add schema/API metadata until a separate enrichment slice.

**Tech Stack:** Cloudflare Assets/Workers, vanilla HTML/CSS/JavaScript, Lucide, Node `node:test` source-contract tests.

**Spec:** `docs/superpowers/specs/2026-09-12-nekromantlib-catalog-design.md`

## Global Constraints

- Reuse Phase 1 NekromantLib shared-shell classes and product branding.
- Use real existing title data only.
- Supported URL params: `q`, `sort`, `dir`, `chaptersMin`, `chaptersMax`.
- Supported `sort`: `updated`, `chapters`, `title`; supported `dir`: `desc`, `asc`.
- No D1 migration or backend TypeScript change in catalog v1.
- Existing title/reader/auth/admin routes remain valid.
- RED -> GREEN -> full CI before declaring the slice complete.

---

### Task 1: Catalog route and structural contract

**Files:**
- Create: `tests/nekromantlib-catalog.test.mjs`
- Create: `public/catalog/index.html`
- Modify: `public/index.html`

**Interfaces:**
- Produces DOM IDs `catalogSearch`, `catalogGrid`, `catalogCount`, `catalogFilters`, `chaptersMin`, `chaptersMax`, `catalogSort`, `catalogDirection`, `applyFilters`, `resetFilters`, `filterToggle`, `filterClose`.

- [ ] Write failing static tests requiring the route, shared header, filter headings and new home `/catalog/` links.
- [ ] Verify RED in CI.
- [ ] Add catalog HTML and update home links.
- [ ] Verify structural GREEN.
- [ ] Commit `feat: add NekromantLib catalog shell`.

### Task 2: URL-backed catalog behavior

**Files:**
- Modify: `tests/nekromantlib-catalog.test.mjs`
- Create: `public/catalog.js`

**Interfaces:**
- `parseCatalogState(search): {q,sort,dir,chaptersMin,chaptersMax}`
- `applyCatalog(titles,state): title[]`
- page fetches `/api/ranobelib` and `/api/bootstrap`.

- [ ] Add failing source-contract tests for supported params, fetch endpoints, popstate and history URL update.
- [ ] Verify RED.
- [ ] Implement parsing, filtering, sorting, rendering, Apply/Reset, popstate and session/auth behavior.
- [ ] Verify GREEN and JS syntax.
- [ ] Commit `feat: make NekromantLib catalog interactive`.

### Task 3: RanobeLib-like catalog styling and mobile filter sheet

**Files:**
- Modify: `tests/nekromantlib-catalog.test.mjs`
- Create: `public/catalog.css`

**Interfaces:**
- Produces `.catalog-layout`, `.catalog-filter-panel`, `.catalog-grid`, `.catalog-toolbar`, `.catalog-filter-backdrop` and responsive <=720px sheet behavior.

- [ ] Add failing CSS assertions for desktop two-column layout, mobile fixed filter sheet, cover ratio, focus state and overflow safety.
- [ ] Verify RED.
- [ ] Implement catalog CSS using Phase 1 tokens/classes.
- [ ] Verify GREEN.
- [ ] Commit `feat: style NekromantLib catalog`.

### Task 4: Verification and continuation handoff

**Files:**
- Modify: `public/build.txt`
- Modify: `docs/NEKROMANTLIB_HANDOFF.md`

- [ ] Add `domnkr-build-20260912-nekromantlib-catalog1`.
- [ ] Run/observe fresh full CI and Test Discovery Guard.
- [ ] Compare branch against `main` and confirm no backend lifecycle/migrations changed by catalog v1.
- [ ] Update handoff with exact next slice: real metadata enrichment, then collections shell.
- [ ] Commit `chore: finalize NekromantLib catalog v1`.
