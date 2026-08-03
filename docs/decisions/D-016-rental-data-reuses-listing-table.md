---
id: D-016
title: Rental listings reuse listing.operation='rent' — no separate rental_listing table
date: 2026-08-03
---

# D-016: Rental listings reuse `listing.operation='rent'` — no separate `rental_listing` table

*Decided: 2026-08-03*

**Context**: Issue #31's own suggested technical approach proposed a new `rental_listing` table ("same shape as `listing` minus sale-specific fields, plus `monthly_rent NUMERIC(10,2)` instead of `current_price`"). By the time #31 was implemented, `etl/schema/init.sql` already carried `listing.operation TEXT CHECK (operation IN ('sale', 'rent'))` — added ahead of this issue (2026-08-03, same day, a different in-flight PR) with an explicit note: "Issue #31's implementer should confirm this representation still fits before ingesting rental data." Three independent pieces of evidence, found while confirming it, all point the same direction:

1. `etl/connectors/base.py`'s `CanonicalListingVersion.operation` is already `Literal["sale", "rent"] | None`, and `etl/orchestrator.py`'s upsert path already `COALESCE`s it end to end on both the INSERT and UPDATE paths — the connector framework was already built assuming rentals land in `listing`, not a parallel table.
2. `property` already carries exactly what a comparable-rent query needs (`lat`, `lon`, `property_type`, `m2_built`). A second table would either duplicate that geometry or join back to `property` anyway, for zero benefit.
3. `dashboard/lib/analytics/area-price.ts` and `dashboard/lib/investment-metrics.ts` (shipped before #31, PR #181) already filter every sale-side query with `listing.operation = 'sale'` — a defensive filter that only makes sense if the authors expected `operation = 'rent'` rows to start appearing in the SAME tables.

A live check (2026-08-03) of a real Milanuncios rental ad confirmed the site publishes rent through the identical `price.cashPrice.value` JSON field sale ads use, so `listing.current_price` (a generic "the listing's price" column, never sale-specific in the schema) holds monthly rent for an `operation='rent'` row with zero column addition.

**Decision**: Rental listings are `listing` rows with `operation = 'rent'`, linked to their own `property` row exactly like sale listings — no `rental_listing` table, no `monthly_rent` column. A rental connector (`etl/connectors/<site>_rental.py`) implements the same `Connector` contract as a sale connector and sets `operation` accordingly (directly, or — as `milanuncios_rental.py` does — by inheriting a `normalize()` that already derives `operation` from the source site's own category taxonomy, never hardcoding a value).

Every query that materializes/matches/dedupes SALE candidates must filter `operation = 'sale'` explicitly — the schema does not separate the two populations structurally, only by column value. Two such gaps existed and were silently invisible until #31 produced real `operation='rent'` rows (nothing before #31 ever inserted anything but `'sale'`), and both were found and fixed as part of landing this decision:

- `dashboard/lib/filtering/scope-query.ts`'s `buildScopeWhereClause` — the query that decides which properties materialize into `profile_listing_state` for every search profile. Its active-listing `EXISTS` and its price-band subquery both had no `operation` filter; a rental-only property (an active `operation='rent'` listing, no active `operation='sale'` one) would have passed the same "has an active listing" gate a sale candidate does and shown up as a sale candidate for every matching profile.
- `etl/dedup/engine.py`'s `fetch_listing_records` — the candidate pool for the pairwise dedup matcher. It now filters `WHERE l.operation = 'sale'`: rental listings are read in aggregate by the rent-estimate query, never resolved to a canonical `property.id` the way two sale listings for the same physical unit are (issue #31's own Context: "does not need property_id/dedup linkage at the same rigor as sale listings"), so feeding them into the pairwise matcher risked a spurious cross-operation merge on a corroborating-signal coincidence unrelated to whether a sale ad and a rental ad are "the same listing".

**Alternatives rejected**: A separate `rental_listing` table (issue #31's own original suggestion) — rejected because it would have required either duplicating `property`'s geometry columns or joining back to `property` for every query anyway, while the schema, the connector contract, and two already-shipped consumer queries had already converged on the `operation` column as the intended discriminator before this issue was implemented.

**Rationale**: Reusing `property`/`listing` means the comparable-rent query is structurally identical to the already-proven `area-price.ts` sale-comparable query (same bounding-box-before-Haversine prefilter, same `idx_property_lat_lon` index) rather than a second, differently-shaped query against a second table. The cost is that every consumer of `property`/`listing` must now be operation-aware — paid once, at the two call sites above, rather than repeatedly across every future query that touches these tables.

**See**: `dashboard/lib/analytics/rent-estimate.ts` (module docstring has the full reasoning), `dashboard/lib/filtering/scope-query.ts`, `etl/dedup/engine.py`, `etl/connectors/milanuncios_rental.py`, `etl/schema/init.sql`'s `listing.operation` column comment, issue #31, issue #76 (the original schema-superset issue that added `operation`).
