# NekromantLib Shell + Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing Dom Nekromanta marketing-style home page with a NekromantLib application shell and RanobeLib-like library home while preserving all existing backend and Telegram contracts.

**Architecture:** Keep the existing static HTML/CSS/vanilla-JS frontend and existing Worker APIs. Phase 1 changes only public home/shell assets plus static behavior tests; `/api/bootstrap`, `/api/ranobelib`, title/reader routes, Telegram auth, D1/R2, scanners and notification delivery remain unchanged.

**Tech Stack:** Cloudflare Assets/Workers, vanilla HTML/CSS/JavaScript, Lucide 1.27, Node 22 `node:test` static UI tests.

**Spec:** `docs/superpowers/specs/2026-09-12-nekromantlib-shell-home-design.md`

## Global Constraints

- Product name is **НекромантЛиб**; translation-team identity remains **Дом Некроманта**.
- Use the saved `01 — Главная.zip` RanobeLib capture as the visual/layout source of truth.
- Implement with our own HTML/CSS/JavaScript and assets; do not copy RanobeLib bundled application code or branded assets.
- No D1 schema migration in Phase 1.
- Preserve `/api/bootstrap`, `/api/ranobelib`, `/auth/telegram/callback`, `/auth/logout`, `/title/?ref=...`, `/reader/?ref=...&chapter=...`, `/admin/`, `/propose/`.
- Do not modify scanner, notification-delivery, Telegram webhook or multi-team lifecycle logic.
- Every production change follows RED -> GREEN -> regression verification.

---

### Task 1: Lock the NekromantLib shell contract

**Files:**
- Create: `tests/nekromantlib-shell-home.test.mjs`
- Modify: `public/index.html`

**Interfaces:**
- Consumes: current static home markup and existing asset URLs.
- Produces: stable DOM IDs `mobileMenuButton`, `primaryNav`, `titleSearch`, `searchResults`, `adminLink`, `accountName`, `loginPanel`, `telegramLogin`, `logoutButton`, `releaseFeed`, `titleGrid`, `proposalGrid` used by `public/site.js` and later tasks.

- [ ] **Step 1: Write the failing structural test**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('NekromantLib home exposes the library shell and removes the legacy marketing hero', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<title>НекромантЛиб/);
  assert.match(html, />НекромантЛиб</);
  assert.match(html, />Каталог</);
  assert.match(html, />Поиск</);
  assert.match(html, /id="releaseFeed"/);
  assert.match(html, /id="titleGrid"/);
  assert.doesNotMatch(html, /id="hero"|ГЛАВНЫЙ ПЕРЕВОД|Истории, которые мы переводим сами/);
});
```

- [ ] **Step 2: Verify RED**

Run in CI/working tree: `node --test tests/nekromantlib-shell-home.test.mjs`
Expected: FAIL on missing `НекромантЛиб`/`releaseFeed` and legacy hero still present.

- [ ] **Step 3: Replace the home structure with a library-style shell**

Implement `public/index.html` with compact application header, catalog/search navigation, account controls, a two-column home layout, latest chapter feed, title discovery blocks, proposal/community block and compact footer. Keep the existing JS IDs listed above.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/nekromantlib-shell-home.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: add NekromantLib application shell`

### Task 2: Rebuild shared desktop visual primitives

**Files:**
- Modify: `tests/nekromantlib-shell-home.test.mjs`
- Modify: `public/site.css`

**Interfaces:**
- Consumes: Task 1 DOM/classes.
- Produces: reusable `.nl-shell`, `.nl-header`, `.nl-home-grid`, `.release-feed`, `.home-rail`, `.book-grid`, `.book-card`, `.surface`, `.section-head`, loading and empty-state styles.

- [ ] **Step 1: Add failing CSS contract assertions**

Assert the stylesheet includes bounded app container tokens, 2-column desktop home layout, cover aspect ratio, focus-visible styling and responsive breakpoint rules.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/nekromantlib-shell-home.test.mjs`
Expected: FAIL on new CSS contracts.

- [ ] **Step 3: Implement desktop shell styles**

Rework global tokens away from the current serif/gold marketing composition toward a compact neutral library UI: light surface background, white cards, subtle borders/shadows, compact sans typography, dense navigation and content modules matching the saved RanobeLib hierarchy.

- [ ] **Step 4: Verify GREEN**

Run the focused test; then `node --check public/site.js`.

- [ ] **Step 5: Commit**

Commit message: `feat: style NekromantLib desktop shell`

### Task 3: Adapt home rendering to recent-chapter feed + discovery cards

**Files:**
- Modify: `tests/nekromantlib-shell-home.test.mjs`
- Modify: `public/site.js`

**Interfaces:**
- Consumes: `/api/ranobelib` `{ titles, releases }`, `/api/bootstrap` session/proposals.
- Produces: `renderHome()`, `releaseRow(item)`, `bookCard(item)`, existing search/session behavior.

- [ ] **Step 1: Add failing JS source-contract tests**

Assert `site.js` still uses `/api/bootstrap` and `/api/ranobelib`, renders `releaseFeed`, renders `titleGrid`, preserves Telegram callback/logout, and no longer references legacy `renderHero`, `heroBackdrop`, `heroTitle` IDs.

- [ ] **Step 2: Verify RED**

Run focused test; expected failure on `renderHero` legacy code and missing release-feed renderer.

- [ ] **Step 3: Implement minimal data mapping**

Replace hero rendering with a dense chapter feed. Render up to the available releases with title, chapter label, relative time and cover; render discovery title cards from real `titles[]`; retain proposal rendering from bootstrap without fabricating popularity/rating data.

- [ ] **Step 4: Verify GREEN**

Run focused test and `node --check public/site.js`.

- [ ] **Step 5: Commit**

Commit message: `feat: render NekromantLib library home`

### Task 4: Mobile shell and interaction parity

**Files:**
- Modify: `tests/nekromantlib-shell-home.test.mjs`
- Modify: `public/site.css`
- Modify: `public/site.js`

**Interfaces:**
- Consumes: existing `mobileMenuButton`, `primaryNav`, search/account DOM.
- Produces: no-horizontal-overflow mobile layout and explicit menu/search states.

- [ ] **Step 1: Add failing responsive/accessibility assertions**

Test for `@media (max-width: 720px)` (or stricter equivalent), `overflow-x`, mobile single-column home layout, `:focus-visible`, and `prefers-reduced-motion` handling.

- [ ] **Step 2: Verify RED**

Run focused test; expected failure until mobile rules exist.

- [ ] **Step 3: Implement mobile rules and menu behavior**

At 360–430 px: compact sticky header, horizontally safe controls, collapsible nav, single-column feed/rail, book-card grid with reserved cover ratio, search results usable at touch sizes. At 768 px: tablet-aware two-column/book density.

- [ ] **Step 4: Verify GREEN**

Run focused test and syntax check.

- [ ] **Step 5: Commit**

Commit message: `feat: add NekromantLib responsive shell`

### Task 5: CI compatibility, cache revision and handoff

**Files:**
- Modify: `.github/workflows/ci.yml` only if hard-coded old asset-version assertions require the new version strings.
- Modify: `public/index.html` asset query revisions.
- Modify: `public/build.txt`
- Create: `docs/NEKROMANTLIB_HANDOFF.md`

**Interfaces:**
- Produces: CI-verifiable Phase 1 and persistent continuation context for the next 26-minute window.

- [ ] **Step 1: Add the build marker and align CI static assertions**

Add `domnkr-build-20260912-nekromantlib-home1`; update only home-asset cache-version grep checks if changed.

- [ ] **Step 2: Run full verification**

Required commands in CI: `npm run typecheck`, `npm test`, `node --check public/site.js`, `npx wrangler deploy --dry-run`.

- [ ] **Step 3: Review diff boundaries**

Compare branch to `main`; confirm no changes under migrations or scanner/Telegram notification lifecycle sources.

- [ ] **Step 4: Write handoff**

Record branch, current HEAD, completed Phase 1 acceptance criteria, remaining visual-parity notes, and exact next phase: catalog + filtering.

- [ ] **Step 5: Commit**

Commit message: `chore: finalize NekromantLib home phase`
