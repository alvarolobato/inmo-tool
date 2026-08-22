---
id: D-168
title: The admin is six sections and the /etl tree does not exist; every retired path is a wire-level 308, never a redirect stub
date: 2026-08-22
group: Frontend / UI
rule: 'Admin strip = Estado/Fuentes/Actividad/Revisión/LLM/Configuración, nothing else. No page under /etl; retired paths 308 from next.config.js redirects(), never a page-level redirect stub. A capability moves or is retired in writing — never by omission.'
---

# D-168: The admin is six sections and the `/etl` tree does not exist; every retired path is a wire-level 308, never a redirect stub

*Decided: 2026-08-22*

**Context**: Issue #642 Phase 2, the last piece of #636's admin redesign. The
owner's complaint that started the whole tracker was not "the admin is
missing something" — it was *"has hecho un rediseño de la administración pero
solo has añadido, no has eliminado nada… quiero que unifiques y elimines no que
solo añadas más"*. #653 (Fase 0) and #642 P1 deleted seven routes between them;
the four `/etl` pages survived because their content had nowhere to go. By the
time P2 started, Estado (#638/#640/#702), Fuentes (#676) and Actividad
(#644/#706) existed, so the destinations finally did.

A fresh reviewer audited both P1 authors' hand-off lists against `main` and
produced a consolidated set of six items that still had no home. Two of the
entries corrected earlier claims that were wrong — #702's hand-off said
Fuentes did not cover D-092's zero-result list, and a re-read showed it does.
That is the reason this decision's operative rule is about *writing the
disposition down*, not about any particular placement: on this tracker, the
recurring failure mode has been a capability disappearing because a hand-off
note asserted coverage nobody re-checked.

Route count, from two real `next build` runs (the only measurement that
counts — `docker-build` does not build the dashboard image, #570):
**`/admin/*` + `/etl/*` = 14 page routes before, 12 after.** P1's own
measurement was 13 → 12; the two added back since were `/admin/actividad`
(#706) and `/admin/diagnostics` (#671).

**Decision**:

1. **The admin strip is exactly six sections**, in this order: Estado
   (`/admin`) · Fuentes (`/admin/fuentes`) · Actividad (`/admin/actividad`) ·
   Revisión (`/admin/dedup`) · LLM (`/admin/llm`) · Configuración
   (`/admin/config`). `lib/admin-nav.ts` is the only source;
   `e2e/admin-nav.spec.ts` asserts the rendered list exhaustively.
   - Estado is ADDED — it had been the landing since #638 with no tab of its
     own, so the one surface login sends you to was the one with no way back.
   - Revisión GROUPS Duplicados + Clasificación under one tab, with
     `<RevisionTabs/>` on both pages. A grouping, not a new route: a "Revisión"
     index page listing two links would be a third route to reach two that
     already exist.
   - `/admin/diagnostics` (#671) and `/admin/extension` are off-strip, owned by
     Fuentes through `matchPrefixes`. Both are deep-link targets for
     capture-source tooling; a tab each is the sprawl this issue undoes.

2. **No page exists under `/etl`.** `app/etl/` is deleted in full. The six
   retired paths redirect from `next.config.js`'s `redirects()`:
   `/etl` → `/admin/actividad`, `/etl/salud` → `/admin`, `/etl/extension` →
   `/admin/extension`, `/etl/:id(\d+)` → `/admin/actividad/run/:id`, plus P1's
   `/etl/connectors` and `/etl/captura` → Fuentes.

3. **Redirects are config-level, never page-level stubs.** Two independent
   reasons, and either alone is sufficient:
   - A `page.tsx` calling `permanentRedirect()` still counts as a route in
     `next build`'s table. Replacing four pages with four stubs deletes
     nothing and repeats the complaint in a subtler shape.
   - `permanentRedirect()` is not a redirect on the wire. Next streams it as
     an RSC instruction inside a **200 with no `Location`**; the navigation
     happens client-side after hydration. `/etl/salud` cannot rely on that: an
     already-installed browser extension opens it from
     `chrome.notifications.onClicked`, and an extension only picks up a
     repointed URL when the owner reloads the packaged zip (D-060). The
     `/etl/salud` → `/admin` 308 is therefore **permanent, indefinitely**.
   `/admin/usage` is converted on the same grounds even though it is not part
   of the `/etl` tree and was #653's, not this phase's (PR #710 review). It was
   the last page-level `permanentRedirect()` stub in the app — the exact
   counter-example to this rule, sitting inside the route table this rule is
   about. `app/admin/usage/page.tsx` is deleted and the redirect declared in
   `next.config.js` with the rest. Its `matchPrefixes` entry on the LLM tab
   goes with it: a wire-level 308 means no browser is ever ON `/admin/usage`
   at render time, so `href` alone lights the tab and a prefix for an
   unreachable path reads as a surviving route.

   Verified with `curl -sI` against `next start`, not by reading the config —
   this repo has been fooled by the 200-vs-308 distinction before (#656).

   One footnote on the "an unmatched `/etl/*` path 404s" claim, because it is
   only half true (PR #710 review): it holds AUTHENTICATED. Unauthenticated,
   `/etl/nonsense` is a `307` to `/admin/login?redirect=/etl/nonsense`. Both
   are correct, and the pair is the routing order itself — `next.config`'s
   `redirects()` run BEFORE middleware, so a retired path 308s for everyone
   (including the installed extension, which carries no session), while a path
   matching no rule falls through to middleware's catch-all gate and is asked
   to log in. Worth writing down: a future "is `/etl/x` really gone" check run
   without a session will see a 307 and must not read it as a surviving page.

4. **A capability moves, or it is retired in writing.** Every item on the
   reviewer's list is answered explicitly in the PR body, placed or retired
   with an argument. Nothing is deleted on the grounds that "something else
   probably covers it".

5. **Where a fact appears more than once, the surfaces divide by JOB, not by
   convenience.** Estado = what is true now. Fuentes/<name> = one source in
   depth. Actividad = what happened, when. Applied to the one duplication this
   phase inherited (the last run's outcome appearing on the Fuentes list, the
   Fuentes detail card AND Actividad's newest `crawl` row): the **Fuentes list
   row drops it** and shows derived freshness instead. #636's verdict decides
   which copy is wrong — run outcome is the *explanation*, never the headline,
   and it is structurally blind to browser-captured portals, which produce no
   run at all.

6. **Off-strip is not off-navigation.** A `matchPrefixes` entry HIGHLIGHTS a
   tab; it never renders a link. So moving a page off the strip and handing it
   to `matchPrefixes` deletes it by omission unless something else anchors it —
   which is exactly what the first cut of this phase did to `/admin/diagnostics`
   (#671): its only remaining mentions in the tree were the nav array and an
   e2e that reached it with `goto`, and #671 is not even in #642's disposition
   table, so it would have been an unratified nav deletion riding along. Both
   off-strip targets now carry a real anchor on Fuentes — `/admin/extension`
   from `<ExtensionCta/>`, `/admin/diagnostics` from the list header's
   "Diagnósticos →" — and two tests hold the line: a source-level guard in
   `lib/__tests__/admin-nav.test.ts` (every off-strip prefix is linked from
   somewhere outside the nav definition) and an e2e that reaches Diagnósticos
   by CLICKING. A highlight test cannot catch an orphan, because it types the
   URL itself.

7. **Fleet-wide quality keeps a chip, not a status colour.** "Calidad por
   fuente" (D-084/D-086) moved to `/admin/fuentes/<name>` per the disposition
   table, which left queue depth with a list chip and extraction quality with
   nothing: a source drifting to 0.2 fotos/anuncio still showed a green
   *fresco* dot on Estado and on the list, and the only way to notice was
   opening every source in turn. That asymmetry is not what the table decided,
   it is a gap the move opened, so quality gets a symmetric chip on the Fuentes
   list — rendered only below `LOW_PHOTO_THRESHOLD`, same quiet-when-clean rule
   as the queue chip.

   It is deliberately NOT folded into the status dot. `deriveSourceStatus`
   (`lib/source-health.ts`) answers exactly one question — how recently did
   this source produce data — and Estado and the Fuentes list render its answer
   from the same derivation, on purpose (one status vocabulary, one set of
   colours). A dot meaning "stale OR low-quality" cannot be read back into
   either, and would put that shared vocabulary in play across two boards to
   express a second, independent axis. A chip sits beside the dot and reads on
   its own.

**Alternatives rejected**:

- *Keep `/etl` as a thin redirect stub tree.* Rejected on both counts in (3).
- *Leave `/admin/usage`'s stub alone because it predates this phase.* True but
  beside the point: it is one `next.config.js` entry and one deleted file, it
  is the only remaining instance of the pattern (3) rejects, and shipping a
  rule with a live counter-example inside its own scope invites the next
  reader to treat the rule as aspirational.
- *Put "Ejecutar todo ahora" on Estado.* Estado is a read-only diagnosis, and
  Actividad's own rule is that it carries no controls. The global sweep went to
  the Fuentes **list** header — the all-sources view of exactly the control
  each source's detail page carries for one source.
- *Rebuild `EvolutionCharts` somewhere.* Five charts, three of which had no
  named home. Charts 1 and 3 (duration trend, slowest connectors) go to #647,
  which needs per-source throughput anyway and will build its own reads — so
  their aggregates were deleted from `/api/etl/stats` with them (**seven**
  aggregates → three — `duration_trend`, `listings_trend`,
  `connector_durations`, `top_connectors_by_listings`; the endpoint is not a
  parking lot). Charts 2, 4 and 5 are retired:
  chart 5's three counts are rendered as text in Estado's Rastreo tile (three
  numbers do not need a donut), chart 4 is per-connector fetched counts for the
  latest run, which Actividad renders per row, dated and uncapped; and chart
  2's signal — the widening encontrados-vs-guardados gap — survives as the
  download-rate tile plus, decomposed per source, Actividad's own crawl rows.
  Stated precisely, because the shorthand "the aggregate survives" is wrong:
  what survives is the funnel as `last_run`'s point-in-time counts; the 30-run
  SERIES `listings_trend` carried does not survive anywhere, and Actividad's
  per-connector rows are its replacement. A fleet-wide aggregate line hides
  *which* source moved, the exact blindness #636 rejected.
- *A per-source block-episode history on Fuentes.* Actividad already renders
  `bloqueo` rows. Fuentes gets the ACTIVE block only — the state, because that
  is where the paused queue is and where the operator acts. #706 had nulled the
  `bloqueo` drill-through rather than point at a page that rendered nothing
  about blocks; P2 gives it something to land on and restores the link.

**Rationale**: The six-section list and the deletions are the issue's own exit
criteria; what needed deciding was the *method*. Two rules do the work. The
config-level redirect rule makes "deleted" mean deleted in the route table and
on the wire at the same time, which is the only definition that satisfies both
the owner's complaint and the installed extension. The divide-by-job rule gives
a repeatable answer to "which copy do we drop", so the next surface that
duplicates a fact does not need another judgement call.

**See**: issue #642 (P2), #636 (tracker); D-154 (P1, Fuentes merge — this
supersedes nothing in it, it completes it); D-166 (Actividad's vocabulary);
D-060 (extension updates only on a manual zip reload); D-047 (clean-stop vs.
error, whose rendering moved onto `ConnectorCard`); D-045 / D-092 / D-093
(location clauses superseded, semantics untouched — see each file's note).
Files: `dashboard/next.config.js`, `dashboard/lib/admin-nav.ts`,
`dashboard/app/admin/fuentes/[[...name]]/page.tsx`,
`dashboard/lib/db/extension-blocks.ts`,
`dashboard/app/admin/page.tsx`, `dashboard/components/estado/AvisoBand.tsx`,
`dashboard/components/estado/CrawlRollup.tsx`,
`dashboard/components/admin/RevisionTabs.tsx`,
`dashboard/app/admin/actividad/run/[id]/page.tsx`,
`dashboard/app/admin/extension/page.tsx`, `browser-extension/background.js`.
