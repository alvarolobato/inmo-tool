---
id: D-125
title: Freshness dot asserts "nothing due" over crawl + capture, fails dark on error
date: 2026-08-20
group: Plumbing / process
rule: The TopBar freshness dot asserts "no in-scope source is due" over crawl-enabled connectors PLUS capture-only portals (supports_discovery=false AND capture_enabled); a DB error or empty in-scope set renders an explicit grey "unknown", never green.
---

# D-125: Freshness dot asserts "nothing due" over crawl + capture, fails dark on error

*Decided: 2026-08-20*

**Context**: The owner caught the TopBar freshness dot reading green in
production while Idealista — a capture-only portal — had not been captured in
two days (issue #586). `getConnectorFreshness()` (`dashboard/lib/db/
freshness.ts`) computed `overallStale` only over connectors with
`connector_config.enabled = true`. Idealista runs `enabled=false,
capture_enabled=true` BY DESIGN (its automated crawl is WAF-blocked, same
class as D-019/D-026/D-027) — see D-055's single-toggle design — so it was
filtered out before the staleness check ever ran, and the query never read
`extension_capture` at all. It was structurally impossible for capture
silence to move the dot, not merely mistuned. Two further paths rendered
green when they should not have: a DB error in `data-health/route.ts`
degraded to `overallStale: false`, and zero enabled connectors hard-coded
"Datos al día" in `FreshnessContext.tsx`. Checked against the live demo stack
(`inmo-tool-main-demo`, 2026-08-20): every crawl connector there was disabled
too, so the dot was reading green off the "zero enabled connectors" path
specifically — confirming the bug is real, not hypothetical.

**Decision**: Green means exactly one claim: **no in-scope source is due**.
It does NOT mean "something arrived recently" — those are different claims,
and making the weaker one while displaying the stronger one is the bug this
decision closes.

- **In-scope set** = `enabled` (crawl connector) OR (`supports_discovery =
  false` AND `capture_enabled`) (capture-only portal). A crawl connector
  that's simply turned off (`supports_discovery=true, enabled=false`) stays
  out of scope, same posture it always had.
- **Capture-only "last success"** = the latest `extension_capture` row with
  `status = 'done'` for that connector — never the `capture_task_run` launch
  ledger, so a launched-but-failed capture cannot read as fresh.
- Both crawl and capture-only connectors are fed through the SAME
  `deriveFreshnessState()` machine (issue #295/D-050) — capture-only
  connectors just supply a discrete "last done capture" instead of a cycle
  (`cycleStartedAt` always null), so they can only ever resolve to `fresh` or
  `due`, never `refreshing`/`stuck`. Window = `connector_config.
  freshness_interval_hours` when set, else `resolveStalenessDays(portal,
  getStalenessConfig()) * 24` (issue #289's Captura staleness config) — the
  fallback formula issue #588 will eventually unify, deliberately not blocked
  on here.
- **Fail dark, never green**: a DB/query error (`data-health/route.ts`'s
  catch branch) or an empty in-scope set (nothing registered, every
  connector genuinely off with no capture fallback) sets `overallUnknown:
  true` on the payload; `overallStale`/`overallRefreshing` stay `false`
  alongside it (nothing to assert either way). `FreshnessContext.tsx` checks
  `overallUnknown` FIRST and renders "Estado desconocido" — a distinct grey
  dot (`var(--fg-muted)`), never the green `var(--up)`.
- `/api/ready`'s `overall_stale` field (it consumes the same
  `getConnectorFreshness()`) now inherits the corrected, honest value for
  free — verified live it still returns HTTP 200 either way (`status:
  "degraded"` is informational only; only DB unreachability trips 503), so
  this doesn't make container readiness flap on a stale portal.

**Alternatives rejected**:
- A second, capture-specific due/stale state machine — rejected; reuses
  `deriveFreshnessState()` exactly as the issue required, so `/etl/connectors`
  and the TopBar dot can never structurally diverge on what "due" means.
- A supporting partial index on `extension_capture (connector_name,
  created_at) WHERE status='done'` for the new `GROUP BY` — measured against
  a synthetic 300k-row table (~100x the current live count) and found to make
  no difference: with only a handful of distinct `connector_name` values, the
  planner prefers a parallel seq scan (~20ms) over the index either way. Not
  added.
- Silently keeping `overallStale`'s old crawl-only scope for `/api/ready` and
  inventing a second field for the TopBar — rejected as needless duplication;
  the readiness route's HTTP status code was already gated on DB reachability
  alone (`overall_stale` only feeds its informational JSON `status` field),
  so broadening the shared value costs nothing there and fixes it for free.

**Rationale**: The two surfaces (`/etl/connectors`' per-connector pill and the
TopBar dot) must never contradict each other on whether a portal is stale —
that was already true for `/etl/connectors` before this fix; the dot was the
one lying. Verified against the live demo stack: before the fix,
`GET /api/data-health` returned `overallStale: false, stalestConnector: null`
(every connector — crawl and capture — was `enabled=false`, hitting the
empty-scope green-wash path). After the fix, the same live data returns
`overallStale: true, stalestConnector: {"connector":"hipoges", ...}` — a
capture-only portal that has never been captured at all, previously invisible
to the dot, now correctly names the most-overdue source.

**See**: `dashboard/lib/db/freshness.ts`, `dashboard/app/api/data-health/
route.ts`, `dashboard/components/FreshnessContext.tsx`,
`dashboard/components/TopBar.tsx`, `dashboard/lib/db/__tests__/
freshness.integration.test.ts`, `dashboard/app/api/data-health/__tests__/
route.test.ts`, [D-050](D-050-connector-freshness-cadence.md),
[D-055](D-055-single-connector-toggle.md), issue #586, follow-up issue #588
(window-knob unification, deliberately not blocked on).
