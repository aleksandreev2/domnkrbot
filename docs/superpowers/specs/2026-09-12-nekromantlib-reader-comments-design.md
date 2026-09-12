# NekromantLib reader comments parity design

## Goal

Reproduce the lower reader surface from the user-provided `03 — Тайтлы и главы.zip` one-for-one in structure and interaction while keeping all social content native to NekromantLib. Do not copy RanobeLib comments, users, vote counts or translator identities.

## Reference surface

The saved normal reader state places the following blocks directly below the chapter text:

1. `Над главой работали` translation-credit block.
2. Primary `Поддержать` action.
3. Comment composer with `Написать комментарий...`.
4. Comment thread rows with author identity, body, score, reply and report controls.

The existing reader top bar, text geometry, chapter list and settings remain unchanged.

## Native data model

Add chapter-scoped comments rather than reusing or copying RanobeLib social data.

### `reader_chapter_comments`

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `book_ref TEXT NOT NULL`
- `chapter_id INTEGER NOT NULL`
- `author_user_id INTEGER NOT NULL`
- `parent_comment_id INTEGER NULL`
- `body TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NULL`
- `deleted_at TEXT NULL`

Indexes:
- `(book_ref, chapter_id, created_at)`
- `(parent_comment_id, created_at)`
- `(author_user_id, created_at)`

Replies use one persisted parent relation. Rendering may indent replies but does not invent imported conversation state.

### Voting

Do not fabricate RanobeLib scores. Native per-user votes use:

`reader_chapter_comment_votes(comment_id, user_id, value, created_at, updated_at)` with `value IN (-1,1)` and composite primary key `(comment_id,user_id)`.

Displayed score is the sum of native votes. Zero is real zero, not copied reference data.

## API

Use the existing Telegram session identity and D1 ownership patterns.

- `GET /api/reader/comments?ref=<book_ref>&chapter=<chapter_id>`
  - public read;
  - returns comments/replies, native vote score and `canDelete`/`myVote` when a session exists.
- `POST /api/reader/comments`
  - authenticated;
  - body: `bookRef`, `chapterId`, `body`, optional `parentCommentId`;
  - validates that title/chapter exists and bounds comment length.
- `DELETE /api/reader/comments/:id`
  - authenticated;
  - author or admin only;
  - soft-delete body while retaining reply topology.
- `PUT /api/reader/comments/:id/vote`
  - authenticated;
  - value `-1`, `0`, or `1`; zero removes the vote.

Report remains visibly present but disabled until a real moderation/report contract exists.

## UI parity

Add directly below chapter content:

- `Над главой работали`, showing only the real `Дом Некроманта` team identity;
- `Поддержать`, linked to the real team support destination already used by the project;
- captured-order comments surface;
- signed-out composer routes to Telegram authentication rather than silently failing;
- signed-in composer posts without reload;
- rows show Telegram display identity, timestamp, body, native score, `ответить`, and disabled `жалоба` until reports exist;
- delete appears only when API returns `canDelete=true`;
- inline reply composer.

No RanobeLib usernames, comment text, reactions or counts are seeded.

## Error handling

- Failed read shows a compact retry/error state without hiding chapter text.
- Failed post/vote/delete preserves user input/state and shows an inline message.
- Deleted parent comments show a neutral deleted marker so replies remain attached.

## Testing

Follow RED -> GREEN:

1. migration/schema contract tests;
2. API authorization and ownership tests;
3. vote idempotency tests;
4. reader HTML/JS parity contract;
5. full CI + Test Discovery Guard.

## Non-goals

- importing RanobeLib comments/accounts;
- report moderation in this slice;
- scanner, translation lifecycle or Telegram notification changes;
- changing the already verified reader header/settings/chapter-list parity.
