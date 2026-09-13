# NekromantLib Collections Shell Design

## Goal

Recreate the saved RanobeLib collections index and collection-detail visual structure under НекромантЛиб without importing RanobeLib users or pretending third-party collections belong to our product.

## Reference behavior

The saved `/ru/collections` capture contains:
- shared app header;
- title `Коллекции`;
- `Создать` action;
- sorting state `Новые`;
- a dense collection list/grid where each row/card has a collection name and several activity counters.

The saved collection detail contains:
- breadcrumb/context back to `Коллекции`;
- collection title;
- owner + activity timestamp;
- view/activity counters;
- description;
- named groups/sections of titles;
- a comment area with count, `Новые`, settings/rules affordances and threaded comments.

## Scope of this slice

This slice builds the production-quality **read shell only**:
- `/collections/` route using the shared NekromantLib shell;
- real session state from `/api/bootstrap`;
- sort/search controls matching the reference hierarchy;
- honest empty onboarding because NekromantLib native collections do not exist yet;
- `Создать` opens a clear authenticated/non-authenticated call-to-action but does not persist anything yet;
- structural placeholder for cards is not populated with fabricated RanobeLib collections.

Native collection persistence, create/edit/delete, item ordering/groups, comments and reactions form the next backend slice and require their own D1/API design.

## UX

Desktop:
- bounded 900–1000px content column;
- title/action row;
- sort tabs/selector;
- list surface with compact rows/cards;
- empty state visually occupies the same collection-list region instead of turning into a marketing landing page.

Mobile:
- title and create action remain visible;
- list becomes one column;
- sort/search controls wrap without horizontal scrolling;
- login/create guidance stays concise.

## Safety

No migration, no collection write endpoint, no fake counters/data, no changes to bot/scanner/notifications. Reuse existing Telegram auth and shared NekromantLib CSS.

## Acceptance

- `/collections/` renders as a NekromantLib/RanobeLib-style application page;
- no third-party RanobeLib collection content is copied into product data;
- signed-out and signed-in create affordances are distinct and honest;
- no backend write occurs;
- mobile and desktop layouts are intentional;
- tests and CI pass.
