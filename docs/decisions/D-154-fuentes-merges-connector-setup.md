---
id: D-154
title: Fuentes merges connector config + capture worklist; supersedes D-045's setup location
date: 2026-08-21
group: Plumbing / process
rule: "/admin/fuentes (list) + /admin/fuentes/[name] (detail) merge /etl/connectors + /etl/captura (301s); Fuentes detail also absorbs per-source quality (D-084/D-086), zero-result regressions (D-092), and drift (D-090/D-093) that used to live on /etl/salud (deleted by P2, D-168). Supersedes D-045's location clause only ('setup stays under /etl/*') — the execution (/captura) vs. setup split itself is untouched."
---

# D-154: Fuentes merges connector config + capture worklist; supersedes D-045's setup location

*Decided: 2026-08-21*

**"(unchanged, P2)" no longer holds (2026-08-22),
[D-168](D-168-admin-six-sections-etl-tree-deleted.md)**: P1 left `/etl/salud`
standing and re-displayed its sections on Fuentes; P2 deleted it, along with
the rest of the `/etl` tree. The rule above is amended accordingly — Fuentes
is the only per-source home for quality/zero-results/drift now, and the
fleet-wide rollups moved to Estado. Everything else here stands.

**Context**: Issue #642 P1, part of #636's admin-IA deletion pass. The owner's
standing complaint ("quiero que unifiques y elimines, no que solo añadas
más.") required this phase to end with fewer routes than it started with, not
just a new one. Per #636's disposition table, `/etl/connectors` (connector
config: enable/disable, freshness cadence, geography override, native
filters, run-now) and `/etl/captura` (the capture worklist ledger: per-portal
progress, paste-seeding, status filter, skip/reactivate) both answer the same
underlying question — "what is this one source doing and how do I control
it" — split across two pages purely because they were built at different
times. D-045 (2026-08-05) had already drawn a line between guided-capture
EXECUTION (`/captura`, top-level, day-to-day) and SETUP (`/etl/*`, admin,
occasional) — that split is sound and untouched. What D-045 got wrong in
hindsight is *where* setup lives: it assumed `/etl/*` was the permanent admin
home, which #636's broader IA redesign (Estado / Fuentes / Actividad /
Revisión / LLM / Configuración) retires in favor of `/admin/*`.

**Decision**:
1. **`/admin/fuentes`** (list) + **`/admin/fuentes/[name]`** (detail) replace
   `/etl/connectors` and `/etl/captura` — implemented as ONE route,
   `app/admin/fuentes/[[...name]]/page.tsx` (an optional catch-all), not two
   separate page files. Two old routes merging into two NEW routes would net
   ZERO on the route count this phase is required to shrink; one catch-all
   route dispatching on whether a `name` segment is present (`<FuentesList>`
   vs. `<FuenteDetail>`, both defined in the same file) is a genuine
   route-table reduction. The list stays lean (identity, active/inactive,
   one-line last-run, a status dot reusing D-144's `lib/source-health.ts`
   derivation — never a second computation) and links to the detail page;
   every control (the `ConnectorCard` component, unchanged, now starting
   expanded since a single-source page has nothing left to collapse behind;
   the worklist ledger, portal-scoped implicitly by the route param instead
   of a query param) lives on the detail page.
2. **Both old routes are deleted outright — no `page.tsx`, so no route-table
   entry — and 301 via `next.config.js`'s `redirects()`**, a real wire-level
   301 + `Location` header. Page-level `permanentRedirect()` (the
   `/admin/usage/page.tsx` pattern — a client-side, RSC-streamed redirect,
   not a real 308 on the wire) would have been *acceptable* here, since both
   are browser-only surfaces nothing server-side depends on — but a stub
   page.tsx still counts as a route in `next build`'s table, and this phase
   is required to end with FEWER routes than it started with (the owner's
   standing complaint: "solo has añadido, no has eliminado nada"). A
   config-level redirect needs no page.tsx at all, so both routes are
   genuinely gone, not just off the nav strip. (`/etl/salud`'s planned P2
   redirect is different in kind regardless of this choice: the installed
   browser extension's notification handler opens it directly and needs a
   redirect that fires without a browser navigation event — config-level or
   route-handler both qualify, page-level does not.) `/etl/captura`'s
   `?portal=` query param maps onto the new route's `[name]` segment via a
   `has` query-match capture; the FULL original query string (`?status=`,
   and `?portal=` itself — Next forwards it verbatim, capturing a param
   doesn't drop it) is appended to the destination too — verified with curl:
   `/etl/captura?portal=aliseda&status=pending` → 308 →
   `/admin/fuentes/aliseda?portal=aliseda&status=pending`. Harmless (nothing
   downstream reads the redundant `portal=`) but worth knowing before writing
   a test that asserts an exact destination query string.
3. **Fuentes detail also absorbs, from `/etl/salud`** (read-only, filtered to
   one source; `/etl/salud` itself is untouched — that deletion is P2):
   última ejecución (already on `ConnectorCard`), capture status
   (`extension_capture`-derived portal health — never `capture_task_run`,
   D-048), quality (D-084/D-086), zero-result regressions (D-092), and drift
   (D-090/D-093). Nothing is recomputed — every section reads the exact same
   `/api/etl/data-health` / `/api/etl/drift-reports` responses `/etl/salud`
   already reads, just filtered client-side to one source.
4. **D-045 is superseded in its location clause only.** "SETUP stays under
   `/etl/*`" is no longer true — setup lives at `/admin/fuentes/[name]` now.
   D-045's actual decision — EXECUTION is the top-level `/captura` page,
   SETUP is a separate, admin-gated surface that `/captura` composes against
   (`GET /api/etl/worklist`, connector config) and cross-links to rather than
   duplicating — is unchanged; only the setup surface's own address moved.

**Alternatives rejected**:
- *Two separate route files (`app/admin/fuentes/page.tsx` +
  `app/admin/fuentes/[name]/page.tsx`), mirroring the two old pages 1:1.*
  Rejected once the route-count arithmetic was checked against a real
  `next build` (measured: before this PR, `/admin/*` + `/etl/*` = 13 page
  routes; two-file Fuentes → 15, a net INCREASE; one catch-all route → 12, a
  net decrease of 1 — matching the whole-app page-route count, 27 → 26). The
  owner's constraint is explicit and numeric, not just directional — a
  same-count merge still repeats "solo has añadido, no has eliminado nada"
  in a subtler shape, so the one-file shape isn't a style preference, it's
  what makes the constraint measurably true.
- *Keep full `ConnectorCard` config on the Fuentes LIST, not just identity.*
  Rejected per the #636 verdict's own framing: "`ConnectorCard` prose
  collapses behind a disclosure" — repeating every connector's full
  scope/freshness/rooms detail on the list is exactly the "wall of
  cards/prose" pattern this redesign exists to remove. One tap to the detail
  page is cheap; a skimmable list is not, once every card is fully expanded.
- *Retire D-045 outright and write a fresh replacement.* Rejected — most of
  D-045 (the execution/setup split, composition-not-reimplementation,
  surfacing loosened pre-filter flags) is still exactly correct. Retiring it
  would lose that reasoning for no gain; a location supersession is the
  narrower, honest fix.

**Rationale**: One page per source is the natural unit an operator thinks in
("what is aliseda doing") — the old split forced two separate lookups
(config on one page, capture progress on another) for what is, from the
owner's side, one question. Reusing `lib/source-health.ts` (D-144) and the
data-health/drift API responses verbatim (rather than adding a parallel
per-source aggregation) is deliberate: two surfaces computing "is this source
healthy" from different inputs is the exact failure mode #590 already
produced twice.

**See**: issue #642 (P1), #636 (tracking issue, `/etl/connectors` +
`/etl/captura` → Fuentes disposition rows); D-045 (execution-top-level,
superseded in its location clause); D-144 (Estado board's `lib/source-health.ts`
derivation, reused here rather than recomputed); D-084/D-086 (quality);
D-092 (zero-result regressions); D-090/D-093 (drift); D-048 (task-driven
Captura, the "never `capture_task_run` for coverage" rule this also follows);
`dashboard/app/admin/fuentes/[[...name]]/page.tsx` (one file, one route —
`FuentesList`/`FuenteDetail` dispatched on the optional catch-all segment),
`dashboard/next.config.js` (`redirects()` — `/etl/connectors` and
`/etl/captura` deleted outright, no page.tsx left behind),
`dashboard/components/connectors/ConnectorCard.tsx` (unchanged, now also used
with `defaultExpanded`).
