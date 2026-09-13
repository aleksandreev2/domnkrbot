# D1 Cost Guard Design

## Goal
Keep RanobeLib monitoring fast for titles with real notification demand while eliminating wasteful D1 writes and chapter polling for titles nobody follows.

## Approved behavior
- Titles with zero notification subscribers are not chapter-scanned.
- Multi-team snapshot persistence writes only new or materially changed branch rows.
- Branch/team mappings are reconciled by delta instead of unconditional DELETE + INSERT on every scan.
- Identical consecutive scans produce zero snapshot mutations.
- Existing release/completion semantics remain unchanged.
- Rollout remains disabled until production D1 write metrics confirm the fix.

## Safety
- Preserve historical branch rows when an upstream response is temporarily incomplete.
- Avoid deleting mappings for branches absent from a single upstream payload.
- Add regression tests that make no-op scans and zero-demand scans explicit invariants.
