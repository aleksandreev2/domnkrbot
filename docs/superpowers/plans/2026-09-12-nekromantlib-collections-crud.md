# NekromantLib Collections CRUD — implementation plan

## Goal

Turn the already verified `/collections/` shell into a real owner-scoped feature without copying RanobeLib user data or touching Telegram notification/scanner lifecycle.

## Slice A — persistence and API

1. Add forward-only migration `0030_web_collections.sql`.
2. Store collection ownership by existing `users.telegram_id`.
3. Add `web_collection_items` now as the stable child table for the next title/group slice, but do not fabricate items.
4. Add `src/web-collections.ts` with public reads plus authenticated owner CRUD.
5. Require a signed Telegram web session for private/mutating operations and same-origin validation for writes.
6. Scope PATCH/DELETE in SQL by both collection id and owner Telegram id.
7. Dispatch the handler from production `live-entry-v2.ts` before the compatibility worker.

## Slice B — web UI

1. Load `/api/collections` for the New tab.
2. Load `/api/collections?mine=1` for My collections when authenticated.
3. Replace the placeholder create notice with a real compact create dialog.
4. Render only API-returned data; no demo/random collections.
5. Keep edit/delete controls for a later detail-management slice unless the API response marks the current user as owner.

## Verification

RED contract first, then migrations, TypeScript typecheck, public JS syntax, complete test suite and Wrangler dry-run. After GREEN, add a build marker and proceed immediately to collection items/groups/detail page.
