# D1 post-#103 hardening plan

**Repository:** `aleksandreev2/domnkrbot`  
**Baseline:** `main` after PR #103 (`b9251cb`)  
**Date:** 2026-09-14  
**Purpose:** finish the D1/Workers hardening after the write-amplification incident without degrading notification speed or completion semantics.

## Current state

PR #102 removed the catastrophic D1 write amplification. PR #103 then removed the quadratic `deleteStaleMappings` reconciliation, restored zero-demand final completion scans, made snapshot persistence query-differential, and made discovery/demand updates material-diff based.

Initial post-deploy observations were encouraging: a no-op multi-team snapshot dropped from tens of thousands of rows read to roughly a few hundred, and Rows Written were around 7k/hour in the mixed rollout window. The remaining work is no longer an emergency billing fix; it is about making the multi-team path safe enough to become the only production scanner and preventing a future cost incident.

## Priority order

### P0 — make Shadow scheduler-read-only

Problem: legacy and multi-team scanners share `ranobelib_titles.next_check_at`, `consecutive_no_change`, `scan_priority`, `last_synced_at` and related scheduling state. In Shadow, both scanners run. PR #103 fixed Shadow coverage by capturing the due set before the legacy scanner runs, but the multi-team Shadow scan can still write common scheduler state afterward.

This matters because the schedulers have different cadence. Legacy eventually backs off to 10–30 minutes for quiet titles, while multi-team currently settles at 5 minutes. A Shadow run can therefore overwrite a legacy `+30 min` schedule with `+5 min`, so Shadow is not passive observation.

Required behavior:

- In `mode='shadow'`, the multi-team scanner must not mutate the production scheduler fields used by legacy.
- Shadow may still read, compare, produce telemetry and validate parity.
- Prefer the simplest safe design first: do not call the production scheduler update from Shadow.
- If Shadow later needs independent cadence, introduce a separate Shadow-only scheduling state rather than sharing `ranobelib_titles.next_check_at`.

Tests:

- Legacy schedules a quiet title to +30 minutes; a Shadow scan must not change that value.
- Shadow still scans the captured due set.
- Live mode still updates multi-team scheduling normally.
- Completion semantics remain unchanged.

### P0 — bound `completion_pending` retries

Problem: final scans for completed translations must bypass subscriber demand, but a translation whose final branch cannot be attributed/finalized can remain `completion_pending=1`. If the selector bypasses normal scheduling for pending rows, the same title can be retried every minute forever.

Required behavior:

- Add bounded retry/backoff for pending completion attempts.
- Preserve the guarantee that a normal successful completion gets its final chapter scan promptly.
- Suggested cadence: 1 → 2 → 5 → 10 → 30 → 60 minutes, then hourly retry.
- Track enough state to distinguish a fresh completion from a repeatedly failing finalization, e.g. attempt count and last-attempt timestamp.
- Surface stuck pending completions in `/stats` or equivalent admin diagnostics.
- Do not silently clear `completion_pending` just because attribution failed.

Tests:

- Zero-subscriber completed translation still receives a final scan.
- Failed/ambiguous finalization does not run every minute indefinitely.
- Successful later attribution clears pending and preserves the final release semantics.

### P0 — add financial guardrails

The system must fail closed if a future bug computes an implausibly large mutation delta.

Add an emergency scanner kill switch in `app_settings`, for example:

`ranobelib_scanner_enabled = 0|1`

Requirements:

- A single D1 setting can stop RanobeLib chapter scanning without disabling the Telegram bot or unrelated features.
- The default remains enabled.
- The scheduler checks the switch cheaply and safely.

Add a mutation anomaly budget before applying a baselined snapshot delta.

Guard inputs should include:

- `branchesToInsert`
- `branchesToUpdate`
- `mappingsToInsert`
- `mappingsToDelete`
- existing snapshot size

Use both absolute and relative thresholds. If a baselined title suddenly wants to rewrite a suspicious fraction of historical state, do not apply the mutation. Log/alert the anomaly and schedule a controlled retry.

Do not hard-code final thresholds until production distributions are measured; make the policy easy to tune.

Tests:

- Small legitimate deltas pass.
- Large anomalous rewrites fail closed.
- Initial baseline/import remains possible through an explicit baseline path.
- Kill switch prevents chapter scanners from running.

### P1 — align multi-team adaptive cadence with legacy

Problem: quiet watched titles in multi-team currently settle at a 5-minute polling interval indefinitely. Legacy already has a better adaptive model that keeps active titles fast and backs quiet titles off to 10–30 minutes.

Target behavior:

- New/changed title: very fast follow-up (1–2 minutes).
- Recent activity: 2–5 minutes.
- Repeated no-change: 10 minutes.
- Long quiet period: 30 minutes.
- Pending completion uses its own bounded retry policy from the P0 item above.

Goal: preserve responsiveness for active releases while cutting polling of long-quiet titles by up to ~6×.

Tests should cover the complete delay progression and reset after a real release/change.

### P1 — remove redundant RanobeLib auth reads

Current problem: `RanobeLibAuthProvider.getAccessToken()` effectively reads the singleton credential row multiple times for a normal request (`readRow()` → `load()` → another `readRow()`). Query Insights showed roughly ~2k credential SELECTs/hour in the mixed post-#103 window.

Required change:

- Read the credential row once for a normal access-token lookup.
- Decrypt from that row directly.
- Add a short-lived per-provider/per-client in-memory cache containing the decrypted token and expiry metadata.
- A normal request should not touch D1 again while the cached token is valid.
- `forceRefresh` must bypass/invalidate the cache correctly.
- A successful refresh must replace the cached bundle.
- Failure/invalid states must remain authoritative.

Do not introduce cross-isolate correctness assumptions; the cache is only an optimization.

Tests:

- Valid token: one D1 read on first access, no extra D1 reads for repeated calls in the same provider instance.
- Expiry/refresh path still works.
- 401 force-refresh invalidates stale cache.
- Invalid credential state still fails correctly.

### P1 — remove duplicate branch-history reads in multi-team scans

Current flow reads stored branch keys in the scanner to build the scan plan, then `persistBranchSnapshot()` reads the richer stored branch snapshot again, plus mappings.

Required change:

- Load the stored multi-team snapshot once per work.
- Reuse that state for scan planning and persistence diff.
- Avoid re-querying `ranobelib_chapter_branches` in the same scan.

Do not add a fingerprint yet unless clean post-#103 metrics show full-history reads remain materially expensive after the simpler deduplication.

### P1 — move global demand refresh out of the team loop

Current discovery still calls `refreshAllWorkNotificationDemand()` inside the per-team discovery path. With N teams, the global demand reconciliation can run N times per discovery cron.

First safe step:

- Process all runnable teams.
- Call `refreshAllWorkNotificationDemand()` once after the team loop.

Preferred follow-up:

- Collect the set of `book_ref`s whose relations/material state changed.
- Refresh demand only for those works.

Tests:

- Multiple teams in one discovery pass result in one global refresh.
- A changed relation still wakes/stops the correct title.
- No-change discovery does not produce title-demand writes.

### P1 — optimize membership maintenance

Current observations show `channel_access_state` as a steady write source. Maintenance runs every 5 minutes and also hourly, and unchanged members are still persisted as heartbeat state.

Required investigation/fix:

- Decide which cron owns full reconciliation; avoid two near-duplicate sweeps.
- Keep webhook membership updates as the fast event path.
- Do not rewrite full status state when nothing material changed unless a heartbeat is genuinely required.
- If a heartbeat timestamp is needed for scheduling, keep the write minimal and avoid touching unrelated columns/indexes.
- Add/verify an index that supports the selector ordering by oldest `last_checked_at`.

Acceptance:

- Correct leave/rejoin/blacklist behavior preserved.
- No duplicate full sweep at the top of the hour.
- Query Insights shows substantially fewer `channel_access_state` rows written.

## P2 — measure before deeper architectural work

### Snapshot fingerprint

Potential optimization: store a canonical fingerprint/hash of the normalized remote chapter/branch snapshot and skip local ledger/mapping reads when the fingerprint is unchanged.

Do not implement this before measuring a clean post-#103 window. #103 already reduced a no-op scan from tens of thousands of rows read to roughly a few hundred. A fingerprint adds new persistent state and synchronization invariants, so only add it if branch/mapping reads are still a material hotspot.

### Split discovery into fast vs deep reconciliation

Potential optimization:

- Fast discovery every ~30 minutes: current catalog, recent relations, status/completion.
- Deep reconciliation every 6–24 hours: full team chapter history, older relations, expensive verification.

This can reduce RanobeLib API traffic because history discovery can walk many pages and secondary-team verification can perform multiple detail requests. Do not rely on undocumented incremental API parameters or ETags unless verified in production-safe experiments.

### Delivery query tuning

When `delivery=1`, measure the multi-team outbox/delivery CTEs before changing them. They may become the next read hotspot only after live cutover. Optimize from Query Insights, not speculation.

### Rollout state model

Long-term replace three independent booleans with a clearer model such as:

- `scanner_mode = legacy | shadow | live`
- `ui_enabled = 0|1`
- independent emergency kill switch

This is operational hardening, not required for the next live cutover.

### Remove dead idle cron

The current idle selectors return no work, so `17 */3 * * *` is effectively dead. Remove it only as a separate cleanup after verifying final completion scans are fully handled by the minute cron and pending backoff logic.

## Rollout plan

1. Keep `delivery=0` while implementing the P0/P1 hardening above.
2. Do not use long-running Shadow as a steady-state mode before scheduler isolation is merged.
3. Deploy hardening through branch → PR → CI → review → merge. Do not push implementation code directly to `main`.
4. After deploy, enable Shadow for a short parity test.
5. Observe at least one clean post-deploy Query Insights window.
6. Confirm:
   - old `WITH incoming_branches ... NOT EXISTS` query is absent;
   - `snapshotBranchWrites`, `snapshotMappingInserts`, `snapshotMappingDeletes` are near zero when no releases occur;
   - no stuck completion retries every minute;
   - Shadow does not alter legacy scheduling;
   - Rows Written remains comfortably below the internal safety budget.
7. If parity is clean, enable `delivery=1` so multi-team becomes the only scanner path.
8. Set `shadow=0` after live cutover.
9. Observe 12–24 hours before additional optimization.

## Operational safety targets

These are internal targets, not Cloudflare limits:

- Normal target: `< 500k Rows Written/day`.
- Attention: sustained `> 1M/day`.
- Emergency: sustained `> 5M/day` or any single query creating a rapid write spike.
- Long-term monthly projection target: comfortably below 15M writes/month while normal traffic is unchanged.

## Post-deploy verification queries / checks

Check rollout and pending completion counts:

```sql
SELECT
  (SELECT COUNT(*) FROM ranobelib_titles WHERE translation_completion_pending = 1) AS legacy_pending,
  (SELECT COUNT(*) FROM ranobelib_team_translations
     WHERE completion_pending = 1 AND presence_state = 'active') AS team_pending,
  (SELECT value FROM app_settings WHERE key = 'ranobelib_multi_team_shadow') AS shadow,
  (SELECT value FROM app_settings WHERE key = 'ranobelib_multi_team_delivery') AS delivery,
  (SELECT value FROM app_settings WHERE key = 'ranobelib_multi_team_ui') AS ui;
```

Check watched/unwatched titles:

```sql
SELECT
  SUM(CASE WHEN notification_subscriber_count > 0 THEN 1 ELSE 0 END) AS watched,
  SUM(CASE WHEN notification_subscriber_count = 0 THEN 1 ELSE 0 END) AS unwatched,
  COUNT(*) AS total
FROM ranobelib_titles;
```

Query Insights expectations after the full hardening:

- No old quadratic stale-mapping DELETE.
- `ranobelib_auth_credentials` SELECT count drops sharply.
- Global demand reconciliation count drops from per-team to once-per-pass or per-changed-work.
- Membership writes drop substantially.
- Quiet watched titles produce fewer scans because adaptive backoff reaches 10–30 minutes.

Workers Logs expectations:

- No-op scans normally report `snapshotBranchWrites=0`, `snapshotMappingInserts=0`, `snapshotMappingDeletes=0`.
- Pending completion retries show bounded attempts/backoff.
- Mutation guard logs anomalies instead of applying large unexpected deltas.

## Definition of done before live cutover

- Shadow cannot mutate legacy production scheduler state.
- `completion_pending` cannot cause an infinite one-minute retry loop.
- Scanner kill switch exists and is tested.
- Large anomalous snapshot mutations fail closed.
- Multi-team cadence backs quiet titles off to 10–30 minutes.
- Auth token reads are cached/deduplicated safely.
- Global notification-demand reconciliation no longer runs once per team.
- Membership maintenance duplicate/redundant work is reduced without breaking enforcement.
- Full CI and Production Smoke are green.
- A clean post-deploy Query Insights window shows no new write/read regression.
- Short Shadow parity test is clean before switching to `delivery=1`.

## Source context

This plan consolidates the post-#103 Cloudflare/D1 diagnostics, the production Query Insights observations, and the independent review captured in `domnkrbot_d1_report_2026-09-13.md`. It intentionally prioritizes safety for live multi-team cutover over speculative micro-optimizations.