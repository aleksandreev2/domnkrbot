# NekromantLib Collections Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Add a faithful NekromantLib `/collections/` read shell based on the saved RanobeLib collections index, without fabricating user content.

**Architecture:** Static route + vanilla JS using `/api/bootstrap` only for session state. The first slice intentionally has no collection persistence; it establishes the exact page structure and create/login states before the separate D1 CRUD slice.

**Tech Stack:** Cloudflare Assets, vanilla HTML/CSS/JavaScript, Lucide, Node source-contract tests.

**Spec:** `docs/superpowers/specs/2026-09-12-nekromantlib-collections-shell-design.md`

## Global Constraints

- Reuse `nekromantlib.css` shared shell.
- Never copy RanobeLib user collection content into NekromantLib data.
- No D1 migration or write endpoint in this shell slice.
- `Создать` must distinguish signed-in vs signed-out state honestly.
- Mobile <=720px must not horizontally overflow.

---

### Task 1: RED structural contract

**Files:**
- Create: `tests/nekromantlib-collections-shell.test.mjs`

- [ ] Require `/collections/index.html`, product header, `Коллекции`, `Создать`, `Новые`, `collectionsList`, session elements and dedicated CSS/JS.
- [ ] Require no hard-coded captured RanobeLib collection names.
- [ ] Verify CI fails before route implementation.

### Task 2: Collections index shell

**Files:**
- Create: `public/collections/index.html`
- Create: `public/collections.css`
- Create: `public/collections.js`

- [ ] Recreate compact title/action/sort/list hierarchy from the saved reference.
- [ ] Fetch `/api/bootstrap` and render Telegram session/admin state.
- [ ] Signed-out Create opens/focuses login guidance; signed-in Create reveals the honest `native collections are being enabled` panel rather than pretending persistence exists.
- [ ] Render a RanobeLib-shaped empty list surface with no fake counters/content.
- [ ] Implement desktop/mobile styling and keyboard close behavior.

### Task 3: Navigation + GREEN checkpoint

**Files:**
- Modify: `public/index.html`
- Modify: `public/catalog/index.html`
- Modify: `public/build.txt`
- Modify: `docs/NEKROMANTLIB_HANDOFF.md`

- [ ] Add unobtrusive collections navigation from NekromantLib footer/shell utilities.
- [ ] Run full CI + Test Discovery Guard.
- [ ] Add `domnkr-build-20260912-nekromantlib-collections-shell1`.
- [ ] Record next slice: native collections D1 CRUD + item grouping, then collection detail/comments.
