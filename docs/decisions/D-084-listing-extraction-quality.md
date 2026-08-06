---
id: D-084
title: Per-listing extraction-quality grade in raw_extra, best-across-listings on the property header
date: 2026-08-06
---

# D-084: Per-listing extraction-quality grade

*Decided: 2026-08-06*

**Context**: Issue #80. A property with `m2_built = NULL` looks identical in
the dashboard whether the source genuinely never published that field or a
connector's parser silently failed on a renamed key. There was no way for the
owner to tell "genuinely thin listing" apart from "our connector
under-extracted this one". `property_web_scraper`'s Chrome-extension pipeline
already computes a *weighted* completeness grade per extraction
(`quality-scorer.ts` `assessQualityWeighted`/`getFieldImportance`, surfaced as
an A/B/C/F popup badge) — the one genuinely transferable idea from that repo
(its Astro app and anonymous "haul" collections are not, see the issue). We
adopt the **concept** (weighted, not a flat extracted/total ratio), not their
TypeScript.

**Decision**:
- **Score is computed at normalize/persist time, connector-agnostically**, in
  `etl/extraction_quality.py` (`compute_extraction_quality`), from the
  **canonical** fields only (`CanonicalListingVersion`) — never from any
  site's raw HTML, never per-connector. The orchestrator calls it in the
  single persist path (`_raw_extra_with_quality`, used by both the INSERT and
  UPDATE branches of `_upsert_canonical_listing`), so every connector inherits
  the signal for free.
- **Weighted, not flat.** Core investment fields weigh more than secondary
  ones: `current_price`/location(lat+lon or address)/`m2_built` = 3,
  `property_type`/`rooms`/photos = 2, `description`/`bathrooms`/
  `energy_rating` = 1. Two listings missing the *same number* of fields but a
  *different which* therefore grade differently — the whole point. Bands on
  the weighted fraction: A ≥ 0.85, B ≥ 0.65, C ≥ 0.45, else F. `WEIGHTS_VERSION`
  is stamped so a stored score can be told apart from one scored under a later
  rubric.
- **Stored in `listing.raw_extra.extraction_quality`** (`{grade, score,
  populated_fields, total_fields, weights_version}`) — a JSONB key, **not a
  first-class column**, matching this project's "unmapped data goes in
  `raw_extra`" convention. Promote to a real column later only if it proves
  worth querying/filtering on directly.
- **No migration/backfill.** Existing rows self-heal on their next fetch (the
  UPDATE path recomputes and rewrites `raw_extra` every re-visit). An absent
  descriptor renders no badge rather than a placeholder grade.
- **Dashboard reads, never recomputes.** `lib/extraction-quality.ts`
  (`parseExtractionQuality`, `bestExtractionQuality`) narrows the stored JSON
  and aggregates across a property's listings. The property header shows the
  **best** (highest-score) grade across its listings, because a deduped
  property's header renders the COALESCE-union of every source's fields — it
  is only as under-extracted as its *best* source; flagging low when one rich
  source exists would mislead. Surfaced as a small badge in
  `PropertyHeader.tsx` (`ExtractionQualityBadge`), tone escalating for C/F,
  mirroring `StalenessBadge`'s token treatment.

**Alternatives rejected**:
- *A new `listing.extraction_quality_grade` column now.* Rejected per the
  issue: start in `raw_extra`, promote only if querying/filtering on it earns
  the schema change and index.
- *Recompute the grade in the dashboard (SQL or TS).* Rejected: it would
  duplicate the weighting rubric and let the displayed grade drift from what
  the ETL stored. The ETL is the single source of truth; the dashboard reads
  the stored value verbatim.
- *A SQL one-time backfill of the grade for existing rows.* Rejected: it would
  be a second implementation of the weighting formula (divergence risk) for a
  signal that self-heals within one ETL cycle anyway.
- *Show the worst / average grade across a deduped property's listings.*
  Rejected: see "best" rationale above.
- *Port their FieldTrace / per-strategy diagnostics + a separate diagnostics
  page.* Out of scope (issue AC 3): no new page, no multi-tenant/"haul"
  concept, no new UI framework.

**See**: issue #80, `etl/extraction_quality.py`, `etl/orchestrator.py`
(`_raw_extra_with_quality`), `dashboard/lib/extraction-quality.ts`,
`dashboard/components/property/ExtractionQualityBadge.tsx`, D-039 (staleness
badge, same header + token pattern), D-041/#355 (per-RUN
`connector_run_results` classification — a different table, deliberately not
touched here).
