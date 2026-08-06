---
id: D-055
title: One connector toggle; a disabled source is hidden from the feed
date: 2026-08-05
group: Data / connectors
rule: 'ONE Activar/Desactivar toggle per connector: normal → `enabled`, capture-only → `capture_enabled` (crawl flag hidden; "solo captura" is a badge, not a mode). Disabled reads neutral. A disabled source is HIDDEN from the candidate feed (cards/badges/price/photos/counts/filter) via the shared `disabled_sources` CTE (`lib/db/source-active.ts`); missing registry/config row = active.'
order: 56
---

# D-055: One connector toggle; a disabled source is hidden from the feed

*Decided: 2026-08-05*

**Context**: The connectors UI (issues #100/#263/#276/#278) had grown two
independent on/off controls per connector — the crawl `enabled` flag and the
capture-processing `capture_enabled` flag. For a capture-only portal (idealista,
aliseda, altamira, cimenta2) both were shown, so the operator saw two toggles
whose interaction was non-obvious ("captura activa" while "desactivado", etc.).
Separately, disabling a connector only stopped future ingestion; its already-
stored listings kept appearing in the candidate feed, so "turning a portal off"
didn't visibly remove that portal's data.

**Decision**:
1. **One toggle per connector.** The connectors page shows a single
   Activar/Desactivar control per connector and one Activo/Desactivado status.
   - Normal (crawl) connectors (`supports_discovery = true`): the toggle writes
     `connector_config.enabled`.
   - Capture-only connectors (`supports_discovery = false`): the toggle writes
     `connector_config.capture_enabled`. The crawl `enabled` flag is never shown
     or toggled (its automated crawl is WAF-blocked and never runs). "Solo
     captura" is a descriptive badge, not a mode the user switches. If a
     capture-only portal ever gains a working crawl, change its *type* in the
     Python registry (`supports_discovery`), not a user toggle.
   - A disabled connector reads as **neutral** (not error/red) in every status.
2. **A disabled source is hidden from the candidate feed.** A listing whose
   source connector is currently OFF does not appear as a card, source badge,
   price, photo, staleness, or in the source-filter options/counts. "OFF" =
   `enabled = false` for a normal connector, `capture_enabled = false` for a
   capture-only one. `listing.source` equals `connector_registry.connector_name`
   for every portal, which is what lets the feed resolve a listing to its
   connector's state. A source with no registry/config row defaults to active
   (matching the ETL's missing-row defaults). Implemented as a shared
   `disabled_sources` CTE (`dashboard/lib/db/source-active.ts`) filtered into
   every listing subquery of `listCandidates` / `listCandidateSources`, and a
   main-WHERE requirement that a candidate have at least one active-sale listing
   from an enabled source.

**Scope — what "the feed" means**: the rule applies to every surface that is
the *profile candidate feed*, which today is BOTH:
- the list view (`lib/candidates.ts` — `listCandidates`, `listCandidateSources`), and
- the map view (`lib/map-candidates.ts` — `listMapCandidates`, including its
  plottable/unplottable counts). The map is the same feed rendered as pins, so
  it hides disabled-source pins/badges/prices/counts identically.

It deliberately does NOT apply to **property-detail** surfaces:
`getPropertyDetail` (`lib/property-detail.ts`) and `getAdjacentCandidates`
(`lib/candidates.ts`) are out of feed scope — once a user has drilled into a
specific property, its full listing history (including from a now-disabled
source) is legitimate context, and prev/next navigation is anchored on the
`profile_listing_state` ranking, not on which sources are currently on. If a
future surface becomes a "feed", apply `DISABLED_SOURCES_CTE` there too.

**Alternatives rejected**:
- *Keep two toggles.* The whole point of the owner's ask was to remove the
  confusion; a capture-only connector has exactly one meaningful lever.
- *Disable = stop ingesting only (leave stored data visible).* Rejected by the
  owner explicitly: turning a portal off should remove its data from view, not
  just freeze it.
- *Per-row source-active resolution.* Rejected for efficiency — the CTE resolves
  every portal's state once and the `NOT IN` anti-join hashes against that tiny
  set, rather than re-checking config per candidate row.

**Rationale**: One lever matches the operator's mental model ("is this portal
on?"). Hiding disabled-source data makes the toggle's effect immediate and
visible, and the shared CTE keeps the "is this source active?" rule in one place
for the feed, the source filter, and any future consumer (e.g. data-health).

**See**: `dashboard/lib/db/source-active.ts`,
`dashboard/lib/candidates.ts`, `dashboard/lib/map-candidates.ts`,
`dashboard/components/connectors/ConnectorCard.tsx`,
`dashboard/app/etl/connectors/page.tsx`, issue #319 (owner "Spec afinada"),
D-047/#263 (the capture toggle this supersedes for capture-only connectors).
Data-health neutral-for-disabled (#304) is a deferred follow-up.
