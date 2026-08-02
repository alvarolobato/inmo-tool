# Data model — canonical real-estate schema

> Implements issue #1 §5 (canonical data model sketch). This document is the durable reference for what each table is, why it exists, and — for the two decisions that came out of a review round rather than the first draft — why it's shaped the way it is. See [`docs/decisions/D-005-numeric-vs-uuid-keys.md`](../decisions/D-005-numeric-vs-uuid-keys.md) for the primary-key strategy.

## Entity overview

```
property ──1───N── listing ──1───N── listing_price_history
   │                  │
   │                  ├──1───N── listing_status_event
   │                  │
   │                  └──N───N── owner_identity   (via listing_owner_identity)
   │
   ├──N───N── search_profile   (via profile_listing_state)
   │
   ├──1───N── feedback_event
   │
   └──1───N── property_merge_log

listing ──1───N── ai_assessment
```

## Core entities

### `property`
The physical real-world asset — one row per real-world unit, once deduplicated. Holds everything that's a fact about the building/unit itself rather than about a specific site's listing of it: `cadastral_ref` (nullable — rarely populated in practice, see the Deduplication note below), address, coordinates, type, size, rooms, floor, elevator, year built, energy rating.

**Every listing gets its own `property` row at ingest time — there is no nullable "pending dedup" state.** A brand-new, never-before-seen listing creates a brand-new singleton `property` row immediately. Deduplication (Phase 2, issue #16) doesn't *fill in* a property reference that started empty; it *reassigns* `listing.property_id` to point at an existing property (or effectively unions two properties) once it determines two listings describe the same real-world unit. This matters for two reasons:
1. It means `listing.property_id` can be `NOT NULL` — simpler queries everywhere downstream, no "has this been deduplicated yet" branch in application code.
2. It makes the merge operation itself well-defined: reassigning a foreign key on the losing side's listings, rather than inventing a "first-listing-wins, others attach" special case.

### `listing`
One row per (source site, external listing ID) — a specific site's advertisement of a property. Carries everything that's specific to *this listing* rather than the underlying property: source, external ID, URL, listing kind (particular/agency), status, price, description, photos, raw contact info, and `raw_extra jsonb` for anything a connector captures that doesn't have a first-class column yet (so normalization gaps don't silently drop data — see issue #12).

`UNIQUE (source, external_id)` is the natural key a connector's `discover`/`fetch_detail` cycle upserts against.

### `listing_price_history` / `listing_status_event`
Append-only event logs. Every observed price is a new row (not an overwrite) so a chart of "price over time" and a "days since last price drop" computation are both just a `SELECT ... ORDER BY observed_at`, no reconstruction from diffs needed. Same for status transitions (active → reserved/sold/withdrawn/expired, and relistings) — issue #1 §10's "withdrawn and relisted at a lower price" pattern is a query over this table, not a bespoke tracked flag.

### `owner_identity` / `listing_owner_identity`
Best-effort seller/agent identity, used as a deduplication signal (phone number extracted from free-text descriptions, agency name) and kept many-to-many with `listing` because the same identity can appear on listings that haven't been matched to the same property yet (that's exactly what the dedup engine uses it to detect).

**Retention default** (resolves the open question in issue #1 §17): an `owner_identity` row is retained only while linked to at least one `listing` with `status = 'active'`. Once `last_linked_active_at` falls outside a 90-day window with no active listing referencing it, a scheduled job should purge/anonymize the row (null out `phone`/`name_normalized`/`agency_name`, keep the opaque `id` so historical `property_merge_log` rows referencing it don't dangle). The purge query is documented as a comment directly above the table in `etl/schema/init.sql`; the job that runs it on a schedule is Phase 1.3's responsibility (issue #11), not this task's — this task only guarantees the schema and query shape exist. 90 days is a default the owner can override; it is not hardcoded anywhere else.

## Search profiles and scoring

### `search_profile`
A named investment thesis/mandate — "high-yield low-cost rental," "commercial units," etc. `scope` (geography/type/price/size filters) and `thesis_params` (yield targets, financing assumptions) are `jsonb`, validated at the application layer rather than via Postgres `CHECK` constraints, because their shape will grow across phases (Phase 2 adds scope filtering, Phase 5 adds financing params) and a rigid DB-level schema would mean a migration for every new filter type.

### `profile_listing_state` — the load-bearing table for correct deduplication

```sql
PRIMARY KEY (profile_id, property_id)
```

**Keyed on `property_id`, not `listing_id`.** This is the single most important design decision in this schema, and it exists because of a mistake caught during review before any code was written against it:

An earlier draft of this table (and of `feedback_event`) keyed scoring/feedback/pipeline-stage state on `listing_id`. That looks reasonable in isolation — a listing is what the user actually sees and reacts to. But once deduplication (issue #16) matches two listings from *different sites* to the same real-world property, a `listing_id`-keyed table gives that one property **two independent state rows per profile** — one per site. Concretely: an investor rejects a property after seeing it on Idealista; the Fotocasa listing of the *exact same property*, now merged to the same `property_id`, would sit in the candidate feed as if nothing had happened, because its `listing_id` never got a rejection recorded against it. This doesn't just create visual duplicate clutter (which would be bad enough) — it silently defeats deduplication's entire purpose, which issue #1 §6 states plainly: preventing the same property from earning independent, possibly contradictory scores.

Keying on `property_id` instead means: no matter how many site listings a property accumulates, or in what order dedup discovers they're the same thing, there is exactly one score, one pipeline stage, one feedback history, per `(profile, property)` pair — enforced by the primary key itself, not by application discipline that could drift.

The corollary this creates for merge-time behavior (Phase 2, issue #16): when dedup reassigns a listing's `property_id` onto an existing property that *already* has its own `profile_listing_state`/`feedback_event` history for some profile, that history has to be reconciled (union feedback, keep the more-advanced pipeline stage, flag genuine conflicts for human review) rather than either side's state being silently dropped or overwritten. That reconciliation logic belongs to issue #16, not this task — this task only guarantees the schema shape makes the *correct* end state representable.

### `feedback_event`
Same keying logic as above: `property_id NOT NULL` is what identifies what the feedback is about. `listing_id` is kept too, but only as an optional "which specific site listing was the user actually looking at" audit/debugging detail — it is never used to determine what the feedback applies to, and a `NULL` there (e.g. feedback given from an aggregate/comparison view rather than a single listing's detail page) is fine.

Append-only — a correction or changed mind is a new row (`feedback_type = 'correction'` or a fresh `accept`/`reject`), never an `UPDATE` of a prior event. The full history is what a future scoring-model retrain (Phase 3) or an audit of "why did the tool think this was a good match three weeks ago" needs.

## AI assessments

### `ai_assessment`
One row per `(listing_id, assessment_type, prompt_version)` — a new prompt or model version produces a *new* row rather than overwriting the old one, so a regression in AI output quality after a prompt change is visible in the data (compare old vs. new assessment for the same listing) rather than silently replacing history. Deliberately keyed on `listing_id`, not `property_id`: an assessment is about a specific listing's *published content* (its particular description text, its particular photos) — two listings of the same deduplicated property can have different descriptions and legitimately different AI reads (one might mention "se vende ocupada," the other might not).

This task only creates the table. Generating assessments is Phase 4 (issues #24–30).

## Deduplication audit trail

### `property_merge_log`
Every automatic merge is recorded here: which property survived, which listings were folded into it, on what basis (`cadastral`/`address_coords`/`phone`/`photo_hash`/`fuzzy`), at what confidence, and — if an operator later decides the merge was wrong — when it was reverted. `match_basis` includes `cadastral` for completeness even though issue #16 (after owner feedback — see #42, closed) treats cadastral-reference matching as a rare opportunistic check rather than something with a dedicated lookup connector; the column doesn't assume otherwise, it just records whatever basis actually fired.

This task only creates the table. The matching engine that writes to it is Phase 2 (issue #16).

## Deliberately deferred

- **Geo query support** (radius/polygon search for a profile's scope filter): `property.lat`/`lon` are plain `NUMERIC(9,6)` columns for now — enough to *store* coordinates. Whether filtering needs PostgreSQL's `earthdistance`/`cube` extensions or full PostGIS is a decision for whoever implements the actual radius/polygon filtering in Phase 2 (issue #18), not this task.
- **`search_profile.scope`/`thesis_params` internal shape**: intentionally `jsonb` with no fixed schema yet. The shape gets defined incrementally as each phase's filters/parameters land, not speculatively here.
