# Telegram Latency v3 Design

## Goal
Make interactive Telegram screens feel immediate and stable by optimizing the time until the next visible screen appears, not only callback acknowledgement latency.

## Context
Performance v1/v2 already removed major webhook routing overhead, moved callback acknowledgement earlier, deferred notification-demand maintenance, and parallelized safe housekeeping. Production is still perceived as slow because many routes perform D1 reads and then await `editMessageText`, while long external RanobeLib work leaves the previous screen visible.

Research findings:
- `answerCallbackQuery` should still happen immediately, but that only removes Telegram's spinner; it does not make the next screen visible.
- `editMessageText` and `sendMessage` share Telegram-side flood/rate pressure; `deleteMessage + sendMessage` is therefore not a universal speed optimization.
- For semantic screen transitions, use `sendMessage` first and delete the old message only after the new one succeeds. This prevents blank-chat failure and avoids making deletion part of the critical path.
- Cloudflare D1 `batch()` reduces database round trips and is appropriate for multi-read UI payloads.
- D1 schema should be deployed with migrations; interactive production requests must not execute DDL/self-heal before rendering.
- Cloudflare Smart Placement is worth an isolated measured production experiment; D1 read replication/Sessions API remains a later experiment.

## Principles
1. Optimize `screen_ready_ms`, not merely callback ACK.
2. Static commands should be able to produce Telegram output without waiting for D1 housekeeping.
3. Production interactive paths never execute `CREATE TABLE`, `CREATE INDEX`, or `ALTER TABLE`.
4. Durable user mutations remain correctness-first.
5. Read-only UI state should use one D1 round-trip where practical.
6. Semantic navigation uses `replace`; local state changes/pagination use `edit`.
7. Replace means `sendMessage(new)` first, then best-effort `deleteMessage(old)` via `waitUntil()`.
8. Long external operations show an immediate loading screen before upstream work.
9. Repeated callbacks must not allow an older render to overwrite a newer semantic screen.
10. Moderation, ban/unban, appeal resolution, publishing and file delivery correctness are out of scope and must not be weakened.

## Render strategies
Introduce a reusable Telegram screen renderer with explicit strategy:

- `edit`: one `editMessageText` request. Use for pagination, inline toggle/status refresh, confirmation prompts, and same-screen mode changes.
- `replace`: one awaited `sendMessage`, followed by background `deleteMessage` for the old callback message. Use for dashboard ↔ list/card, proposal step changes, returning to root, stale/error screens, and other semantic transitions.
- `send`: normal new message for commands or text-input results.

If `replace` send fails, do not delete the old message. A failed background delete is non-fatal.

## Proposal wizard
Use `replace` for semantic step transitions such as root → source choice, source → input step, review → field edit, back across wizard steps, resume, stale/error, and completed/reset screens.

For RanobeLib operations (`pick`, `retry`, remote confirmation): immediately render a lightweight loading screen using `replace`, then perform external requests and edit/replace the loading message with the final result. Loading state disables stale action buttons.

Pagination of already-local candidate results remains `edit`.

## Notification UI
Keep `edit` for title-list pagination, toggles and mode changes on the same title.

Use `replace` for dashboard → title list/card, card → dashboard/list, search prompt/result transitions, stale/error screens, and destructive-flow completion where the semantic screen changes.

Batch dashboard/title-card read queries so one interaction does not perform multiple D1 network round trips for independent state.

## `/start` and static command fast path
`/start` should not await runtime schema initialization. Main-menu Telegram output should start immediately. Required user-state housekeeping runs in parallel/background where correctness allows.

Evaluate webhook-response Bot API only for fully static/deterministic commands. Keep it only if tests show equivalent ownership/error semantics and simpler critical path; otherwise retain concurrent outbound `sendMessage`.

## Remove runtime DDL
Existing `ensure*Schema()` helpers may remain for tests, maintenance, or explicit repair paths, but interactive handlers must not call them in production steady-state routing.

CI/local setup continues applying migrations. Add static regression tests that reject DDL helpers in interactive handlers.

## Detailed latency telemetry
Instrument safe coarse fields without raw callback data, message text, IDs, tokens or user content:
- `route`
- `kind`
- normalized `action`
- `render_strategy`
- `ack_started_ms`
- `db_started_ms`
- `db_done_ms`
- `telegram_started_ms`
- `screen_ready_ms`
- `telegram_method`
- `telegram_api_ms`
- `total_ms`

Telegram method timings must be captured around the actual outbound method used for the visible screen (`sendMessage`, `editMessageText`). Background `deleteMessage` is recorded separately or omitted from `screen_ready_ms`.

## Race protection
For semantic `replace`, the old message is deleted only after a successful new send. Buttons on loading screens are disabled. For edit-based routes, avoid unnecessary repeated edits and treat Telegram `message is not modified` as non-fatal.

Do not introduce a distributed locking subsystem in v3 unless tests demonstrate a remaining correctness race after replace/loading changes.

## Cloudflare placement experiment
After code-level changes are green, add Smart Placement (`placement.mode = "smart"`) as a measured production experiment because the Worker makes repeated D1 and external API calls. Production latency logs determine whether it stays.

Do not enable D1 read replication/Sessions API in this PR; it changes consistency/routing semantics and should be a separately measured v3.1 change if D1 read latency remains material.

## Validation gates
- TDD for every behavior change.
- Full local-equivalent GitHub CI: migrations, TypeScript, website JS/static guards, full `npm test`, Wrangler dry-run.
- Exact-head CI green before merge.
- Full diff review and no blocking review threads.
- Unique production marker `domnkr-build-20260909-telegram-perf3`.
- Post-merge CI green on exact merge SHA.
- Production smoke must observe the perf3 marker and existing readiness checks.
