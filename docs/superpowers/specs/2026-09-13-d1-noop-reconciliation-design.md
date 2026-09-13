# D1 No-op Reconciliation Design

## Goal
Follow-up to the D1 cost guard (#102): make unchanged scans and discovery passes cheap in rows read,
not only in rows written, and restore mandatory completion final scans for zero-demand works.

## Observed problem
- `deleteStaleMappings` ran on every multi-team snapshot. Its correlated `EXISTS` / `NOT EXISTS`
  subqueries re-scanned the `json_each` payload for every stored mapping, so rows read grew as
  stored × incoming (270 chapters ≈ 72.9k rows read per call, 90% of SQL runtime).
- `refreshAllWorkNotificationDemand` rewrote `subscriber_count_updated_at` for every candidate work.
- Multi-team discovery rewrote every title and team relation (timestamps) every 30 minutes; legacy
  discovery rewrote every title row.
- After #102 both scanner selectors required demand > 0, so a pending translation completion on a
  work nobody follows never received its final chapter poll.
- In shadow mode the legacy scan rescheduled `ranobelib_titles.next_check_at` before the multi-team
  shadow scan selected its due set, hiding those works from shadow coverage.

## Behavior
- `persistBranchSnapshot` loads stored branches/mappings for the book, diffs in the Worker and sends
  only changed branch rows, missing mapping tuples and explicit stale tuples. An identical snapshot
  sends no mutation statement. Mappings are reconciled only for branches present in the payload.
- The scan result reports `snapshotBranchWrites`, `snapshotMappingInserts`, `snapshotMappingDeletes`
  so Workers Logs attribute persistence cost per cron run.
- Demand refresh updates a title only when its effective demand changed; the per-work refresh still
  returns the authoritative count.
- Multi-team discovery updates titles/relations only on material change; the team row keeps the
  sync heartbeat. A pending completion wake-up is not re-armed while already due.
- Legacy discovery skips title rows whose upsert would reproduce stored values.
- `translation_completion_pending` works stay selectable regardless of demand in both scanners;
  ordinary zero-demand works stay excluded.
- Shadow mode captures the multi-team due set before the legacy scan runs.

## Out of scope
Rollout flags, cron list, migrations, mutation budget / kill switch.
