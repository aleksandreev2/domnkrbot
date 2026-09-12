# NekromantLib Catalog Translation Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Expose primary-team translation status in the read API and activate an honest status filter in `/catalog/`.

**Architecture:** Add an additive `catalogTitles` D1 projection joining `ranobelib_titles` to the primary `ranobelib_team_translations` relation. Keep existing home `titles` untouched; catalog prefers the richer projection and filters client-side.

**Tech Stack:** TypeScript Cloudflare Worker runtime, D1 SQL, vanilla JS/HTML, Node test contracts.

**Spec:** `docs/superpowers/specs/2026-09-12-nekromantlib-catalog-status-design.md`

## Global Constraints

- No migration and no new upstream RanobeLib request.
- Do not alter discovery/scanner/completion/notification semantics.
- Scope `catalogTitles` to the primary team and active presence relationships.
- Status values are exactly `active`, `completed`, `unknown`.
- Existing `titles` and `releases` response behavior stays backward compatible.

---

### Task 1: RED API + UI contract

**Files:**
- Create: `tests/nekromantlib-catalog-status.test.mjs`

- [ ] Require `RanobeLibHomeData.catalogTitles` and a SQL join through primary team relations.
- [ ] Require catalog URL state and UI control for `translationStatus`.
- [ ] Verify CI fails for the new contract.

### Task 2: Additive catalog read projection

**Files:**
- Modify: `src/ranobelib-runtime.ts`

- [ ] Extend title card types with team-scoped translation fields.
- [ ] Add `catalogTitles` query using `ranobelib_teams` + `ranobelib_team_translations` and `presence_state='active'`.
- [ ] Return normalized `catalogTitles` without touching existing `titles` query.
- [ ] Typecheck.

### Task 3: Activate translation status filter

**Files:**
- Modify: `public/catalog/index.html`
- Modify: `public/catalog.js`
- Modify: `public/catalog.css` only if needed for active controls.

- [ ] Replace disabled status mock with real selectable status controls.
- [ ] Parse/write `translationStatus` URL param.
- [ ] Prefer `catalogTitles ?? titles` and filter against `translation_semantic_status`.
- [ ] Reset clears the status.
- [ ] Keep frozen/abandoned visibly unavailable rather than fabricating them.

### Task 4: GREEN + checkpoint

**Files:**
- Modify: `public/build.txt`
- Modify: `docs/NEKROMANTLIB_HANDOFF.md`

- [ ] Verify full CI and Test Discovery Guard.
- [ ] Add build marker `domnkr-build-20260912-nekromantlib-status1`.
- [ ] Record exact next slice: collections shell, while genres/tags await verified upstream schema.
