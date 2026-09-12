# NekromantLib title parity slice

## Source of truth

Reference: saved RanobeLib title captures from `03 — Тайтлы и главы.zip`, especially the title states corresponding to `05.html` (chapters active) and `08.html` (about active).

The implementation must reproduce the captured information hierarchy and spacing model without copying RanobeLib code, private/user data, ratings, views, list counts, or unsupported metadata.

## Captured hierarchy

Desktop title detail uses the following visual order:

1. cover column;
2. reading-progress / plan controls below the cover;
3. compact title facts below those controls;
4. title name and optional alternate-name line at the top of the content column;
5. a compact rating slot aligned with the title header;
6. a single paper/content region containing tabs and the active panel;
7. tabs ordered exactly: `О тайтле`, `Главы`, `Комментарии`, `Обсуждения`, `Отзывы`;
8. chapters panel has compact controls followed by a flat 40px-ish chapter list with chapter label/name and date.

The captured desktop grid is equivalent to a `260px / content / auto` title shell with about 30px column gap. On narrow screens the capture collapses into a centered vertical flow: cover, rating, title, controls, content.

## Data rules

Only render synchronized NekromantLib data:

- title name;
- cover;
- chapter count;
- translation status;
- latest chapter;
- update timestamp;
- source hostname;
- reader availability;
- summary;
- chapter list;
- local reader progress;
- translator identity `Дом Некроманта`.

Do not invent origin country, release year, author, publisher, views, title rating, user-list counts, genres/tags, similar titles, or alternate names when the backend does not provide them.

Unsupported title-level tabs (`Комментарии`, `Обсуждения`, `Отзывы`) remain visible but disabled/muted so the shell matches the capture without implying functionality.

`Добавить в планы` remains visibly disabled until a native title-list model exists. Do not map it to collections because that changes the captured semantics.

No fake `Скачать` action is shown.

## Interaction

- Default active tab: `Главы`, matching the chapters capture.
- `О тайтле` and `Главы` switch client-side without navigation.
- Search and new/old chapter sorting keep existing behavior.
- Reader links and local progress keep existing behavior.
- Signed-in/account/admin behavior remains unchanged.

## Accessibility / responsive requirements

- Tab buttons expose selected/disabled state.
- Keyboard focus remains visible.
- Disabled unsupported actions cannot fire.
- 360–430px layouts must not overflow horizontally.
- Reduced-motion preference remains respected.
