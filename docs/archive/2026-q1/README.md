# Archive: 2026 Q1 planning docs

Moved here on 2026-10-09 (Phase 2 cleanup, CLEANUP_REPORT.md item 31). These files predate Engine 2, Engine 3 and multi-tenancy, and their checklists are not a reliable status source. The live trackers are `Engine 2/docs/superpowers/plans/completion.md` and `Engine 3/docs/superpowers/plans/completion.md`; the root `CLAUDE.md` has the current state.

| File | What it was |
|---|---|
| `progress.md` | Feb 2026 build-progress checklist |
| `MASTER-PLAN.md` | Feb 2026 multi-team build plan |
| `COMPLETENESS-AUDIT.md` | Mar 2026 completeness audit |
| `missing-features.md` | Feb 2026 missing-feature list |
| `memory.md` | Feb 2026 session notes |
| `_spec_output.txt` | Generated spec dump |

## Still open from these docs

- **COMP-012 (`COMPLETENESS-AUDIT.md`): push notifications are DB-only.** `lib/push-notify.ts` only inserts into `notifications`; the Web Push API is never called and there is no `web-push` dependency. Verified still true 2026-10-09.

Everything else in `COMPLETENESS-AUDIT.md` and `missing-features.md` is either fixed (e.g. COMP-002: `executeWorkflows()` is now called from three routes) or superseded; re-audit before acting on any item.
