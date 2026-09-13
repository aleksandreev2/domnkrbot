# NekromantLib title comments — design

## Goal
Turn the captured title-level `Комментарии` tab into a native NekromantLib social surface without mixing it with chapter comments and without importing or inventing RanobeLib user data.

## Reference hierarchy
The saved RanobeLib title capture establishes this order inside the comments tab:

1. `Новые`
2. `Настройки`
3. `Правила`
4. comment composer
5. comment thread

Comments expose replies, voting and report actions. Elevated composer/moderation actions such as pinning must only be enabled when NekromantLib has a real permission and persisted state for them.

## Native data model
Use title-scoped tables, separate from `reader_chapter_comments`:

- `web_title_comments`: comment identity, `book_ref`, Telegram author, optional parent, body, pin/deletion timestamps.
- `web_title_comment_votes`: one `-1/+1` vote per Telegram user/comment.
- `web_title_comment_reports`: one report per Telegram user/comment with persisted reason/status.

No title comment may reference a chapter id. Title existence is validated against `ranobelib_titles`.

## API
Native routes live under `/api/title/comments`:

- `GET /api/title/comments?ref=<bookRef>&sort=new|top`
- `POST /api/title/comments`
- `DELETE /api/title/comments/:commentId`
- `PUT /api/title/comments/:commentId/vote`
- `POST /api/title/comments/:commentId/report`
- `PUT /api/title/comments/:commentId/pin` — admin only

Reads are public. Mutations require the established Telegram session and same-origin mutation guard. Delete is allowed to the author or admin. Pin is admin-only. Reports are persisted and idempotent per reporter/comment.

## UI
The existing title tab becomes enabled and owns an isolated `titleCommentsPanel`. It must:

- preserve the captured `Новые / Настройки / Правила` ordering;
- expose a native composer only to signed-in users and a Telegram login affordance otherwise;
- render title-scoped replies, votes, delete/report and permitted pin actions;
- support `Новые` and `Лучшие` sorting without fabricated counts;
- keep discussions/reviews disabled until their own native scopes exist;
- contain no seeded RanobeLib usernames/comments/counts.

## Accessibility / responsive behavior
Buttons retain focus-visible treatment, menus/actions remain keyboard reachable, status text uses an ARIA live region, and the comments panel must fit the existing 360–430 px mobile title layout without horizontal overflow.

## Security / integrity
- body length: 1–3000 chars;
- validate `book_ref`, UUID-like comment ids and parent scope;
- soft-delete comments so reply topology survives;
- disallow voting/reporting deleted comments;
- no runtime DDL;
- no copied RanobeLib social data.
