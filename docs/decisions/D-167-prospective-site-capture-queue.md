---
id: D-167
title: "Prospective-site captures ride the auto-driver into extension_diagnostic, in their own queue, and never produce a 'failed'"
date: 2026-08-22
group: Data / connectors
rule: "Prospective-site captures go in `capture_spike_request` (own table, statuses pending/captured/skipped/unreachable — never `failed`) and land in `extension_diagnostic`, never `extension_capture`. Seeding refuses any host that HAS a connector. `purge_extension_diagnostics()` now runs every ETL sweep."
---

# D-167: Prospective-site captures ride the auto-driver into `extension_diagnostic`, in their own queue, and never produce a "failed"

*Decided: 2026-08-22*

**Context**: The owner, verbatim: *"una cosa que estaría bien es poder pedir a
la extensión una captura si ya está haciendo polling para el automático, poner
algo en la cola para que capture páginas ya sea de sitios soportados o nuevos
que quieres soportar"* (issue #705).

For **supported** portals this was already built and needed nothing: the queue
is `capture_worklist`, the seeding surface is the paste box on
`/admin/fuentes/<portal>`, and the auto-driver already drains it (`GET
/api/etl/auto-plan` → `planAutoUnit` → `{kind:'drain'}` → `runBatchLoop`).

For **unsupported** sites it was structurally impossible, in two places:
`isCapturePortal()`/`portalForUrl()` refuse an unknown host at seed time, and
`etl/capture.py:_connector_for_url()` returns `None` for one at ingest time and
files the page as **`failed`** with "no capture-capable connector".

That gap is the feasibility-spike workflow, which had no mechanism at all and
cost us twice in one week: diagnosing Hipoges' broken readiness selectors
needed a real rendered sample (only route: flip `ETL_RETAIN_CAPTURE_HTML_FOR`
on, restart the ETL, ask the owner to open a page by hand), and Cimenta2's
spike (#682) plus every "is this buildable" assessment behind D-019/D-021/
D-026/D-027/D-033 was ad-hoc improvisation. It also matters *because* of those
refusals: an extension capture of what the owner's own browser rendered is the
one path compatible with the WAF-protected sites we have deliberately declined
to build against (issue #1 §15). **No evasion, ever** — nothing here fetches
the candidate site.

**Decision**:

1. **Own queue table, `capture_spike_request`.** Not `capture_worklist`.
2. **The HTML lands in `extension_diagnostic`** (D-153's channel), never in
   `extension_capture`, and the extension posts it to the SAME
   `POST /api/extension/diagnostic` route the #675 manual button already uses.
   Correlation to the queue row is by the canonical `worklistMatchKey`, so no
   new payload field exists.
3. **Statuses are `pending` / `captured` / `skipped` / `unreachable`. There is
   no `failed`, and the CHECK constraint refuses one.** `unreachable` is the
   give-up state after `MAX_SPIKE_ATTEMPTS` opens that produced no page.
4. **Seeding is on `/admin/diagnostics`, and refuses any host that HAS a
   capture connector** — the exact mirror of `addWorklistUrls` refusing any
   host that hasn't. A non-empty `site_label` is also required.
5. **`spike` is a fourth auto unit, planned FIRST**, capped at
   `SPIKE_UNIT_LIMIT` per unit with the pending queue capped at
   `MAX_PENDING_SPIKE_REQUESTS`. It never passes through
   `selectNextPendingUrls`.
6. **`purge_extension_diagnostics()` is called once per `run_scheduler_loop`
   iteration**, retention from `etl.diagnostic_retention_days` (default 30).
7. **Host permission is granted from the extension POPUP**, per origin, via
   `optional_host_permissions`. The service worker only ever CHECKS. An
   ungranted origin is skipped, not failed.

**Alternatives rejected**:

- **Put spike rows in `capture_worklist` with a `kind` column.** D-156 says
  re-capture must never be "a parallel queue" and that still stands — but it is
  about the *same work on the same rows to the same destination*, where a second
  queue would be pure duplication. This is different work, no connector, a
  different store, a different terminal state. `capture_worklist` is
  load-bearing for the ingestion ledger: `listWorklist`, `listPendingWorklist`,
  the per-portal roll-ups, `getPortalCaptureActivity`, `RecapturePanel`'s cohort
  resolver, `/etl/salud`, and the boot-time `source_portal NOT IN (...)`
  cleanup would each need a `kind = 'listing'` filter, and **one missed filter
  silently corrupts the ledger or reorders the owner's ~1,700-row drain**. A
  table nothing else queries cannot do that, at the cost of one extra file.
- **A second store for prospective-site HTML.** Refused outright: that is a
  second unbounded pile of scraped third-party pages, which is what #698
  documents going wrong on `extension_capture.html`. `extension_diagnostic`
  already *is* "an arbitrary page from a site the connectors can't read, kept
  whole so a human can look at it" — browsable at `/admin/diagnostics`,
  downloadable only as `application/octet-stream` + `nosniff`, purgeable.
- **Route spike pages through `POST /api/extension/capture` and give
  `extension_capture` a `spike` status** (the literal reading of the
  #292/#692 precedent). Rejected: it would put prospective pages INTO the
  ingestion ledger — counted in per-portal capture activity, visible in
  data-health — which is exactly what constraint 1 forbids. The precedent's
  *principle* (a deliberate non-listing outcome gets its own terminal state,
  never `failed`) is honoured on the spike table instead, and the stronger
  version of it is available here: with no `extension_capture` row at all,
  there is nothing to mis-count in the first place.
- **A checkbox — "this is a new site" — on the existing worklist paste box.**
  Rejected: one deliberate act is a checkbox you leave ticked. Two mutually
  exclusive boxes, split by whether the host has a connector, make a typo'd
  idealista link refused by BOTH, which is a property of the design rather than
  of the operator's attention.
- **A new admin nav tab.** Rejected: `dashboard/e2e/admin-nav.spec.ts` pins the
  tab list exhaustively, and this is one panel of work whose *output* is the
  diagnostic list. Queue a page, see the captured page on the same screen.
- **Wire the pending set into `selectNextPendingUrls` so one ranking covers
  both.** Rejected: a spike URL has no portal, hence no due-rank, and folding it
  in would put the ordering of the owner's real drain (D-156's `requeue_rank`,
  the due-first ranking) at risk for no gain.
- **Server-side probing / a headless browser to fetch the candidate site.**
  Refused on principle (issue #1 §15). The extension reads what the owner's own
  browser rendered, or nothing happens.

**Rationale**: The valuable half of the owner's ask was the half that didn't
exist, and #675 had already built its destination — this is the queue that
feeds it. Everything else follows from one rule: a prospective-site capture
must be *invisible* to the ingestion pipeline rather than *filtered out of* it,
because invisible is a property of the schema and filtered-out is a property of
however many queries someone remembers to update.

The retention clause is not optional scope. Reusing `extension_diagnostic` is
only defensible because it is bounded; it was bounded only in principle
(`purge_extension_diagnostics()` had no caller anywhere) and this change adds
an automated writer, so wiring the purge is part of the same decision.

**See**: issue #705 (this change), #671/#675 + [D-153](D-153-force-capture-diagnostic-channel.md)
(the diagnostic channel and its purge), [D-156](D-156-recapture-requeues-worklist-rows.md)
(the "never a parallel queue" rule this does not violate),
[D-161](D-161-prod-deploy-stages-extension.md) (why the manifest bumps to
0.19.0 in the same PR), #292 / #692 (terminal states over an overloaded
`failed`), #698 (the unbounded-store counter-example), #682 and
[D-019](D-019-aliseda-not-viable-disallowed-api.md) /
[D-021](D-021-haya-merged-into-solvia.md) /
[D-026](D-026-sareb-not-viable-incapsula-block.md) /
[D-027](D-027-altamira-not-viable-akamai-block.md) /
[D-033](D-033-cimenta2-not-viable-guest-api-overexposure.md) (the spikes that
had no mechanism), #75 (the browser-extension capture route this generalises).
Files: `etl/schema/init.sql` (`capture_spike_request`),
`dashboard/lib/spike-queue.ts`, `dashboard/lib/db/spike-queue.ts`,
`dashboard/app/api/etl/spike-queue/`, `dashboard/lib/auto-plan.ts`,
`dashboard/app/admin/diagnostics/SpikeQueuePanel.tsx`,
`browser-extension/background.js` (`runAutoSpike`/`captureSpikePage`),
`etl/orchestrator.py` (`purge_old_diagnostics`).
