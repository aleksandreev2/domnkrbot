# NekromantLib native title state

## Goal

Replace the captured title-page placeholders `Добавить в планы` and title rating with native NekromantLib data backed by D1 and Telegram sessions. The UI keeps the saved RanobeLib hierarchy but never copies RanobeLib user counts or ratings.

## Persistence

One row per `book_ref + Telegram user` stores two independent optional fields:

- `list_status`: `reading`, `planned`, `dropped`, `completed`, `favorite`, `other` or null;
- `rating`: integer 1–10 or null.

The row belongs to a real `users.telegram_id` and a real `ranobelib_titles.book_ref`.

## API

- `GET /api/title/state?ref=...` is public and returns real aggregates plus viewer state when signed in.
- `PUT /api/title/state/list` requires Telegram session and same-origin mutation. Body: `{ bookRef, value }`, where value is a supported status or null.
- `PUT /api/title/state/rating` requires Telegram session and same-origin mutation. Body: `{ bookRef, value }`, where value is 1–10 or null.

Response shape contains:

- `ratingAverage`, `ratingCount`;
- `listTotal`;
- `listCounts` by status;
- `myRating`, `myListStatus`.

## UI

- static HTML starts disabled for progressive enhancement;
- after session/state load, signed-in users can choose a list status and a 1–10 rating;
- guests still see real public aggregates but cannot mutate;
- selected list status replaces `Добавить в планы` in the button;
- title rating slot shows real average/vote count, or `—` / zero votes when empty;
- `О тайтле` shows real list distribution for the six captured list buckets;
- no copied reference values are seeded.
