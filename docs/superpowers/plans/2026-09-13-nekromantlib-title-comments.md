# NekromantLib title comments implementation plan

1. Add a RED contract test covering title-scoped schema, session/same-origin security, replies/votes/reports/admin pin, Worker routing, and the captured title comments UI hierarchy.
2. Add migration `0035_web_title_comments.sql` for comments, votes and reports with FK/index constraints and no runtime DDL.
3. Implement `src/web-title-comments.ts`: public list/sort, create/reply, soft delete, vote, idempotent report, admin-only pin; validate title and parent scope.
4. Route the handler in `src/live-entry-v2.ts` before the base Worker.
5. Enable the existing `Комментарии` title tab and add an isolated comments panel/composer to `public/title/index.html`.
6. Wire authenticated client behavior in `public/title.js`; preserve existing title-state, chapters and local reading progress.
7. Add compact responsive comments styles to `public/title.css`, keeping discussions/reviews disabled.
8. Run full CI + Test Discovery Guard. Fix only evidenced failures. After GREEN append `domnkr-build-20260913-nekromantlib-title-comments1` to `public/build.txt`.
