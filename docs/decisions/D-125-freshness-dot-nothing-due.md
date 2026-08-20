---
id: D-125
title: Freshness dot asserts "nothing due" over crawl + capture, fails dark on error
date: 2026-08-20
group: Data / connectors
rule: 'getConnectorFreshness()/listConnectors() share ONE freshness fn; DB error/empty scope -> unknown, never green; never-succeeded never buries a measurable regression in the headline.'
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

A first-round fix (PR #590) corrected `getConnectorFreshness()` alone and
shipped a claim in this file that the shared `deriveFreshnessState()` state
machine meant the TopBar dot and the `/etl/connectors` pill "can never
structurally diverge on what due means." **That was false as shipped**: the
*state machine* was shared, but `listConnectors()` (`lib/db/connectors.ts`,
which drives the pill) still fed it `connector_freshness_state` alone for
EVERY connector, including capture-only ones — a table with no rows at all
for a connector whose crawl never runs. So the pill read "obsoleto, sin ciclo
iniciado" for idealista/aliseda/altamira/hipoges permanently, regardless of
how recently they'd actually been captured, while the corrected dot
correctly read some of them fresh — the same class of lie #586 opened, one
click deeper (Opus review on PR #590, finding B1). The same review also
caught a second problem live on production-shaped seed data: hipoges has
never been captured at all, so it permanently owned the stale headline
(`stalestConnector`), and altamira — actually 11 days stale, the real,
actionable regression — was never named. A dot that is permanently amber for
the wrong reason is the alarm-fatigue mirror of a dot that's permanently
green (finding B2). Both are fixed here, in the same PR.

**Decision**: Green means exactly one claim: **no in-scope source is due**.
It does NOT mean "something arrived recently" — those are different claims,
and making the weaker one while displaying the stronger one is the bug this
decision closes.

- **In-scope set** = `enabled` (crawl connector) OR (`supports_discovery =
  false` AND on the #454 `CAPTURE_PORTALS` allow-list AND `capture_enabled`)
  (capture-only portal). A crawl connector that's simply turned off
  (`supports_discovery=true, enabled=false`) stays out of scope, same
  posture it always had. The allow-list check (`isCaptureOnlyForFreshness()`)
  matters beyond Idealista/Aliseda/Altamira/Hipoges: a hypothetical future
  non-discovery connector that ISN'T extension-capturable would otherwise be
  pulled into the capture branch with no `extension_capture` rows ever
  possible for it — permanently "due" with no way to ever clear.
- **Capture-only "last success"** = the latest `extension_capture` row with
  `status = 'done'` for that connector — never the `capture_task_run` launch
  ledger, and never a `'listing'` (search-page capture, D-069's clean
  outcome) or `'failed'` row either, so neither a launched-but-failed capture
  nor a captured results page can read as fresh.
- **One shared definition, not two.** `resolveConnectorFreshnessState()`
  (`dashboard/lib/db/connectors.ts`) is the ONLY place that decides a
  connector's `fresh`/`refreshing`/`stuck`/`due` state; both
  `getConnectorFreshness()` (the TopBar dot) and `listConnectors()` (the
  `/etl/connectors` pill) call it. A crawl connector is fed its freshness
  CYCLE (`connector_freshness_state`, issue #295/D-050); a capture-only
  portal is fed its latest 'done' `extension_capture` timestamp instead, no
  cycle (`cycleStartedAt` always null, so it can only ever resolve to
  `fresh` or `due`), and a different default window:
  `connector_config.freshness_interval_hours` when set, else
  `resolveStalenessDays(portal, getStalenessConfig()) * 24` (issue #289's
  Captura staleness config — the fallback formula issue #588 will eventually
  unify, deliberately not blocked on here). Both call sites run the SAME SQL
  `LEFT JOIN` against `extension_capture` for this — verified live against
  the demo stack that the two surfaces now report byte-identical
  `state`/`lastFreshAt` for every capture-only portal.
- **A never-succeeded entry never permanently owns the stale headline.**
  `stalestConnector` prioritizes an in-scope STALE connector with a
  MEASURABLE age (something that regressed from a working state) over one
  that has literally never succeeded/been captured. A never-succeeded entry
  still counts toward `overallStale` (its due-ness is real), and still wins
  the headline when it's the ONLY stale thing — it just never buries a real,
  actionable regression. Verified live: with hipoges never-captured and
  altamira 11 days stale, `stalestConnector` names altamira, not hipoges.
- **Fail dark, never green**: a DB/query error (`data-health/route.ts`'s
  catch branch) or an empty in-scope set (nothing registered, every
  connector genuinely off with no capture fallback) sets `overallUnknown:
  true` on the payload; `overallStale`/`overallRefreshing` stay `false`
  alongside it (nothing to assert either way). `FreshnessContext.tsx` checks
  `overallUnknown` FIRST and renders "Estado desconocido" — a distinct grey
  dot (`var(--fg-muted)`), never the green `var(--up)`. The dot carries its
  own `role="status"`/`aria-label` (issue #571 made it the ONLY thing
  rendered below md — the text span is `display:none` there, dropped from
  the accessibility tree too, not just hidden visually).
- `/api/ready` surfaces the SAME `overallUnknown` boolean as a third
  `status: "unknown"` value (alongside `ready`/`degraded`) — still always
  HTTP 200 either way; only DB unreachability trips 503. Readiness still
  gates on DB reachability alone, never on staleness/scope, so this doesn't
  make container readiness flap.

**Alternatives rejected**:
- A second, capture-specific due/stale state machine — rejected; reuses
  `deriveFreshnessState()` exactly as the issue required. (The first-round
  mistake was believing "reuses the state machine" alone was sufficient to
  make the two surfaces agree — it is necessary but not sufficient; the
  *inputs* also have to be the same query, which is why
  `resolveConnectorFreshnessState()` exists as a second, smaller shared
  layer on top.)
- A supporting partial index on `extension_capture (connector_name,
  created_at) WHERE status='done'` for the new `GROUP BY` — measured against
  a synthetic 300k-row table (~100x the current live count) and found to make
  no difference: with only a handful of distinct `connector_name` values, the
  planner prefers a parallel seq scan (~20ms) over the index either way. Not
  added.
- Silently keeping `overallStale`'s old crawl-only scope for `/api/ready` and
  inventing a second STATE definition for the TopBar — rejected as needless
  duplication; the readiness route's HTTP status code was already gated on
  DB reachability alone (`overall_stale`/`overall_unknown` only feed its
  informational JSON `status` field), so broadening/surfacing the shared
  values costs nothing there and fixes the same class of fail-green for
  free, once explicitly wired through (a one-line gap the review also
  caught: `overallUnknown` existed in the shared payload but `/api/ready`
  was silently dropping it).
- Excluding a never-captured portal from `overallStale` entirely (treating
  "never captured" as a non-issue) — rejected; a capture-enabled portal that
  has literally never been captured IS a real, honest "due" — matches the
  pre-existing "never succeeded is deliberately stale" precedent for crawl
  connectors. Only the HEADLINE naming changes (see above), not the
  underlying stale flag.

**Rationale**: The two surfaces (`/etl/connectors`' per-connector pill and
the TopBar dot) must never contradict each other on whether a portal is
stale — verified live, twice: once for the original bug (capture portals
invisible to the dot) and once for the B1 regression the first fix
introduced (pill and dot disagreeing on Idealista's freshness because they
read different tables). Before this fix, `GET /api/data-health` returned
`overallStale: false, stalestConnector: null` (every connector — crawl and
capture — was `enabled=false`, hitting the empty-scope green-wash path).
After this fix, the same live data returns `overallStale: true,
stalestConnector: {"connector":"altamira", ...}` — altamira's 11-day-old
capture, the real regression, correctly named ahead of hipoges (never
captured) — and `GET /api/etl/connectors` reports the identical
`fresh`/`due` verdict and `lastFreshAt` for every capture-only portal.

**See**: `dashboard/lib/db/freshness.ts`, `dashboard/lib/db/connectors.ts`
(`resolveConnectorFreshnessState`, `isCaptureOnlyForFreshness`),
`dashboard/app/api/data-health/route.ts`, `dashboard/app/api/ready/route.ts`,
`dashboard/components/FreshnessContext.tsx`, `dashboard/components/
TopBar.tsx`, `dashboard/lib/db/__tests__/freshness.integration.test.ts`,
`dashboard/lib/db/__tests__/connectors-freshness-agreement.integration.test.ts`,
`dashboard/app/api/data-health/__tests__/route.test.ts`,
`dashboard/app/api/ready/__tests__/route.test.ts`,
[D-050](D-050-connector-freshness-cadence.md),
[D-055](D-055-single-connector-toggle.md), issue #586, follow-up issue #588
(window-knob unification, deliberately not blocked on).
