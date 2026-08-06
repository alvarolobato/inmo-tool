DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_stat_statements not available — skipping (enable shared_preload_libraries to activate)';
END
$$;

-- pgcrypto provides gen_random_uuid() used by llm_interactions.id.
-- Wrapped in a DO/EXCEPTION block so that installations where the role
-- lacks CREATE EXTENSION privilege (or the extension is unavailable)
-- fall back gracefully with a notice rather than aborting init.sql.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgcrypto not available — gen_random_uuid() may require PostgreSQL 13+ core support';
END
$$;

-- PostgreSQL DDL for the inmo-tool canonical real-estate data model.
-- See docs/architecture/data-model.md for the full ER description and
-- design rationale (especially the property_id-vs-listing_id keying
-- decision in profile_listing_state/feedback_event) and
-- docs/decisions/D-005-numeric-vs-uuid-keys.md for the PK strategy.
--
-- Run once to create tables; safe to re-run (IF NOT EXISTS).

-- ============================================================
-- Core entities
-- ============================================================

CREATE TABLE IF NOT EXISTS property (
    id             BIGSERIAL    PRIMARY KEY,
    -- Deliberately NOT UNIQUE — see the ALTER + index below for why.
    cadastral_ref  TEXT,
    address        TEXT,
    lat            NUMERIC(9,6),
    lon            NUMERIC(9,6),
    property_type  TEXT         CHECK (property_type IN ('piso','chalet','atico','local','nave','garaje','terreno','edificio')),
    m2_built       NUMERIC(8,2),
    m2_useful      NUMERIC(8,2),
    rooms          SMALLINT,
    bathrooms      SMALLINT,
    floor          TEXT,
    has_elevator   BOOLEAN,
    year_built     SMALLINT,
    energy_rating  TEXT,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_property_lat_lon ON property (lat, lon);

-- `cadastral_ref` was originally UNIQUE (task 1.2), on the intuitive
-- reasoning that a cadastral reference identifies exactly one real
-- property. That intuition is right about the *world* and wrong about
-- *this table*: `property` rows are created one-per-listing at ingest
-- (see docs/architecture/data-model.md), so the same real flat listed on
-- two portals legitimately produces two `property` rows — and if both
-- sources publish the reference, both rows carry it.
--
-- UNIQUE therefore made the highest-confidence dedup signal
-- (etl/dedup/signals/cadastral.py, issue #1 §6 signal 1) structurally
-- unreachable: it exists to detect exactly the two-rows-same-ref state the
-- constraint forbade, so it could never fire by construction. Worse, the
-- second ingest raised a property-level UniqueViolation that the
-- listing-level handler in orchestrator.py mis-attributed.
--
-- UNIQUE dropped in favour of a plain index (issue #140): it made signal 1
-- structurally unreachable, since two property rows sharing a reference —
-- the exact state the signal detects and merges — could never exist.
-- Deduplication is the engine's job, enforced by merging rows, not by
-- rejecting inserts. DROP/CREATE rather than editing the CREATE TABLE
-- above, which is a no-op on an already-migrated database — same reasoning
-- as the other post-hoc migrations in this file.
--
-- The index is *not* read by the dedup engine: fetch_listing_records()
-- full-scans the candidate set with no predicate on this column. It exists
-- for operator lookups ("which property is 9872023VH5797S0001WX?") and for
-- any future targeted query. Partial to match idx_listing_reference_code
-- and because the column is NULL for every consumer-portal listing —
-- only servicer/REO portals publish a reference at all.
ALTER TABLE property DROP CONSTRAINT IF EXISTS property_cadastral_ref_key;
CREATE INDEX IF NOT EXISTS idx_property_cadastral_ref ON property (cadastral_ref)
    WHERE cadastral_ref IS NOT NULL;

-- Keeps property.updated_at accurate without every writer having to
-- remember to set it (e.g. task 2.2's dedup merges, task 4.x's AI fields
-- landing on property later). Defined once, generic enough to reuse on
-- other tables in later phases if they need the same guarantee.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_property_set_updated_at ON property;
CREATE TRIGGER trg_property_set_updated_at
    BEFORE UPDATE ON property
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- listing.property_id is NOT NULL by design: every listing gets its own
-- singleton `property` row created at ingest time, never a deferred-null
-- FK. Dedup (Phase 2 task 2.2, issue #16) reassigns/unions property_id
-- onto an existing property when it matches two listings, rather than
-- filling in a previously-empty reference. See
-- docs/architecture/data-model.md.
CREATE TABLE IF NOT EXISTS listing (
    id             BIGSERIAL    PRIMARY KEY,
    property_id    BIGINT       NOT NULL REFERENCES property(id),
    source         TEXT         NOT NULL,
    external_id    TEXT         NOT NULL,
    url            TEXT,
    listing_kind   TEXT         CHECK (listing_kind IN ('particular','agency')),
    status         TEXT         NOT NULL DEFAULT 'active' CHECK (status IN ('active','reserved','sold','withdrawn','expired')),
    first_seen_at  TIMESTAMPTZ,
    last_seen_at   TIMESTAMPTZ,
    current_price  NUMERIC(12,2),
    description    TEXT,
    photo_urls     TEXT[],
    contact_raw    TEXT,
    raw_extra      JSONB        NOT NULL DEFAULT '{}',
    UNIQUE (source, external_id)
);

-- ALTER, not a column in the CREATE TABLE above (same reasoning as
-- listing.missed_discovery_count/operation elsewhere in this file): this
-- file must stay safe to re-run against an already-migrated database, and
-- `reference_code` was added after `listing`'s original CREATE TABLE.
--
-- Seller/agency-assigned reference code (e.g. Fotocasa's "Referencia:
-- NS603") — a dedicated column, not raw_extra, because the dedup engine
-- (etl/dedup/signals/reference_code.py, issue #72) needs to compare it
-- across every listing pair; NOT globally unique (two different
-- agencies can coincidentally use the same code) so it carries no
-- UNIQUE constraint — see that signal module for the corroboration
-- discipline this requires.
ALTER TABLE listing ADD COLUMN IF NOT EXISTS reference_code TEXT;

CREATE INDEX IF NOT EXISTS idx_listing_reference_code ON listing (reference_code)
    WHERE reference_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_listing_property_id  ON listing (property_id);
-- Both of these are kept, not redundant: a b-tree composite index on
-- (source, status) only serves queries that filter on `source` (alone, or
-- with status) — leftmost-prefix matching means it can't efficiently serve
-- a `WHERE status = ...` query with no `source` predicate. idx_listing_status
-- covers that pattern (e.g. "all active listings across every source");
-- idx_listing_source_status covers "active listings for source X" (the
-- withdrawal-reconciliation query below, and any future per-connector view).
CREATE INDEX IF NOT EXISTS idx_listing_status       ON listing (status);
CREATE INDEX IF NOT EXISTS idx_listing_source_status ON listing (source, status);
CREATE INDEX IF NOT EXISTS idx_listing_last_seen_at ON listing (last_seen_at);

-- Consecutive discover() sweeps a still-'active' listing was absent from.
-- Added in task 1.4 (#12) to implement EC-5 (withdrawal detection) — a
-- listing missing from one sweep isn't necessarily gone (pagination noise,
-- a transient per-item fetch failure, falling off page 1 as newer listings
-- push it down), so the orchestrator only marks 'withdrawn' after several
-- consecutive misses, not one. See etl.orchestrator._reconcile_missed_discoveries.
-- ALTER, not a column in the CREATE TABLE above: a column added inside
-- `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already
-- exists (as this one will, once task 1.2's schema has been applied once)
-- — this file must be safe to re-run against an already-migrated database,
-- not just a fresh one.
ALTER TABLE listing ADD COLUMN IF NOT EXISTS missed_discovery_count SMALLINT NOT NULL DEFAULT 0;

-- Issue #143 (fetch-budget / skip-if-seen): separates "last time we saw
-- this id in a discover() sweep" (last_seen_at, above) from "last time we
-- actually ran fetch_detail()+normalize() for it" (this column). Before
-- this issue the two were the same moment by construction — every
-- discovered id was fetched every run, and last_seen_at was only ever
-- written from the fetch path. Skip-if-seen breaks that equivalence: a
-- listing can now be "seen" (last_seen_at bumped from discover() alone,
-- see etl.orchestrator._update_last_seen_for_discovered) without being
-- re-fetched, so the staleness decision needs its own, narrower signal —
-- this column is what etl.orchestrator._should_skip_fetch actually gates
-- on, never last_seen_at.
ALTER TABLE listing ADD COLUMN IF NOT EXISTS last_fetched_at TIMESTAMPTZ;

-- One-time migration: every row that predates this column had its
-- last_seen_at written exclusively from the fetch path (see above), so
-- for any such row, last_seen_at IS the best available value for "last
-- fetched". WHERE last_fetched_at IS NULL alone is NOT sufficient to
-- keep this idempotent once skip-if-seen (issue #143) is live (Opus
-- review, PR #175 also-fix): this file is applied on every ETL container
-- startup (etl/main.py's _init_schema), not once, and last_seen_at no
-- longer means "last fetched" post-#143 — a row created AFTER this
-- migration first ran, with last_fetched_at deliberately left NULL
-- (meaning "never fetched, please fetch" — see _should_skip_fetch reason
-- #1, and the browser-extension capture / future-backfill paths its
-- docstring calls out), would otherwise get silently "fetched-washed" by
-- this exact UPDATE on the next container restart, permanently hiding it
-- from that force-fetch rule. Scoped to `first_seen_at` predating this
-- column's introduction (2026-08-03, this same commit) so the backfill
-- can only ever touch rows that genuinely predate skip-if-seen, no
-- matter how many times init.sql runs.
UPDATE listing SET last_fetched_at = last_seen_at
 WHERE last_fetched_at IS NULL AND last_seen_at IS NOT NULL
   AND first_seen_at < '2026-08-03'::timestamptz;

CREATE INDEX IF NOT EXISTS idx_listing_last_fetched_at ON listing (last_fetched_at);

-- Schema superset vs. RealEstateWebTools/property_web_scraper's field model
-- (issue #76). city/province/postal_code/m2_plot/features are additive
-- columns for data both live connectors already parse and currently
-- discard when flattening into `property.address` (see issue #76's
-- Context for the exact discarded fields per connector) — populating them
-- from real connector data is the Fotocasa/Milanuncios retrofit issues'
-- job (#77/#78), not this one; this issue only adds the columns.
ALTER TABLE property ADD COLUMN IF NOT EXISTS city         TEXT;
ALTER TABLE property ADD COLUMN IF NOT EXISTS province     TEXT;
ALTER TABLE property ADD COLUMN IF NOT EXISTS postal_code  TEXT;
-- NUMERIC(12,2), not (8,2): Milanuncios already maps a venta-de-fincas
-- (rural land/estate) category, and (8,2) tops out around 100 hectares —
-- a real rural finca listing above that would raise a numeric field
-- overflow and abort ingestion outright.
ALTER TABLE property ADD COLUMN IF NOT EXISTS m2_plot      NUMERIC(12,2);
ALTER TABLE property ADD COLUMN IF NOT EXISTS features     TEXT[] NOT NULL DEFAULT '{}';

-- Added now, ahead of #77/#78 actually populating `features`: cheap to add
-- alongside the column, easy to forget once hard-filtering starts querying
-- against it.
CREATE INDEX IF NOT EXISTS idx_property_features ON property USING GIN (features);

-- Sale vs. rent (issue #76's one field needing a product decision, not a
-- blind column add). Both live connectors only ever discover sale listings
-- today (Fotocasa's URL is /comprar/..., Milanuncios's is
-- venta-de-pisos-en-...), so this has been invisible so far — it stops
-- being invisible the moment a rental-comp connector (issue #31) lands.
-- Decision: add now, defaulted to 'sale', while the backfill is trivial
-- (every existing/future row from the current two connectors is
-- unambiguously a sale) rather than as an emergency migration once #31
-- needs to distinguish rentals. Issue #31's implementer should confirm
-- this representation still fits before ingesting rental data.
ALTER TABLE listing ADD COLUMN IF NOT EXISTS operation TEXT NOT NULL DEFAULT 'sale' CHECK (operation IN ('sale', 'rent'));

-- ============================================================
-- Change tracking (append-only)
-- ============================================================

CREATE TABLE IF NOT EXISTS listing_price_history (
    id           BIGSERIAL     PRIMARY KEY,
    listing_id   BIGINT        NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
    observed_at  TIMESTAMPTZ   NOT NULL,
    price        NUMERIC(12,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listing_price_history_listing_observed
    ON listing_price_history (listing_id, observed_at);

CREATE TABLE IF NOT EXISTS listing_status_event (
    id           BIGSERIAL    PRIMARY KEY,
    listing_id   BIGINT       NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
    observed_at  TIMESTAMPTZ  NOT NULL,
    status       TEXT         NOT NULL CHECK (status IN ('active','reserved','sold','withdrawn','expired'))
);

CREATE INDEX IF NOT EXISTS idx_listing_status_event_listing_observed
    ON listing_status_event (listing_id, observed_at);

-- ============================================================
-- Owner identity (dedup signal input + GDPR-minimized retention)
-- ============================================================

CREATE TABLE IF NOT EXISTS owner_identity (
    id                     BIGSERIAL    PRIMARY KEY,
    phone                  TEXT,
    name_normalized        TEXT,
    agency_name            TEXT,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_linked_active_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS listing_owner_identity (
    listing_id        BIGINT NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
    owner_identity_id BIGINT NOT NULL REFERENCES owner_identity(id) ON DELETE CASCADE,
    PRIMARY KEY (listing_id, owner_identity_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_owner_identity_owner
    ON listing_owner_identity (owner_identity_id);

CREATE INDEX IF NOT EXISTS idx_owner_identity_last_linked_active_at
    ON owner_identity (last_linked_active_at);

CREATE INDEX IF NOT EXISTS idx_owner_identity_phone
    ON owner_identity (phone) WHERE phone IS NOT NULL;

-- Retention default (issue #1 §17, owner-overridable): an owner_identity
-- row is retained only while linked to at least one active listing. Once
-- it falls outside the retention window with no active listing
-- referencing it, this function purges (anonymizes) the row. Shipped as a
-- real function rather than a comment-only query so there is exactly one
-- copy of this logic (tests call it too — see test_schema.py) instead of
-- letting a copy-pasted query drift from what's actually run. Phase 1.3's
-- orchestrator owns *scheduling* the call (e.g. `SELECT
-- purge_stale_owner_identities();` once per sync run); this task only
-- ships the mechanism.
--
-- COALESCE(last_linked_active_at, created_at): a row that was never linked
-- to an active listing at all (last_linked_active_at IS NULL) must still
-- age out eventually — falling back to created_at closes that gap rather
-- than retaining such rows forever.
CREATE OR REPLACE FUNCTION purge_stale_owner_identities(retention_days INT DEFAULT 90)
RETURNS INT AS $$
DECLARE
    purged_count INT;
BEGIN
    WITH purged AS (
        UPDATE owner_identity
        SET phone = NULL, name_normalized = NULL, agency_name = NULL
        WHERE COALESCE(last_linked_active_at, created_at) < NOW() - make_interval(days => retention_days)
          AND id NOT IN (
              SELECT loi.owner_identity_id
              FROM listing_owner_identity loi
              JOIN listing l ON l.id = loi.listing_id
              WHERE l.status = 'active'
          )
        RETURNING id
    )
    SELECT count(*)::INT INTO purged_count FROM purged;
    RETURN purged_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Search profiles (independent scoring "mandates" over shared data)
-- ============================================================

CREATE TABLE IF NOT EXISTS search_profile (
    id             BIGSERIAL    PRIMARY KEY,
    name           TEXT         NOT NULL,
    scope          JSONB        NOT NULL DEFAULT '{}',
    thesis_params  JSONB        NOT NULL DEFAULT '{}',
    archived_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Issue #113: `scope`'s own DB-level default of '{}' is guaranteed to fail
-- ScopeSchema (geography/property_types are both required, non-optional
-- fields) -- there is no schema-valid "empty" scope to default to instead
-- (property_types requires >=1 element). Every real write path
-- (createProfile) already supplies an explicit, validated scope, so the
-- column default was never anything but a trap reachable only via a manual
-- SQL insert, a seed script, or a future migration that forgets to set it --
-- dropping it forces exactly that mistake to surface immediately as a NOT
-- NULL violation at INSERT time, instead of silently persisting a row that
-- toSearchProfileRowSafe (lib/db/profiles.ts) can only detect after the fact.
-- See docs/decisions/D-013-search-profile-scope-no-default.md.
ALTER TABLE search_profile ALTER COLUMN scope DROP DEFAULT;

-- Issue #191 (design: docs comment on #176 §1/§4). Two facts the redesigned
-- Perfiles page needs that are structurally unrepresentable without a
-- timestamp:
--   - last_materialized_at: distinguishes "this profile has never been
--     materialized" from "materialized, and matched zero properties" -- both
--     look identical as zero rows in profile_listing_state without this.
--     Set (to NOW()) at the end of every materializeProfile run, including
--     the zero-matches case (lib/filtering/materialize.ts).
--   - last_viewed_at: "new since I last looked" needs a per-profile visit
--     timestamp, which doesn't otherwise exist anywhere. Set best-effort
--     (never blocks/fails the page) whenever GET /api/profiles/[id] is read.
-- Both nullable, no backfill -- NULL is a real, meaningful "never" state for
-- each existing row.
ALTER TABLE search_profile ADD COLUMN IF NOT EXISTS last_materialized_at TIMESTAMPTZ;
ALTER TABLE search_profile ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ;

-- Issue #35 (Phase 5.5, D-054): per-profile daily/weekly "what's new" digest.
--   - digest_cadence: how often this profile's digest is assembled and sent.
--     'daily' by default so a fresh install produces digests immediately; the
--     send is a no-op (logged) until SMTP is configured, so 'daily' can't spam
--     an unconfigured deployment. 'off' opts a profile out entirely. Task 2.3's
--     profile-edit API will expose this; until then it is DB-default-driven.
--   - digest_email: the recipient for THIS profile's digest. NULL falls back to
--     the global notifications.digest_to config value (personal tool, one owner),
--     so a working default needs zero per-profile setup.
-- Both ALTER (not part of the CREATE TABLE below-first path) for the standard
-- already-migrated-database reason as last_viewed_at above.
ALTER TABLE search_profile ADD COLUMN IF NOT EXISTS digest_cadence TEXT
    NOT NULL DEFAULT 'daily'
    CHECK (digest_cadence IN ('daily', 'weekly', 'off'));
ALTER TABLE search_profile ADD COLUMN IF NOT EXISTS digest_email TEXT;

-- Issue #35: one row per digest actually assembled for a profile — the
-- "since last digest" watermark the next run reads (its `sent_at` becomes the
-- next run's lower bound for "new candidates"), plus a lightweight audit of
-- how much each digest carried. Written on EVERY assembled cycle, including
-- the empty case (candidate_count = 0, no email sent) — that is exactly how an
-- empty digest advances the watermark without sending a content-free email
-- (issue #35 EC-2 / technical approach §4). `sent` records whether an email
-- actually went out (false for an empty digest or an unconfigured-SMTP no-op),
-- so the audit distinguishes "nothing to say" from "SMTP not set up".
CREATE TABLE IF NOT EXISTS digest_run (
    id              BIGSERIAL    PRIMARY KEY,
    profile_id      BIGINT       NOT NULL REFERENCES search_profile(id) ON DELETE CASCADE,
    sent_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    candidate_count INTEGER      NOT NULL DEFAULT 0,
    sent            BOOLEAN      NOT NULL DEFAULT false
);

-- The scheduler's due-check reads the most recent digest_run per profile
-- (ORDER BY sent_at DESC LIMIT 1) — index the (profile_id, sent_at DESC) path.
CREATE INDEX IF NOT EXISTS idx_digest_run_profile_sent
    ON digest_run (profile_id, sent_at DESC);

-- profile_listing_state is keyed on (profile_id, property_id), NOT
-- listing_id. This is load-bearing: once dedup (task 2.2) unions two
-- listings from different sites into one property, this table must still
-- carry exactly one score/feedback/pipeline-stage row per profile for
-- that property. Keying on listing_id would let one deduplicated
-- property carry two independent, possibly contradictory states per
-- profile (e.g. rejected via its Idealista listing while its Fotocasa
-- listing of the same property sits un-rejected) — silently defeating
-- the entire point of deduplication. See docs/architecture/data-model.md.
-- pipeline_stage vocabulary and ordering (must match issue #16's dedup
-- merge-reconciliation logic, which keeps the more-advanced stage when two
-- properties with state for the same profile get merged):
--   new < reviewing < interested < contacted < visited < offer_made < closed/rejected
-- 'new' is the pre-pipeline default (not part of issue #1 §13's named
-- pipeline, which starts at 'interested') — a row exists here as soon as a
-- profile's hard filters match a property, before any human action.
-- 'closed' and 'rejected' are both terminal and treated as equally
-- "most advanced" for reconciliation purposes.
CREATE TABLE IF NOT EXISTS profile_listing_state (
    profile_id       BIGINT       NOT NULL REFERENCES search_profile(id),
    property_id      BIGINT       NOT NULL REFERENCES property(id),
    score            NUMERIC(6,3),
    rank_explanation TEXT,
    pipeline_stage   TEXT         NOT NULL DEFAULT 'new'
                     CHECK (pipeline_stage IN ('new','reviewing','interested','contacted','visited','offer_made','closed','rejected')),
    notes            TEXT,
    last_scored_at   TIMESTAMPTZ,
    PRIMARY KEY (profile_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_listing_state_property
    ON profile_listing_state (property_id);

CREATE INDEX IF NOT EXISTS idx_profile_listing_state_profile_score
    ON profile_listing_state (profile_id, score DESC);

-- Task 2.4 (#18): a property that once matched a profile's hard filters but
-- no longer does (scope edited narrower, or the property's own data changed)
-- has its row flipped to matched=false rather than deleted — a row can carry
-- feedback/notes/pipeline_stage by the time it stops matching, and deleting
-- it would silently destroy that history. Candidate-list UI (task 2.5)
-- filters on `matched = true`; a `false` row stays queryable for audit /
-- "why did this disappear" purposes. ALTER, not part of CREATE TABLE above,
-- for the same already-migrated-database reason as listing.missed_discovery_count.
ALTER TABLE profile_listing_state ADD COLUMN IF NOT EXISTS matched BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_profile_listing_state_profile_matched
    ON profile_listing_state (profile_id, matched);

-- Task 3.4 (#23) wrap-up (Fable review of PR #93): distinguishes a real
-- trained-model score from a deterministic cold-start heuristic score.
-- Before this column existed, the only way to tell them apart was
-- string-equality against explain.ts's COLD_START_EXPLANATION text (used
-- this way in a test) — fragile, since that's UI copy that could change for
-- cosmetic reasons alone. NULL means "never scored", matching `score`'s own
-- nullability rather than a third scoring state to keep in sync. ALTER, not
-- part of CREATE TABLE above, for the same already-migrated-database reason
-- as `matched`.
ALTER TABLE profile_listing_state ADD COLUMN IF NOT EXISTS score_kind TEXT
    CHECK (score_kind IN ('cold_start', 'trained'));

-- Issue #166: lib/candidates.ts's listCandidates() and getAdjacentCandidates()
-- (#152/#146) both keyset-scan this table with the same predicate/ordering:
--   WHERE profile_id = $1 AND matched = true
--     AND (COALESCE(score, -1) < $2 OR (COALESCE(score, -1) = $2 AND property_id < $3))
--   ORDER BY COALESCE(score, -1) DESC, property_id DESC
-- Neither idx_profile_listing_state_profile_score (plain `score DESC`, not
-- COALESCE'd, so a NULL-containing sort can't be served from it) nor
-- idx_profile_listing_state_profile_matched (no ordering at all) matches this.
-- Partial on `matched = true` since every consumer of this ordering filters on
-- it, and excluding matched=false rows (task 2.4's soft-delete convention,
-- kept for audit) keeps the index smaller and more selective.
--
-- Measured with EXPLAIN (ANALYZE, BUFFERS), 5 repeated runs each, on a
-- freshly-ANALYZEd 60k-row profile_listing_state (one profile, ~15% NULL
-- scores) — median execution time, mid-scan cursor (not a trivial first/last
-- page):
--   listCandidates keyset query:        55.6ms Hash Join+Sort -> 29.1ms Nested Loop  (~48% faster)
--   getAdjacentCandidates NEXT:         36.3ms Seq Scan+Sort  -> 27.1ms Index Scan   (~25% faster)
--   getAdjacentCandidates PREV:         33.0ms Seq Scan+Sort  -> 19.3ms Index Scan Backward (~42% faster)
-- All three plans confirm the new index in use. The win here comes from
-- avoiding the Sort (and, for listCandidates, the Hash Join build) over the
-- whole per-profile row set, not from a true bounded index-range seek: the
-- application's WHERE is written as `(a < x) OR (a = x AND b < y)` cast to
-- `::double precision`, a shape Postgres's planner does not fold into a
-- single multi-column index condition (only `profile_id = $1` becomes a real
-- Index Cond; the rest is still a Filter re-checked per row scanned before
-- the LIMIT is satisfied). A row-comparison rewrite of the query
-- (`(COALESCE(score,-1), property_id) < ($2, $3)`, matching the index's
-- native NUMERIC type) measured sub-millisecond in the same setup, but
-- changing the query shape is out of scope for this index-only issue —
-- worth a follow-up if this ever shows up hot in pg_stat_statements at
-- production scale.
CREATE INDEX IF NOT EXISTS idx_profile_listing_state_profile_ranked
    ON profile_listing_state (profile_id, (COALESCE(score, -1)) DESC, property_id DESC)
    WHERE matched = true;

-- feedback_event.property_id (not listing_id) is what the feedback's
-- identity is keyed on, matching profile_listing_state above. listing_id
-- is kept only as an optional "which site listing was the user actually
-- looking at" audit detail — never used to identify what the feedback
-- applies to.
CREATE TABLE IF NOT EXISTS feedback_event (
    id             BIGSERIAL    PRIMARY KEY,
    profile_id     BIGINT       REFERENCES search_profile(id),
    property_id    BIGINT       NOT NULL REFERENCES property(id),
    listing_id     BIGINT       REFERENCES listing(id),
    feedback_type  TEXT         NOT NULL CHECK (feedback_type IN ('accept','reject','star','note','correction')),
    value          JSONB,
    note           TEXT,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_event_profile_property
    ON feedback_event (profile_id, property_id);

CREATE INDEX IF NOT EXISTS idx_feedback_event_listing_id
    ON feedback_event (listing_id) WHERE listing_id IS NOT NULL;

-- Task 3.2 (#21): one trained model per profile. `coefficients` carries the
-- whole model (weights, bias, feature names, and the z-score normalization
-- stats used to standardize a candidate's raw features before scoring) as a
-- single JSONB blob rather than one column per field — the exact shape is
-- expected to evolve as later tasks add features (Phase 4's AI-derived
-- inputs, Phase 5's yield/days-on-market), and a JSONB blob absorbs that
-- without a migration each time. `search_profile(id)` FK, not
-- `profile_listing_state`, because a model exists per profile independent of
-- any single candidate — deleting a profile should delete its model
-- (ON DELETE CASCADE), not leave an orphaned row.
CREATE TABLE IF NOT EXISTS profile_scoring_model (
    profile_id             BIGINT       PRIMARY KEY REFERENCES search_profile(id) ON DELETE CASCADE,
    coefficients           JSONB        NOT NULL,
    trained_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    training_example_count INTEGER      NOT NULL
);

-- ============================================================
-- AI assessments (Phase 4 generates these).
--
-- Keyed on property_id, NOT listing_id (#25). An assessment answers a
-- question about the *physical property* ("is it occupied?"), not about
-- one portal's advert copy. Keying on listing_id — as this table did
-- until #25 — meant a property deduplicated across three portals got
-- three LLM calls, three bills, and three verdicts that could disagree
-- with nothing to reconcile them. It also starved each call: occupancy
-- is precisely the fact one seller discloses and another omits, so the
-- union of the merged listings' descriptions is strictly better input
-- than any single listing's.
--
-- Provenance is not lost: which portal's text produced the verdict is
-- carried inside `result` as `evidence_source`, so an investor can go
-- and check the claim (issue #1 §9 — evidence shown, not just a label).
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_assessment (
    id              BIGSERIAL    PRIMARY KEY,
    property_id     BIGINT       NOT NULL REFERENCES property(id),
    assessment_type TEXT         NOT NULL CHECK (assessment_type IN ('occupancy','condition','redflags','extract','compare')),
    result          JSONB        NOT NULL,
    confidence      NUMERIC(4,3),
    model           TEXT,
    prompt_version  TEXT,
    generated_at    TIMESTAMPTZ,
    -- NULLS NOT DISTINCT (PG15+): without it, Postgres treats every NULL
    -- prompt_version as distinct, so this constraint would silently allow
    -- unlimited duplicate (property_id, assessment_type, NULL) rows —
    -- defeating the point of the uniqueness check for any assessment
    -- generated before prompt_version tracking existed for that flow.
    --
    -- Named explicitly rather than left to Postgres' auto-naming so the
    -- fresh-install path and the migration path below converge on one
    -- constraint instead of quietly creating two equivalent ones.
    CONSTRAINT ai_assessment_property_key
        UNIQUE NULLS NOT DISTINCT (property_id, assessment_type, prompt_version)
);

-- The flow catalog gained `compare` in #24 (Phase 4.1). Re-stated as an
-- ALTER because the CREATE TABLE above is a no-op against a database that
-- already has ai_assessment — an inline edit alone would leave existing
-- installs rejecting every 'compare' row at runtime.
ALTER TABLE ai_assessment DROP CONSTRAINT IF EXISTS ai_assessment_assessment_type_check;
ALTER TABLE ai_assessment ADD CONSTRAINT ai_assessment_assessment_type_check
    CHECK (assessment_type IN ('occupancy','condition','redflags','extract','compare'));

-- #25: re-key listing_id → property_id on databases that already have the
-- old shape. The CREATE TABLE above is a no-op for them, so without this
-- block an existing install would keep the listing-keyed constraint and
-- reject the per-property writes this task makes.
--
-- Backfill is total, not best-effort: listing_id was NOT NULL REFERENCES
-- listing(id), and listing.property_id is itself NOT NULL, so every
-- pre-existing row resolves to exactly one property. Dropping the column
-- also drops the unique constraint that used it, so no constraint name
-- has to be guessed.
ALTER TABLE ai_assessment ADD COLUMN IF NOT EXISTS property_id BIGINT REFERENCES property(id);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'ai_assessment' AND column_name = 'listing_id'
    ) THEN
        UPDATE ai_assessment a
           SET property_id = l.property_id
          FROM listing l
         WHERE a.listing_id = l.id
           AND a.property_id IS NULL;

        -- Two rows that were distinct per-listing can collapse onto one
        -- property. Keep the newest and drop the rest, so SET NOT NULL and
        -- the new unique constraint below both succeed. "Newest" is by
        -- `generated_at`, not `id`: id order only happens to agree with
        -- insertion order, and insertion order is not the question — which
        -- verdict was actually generated most recently is. Old-shape rows
        -- with no `generated_at` (NULL) tie amongst themselves, so `id` is
        -- kept only as the tiebreaker, never the primary key.
        DELETE FROM ai_assessment a
              USING ai_assessment b
              WHERE a.property_id = b.property_id
                AND a.assessment_type = b.assessment_type
                AND a.prompt_version IS NOT DISTINCT FROM b.prompt_version
                AND (
                      a.generated_at < b.generated_at
                      OR (
                           a.generated_at IS NOT DISTINCT FROM b.generated_at
                           AND a.id < b.id
                         )
                    );

        ALTER TABLE ai_assessment DROP COLUMN listing_id;
    END IF;
END
$$;

ALTER TABLE ai_assessment ALTER COLUMN property_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        -- Qualified by conrelid, not just conname: pg_constraint is
        -- database-wide, so an unqualified name lookup can match a
        -- same-named constraint on a different table (or in a different
        -- schema on the same search_path) and skip the ADD CONSTRAINT below.
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ai_assessment_property_key'
           AND conrelid = 'ai_assessment'::regclass
    ) THEN
        ALTER TABLE ai_assessment ADD CONSTRAINT ai_assessment_property_key
            UNIQUE NULLS NOT DISTINCT (property_id, assessment_type, prompt_version);
    END IF;
END
$$;

-- No separate (property_id, assessment_type) index: ai_assessment_property_key
-- above is UNIQUE (property_id, assessment_type, prompt_version), and Postgres
-- can use a multi-column index's leading columns for a query that only
-- filters on the prefix — a dedicated two-column index duplicated that for
-- free. Existing installs still carry the old index; drop it explicitly
-- rather than leaving dead weight behind.
DROP INDEX IF EXISTS idx_ai_assessment_property_type;

-- Phase 4.7 (#30): content-hash cache invalidation. `content_hash` is a
-- SHA-256 of the exact `(listing_id, description)` pairs a property-level
-- assessment flow's prompt reads (see dashboard/lib/ai-assessment/cache.ts's
-- `computeAssessmentContentHash`) — recomputed fresh on every read and
-- compared to what is stored here, so a description change (or a listing
-- joining/leaving the property, which is what a dedup merge IS) invalidates
-- automatically without any hook into the ETL orchestrator or connectors.
-- NULL for rows written before this migration (and for direct
-- save*Assessment() callers that don't pass one, e.g. tests) — cache.ts's
-- `getOrCompute` always treats a NULL content_hash as a miss, which is the
-- correct conservative behaviour: a pre-existing row's hash is unknowable,
-- not "matches by default".
--
-- ADD COLUMN IF NOT EXISTS, not a column in the CREATE TABLE above: this file
-- must stay safe to re-run against an already-migrated database (same
-- reasoning as `reference_code`/`missed_discovery_count` elsewhere in this
-- file) — a column added inside `CREATE TABLE IF NOT EXISTS` is a no-op
-- against a table that already exists.
ALTER TABLE ai_assessment ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- ============================================================
-- Deduplication audit trail (Phase 2 task 2.2, issue #16, writes here)
-- ============================================================

-- Perceptual photo hashes, keyed on the URL (issue #221).
--
-- A perceptual hash of a given image never changes, so a URL only ever needs
-- hashing once. Before this table the dedup engine memoised hashes for the
-- duration of a single run and threw them away, re-downloading every photo of
-- every listing on the next pass: ~8,800 HTTP fetches per run against
-- third-party CDNs, outside any connector's rate limiter, which put a full
-- run over 30 minutes and made dedup impractical to run per sweep (#185).
--
-- Keyed on photo_url alone, not (listing_id, photo_url): a listing whose
-- photo_urls array changes then re-hashes only the genuinely new URLs, and
-- syndicated listings that share CDN objects across sources hash them once
-- for the whole corpus. Nothing needs invalidating, because the cached value
-- is immutable.
--
-- ok = false rows are failures, kept deliberately. A dead URL used to be
-- retried every run forever — exactly how the Milanuncios "Rule parameter not
-- Found" breakage (#209/#213) stayed invisible, its cost spread evenly across
-- every run instead of showing up as a spike. Retried only after a backoff
-- (etl/dedup/photo_hash_store.py), so a transient outage still heals.
CREATE TABLE IF NOT EXISTS photo_hashes (
    photo_url       TEXT         PRIMARY KEY,
    phash           TEXT,
    ok              BOOLEAN      NOT NULL,
    source          TEXT,
    failure_reason  TEXT,
    attempts        INTEGER      NOT NULL DEFAULT 1,
    first_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- No secondary index on purpose. The only query that reads this table is
-- `photo_url = ANY(...) AND (ok OR last_attempt_at > cutoff)`, which the
-- planner answers with a bitmap scan on the primary key and evaluates the
-- second predicate as a heap filter — measured on 50k rows. A partial index
-- on (last_attempt_at) WHERE NOT ok shipped in the first cut of #221 and was
-- never chosen by that plan; it only cost write throughput on the hot path.
DROP INDEX IF EXISTS idx_photo_hashes_retry;

CREATE TABLE IF NOT EXISTS property_merge_log (
    id                  BIGSERIAL    PRIMARY KEY,
    property_id         BIGINT       REFERENCES property(id),
    merged_listing_ids  BIGINT[],
    match_basis         TEXT         CHECK (match_basis IN ('cadastral','address_coords','phone','reference_code','photo_hash','fuzzy')),
    confidence          NUMERIC(4,3),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    reverted_at         TIMESTAMPTZ
);

-- 'reference_code' (issue #72) was added to the CHECK list above after
-- this table's original CREATE TABLE — inert against an already-migrated
-- database (CREATE TABLE IF NOT EXISTS is a no-op there), so the live
-- constraint needs its own migration or a pre-#72 database would reject
-- every real 'reference_code' insert at runtime.
ALTER TABLE property_merge_log DROP CONSTRAINT IF EXISTS property_merge_log_match_basis_check;
ALTER TABLE property_merge_log ADD CONSTRAINT property_merge_log_match_basis_check
    CHECK (match_basis IN ('cadastral','address_coords','phone','reference_code','photo_hash','fuzzy'));

-- ALTER, not a column in the CREATE TABLE above (same reasoning as
-- listing.missed_discovery_count in task 1.4): this file must stay safe to
-- re-run against an already-migrated database.
--
-- The "losing" property row from a merge (property_merge_log.property_id
-- only records the *survivor*) is never deleted — FK RESTRICT from
-- profile_listing_state/feedback_event/property_merge_log itself means it
-- couldn't be deleted anyway once it has ever accumulated state, and
-- etl.dedup.engine.perform_merge only reassigns listing.property_id away
-- from it, never issues a DELETE. Recording which property_id was the
-- losing side makes revert (etl.dedup.engine.revert) a simple, exact
-- pointer restoration — point merged_listing_ids back at
-- losing_property_id, which still physically exists — rather than having
-- to reconstruct a plausible-looking property row from scratch.
ALTER TABLE property_merge_log ADD COLUMN IF NOT EXISTS losing_property_id BIGINT REFERENCES property(id);

-- ALTER, same re-runnable-migration reasoning as losing_property_id above.
--
-- Snapshot of what etl.dedup.reconcile.reconcile_merge changed on
-- profile_listing_state/feedback_event for this merge, so etl.dedup.engine.
-- revert can restore pre-merge per-profile state (score, pipeline_stage,
-- which feedback_event rows lived on which side) — not just listing->
-- property pointers. See reconcile.py's module docstring for the snapshot
-- shape (a list of per-profile "ops" plus the re-keyed feedback_event ids).
ALTER TABLE property_merge_log ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_property_merge_log_property_id
    ON property_merge_log (property_id);

-- Medium-confidence match candidates for human review (issue #16 signals
-- 3-5: uncorroborated phone, photo-hash, fuzzy fallback all land here
-- instead of auto-merging) AND merge-time reconciliation conflicts
-- (status='conflict' — issue #16 Technical approach item 6/EC-7). Rows are
-- keyed on the two *listings* that triggered the candidate/conflict, not
-- properties: for a plain suggestion nothing has merged yet, so there's no
-- single property_id to key on; for a conflict, the property-level merge
-- already happened (the identity match itself was confident) but
-- profile_listing_state's PRIMARY KEY (profile_id, property_id) makes it
-- impossible to hold two live rows for the same pair to show "both original
-- states" — so a conflict's `detail` JSON carries both original
-- pipeline_stage values (and which listing/profile they came from) for a
-- human to inspect and resolve, rather than the table trying to represent
-- two rows the schema can't hold at once.
CREATE TABLE IF NOT EXISTS suggested_merge (
    id            BIGSERIAL    PRIMARY KEY,
    listing_id_a  BIGINT       NOT NULL REFERENCES listing(id),
    listing_id_b  BIGINT       NOT NULL REFERENCES listing(id),
    match_basis   TEXT         NOT NULL CHECK (match_basis IN ('cadastral','address_coords','phone','reference_code','photo_hash','fuzzy')),
    confidence    NUMERIC(4,3),
    status        TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','conflict')),
    detail        JSONB        NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    resolved_at   TIMESTAMPTZ,
    CHECK (listing_id_a <> listing_id_b)
);

-- 'reference_code' (issue #72) was added to the CHECK list above after
-- this table's original CREATE TABLE — same inert-on-existing-DB issue as
-- property_merge_log's identical constraint above; migrate it too.
ALTER TABLE suggested_merge DROP CONSTRAINT IF EXISTS suggested_merge_match_basis_check;
ALTER TABLE suggested_merge ADD CONSTRAINT suggested_merge_match_basis_check
    CHECK (match_basis IN ('cadastral','address_coords','phone','reference_code','photo_hash','fuzzy'));

-- Prevents the engine from re-suggesting the same pair on every run
-- regardless of which listing was recorded as "a" vs "b" (the engine
-- always normalizes to the lower id first when inserting, so this
-- constraint is reachable, not decorative).
CREATE UNIQUE INDEX IF NOT EXISTS idx_suggested_merge_pair
    ON suggested_merge (listing_id_a, listing_id_b);

CREATE INDEX IF NOT EXISTS idx_suggested_merge_status
    ON suggested_merge (status) WHERE status = 'pending';

-- Dashboard-originated confirm/reject requests for the review-queue UI
-- (the "missing half" of the dedup workflow: `confirm_suggestion()`/
-- `reject_suggestion()` existed and were CLI-callable, but nothing in the
-- dashboard could reach them, so the 585 suggestions a real run filed sat
-- unreachable). A queue table, not a synchronous HTTP call from the
-- dashboard straight into the ETL container — same reasoning as
-- `extension_capture` above: the dashboard (Node/TypeScript) and the dedup
-- engine (Python, etl/dedup/engine.py's `confirm_suggestion`/
-- `reject_suggestion`) run in separate containers with no shared
-- filesystem or RPC channel, and issue #185's own review made clear this
-- project's answer to "Node needs Python's business logic" is a queue
-- table polled by the ETL container, not a second, drifting TypeScript
-- reimplementation of `perform_merge`/`reconcile_merge`. See
-- etl/dedup/actions.py's module docstring for the poll loop
-- (`run_action_poll_loop`, started in etl/main.py alongside the
-- extension-capture poll thread) and dashboard/lib/dedup.ts for the
-- enqueue/poll-for-result side.
CREATE TABLE IF NOT EXISTS suggested_merge_action (
    id             BIGSERIAL    PRIMARY KEY,
    suggestion_id  BIGINT       NOT NULL REFERENCES suggested_merge(id) ON DELETE CASCADE,
    action         TEXT         NOT NULL CHECK (action IN ('confirm','reject')),
    status         TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
    error_msg      TEXT,
    -- Populated on a successful 'confirm' with the same shape
    -- engine.confirm_suggestion() returns (survivor/losing property ids,
    -- had_conflict) — lets the dashboard's poll response tell the operator
    -- which property survived without a second query.
    result         JSONB        NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    processed_at   TIMESTAMPTZ
);

-- Same reasoning as idx_extension_capture_pending: the poll query is
-- `WHERE status = 'pending' ORDER BY created_at`, so a partial index keeps
-- it cheap regardless of how many done/failed rows accumulate.
CREATE INDEX IF NOT EXISTS idx_suggested_merge_action_pending
    ON suggested_merge_action (created_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_suggested_merge_action_suggestion_id
    ON suggested_merge_action (suggestion_id);

-- ============================================================
-- Connector observability (Phase 1.3, issue #11)
-- ============================================================
--
-- These are a fresh pair of tables, not a reuse of the source project's
-- etl_sync_runs/etl_sync_run_tables (kept below, still present but now
-- orphaned — nothing writes to them since Phase 1.1 deleted the table-sync
-- modules that populated them; left alone as a Phase-1.1/1.3 cleanup gap
-- rather than dropped speculatively here, since a later phase's dashboard
-- reuse might still want the etl_manual_trigger UI-trigger mechanism they
-- sit alongside). connector_runs/connector_run_results track the new
-- per-connector discover+fetch+normalize+store cycle instead of the old
-- per-table watermark-delta sync.

CREATE TABLE IF NOT EXISTS connector_runs (
    id                 BIGSERIAL    PRIMARY KEY,
    trigger            TEXT         NOT NULL,
    started_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at        TIMESTAMPTZ,
    duration_ms        INTEGER,
    status             TEXT         NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','partial','failed')),
    connectors_ok      INTEGER,
    connectors_failed  INTEGER,
    total_connectors   INTEGER
);

CREATE TABLE IF NOT EXISTS connector_run_results (
    id               BIGSERIAL    PRIMARY KEY,
    run_id           BIGINT       NOT NULL REFERENCES connector_runs(id) ON DELETE CASCADE,
    connector_name   TEXT         NOT NULL,
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    -- This inline CHECK is the original (3-value) definition, kept as-is
    -- for a correct history on a fresh install — it's superseded below by
    -- an ALTER adding 'skipped' (issue #99). Reading this line alone gives
    -- a stale picture of what's actually allowed on a real database; see
    -- the ALTER a few lines down for the current 4-value constraint.
    status           TEXT         NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','failed','circuit_open')),
    discovered_count INTEGER      NOT NULL DEFAULT 0,
    fetched_count    INTEGER      NOT NULL DEFAULT 0,
    error_count      INTEGER      NOT NULL DEFAULT 0,
    error_msg        TEXT,
    -- One row per connector per run — still a real 1:1 pairing after issue
    -- #71 (profile-driven scope), but don't read "one row" as "discover()/
    -- fetch_detail() ran once": a connector now processes one scope per
    -- active search-profile geography within a single run, and this row's
    -- discovered_count/fetched_count/error_count are the SUM across all of
    -- them, with per-scope detail folded into error_msg on anything but a
    -- clean 'ok' (see etl.orchestrator.run_all_connectors). What stays
    -- 1:1 is "one connector, one run, one result row" — not "one scope".
    UNIQUE (run_id, connector_name)
);

-- Issue #99 hardening: an operator disabling a connector via connector_config
-- previously left zero trace — no connector_run_results row, no count
-- anywhere — making a run where every connector is disabled indistinguishable
-- from a healthy, fully-successful empty run. 'skipped' plus
-- connectors_skipped close that gap: a disabled connector now gets a real
-- result row (status='skipped', not counted toward connectors_ok/failed)
-- so an operator can actually see "this ran, but I told it not to do
-- anything" rather than a suspiciously-quiet clean run.
ALTER TABLE connector_run_results DROP CONSTRAINT IF EXISTS connector_run_results_status_check;
ALTER TABLE connector_run_results ADD CONSTRAINT connector_run_results_status_check
    CHECK (status IN ('ok', 'failed', 'circuit_open', 'skipped'));
ALTER TABLE connector_runs ADD COLUMN IF NOT EXISTS connectors_skipped INTEGER;

-- Issue #143: listings this connector's run left unfetched under the
-- skip-if-seen policy ("known, still present per discover(), deliberately
-- not re-fetched this run" — etl.orchestrator._should_skip_fetch). NOT the
-- same concept as connectors_skipped above, which counts whole *connectors*
-- skipped via connector_config.enabled=false — this is a listing-level
-- count, always 0 for a connector that hasn't opted into
-- min_refetch_interval_seconds > 0 (today's default for every connector).
ALTER TABLE connector_run_results ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_connector_run_results_run_id ON connector_run_results (run_id);
-- Recent-runs lookups (dashboards, `ps connector status`-style queries)
-- filter/sort on started_at; unindexed, that's a seq scan once this table
-- has any real history.
CREATE INDEX IF NOT EXISTS idx_connector_runs_started_at ON connector_runs (started_at DESC);

-- ============================================================
-- Dedup observability (issue #185)
-- ============================================================
--
-- The dedup engine (etl/dedup/engine.py, issue #16) ran only via
-- `ps dedup run` — nothing in the connector sweep, the scheduler, or
-- container startup ever called it. Confirmed on the live database:
-- property_merge_log and suggested_merge were both empty across every run
-- since the connectors went live. `connector_runs`/`connector_run_results`
-- gave an operator visibility into ingestion; dedup had no equivalent, so a
-- run that silently compared nothing looked identical to a run that
-- silently found nothing — which is exactly how this went unnoticed.
--
-- Mirrors the connector_runs/connector_run_results shape rather than
-- inventing a new pattern. One row per dedup pass (`etl.orchestrator.
-- run_dedup`), whether triggered automatically after a connector sweep
-- (trigger derived from the connector run, e.g. 'scheduler'/'cli') or
-- manually via `ps dedup run` (trigger='cli-manual').
CREATE TABLE IF NOT EXISTS dedup_runs (
    id                BIGSERIAL    PRIMARY KEY,
    trigger           TEXT         NOT NULL,
    -- Nullable: a manual `ps dedup run` has no connector_runs row to point
    -- at. Set when this dedup pass was triggered automatically right after
    -- a connector sweep (etl.orchestrator.run_all_connectors), so an
    -- operator can join back to exactly which ingestion run preceded it.
    connector_run_id  BIGINT       REFERENCES connector_runs(id) ON DELETE SET NULL,
    started_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ,
    duration_ms       INTEGER,
    status            TEXT         NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','failed')),
    pairs_compared    INTEGER,
    merged            INTEGER,
    suggested         INTEGER,
    conflicts         INTEGER,
    error_msg         TEXT
);

CREATE INDEX IF NOT EXISTS idx_dedup_runs_started_at ON dedup_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dedup_runs_connector_run_id ON dedup_runs (connector_run_id);

-- Issue #99: an explicit, operator-visible override on top of issue #71's
-- union-of-active-profiles scope derivation. A connector with no row here
-- (the common case — this table starts empty) keeps #71's default
-- behavior unchanged. A row's presence is what an operator toggles from
-- the connector-management UI (#100), not a config file, so it survives
-- container restarts and is queryable by the same dashboard that renders
-- it.
--
--   enabled = false            -> orchestrator skips this connector
--                                  entirely, before ever deriving a scope
--                                  or calling discover() (never counted
--                                  as ok/failed in connector_runs).
--   geography_override IS NULL -> scope still comes from the union of
--                                  active search_profile rows (#71's
--                                  default), even with a row present here
--                                  (e.g. a row that only sets `filters`).
--   geography_override set     -> {"center": [lat, lon], "radius_km": n},
--                                  same shape as search_profile.scope.geography
--                                  (dashboard/lib/profiles-schema.ts) —
--                                  used INSTEAD of the profile union for
--                                  this connector, e.g. an operator
--                                  broadening ingestion ahead of profiles
--                                  that don't exist yet.
--   filters                    -> a flexible bag of connector-specific
--                                  native site filters (e.g. {"rooms": 2}
--                                  for fotocasa — an EXACT-match filter on
--                                  Fotocasa's side, confirmed live, hence
--                                  `rooms` not `min_rooms`), not a fixed column
--                                  per site-per-filter — issue #99 only
--                                  confirmed one filter dimension
--                                  (Fotocasa room count) as real via live
--                                  verification; price/property-type and
--                                  Milanuncios' equivalent are still
--                                  unconfirmed (docs/architecture/connectors.md),
--                                  so this stays additive rather than a
--                                  schema migration per future finding.
--                                  A connector that doesn't recognise a
--                                  key in here ignores it, it doesn't
--                                  error — see etl/orchestrator.py.
--   min_refetch_interval_seconds -> issue #143's fetch-budget override: a
--                                  dedicated column, not folded into
--                                  `filters`, because it's a
--                                  framework-level fetch-economics knob
--                                  (how often to re-fetch an already-known
--                                  listing), not a native site filter
--                                  (what discover() asks the site for) —
--                                  same category as `enabled`, not
--                                  `filters`. NULL (the default for every
--                                  row, including ones seeded by
--                                  sync_connector_registry) means "no
--                                  override, use this connector's
--                                  Connector.min_refetch_interval_seconds
--                                  class attribute" — see
--                                  etl.orchestrator._scopes_for_connector.
CREATE TABLE IF NOT EXISTS connector_config (
    connector_name      TEXT         PRIMARY KEY,
    enabled              BOOLEAN      NOT NULL DEFAULT true,
    geography_override   JSONB,
    filters              JSONB        NOT NULL DEFAULT '{}'::jsonb,
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE connector_config ADD COLUMN IF NOT EXISTS min_refetch_interval_seconds INTEGER;

-- Issue #295 (D-050): per-connector override for the freshness cadence — how
-- often this connector's data should be re-refreshed. NULL (the default for
-- every row, including ones seeded by sync_connector_registry) means "no
-- override, use the global etl.default_freshness_interval_hours (config/
-- schema.yaml, 24h)", NOT "no freshness tracking" — a connector with a NULL
-- override is still fully in the cadence machinery, just at the default
-- interval. Same override-vs-global-default shape as
-- min_refetch_interval_seconds above (issue #143), reused rather than
-- inventing a second pattern. Unlike geography_override/filters, this is a
-- framework-level scheduling knob, valid even for capture-only
-- (supports_discovery=false) connectors — it doubles as the staleness window
-- #289's manual-capture UI should read (converted to days), so the PATCH route
-- must accept it for capture-only connectors too (Phase 2).
ALTER TABLE connector_config ADD COLUMN IF NOT EXISTS freshness_interval_hours INTEGER;

-- Issue #263: capture PROCESSING is gated on THIS flag, not the crawl
-- `enabled` flag above. The two are deliberately independent.
--
-- A capture-only portal (Idealista, Aliseda, Cimenta2) is WAF-blocked to
-- automated crawling (D-019), so its `enabled` is set false on purpose to
-- keep the doomed nightly crawl from ever running. But capture is those
-- portals' ONLY ingestion path — the owner browses them with the extension
-- and the HTML is queued in `extension_capture`. Before this column, the
-- capture poller (etl/capture.py) gated processing on `enabled`, so those
-- captures sat `pending` forever: the flag that silences the doomed crawl
-- also silently killed the extension's whole purpose (issue #263 incident,
-- 2026-08-05).
--
-- `capture_enabled` is the independent knob: the poller checks it, never
-- `enabled`. Enabling capture never arms the crawl; disabling the crawl
-- never blocks capture. Default TRUE (and TRUE for every existing row this
-- ALTER backfills) so a newly-registered capture-only connector processes
-- captures out of the box — this incident must never recur for a third
-- portal. It stays operator-controllable so a misbehaving capture connector
-- can still be paused (capture_enabled=false) without touching code.
--
-- No one-time UPDATE seeds idealista/aliseda/cimenta2 to true: the
-- `NOT NULL DEFAULT true` above already backfills every existing row when the
-- column is first added, so there is no pre-existing `false` to migrate. And
-- init.sql is re-applied on EVERY ETL container startup (etl/main.py's
-- _init_schema), so any `UPDATE ... SET capture_enabled = true` here would
-- silently un-pause a connector the operator deliberately paused via the UI on
-- the very next redeploy — the exact silent-reset footgun this PR exists to
-- remove, and strictly worse than the crawl `enabled` flag (protected by
-- sync_connector_registry's ON CONFLICT DO NOTHING). An operator's
-- capture_enabled=false must survive restarts, so it is never re-asserted.
ALTER TABLE connector_config ADD COLUMN IF NOT EXISTS capture_enabled BOOLEAN NOT NULL DEFAULT true;

-- Issue #100: what connectors *exist*, as opposed to connector_config's
-- "how is this one configured". The connector management UI has to list
-- every registered connector — including ones with no connector_config
-- row and no run history yet — but the registry itself
-- (etl/connectors/__init__.py's register_all() -> orchestrator.CONNECTORS)
-- lives in Python, and the dashboard is TypeScript in a separate
-- container with no shared filesystem or RPC channel.
--
-- Three ways to bridge that were considered:
--   1. Hardcode the connector list in TypeScript. Rejected: two sources of
--      truth for "which connectors exist", silently drifting the moment
--      anyone adds a connector in Python without remembering to edit a TS
--      constant — exactly the class of bug this project keeps finding.
--   2. Derive the list from connector_run_results history. Rejected: a
--      newly-added connector, or one an operator disabled before it ever
--      ran, would be invisible in the UI — including the "everything is
--      off until I configure it" state the owner explicitly asked for.
--   3. (chosen) The ETL upserts its own registry here at startup. The
--      Python registry stays the single source of truth, the dashboard
--      reads real rows, and adding a connector in Python makes it appear
--      in the UI with no TypeScript change at all. Same "signal via a
--      Postgres row" pattern this codebase already uses for
--      etl_manual_trigger and extension_capture rather than inventing
--      cross-container HTTP.
--
-- Written by etl/orchestrator.sync_connector_registry(), called from
-- etl/main.py after register_all(). Rows are never deleted by that sync:
-- a connector removed from the Python registry keeps its row (marked
-- registered=false) so its historical runs still resolve to a name in the
-- UI instead of rendering as an orphan id.
CREATE TABLE IF NOT EXISTS connector_registry (
    connector_name            TEXT         PRIMARY KEY,
    -- false once a connector disappears from the Python registry (renamed,
    -- retired) — distinct from connector_config.enabled, which is an
    -- operator's deliberate "don't run this", not "this no longer exists".
    registered                BOOLEAN      NOT NULL DEFAULT true,
    rate_limit_per_minute     INTEGER,
    discovers_full_inventory  BOOLEAN,
    -- Whether this connector's discover() can ever run at all. Idealista
    -- is capture-only (issue #75): scope_key() always returns None, so the
    -- orchestrator skips it every sweep by design. The UI needs to render
    -- that as "capture-only, nothing to schedule" rather than offering
    -- geography/filter controls that would silently do nothing.
    supports_discovery        BOOLEAN      NOT NULL DEFAULT true,
    -- Native site-filter keys this connector actually honours in
    -- discover(), as a JSON array (e.g. ["rooms"] for fotocasa). Issue #99
    -- only confirmed one filter dimension as real via live verification;
    -- the UI renders a control per key listed here and nothing for a
    -- connector with an empty list, so an unconfirmed filter never ships
    -- as a control that appears to work but doesn't.
    supported_filters         JSONB        NOT NULL DEFAULT '[]'::jsonb,
    updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Issue #217 (D-030): per-(connector, scope) "when did this geography last
-- actually get a discover() attempt" bookkeeping — what makes scope
-- ordering fair across runs instead of a fixed list order that lets
-- whichever scope sorts first monopolize the shared circuit breaker's
-- error budget forever (see run_all_connectors' scope-ordering comment).
--
-- One row per (connector_name, scope_key) that has EVER reached the point
-- of being attempted this run — i.e. `run_connector` was actually called
-- for it, regardless of whether that attempt succeeded, errored, or was
-- cut short by the breaker tripping partway through it. A scope with no
-- row here (or whose row's `last_attempted_at` sorts earliest) is treated
-- as highest priority for the NEXT run — which is what guarantees a
-- brand-new profile's geography, appearing for the first time, sorts
-- ahead of every scope that already got a turn.
--
-- Deliberately keyed by scope_key (a connector's own resolved-geography
-- string, e.g. Fotocasa's city slug), not by search_profile.id: two
-- profiles that resolve to the same city must share one fairness slot
-- (matching `seen_scope_keys`'s existing per-run dedup), and a profile
-- getting archived/re-created shouldn't reset a city's fairness history.
--
-- A row exists for every scope this connector has ever been able to
-- RESOLVE (scope_key() returned non-None = "I cover this geography"),
-- which is deliberately broader than "has been attempted":
--
--   last_attempted_at IS NULL      -> covered, but has never had its turn yet
--                                     (created by the skipped-for-budget path)
--   last_attempted_at IS NOT NULL  -> we TRIED at least once; says nothing
--                                     about whether the try worked
--   last_discovered_at IS NOT NULL -> a discover() for this scope actually
--                                     SUCCEEDED at least once
--
-- That NULL state is what makes issue #217's third acceptance criterion
-- answerable from data rather than from free-text: "your area is covered,
-- it just hasn't been crawled yet" is a row with a NULL last_attempted_at,
-- while "your area isn't covered by this connector at all" has no row here
-- at all (scope_key() returned None, so there is no key to store).
--
-- last_attempted_at and last_discovered_at are deliberately SEPARATE columns
-- (PR #228 review, finding 1). Fairness ordering needs failures to count as
-- attempts, or a permanently-broken scope wins the front of the queue
-- forever; the user-facing coverage claim needs the exact opposite, or the
-- dashboard tells someone "this area was crawled on <date>" about a scope
-- whose discover() has raised on every run since it was created. One column
-- cannot carry both meanings, so it no longer tries to.
--
-- coverage_center_lat/coverage_center_lon/coverage_radius_km describe WHAT
-- WAS ACTUALLY CRAWLED, so a consumer that only knows a lat/lon (the
-- dashboard's zero-candidate diagnostic, issue #194) can ask "has any
-- connector ever crawled a scope covering this point" without reimplementing
-- each connector's Python-side geography resolution.
--
-- These are NOT the profile's own center/radius (PR #228 review, finding 2).
-- A ConnectorScope's radius_km only TIGHTENS which listings match; it never
-- widens what gets crawled, and it is allowed up to 200 km. Storing it here
-- claimed a 200 km disc for a crawl that covered one municipality — which
-- reported "crawled" for Estepona, 117.8 km from a Dos Hermanas scope that
-- had never looked at it. The columns now hold the RESOLVED PLACE's own
-- centroid plus a deliberately conservative municipal extent, so the circle
-- under-reports rather than over-reports. Nullable: a scope with no center,
-- or whose center resolves to no place at all, gets no circle and therefore
-- never contributes a coverage claim.
CREATE TABLE IF NOT EXISTS connector_scope_state (
    connector_name    TEXT         NOT NULL,
    scope_key         TEXT         NOT NULL,
    last_attempted_at TIMESTAMPTZ  NOT NULL,
    PRIMARY KEY (connector_name, scope_key)
);

-- The CREATE above is the original (issue #217 first-draft) shape, kept for
-- a correct history on a fresh install; these ALTERs are the current truth.
-- Idempotent (init.sql is re-applied on every ETL start).
ALTER TABLE connector_scope_state ALTER COLUMN last_attempted_at DROP NOT NULL;
-- When a discover() for this scope last SUCCEEDED (NULL = never succeeded,
-- whether or not it was ever attempted). This, not last_attempted_at, is
-- what may be reported to a user as "this area was crawled".
ALTER TABLE connector_scope_state ADD COLUMN IF NOT EXISTS last_discovered_at TIMESTAMPTZ;
-- PR #228 review, finding 2: the pre-review columns (center_lat/center_lon/
-- radius_km) held the PROFILE's search circle, which is not what any
-- connector crawls. Dropped rather than renamed-in-place: their stored
-- values are coverage claims the ETL was never able to vouch for, so
-- carrying them forward under a new name would preserve exactly the wrong
-- answers. Every row repopulates its new columns on the scope's next
-- attempt or budget-skip. (AGENTS.md: break it by default — no deployment
-- to keep compatible with.)
ALTER TABLE connector_scope_state DROP COLUMN IF EXISTS center_lat;
ALTER TABLE connector_scope_state DROP COLUMN IF EXISTS center_lon;
ALTER TABLE connector_scope_state DROP COLUMN IF EXISTS radius_km;
ALTER TABLE connector_scope_state ADD COLUMN IF NOT EXISTS coverage_center_lat DOUBLE PRECISION;
ALTER TABLE connector_scope_state ADD COLUMN IF NOT EXISTS coverage_center_lon DOUBLE PRECISION;
ALTER TABLE connector_scope_state ADD COLUMN IF NOT EXISTS coverage_radius_km  DOUBLE PRECISION;
-- When this scope was last passed over because the shared circuit breaker
-- was already open (NULL = never skipped for budget). Kept alongside
-- last_attempted_at rather than replacing it: a scope can legitimately have
-- both (crawled three runs ago, skipped for budget on the two runs since).
ALTER TABLE connector_scope_state ADD COLUMN IF NOT EXISTS last_skipped_for_budget_at TIMESTAMPTZ;
-- Covers the dashboard diagnostic's "is this point inside any crawled
-- scope" lookup, which filters on a non-NULL center before doing any
-- haversine arithmetic.
DROP INDEX IF EXISTS idx_connector_scope_state_center;
CREATE INDEX IF NOT EXISTS idx_connector_scope_state_coverage_center
    ON connector_scope_state (coverage_center_lat, coverage_center_lon)
    WHERE coverage_center_lat IS NOT NULL AND coverage_center_lon IS NOT NULL;

-- Issue #217: the structured counterpart to error_msg's human-readable
-- "skipped for budget (...)" text. One JSON array per run row:
--   [{"scope": "estepona", "reason": "budget"}, ...]
-- `reason` is one of:
--   'budget'       covered, never got its turn — the shared breaker was
--                  already open before this scope was reached
--   'uncovered'    scope_key() returned None; issue #177's case
--   'unresolvable' scope_key() returned the `unresolvable-geography:`
--                  sentinel — discover() raises for it on every run by
--                  construction, so more budget would never help
-- Before this, all of them looked identical from outside — a consumer had
-- to string-match error_msg to tell "we ran out of budget before reaching
-- your profile" from "your profile's geography isn't covered at all".
ALTER TABLE connector_run_results ADD COLUMN IF NOT EXISTS skipped_scopes JSONB;

-- ============================================================
-- Typed failure classification + resolved geography scope
-- (issues #242 + #109, D-079)
-- ============================================================
--
-- Two columns landed together in one migration window because both hang off
-- the SAME write site (etl.orchestrator._record_connector_result) and the same
-- table — the roadmap (docs/roadmap/connector-etl-ops.md §4/§109) explicitly
-- asked for them to be coordinated so this table isn't migrated twice in a row.
--
-- 1. failure_classification (#242): the typed, trend-analyzable counterpart to
--    error_msg's free text. Today an operator can only tell WHY a connector
--    result is not clean by string-matching prose; this makes the failure kind
--    a queryable enum (feeds #171 trend analysis). NULL means "no notable
--    failure signal" — a clean run that actually ingested data. The taxonomy is
--    grounded in what the orchestrator already distinguishes at write time (the
--    SoftBlockError / UnresolvableGeographyError / fatal-ConnectorError /
--    scope_key()-None / circuit-breaker paths in run_all_connectors), a
--    superset of #242's proposed soft_block/structure_change/network/uncovered/
--    other:
--      'soft_block'       site rate-throttling / bot-mitigation wall
--                         (SoftBlockError, soft-block breaker trip, or
--                         soft-block fetch errors) — a clean budget backoff,
--                         so this is recorded even on an 'ok' status row.
--      'network'         a fatal ConnectorError whose message looks like a
--                         connection/timeout/DNS/TLS failure.
--      'structure_change' a fatal ConnectorError whose message looks like a
--                         parse/markup/JSON break, OR a circuit_open driven by
--                         genuine fatal errors ("the site changed / is down").
--      'unresolvable'    UnresolvableGeographyError — a profile centre that
--                         matches no place in the gazetteer at all.
--      'uncovered'       scope_key() returned None — this connector covers no
--                         target for the scope (issue #177), and nothing else
--                         this run succeeded.
--      'empty_result'    every scope ran cleanly but discovered zero listings.
--      'other'           a fatal failure that matched none of the above.
--    A CHECK keeps the column honest; NULL is always allowed. Idempotent:
--    DROP-then-ADD the named constraint so re-applying init.sql is a no-op.
-- 2. geography_scope (#109): the resolved scope(s) this run actually ran
--    against — the audit trail #109 asked for so a surprising result can be
--    traced to the exact geography/filters used, not reverse-engineered from
--    error_msg. JSONB array, one entry per resolved ConnectorScope (fairness-
--    ordered as the run walked them), each:
--      {"scope_key": <site key or null>, "center": [lat, lon] | null,
--       "radius_km": <n> | null, "rooms": <n> | null, "outcome": <str>}
--    `outcome` records what happened to that specific geography this run:
--    'crawled' / 'empty' / 'uncovered' / 'unresolvable' / 'budget' /
--    'soft_block' / 'fresh_this_cycle' / 'duplicate' / 'failed'. This is what
--    lets an operator see, per geography, "disabled-scope vs no-resolvable-
--    scope"-style distinctions (#109 AC): 'uncovered' and 'unresolvable' are
--    structurally different outcomes for the same city, no longer collapsed
--    into one label. NULL only when the row somehow ran with zero scopes
--    (the orchestrator emits no row at all for the disabled / no-scope cases,
--    per issue #292/#71 — so on any real row this is a non-empty array).
ALTER TABLE connector_run_results
    ADD COLUMN IF NOT EXISTS failure_classification TEXT;
ALTER TABLE connector_run_results
    DROP CONSTRAINT IF EXISTS connector_run_results_failure_classification_check;
ALTER TABLE connector_run_results
    ADD CONSTRAINT connector_run_results_failure_classification_check
    CHECK (failure_classification IS NULL OR failure_classification IN (
        'soft_block', 'network', 'structure_change', 'unresolvable',
        'uncovered', 'empty_result', 'other'
    ));
ALTER TABLE connector_run_results ADD COLUMN IF NOT EXISTS geography_scope JSONB;

-- One-time best-effort backfill (#242): classify pre-existing rows from their
-- status + error_msg prose so history is trend-analyzable too. Only ever fills
-- NULLs (idempotent — re-runs to a no-op once every row is classified, and it
-- never overwrites a value the orchestrator wrote). 'skipped' rows are left
-- NULL: a disabled/omitted connector is not a failure. Ordered most- to
-- least-specific; the first matching CASE branch wins. This is deliberately
-- coarse — the orchestrator writes the precise value going forward.
UPDATE connector_run_results
   SET failure_classification = CASE
       WHEN error_msg ILIKE '%unresolvable geography%' THEN 'unresolvable'
       WHEN error_msg ILIKE '%resolved but uncovered%'
            OR error_msg ILIKE '%no known coverage%' THEN 'uncovered'
       WHEN error_msg ILIKE '%bloqueo temporal%'
            OR error_msg ILIKE '%rate-throttl%'
            OR error_msg ILIKE '%soft-block%'
            OR error_msg ILIKE '%presupuesto%' THEN 'soft_block'
       WHEN status = 'circuit_open' THEN 'structure_change'
       WHEN status = 'failed' AND (
                error_msg ILIKE '%timeout%'
                OR error_msg ILIKE '%timed out%'
                OR error_msg ILIKE '%connection%'
                OR error_msg ILIKE '%could not connect%'
                OR error_msg ILIKE '%refused%'
                OR error_msg ILIKE '%unreachable%'
                OR error_msg ILIKE '%name resolution%'
                OR error_msg ILIKE '%DNS%'
                OR error_msg ILIKE '%SSL%'
            ) THEN 'network'
       WHEN status = 'failed' AND (
                error_msg ILIKE '%parse%'
                OR error_msg ILIKE '%JSON%'
                OR error_msg ILIKE '%HTML%'
                OR error_msg ILIKE '%selector%'
                OR error_msg ILIKE '%marker%'
                OR error_msg ILIKE '%NoneType%'
                OR error_msg ILIKE '%KeyError%'
                OR error_msg ILIKE '%structure%'
            ) THEN 'structure_change'
       WHEN status = 'failed' THEN 'other'
       ELSE NULL
   END
 WHERE failure_classification IS NULL
   AND status IN ('failed', 'circuit_open');

-- ============================================================
-- Run-level extraction-quality aggregate + trend (issue #171, D-086)
-- ============================================================
--
-- The per-listing extraction-quality grade (issue #80, D-084) lives on
-- listing.raw_extra.extraction_quality — the right signal for a human
-- inspecting ONE property, but it cannot answer the question an operator
-- watching the monitor has: is a connector's extraction quality DEGRADING in
-- aggregate, run over run, before it becomes a wall of individually-thin
-- listings? A connector can partially break (a site renames one JSON key, one
-- selector goes stale) and — thanks to first_present()'s deliberate
-- fallback-chain design (#77) — keep reporting status='ok' with zero fetch
-- errors while more listings quietly fall through to a weaker fallback. Nothing
-- fails, nothing trips the breaker, nothing is queryable.
--
-- This column is that queryable signal. At _record_connector_result time the
-- orchestrator folds the per-listing scores of exactly the listings THIS run
-- produced (source = connector, last_fetched_at >= run start) into one summary
-- and attaches a run-over-run degradation trend vs the connector's trailing
-- baseline. It REUSES #80's stored scores — it never recomputes or redefines
-- the scoring. Shape:
--     {"n": <int>,
--      "mean_score": <weighted-completeness fraction 0..1>,
--      "grade_histogram": {"A": n, "B": n, "C": n, "F": n},
--      "low_quality_count": <int, grades C+F>,
--      "weights_version": <int | null>,
--      "trend": {"baseline_mean": <0..1 | null>, "baseline_n_runs": <int>,
--                "delta": <current - baseline | null>, "degraded": <bool>}}
-- NULL — not an empty object — on a run that produced no scored listings (a
-- failed/empty run, or one that only skip-if-seen'd), so
-- `WHERE extraction_quality_summary IS NOT NULL` stays a usable filter and a
-- fetch-nothing run never fabricates a quality number. Additive + idempotent
-- (ADD COLUMN IF NOT EXISTS); old rows stay NULL and are naturally re-populated
-- as each connector runs again — no backfill query is possible or wanted (the
-- per-run listing set a historical row aggregated is not reconstructable after
-- the fact, since listing.last_fetched_at has since moved on).
ALTER TABLE connector_run_results ADD COLUMN IF NOT EXISTS extraction_quality_summary JSONB;

-- ============================================================
-- Connector freshness cadence (issue #295, D-050)
-- ============================================================
--
-- Per-connector "how fresh do I want this data" scheduling, layered ON TOP of
-- the hourly scheduler tick (which stays hourly, unchanged). The scheduler
-- keeps running often; a connector only STARTS a refresh cycle when it's due
-- (its data is older than its interval), then CONTINUES that same cycle across
-- as many ticks as needed (budget caps, rate limits, the shared circuit
-- breaker tripping mid-sweep) until every currently-covered scope has been
-- re-discovered = fresh, then waits out the interval before starting again.
--
-- The ONLY genuinely new per-connector state is the two-column cycle marker
-- (last_fresh_at + cycle_started_at). "Which scopes still need doing this
-- cycle" is NOT stored here — it's a live query against the existing
-- connector_scope_state table (issue #217/D-030): a scope is "done this cycle"
-- iff its last_discovered_at >= cycle_started_at. That is why no new per-scope
-- progress table exists: connector_scope_state already records exactly when
-- each scope was last confirmed discovered.
--
-- Crash safety falls out for free: a process that dies mid-cycle leaves
-- cycle_started_at set and connector_scope_state exactly as of the last
-- committed scope. Resuming after a restart is just "the next tick sees
-- cycle_started_at IS NOT NULL and continues" — there is no 'running' status to
-- wedge (unlike connector_runs/dedup_runs, which need _reconcile_stale_runs),
-- only a timestamp plus a live query against durable per-scope state.
--
--   last_fresh_at            -> when the last full cycle completed. NULL =
--                               never completed a cycle = due immediately (same
--                               NULL-means-never-happened posture as every
--                               other timestamp column in this schema; no
--                               backfill needed).
--   cycle_started_at         -> non-NULL WHILE a cycle is in progress, NULL when
--                               idle/waiting for the next due time. The single
--                               "in progress" marker; continuation is
--                               unconditional once it's set (the interval only
--                               gates STARTING a new cycle, never abandoning one
--                               partway through).
--   cycle_target_scope_count -> observability snapshot taken at cycle start
--                               (how many resolvable scopes this cycle set out
--                               to cover); NOT used in completion logic, which
--                               recomputes the live target set each tick.
--
-- A cycle whose cycle_started_at is older than
-- etl.freshness_cycle_stuck_after_hours (default 7d) is DERIVED as "stuck" for
-- observability (a connector that can never fully refresh, e.g. Fotocasa
-- tripping the breaker every tick — #270). Stuck is NEVER force-completed: it
-- reads as "still refreshing, taking unusually long" forever, never falsely
-- fresh. There is deliberately no stored `stuck` column — the age of
-- cycle_started_at IS the signal, computed by the consumer (Phase 2).
CREATE TABLE IF NOT EXISTS connector_freshness_state (
    connector_name           TEXT         PRIMARY KEY,
    last_fresh_at            TIMESTAMPTZ,
    cycle_started_at         TIMESTAMPTZ,
    cycle_target_scope_count INTEGER,
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Browser-extension listing capture (issue #75): a queue table, not a
-- synchronous request/response — the dashboard (Node/TypeScript) and the
-- ETL orchestrator (Python, where the Idealista connector's normalize()
-- and the shared extraction.py fallback-chain helper live) run in
-- separate containers with no shared filesystem or RPC channel. This
-- mirrors the same "signal via a Postgres row" pattern this project
-- already uses for etl_manual_trigger (force-resync) rather than
-- inventing cross-container HTTP or duplicating the Idealista field
-- mapping in TypeScript (which issue #75 explicitly wants to avoid — a
-- future automated Idealista connector, if one ever becomes viable, must
-- share one source of truth with this capture path, not a second,
-- drifting implementation).
--
-- Flow: POST /api/extension/capture inserts a 'pending' row and returns
-- immediately; etl/capture.py's background poll (started alongside the
-- connector scheduler loop, etl/main.py) picks it up, runs the matching
-- connector's normalize() + the same _upsert_canonical_listing() the
-- automated sweep uses, and marks the row 'done'/'failed'. The dashboard
-- polls GET /api/extension/capture/[id] for the result.
CREATE TABLE IF NOT EXISTS extension_capture (
    id               BIGSERIAL    PRIMARY KEY,
    url              TEXT         NOT NULL,
    -- Nullable, not NOT NULL: nulled out once a capture reaches 'done' —
    -- the raw HTML is only useful transiently, for debugging a failed
    -- parse; keeping every full page capture forever is unbounded storage
    -- growth for data with no ongoing value (Opus review, PR #87). A
    -- 'failed' row keeps its html for debugging.
    html             TEXT,
    connector_name   TEXT,
    -- 'listing' (issue #292): the captured page was a SEARCH/results listing
    -- page, not a detail page — a clean, informational outcome (its detail
    -- links are harvested into capture_worklist), NOT a failure. 'failed' is
    -- reserved for genuinely broken DETAIL captures.
    status           TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','listing')),
    error_msg        TEXT,
    property_id      BIGINT       REFERENCES property(id),
    listing_id       BIGINT       REFERENCES listing(id),
    fields_extracted INTEGER,
    fields_available INTEGER,
    title            TEXT,
    price_display    TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    processed_at     TIMESTAMPTZ
);

-- The poll query is `WHERE status = 'pending' ORDER BY created_at`; a
-- partial index keeps this cheap forever regardless of how many
-- done/failed rows accumulate (they're never re-scanned by the poll).
CREATE INDEX IF NOT EXISTS idx_extension_capture_pending
    ON extension_capture (created_at) WHERE status = 'pending';

-- Migration (issue #292): widen the status CHECK to admit 'listing'. A DB
-- created before #292 carries the three-value constraint under its default
-- name (extension_capture_status_check); CREATE TABLE IF NOT EXISTS above
-- never alters an existing table, so drop-and-re-add here. init.sql re-applies
-- on every ETL boot, so this must be idempotent: DROP IF EXISTS then ADD is a
-- no-op-safe pair. No data rewrite — 'listing' only widens the allowed set.
ALTER TABLE extension_capture DROP CONSTRAINT IF EXISTS extension_capture_status_check;
ALTER TABLE extension_capture ADD CONSTRAINT extension_capture_status_check
    CHECK (status IN ('pending','done','failed','listing'));

-- One-time migration (issue #292): drop the per-sweep 'disabled via
-- connector_config' rows that issue #99 wrote to connector_run_results for
-- every disabled connector on every sweep (~63 rows / 8 connectors). A
-- deliberately-disabled connector no longer emits a result row (see
-- etl/orchestrator.py run_all_connectors); this clears the historical noise
-- so the ETL health surface is green unless something is genuinely broken.
-- Idempotent by construction — a plain DELETE re-runs to a no-op once the rows
-- are gone. Only the exact orchestrator-written marker is matched, so a
-- user-authored row could never be touched. The historical
-- connector_runs.connectors_skipped counters are left as-is (past aggregates).
DELETE FROM connector_run_results
 WHERE status = 'skipped'
   AND error_msg = 'disabled via connector_config';


-- ============================================================
-- Guided capture worklist (issue #237)
-- ============================================================
--
-- The "page with all the places to visit one by one" the owner asked for.
-- It sits entirely UPSTREAM of the extension-capture pipeline
-- (extension_capture above) — it is a *producer of URLs for the human to
-- open*, never a gate on ingestion. A capture whose URL is not in this
-- table still processes normally (see etl/capture.py); the worklist only
-- remembers what is left to visit and tracks per-URL progress.
--
-- Seeding: manual paste today (Aliseda has no usable sitemap — its only
-- host that serves listing data is robots.txt `Disallow: /`, see D-019),
-- so a URL arrives here via the dashboard worklist page
-- (POST /api/etl/worklist, added_via='manual'). 'sitemap'/'derived' are
-- reserved for portals that later gain those seeding paths (issue #237 §2)
-- — the column exists now so no migration is needed when they do.
--
-- Correlation: etl/capture.py, after a successful capture reaches 'done',
-- flips the matching worklist row to 'captured' and records which capture
-- satisfied it (matched_capture_id). Matching is by `match_key`, a
-- cosmetic-difference-tolerant canonical form of the URL (host without
-- www + path without trailing slash, scheme/query/fragment dropped) so a
-- capture of `https://www.alisedainmobiliaria.com/inmueble/ANT1/` still
-- correlates to a worklist row seeded as
-- `http://alisedainmobiliaria.com/inmueble/ANT1`. The identical
-- canonicalisation runs in two places — dashboard/lib/worklist.ts
-- (`worklistMatchKey`, at seed time) and etl/capture.py
-- (`worklist_match_key`, at correlation time) — kept in lockstep by a
-- shared table of (input -> expected) cases asserted in BOTH test suites.
CREATE TABLE IF NOT EXISTS capture_worklist (
    id                 BIGSERIAL    PRIMARY KEY,
    -- The URL as the operator entered it — this is what the worklist page's
    -- "Abrir" link opens, so it is preserved verbatim (case, scheme, query),
    -- NOT rewritten to its canonical form.
    url                TEXT         NOT NULL,
    -- Canonical correlation key (see table comment). UNIQUE so re-pasting or
    -- re-seeding the same listing is idempotent (ON CONFLICT DO NOTHING) and
    -- so a capture maps to at most one worklist row.
    match_key          TEXT         NOT NULL UNIQUE,
    source_portal      TEXT         NOT NULL,
    -- 'stale' (issue #273): a sitemap-seeded row whose listing has since
    -- vanished from the portal's sitemap (sold/delisted). Set by the reseed
    -- reconciliation in etl/worklist_seed.py, distinct from 'skipped' (owner
    -- choice) and 'failed' (a capture was attempted and didn't land). Excluded
    -- from the "Abrir siguiente pendiente" pool.
    status             TEXT         NOT NULL DEFAULT 'pending'
                                    CONSTRAINT capture_worklist_status_check
                                    CHECK (status IN ('pending','captured','failed','skipped','stale')),
    added_via          TEXT         NOT NULL DEFAULT 'manual'
                                    CHECK (added_via IN ('sitemap','manual','derived')),
    -- The portal's own asset id, parsed from the URL slug at seed time
    -- (issue #260). Populated for sitemap-seeded rows (e.g. Cimenta2's
    -- Salesforce record id); NULL for manually-pasted rows whose portal has
    -- no stable id convention. Purely informational here — correlation is by
    -- `match_key`, never by this — but it lets Phase B/E key a captured row
    -- back to the portal's catalogue without re-parsing the URL.
    external_id        TEXT,
    note               TEXT,
    -- Which extension capture satisfied this row (NULL until captured).
    matched_capture_id BIGINT       REFERENCES extension_capture(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Per-portal status roll-ups ("Aliseda: 12/40 captured") are the worklist
-- page's headline query — a composite index keeps them cheap as the list
-- grows to thousands of rows.
CREATE INDEX IF NOT EXISTS idx_capture_worklist_portal_status
    ON capture_worklist (source_portal, status);

-- Reuse the generic set_updated_at() trigger function (defined near the
-- top of this file, on `property`) so updated_at stays accurate on every
-- status transition without each writer having to remember to set it.
DROP TRIGGER IF EXISTS trg_capture_worklist_set_updated_at ON capture_worklist;
CREATE TRIGGER trg_capture_worklist_set_updated_at
    BEFORE UPDATE ON capture_worklist
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Forward-compat: an older DB may already have capture_worklist without the
-- sitemap-seeding column (issue #260). IF NOT EXISTS keeps this idempotent.
ALTER TABLE capture_worklist ADD COLUMN IF NOT EXISTS external_id TEXT;

-- Migration (issue #273): widen the status CHECK to admit 'stale'. A DB created
-- before #273 carries the four-value constraint under its default name
-- (capture_worklist_status_check); CREATE TABLE IF NOT EXISTS above never alters
-- an existing table, so drop-and-re-add here. init.sql is re-applied on every
-- ETL boot, so this must be idempotent: DROP IF EXISTS then ADD is a no-op-safe
-- pair (Postgres has no ADD CONSTRAINT IF NOT EXISTS for CHECKs). No data
-- rewrite — 'stale' only widens the allowed set, so every existing row still
-- satisfies it.
ALTER TABLE capture_worklist DROP CONSTRAINT IF EXISTS capture_worklist_status_check;
ALTER TABLE capture_worklist ADD CONSTRAINT capture_worklist_status_check
    CHECK (status IN ('pending','captured','failed','skipped','stale'));

-- ── Worklist sitemap-seed trigger (issue #260) ──────────────────────────────
-- The same "queue table, not a synchronous call" transport the dashboard uses
-- for ad-hoc connector runs (etl_manual_trigger) and extension captures: the
-- worklist page's "Refrescar sitemap" button can't run a sitemap sweep in
-- process — that's Python in a separate container — so it writes a row here
-- and etl/worklist_seed.py's poll loop picks it up, fetches the portal's
-- public sitemap (ONE static GET, discovery-only — never a listing/detail page
-- or the guest RPC; D-034/D-035), and upserts `pending` `sitemap` worklist
-- rows. A deliberately separate table from etl_manual_trigger: that one's
-- single-pending-row index and connector-name validation are about connector
-- sweeps, and a worklist seed must not block (or be blocked by) one.
CREATE TABLE IF NOT EXISTS capture_worklist_seed_trigger (
    id            SERIAL       PRIMARY KEY,
    source_portal TEXT         NOT NULL,
    status        TEXT         NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','running','done','failed')),
    requested_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    picked_up_at  TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    -- How many NEW worklist rows the seed inserted (upsert ignores dupes).
    added_count   INTEGER,
    error_msg     TEXT,
    triggered_by  TEXT
);

-- At most one pending seed per portal at a time, so a double-click (or the UI
-- polling and re-posting) is idempotent: the second INSERT trips this and the
-- route reports the already-queued one (same posture as etl_manual_trigger).
CREATE UNIQUE INDEX IF NOT EXISTS idx_worklist_seed_trigger_single_pending
    ON capture_worklist_seed_trigger (source_portal) WHERE status = 'pending';

-- Supports frequent polling/claim of the oldest pending seed request.
CREATE INDEX IF NOT EXISTS idx_worklist_seed_trigger_pending
    ON capture_worklist_seed_trigger (requested_at, id) WHERE status = 'pending';


-- ── Capture-task last-run ledger (issue #289) ───────────────────────────────
-- The task-driven Captura page (/captura) shows one openable capture TASK per
-- (profile × portal × searchable section) — the deterministic `tasks[]` shape
-- from the search-url builder (GET /api/profiles/[id]/search-urls). Each task
-- has a stable `task_id` derived from the profile+filters, so "when did I last
-- run this exact task" is a single fact keyed by (profile_id, task_id).
--
-- A row is upserted every time the operator executes a task (the button POSTs
-- before opening the portal). `last_run_at` drives the staleness window in the
-- UI: a task run within its window is greyed out (not due); once the window
-- elapses it returns to full colour (due again). Graying is a visual cue only,
-- never a block — the operator can always re-run, which just bumps last_run_at.
--
-- No status/outcome column: this is a "last touched" ledger, not a capture
-- result (capture outcomes live in capture_worklist / extension_capture). ON
-- DELETE CASCADE so deleting a profile drops its task-run history with it.
CREATE TABLE IF NOT EXISTS capture_task_run (
    profile_id   BIGINT       NOT NULL
                              REFERENCES search_profile(id) ON DELETE CASCADE,
    task_id      TEXT         NOT NULL,
    last_run_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, task_id)
);

-- The Captura page reads every task-run row for one profile in a single query
-- (keyed on profile_id); the PK's leading column already serves that, so no
-- extra index is needed.


-- ── Capture-to-infer: learned search-URL examples (issue #293, D-051) ───────
-- Instead of hand-maintaining each portal's search-URL grammar, we LEARN it
-- from the owner's real navigated URLs. When the owner clicks "Capturar todas"
-- on a search-results page, the extension already has that page's URL; it POSTs
-- it here (POST /api/extension/search-url-example), where the matching portal's
-- parse() — the structural inverse of the owner-confirmed slug builder (#296) —
-- decodes it into `filters` + `category_key` + `template`. Auto-trusted (owner
-- decision 2026-08-05): the owner navigated it, so it's a correct example — no
-- review step. The resolver (dashboard/lib/search-url/resolve.ts) later prefers
-- a confirmed template over the hand-written builder, per (portal × section).
--
-- Additive, no changes to capture_worklist / extension_capture: this learns a
-- search page's OWN URL grammar, a different concern from mining its detail
-- links (#262). `match_key` reuses the same cosmetic-tolerant canonicalisation
-- as the worklist so re-navigating the same page is idempotent (ON CONFLICT).
CREATE TABLE IF NOT EXISTS search_url_example (
    id            BIGSERIAL    PRIMARY KEY,
    portal        TEXT         NOT NULL,
    -- The search URL exactly as captured (what the operator navigated).
    url           TEXT         NOT NULL,
    -- Canonical correlation key (host without www + path without trailing
    -- slash). UNIQUE per portal so a re-capture of the same page refreshes the
    -- decoded columns rather than inserting a duplicate.
    match_key     TEXT         NOT NULL,
    -- Decoded, portal-neutral filters (ParsedSearchFilters): section, property
    -- types, price/size bands, the location path slug (idealista
    -- <municipio>-<provincia> / aliseda <comunidad>/<provincia>), and its
    -- approximate centroid resolved from the known municipio/province tables
    -- (NULL for a national / unresolved search) — used only for area matching.
    filters       JSONB        NOT NULL,
    -- The categorical match axis: the portal section (idealista operation /
    -- aliseda tipo-plural), which under the slug grammar IS the property-type
    -- granularity. Never geography or numeric ranges.
    category_key  TEXT         NOT NULL,
    -- The captured URL with every continuous numeric value swapped for a named
    -- placeholder ({price_min} …) so a profile's own values substitute back in.
    template      TEXT         NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (portal, match_key)
);

-- The resolver's read query is `WHERE portal = $1` then in-memory section /
-- area matching; a composite (portal, category_key) index keeps the exact
-- section lookup cheap as examples accumulate.
CREATE INDEX IF NOT EXISTS idx_search_url_example_lookup
    ON search_url_example (portal, category_key);


-- URL-building discovery catalog (issue #336, D-063).
--
-- One row per connector × discovery session. The browser extension enumerates a
-- portal's search-form filter OPTIONS (property type, rooms, condition, price
-- buckets, zones — as the portal labels them) and the URL FRAGMENT each option
-- produces, then POSTs the catalog to /api/extension/filter-catalog. The
-- connector's URL builder reads the LATEST catalog per connector
-- (lib/search-url/discovered-mapping.ts) and prefers the discovered option→slug
-- mapping over its hard-coded seed table, so a portal re-labelling `pisos` or
-- adding a subtype code never needs a code change — only a re-run of discovery.
--
-- Connector-agnostic by construction: `axes` is a JSONB object of
-- {axisName -> [{label, portalValue?, urlFragment, category?, subtipo?, ...}]},
-- so it carries whatever axes a portal exposes; only Aliseda is wired first.
-- Latest-wins: the read path loads the newest row per connector (no upsert —
-- each session is retained for drift archaeology).
CREATE TABLE IF NOT EXISTS portal_filter_catalog (
    id            BIGSERIAL    PRIMARY KEY,
    connector     TEXT         NOT NULL,
    -- Where the catalog came from: the in-page embedded config JSON
    -- (least brittle), the live form <option> elements, or operator-navigated
    -- click-through. Kept for auditing which source produced a mapping.
    source        TEXT         NOT NULL,   -- embedded-config | form-options | navigated
    -- axis -> [{label, portalValue?, urlFragment, category?, subtipo?, ...}]
    axes          JSONB        NOT NULL,
    captured_at   TIMESTAMPTZ  NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- The read path is `WHERE connector = $1 ORDER BY captured_at DESC LIMIT 1`
-- (latest catalog wins); this composite index serves it directly.
CREATE INDEX IF NOT EXISTS idx_portal_filter_catalog_latest
    ON portal_filter_catalog (connector, captured_at DESC);


-- ============================================================
-- Dashboard App
-- ============================================================

CREATE TABLE IF NOT EXISTS dashboards (
    id           SERIAL       PRIMARY KEY,
    name         TEXT         NOT NULL,
    description  TEXT,
    spec         JSONB        NOT NULL,
    created_at   TIMESTAMPTZ  DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- Remove legacy chat message cache columns — conversation history is stored
-- exclusively in conversation_messages (via the conversations table).
ALTER TABLE dashboards DROP COLUMN IF EXISTS chat_messages_analyze;
ALTER TABLE dashboards DROP COLUMN IF EXISTS chat_messages_modify;

CREATE TABLE IF NOT EXISTS dashboard_versions (
    id            SERIAL       PRIMARY KEY,
    dashboard_id  INTEGER      NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    spec          JSONB        NOT NULL,
    prompt        TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS llm_usage (
    id                  SERIAL        PRIMARY KEY,
    endpoint            TEXT          NOT NULL,
    model               TEXT          NOT NULL,
    prompt_tokens       INTEGER       NOT NULL DEFAULT 0,
    completion_tokens   INTEGER       NOT NULL DEFAULT 0,
    total_tokens        INTEGER       NOT NULL DEFAULT 0,
    estimated_cost_usd  NUMERIC(10,6) NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Weekly reviews (Dashboard App — weekly business review)
-- ============================================================

CREATE TABLE IF NOT EXISTS weekly_reviews (
    id          SERIAL      PRIMARY KEY,
    week_start  DATE        NOT NULL,
    content     JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_weekly_reviews_week ON weekly_reviews (week_start DESC);

-- Weekly review v2: versioning + analysis window (additive for existing installs)
ALTER TABLE weekly_reviews ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE weekly_reviews ADD COLUMN IF NOT EXISTS generation_mode TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE weekly_reviews ADD COLUMN IF NOT EXISTS supersedes_review_id INTEGER;
ALTER TABLE weekly_reviews ADD COLUMN IF NOT EXISTS window_start DATE;
ALTER TABLE weekly_reviews ADD COLUMN IF NOT EXISTS window_end DATE;

UPDATE weekly_reviews
SET window_start = COALESCE(window_start, week_start),
    window_end = COALESCE(window_end, (week_start + INTERVAL '6 days')::date)
WHERE window_start IS NULL OR window_end IS NULL;

ALTER TABLE weekly_reviews ALTER COLUMN window_start SET NOT NULL;
ALTER TABLE weekly_reviews ALTER COLUMN window_end SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'weekly_reviews_generation_mode_check'
  ) THEN
    ALTER TABLE weekly_reviews
      ADD CONSTRAINT weekly_reviews_generation_mode_check
      CHECK (generation_mode IN ('initial', 'refresh_data', 'alternate_angle'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'weekly_reviews_supersedes_fk'
  ) THEN
    ALTER TABLE weekly_reviews
      ADD CONSTRAINT weekly_reviews_supersedes_fk
      FOREIGN KEY (supersedes_review_id) REFERENCES weekly_reviews(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Assign deterministic revision numbers per week before the unique index (existing rows may share revision=1).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY week_start ORDER BY created_at NULLS LAST, id) AS rn
  FROM weekly_reviews
)
UPDATE weekly_reviews wr
SET revision = ranked.rn
FROM ranked
WHERE wr.id = ranked.id
  AND wr.revision IS DISTINCT FROM ranked.rn;

CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_reviews_week_revision
  ON weekly_reviews (week_start, revision);

-- Action tracking for weekly reviews (per revision)
CREATE TABLE IF NOT EXISTS weekly_review_actions (
    id            SERIAL       PRIMARY KEY,
    review_id     INTEGER      NOT NULL REFERENCES weekly_reviews(id) ON DELETE CASCADE,
    action_key    TEXT         NOT NULL,
    priority      TEXT         NOT NULL CHECK (priority IN ('alta', 'media', 'baja')),
    owner_role    TEXT         NOT NULL DEFAULT '',
    owner_name    TEXT         NOT NULL DEFAULT '',
    due_date      DATE         NOT NULL,
    expected_impact TEXT       NOT NULL DEFAULT '',
    status        TEXT         NOT NULL DEFAULT 'pendiente'
      CHECK (status IN ('pendiente', 'en_curso', 'hecha', 'descartada')),
    last_update   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (review_id, action_key)
);
CREATE INDEX IF NOT EXISTS idx_weekly_review_actions_review ON weekly_review_actions (review_id);

-- ============================================================
-- ETL control
-- ============================================================

CREATE TABLE IF NOT EXISTS etl_watermarks (
    table_name   TEXT        PRIMARY KEY,
    last_sync_at TIMESTAMPTZ NOT NULL,
    rows_synced  INTEGER,
    status       TEXT        DEFAULT 'ok',
    error_msg    TEXT,
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS etl_sync_runs (
    id                SERIAL       PRIMARY KEY,
    trigger           TEXT         NOT NULL,
    started_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ,
    duration_ms       INTEGER,
    status            TEXT         NOT NULL DEFAULT 'running',
    -- 'delta' (hourly, only watermark-driven syncs) vs 'full' (nightly,
    -- every module including the truncate-only ones). Pre-existing rows
    -- are backfilled to 'full' since that was the only mode before.
    kind              TEXT         NOT NULL DEFAULT 'full',
    tables_ok         INTEGER,
    tables_failed     INTEGER,
    total_tables      INTEGER,
    total_rows_synced INTEGER
);

ALTER TABLE etl_sync_runs ADD COLUMN IF NOT EXISTS total_tables INTEGER;
ALTER TABLE etl_sync_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'full';

CREATE TABLE IF NOT EXISTS etl_sync_run_tables (
    id               SERIAL       PRIMARY KEY,
    run_id           INTEGER      NOT NULL REFERENCES etl_sync_runs(id) ON DELETE CASCADE,
    table_name       TEXT         NOT NULL,
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    duration_ms      INTEGER,
    status           TEXT         NOT NULL DEFAULT 'ok',
    rows_synced      INTEGER,
    sync_method      TEXT,
    rows_total_after INTEGER,
    watermark_from   TIMESTAMPTZ,
    watermark_to     TIMESTAMPTZ,
    error_msg        TEXT
);

ALTER TABLE etl_sync_run_tables ADD COLUMN IF NOT EXISTS watermark_from TIMESTAMPTZ;
ALTER TABLE etl_sync_run_tables ADD COLUMN IF NOT EXISTS watermark_to   TIMESTAMPTZ;
ALTER TABLE etl_sync_run_tables ADD COLUMN IF NOT EXISTS error_msg      TEXT;

-- OTel trace correlation — nullable; populated by Phase 2 ETL instrumentation.
-- trace_id links the DB row to the distributed trace in Elastic APM / Kibana.
ALTER TABLE etl_sync_runs      ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE etl_sync_runs      ADD COLUMN IF NOT EXISTS span_id  TEXT;
ALTER TABLE etl_sync_run_tables ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE etl_sync_run_tables ADD COLUMN IF NOT EXISTS span_id  TEXT;

CREATE INDEX IF NOT EXISTS idx_etl_sync_runs_trace_id       ON etl_sync_runs(trace_id)       WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_etl_sync_run_tables_trace_id ON etl_sync_run_tables(trace_id) WHERE trace_id IS NOT NULL;

-- Transport channel: dashboard writes a row here; ETL polls and picks it up.
CREATE TABLE IF NOT EXISTS etl_manual_trigger (
    id           SERIAL       PRIMARY KEY,
    requested_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    status       TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'picked_up')),
    picked_up_at TIMESTAMPTZ,
    run_id       INTEGER      REFERENCES etl_sync_runs(id) ON DELETE SET NULL,
    -- Issue #398: allow the dashboard/CLI to request a force re-sync for a
    -- subset of tables (or the full pipeline) by clearing watermarks before
    -- the next run picks them up. Defaults keep the historical "incremental"
    -- semantics when these columns are absent from the INSERT.
    force_full   BOOLEAN      NOT NULL DEFAULT FALSE,
    force_tables TEXT[]       NOT NULL DEFAULT '{}',
    -- Audit column: identifies who requested the sync (e.g. client IP, 'dashboard', 'cli').
    triggered_by TEXT
);

-- Forward-compat: if an older DB already has the table without the new
-- columns, add them in place. IF NOT EXISTS makes this idempotent.
ALTER TABLE etl_manual_trigger ADD COLUMN IF NOT EXISTS force_full   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE etl_manual_trigger ADD COLUMN IF NOT EXISTS force_tables TEXT[]  NOT NULL DEFAULT '{}';
ALTER TABLE etl_manual_trigger ADD COLUMN IF NOT EXISTS triggered_by TEXT;

-- Issue #244: revive ad-hoc execution. The inmo-tool connector orchestrator
-- polls this table (etl/manual_trigger.py) and runs a sweep — either every
-- enabled connector, or just one when `connector_name` is set (NULL = all,
-- the same "empty = everything" convention `force_tables` already uses). The
-- old `run_id` FK points at the source project's now-orphaned etl_sync_runs;
-- the connector pipeline records `connector_runs` instead, so the outcome
-- links there via `connector_run_id`. `finished_at`/`error_msg` record the
-- result the dashboard's GET /api/etl/run?id= reports back.
ALTER TABLE etl_manual_trigger ADD COLUMN IF NOT EXISTS connector_name   TEXT;
ALTER TABLE etl_manual_trigger ADD COLUMN IF NOT EXISTS connector_run_id BIGINT REFERENCES connector_runs(id) ON DELETE SET NULL;
ALTER TABLE etl_manual_trigger ADD COLUMN IF NOT EXISTS finished_at      TIMESTAMPTZ;
ALTER TABLE etl_manual_trigger ADD COLUMN IF NOT EXISTS error_msg        TEXT;

-- The lifecycle is pending -> running -> done|failed (issue #244). 'picked_up'
-- is kept in the allow-set for the inherited PowerShop helpers/tests that used
-- it (etl.db.postgres.check_and_consume_trigger); the new poll loop never
-- writes it. Drop-and-re-add is the idempotent way to widen an inline CHECK,
-- mirroring connector_run_results' status-constraint migration above.
ALTER TABLE etl_manual_trigger DROP CONSTRAINT IF EXISTS etl_manual_trigger_status_check;
ALTER TABLE etl_manual_trigger ADD CONSTRAINT etl_manual_trigger_status_check
    CHECK (status IN ('pending', 'picked_up', 'running', 'done', 'failed'));

-- Unique: at most one pending trigger row at a time (supports ON CONFLICT idempotency).
CREATE UNIQUE INDEX IF NOT EXISTS idx_etl_manual_trigger_single_pending
    ON etl_manual_trigger (status) WHERE status = 'pending';

-- Supports frequent polling/claim of the oldest pending manual trigger.
CREATE INDEX IF NOT EXISTS idx_etl_manual_trigger_pending_requested_at
    ON etl_manual_trigger (requested_at, id)
    WHERE status = 'pending';

-- ============================================================
-- LLM usage tracking (Dashboard App)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_llm_usage_created_at ON llm_usage(created_at);

-- Dashboard App — per tool call telemetry (agentic LLM)
CREATE TABLE IF NOT EXISTS llm_tool_calls (
    id                  SERIAL        PRIMARY KEY,
    tool_name           TEXT          NOT NULL,
    endpoint            TEXT          NOT NULL,
    request_id          TEXT,
    status              TEXT          NOT NULL CHECK (status IN ('ok', 'error')),
    latency_ms          INTEGER       NOT NULL,
    payload_in_bytes    INTEGER,
    payload_out_bytes   INTEGER,
    error_code          TEXT,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_llm_tool_calls_created_at ON llm_tool_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_tool_calls_endpoint_tool ON llm_tool_calls(endpoint, tool_name);

ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS llm_provider TEXT NOT NULL DEFAULT 'openrouter';
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS llm_driver TEXT;
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS cache_creation_input_tokens INTEGER;
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS cache_read_input_tokens INTEGER;

CREATE INDEX IF NOT EXISTS idx_llm_usage_endpoint_request_id
    ON llm_usage (endpoint, request_id)
    WHERE request_id IS NOT NULL;

ALTER TABLE llm_tool_calls ADD COLUMN IF NOT EXISTS llm_provider TEXT NOT NULL DEFAULT 'openrouter';
ALTER TABLE llm_tool_calls ADD COLUMN IF NOT EXISTS llm_driver TEXT;

-- OTel trace correlation for llm_tool_calls — populated by Phase 3 instrumentation.
ALTER TABLE llm_tool_calls ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE llm_tool_calls ADD COLUMN IF NOT EXISTS span_id  TEXT;
CREATE INDEX IF NOT EXISTS idx_llm_tool_calls_trace_id ON llm_tool_calls(trace_id) WHERE trace_id IS NOT NULL;

-- ============================================================
-- AGENTIC_RUNNER failure audit log (Dashboard App — issue #419)
-- One row per AgenticRunnerError surfaced from /api/dashboard/{generate,modify,analyze}.
-- All string columns store sanitized values (see lib/llm-provider/sanitize.ts).
-- ============================================================
CREATE TABLE IF NOT EXISTS llm_errors (
    id                SERIAL       PRIMARY KEY,
    request_id        TEXT         NOT NULL,
    endpoint          TEXT         NOT NULL,
    code              TEXT         NOT NULL,
    sub_error         TEXT,
    provider          TEXT         NOT NULL,
    driver            TEXT,
    model             TEXT,
    phase             TEXT,
    duration_ms       INTEGER,
    tool_rounds_used  INTEGER,
    tool_calls_used   INTEGER,
    last_tool_name    TEXT,
    last_tool_args    TEXT,
    cli_exit_code     INTEGER,
    cli_inner_code    TEXT,
    cli_command       TEXT,
    cli_stdout_tail   TEXT,
    cli_stderr_tail   TEXT,
    limits            JSONB,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_llm_errors_created_at ON llm_errors(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_errors_request_id  ON llm_errors(request_id);
CREATE INDEX IF NOT EXISTS idx_llm_errors_endpoint    ON llm_errors(endpoint);

-- OTel trace correlation for llm_errors — populated by Phase 3 instrumentation.
ALTER TABLE llm_errors ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE llm_errors ADD COLUMN IF NOT EXISTS span_id  TEXT;
CREATE INDEX IF NOT EXISTS idx_llm_errors_trace_id ON llm_errors(trace_id) WHERE trace_id IS NOT NULL;

-- ============================================================
-- LLM interaction history (Dashboard App — full run audit trail)
-- ============================================================

-- One row per generate/modify/analyze call.  The `lines` column stores
-- InteractionLine objects (kind, text, optional ts) as a JSONB array so they
-- can be replayed in the admin UI without string parsing.
CREATE TABLE IF NOT EXISTS llm_interactions (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id   TEXT         NOT NULL,
    endpoint     TEXT         NOT NULL CHECK (endpoint IN ('generate','modify','analyze')),
    dashboard_id INTEGER      REFERENCES dashboards(id) ON DELETE SET NULL,
    prompt       TEXT         NOT NULL,
    final_output TEXT,
    lines        JSONB        NOT NULL DEFAULT '[]'::jsonb,
    llm_provider TEXT,
    llm_driver   TEXT,
    started_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at  TIMESTAMPTZ,
    status       TEXT         NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running','completed','error'))
);

CREATE INDEX IF NOT EXISTS idx_llm_interactions_dashboard ON llm_interactions(dashboard_id);
-- idx_llm_interactions_request intentionally omitted: the UNIQUE (request_id)
-- constraint added below creates an equivalent unique index automatically.
CREATE INDEX IF NOT EXISTS idx_llm_interactions_started   ON llm_interactions(started_at DESC);
-- Support common admin filter patterns without sequential scans
CREATE INDEX IF NOT EXISTS idx_llm_interactions_endpoint_started
    ON llm_interactions(endpoint, started_at DESC);
-- request_id must be unique: the admin detail page and client fetch use it as a stable key
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'llm_interactions'::regclass AND contype = 'u'
      AND conname = 'llm_interactions_request_id_key'
  ) THEN
    ALTER TABLE llm_interactions ADD CONSTRAINT llm_interactions_request_id_key UNIQUE (request_id);
  END IF;
END
$$;

-- OTel trace correlation for llm_interactions — populated by Phase 3 instrumentation.
-- trace_id on this table is the primary click-through from the admin UI to Kibana APM.
ALTER TABLE llm_interactions ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE llm_interactions ADD COLUMN IF NOT EXISTS span_id  TEXT;
CREATE INDEX IF NOT EXISTS idx_llm_interactions_trace_id ON llm_interactions(trace_id) WHERE trace_id IS NOT NULL;

-- ============================================================
-- Conversations (Dashboard App — persistent LLM chat history)
-- ============================================================

CREATE TABLE IF NOT EXISTS conversations (
    id                TEXT         PRIMARY KEY,
    mode              TEXT         NOT NULL,
    title             TEXT,
    first_user_prompt TEXT,
    context_url       TEXT,
    context_kind      TEXT,
    context_ref       TEXT,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at       TIMESTAMPTZ,
    last_status       TEXT,
    llm_provider      TEXT,
    llm_driver        TEXT,
    initial_context   JSONB,
    created_by        TEXT,
    last_read_at      TIMESTAMPTZ
);

-- Idempotent migration: add last_read_at to existing databases
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversations_active_recent
    ON conversations (last_interaction_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_context_recent
    ON conversations (context_kind, context_ref, last_interaction_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_all_recent
    ON conversations (last_interaction_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id TEXT         NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
    role            TEXT         NOT NULL,
    content         JSONB        NOT NULL,
    tokens_input    INT,
    tokens_output   INT,
    tokens_cache_read     INT,
    tokens_cache_creation INT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_by_conv
    ON conversation_messages (conversation_id, created_at);

-- Server-driven conversation turns (D-034 unified engine)
-- Each row represents one user→assistant exchange. Background job transitions
-- status: pending → streaming → complete|error.
CREATE TABLE IF NOT EXISTS conversation_turns (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id TEXT         NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
    turn_index      INTEGER      NOT NULL,
    user_message    TEXT         NOT NULL,
    status          TEXT         NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'streaming', 'complete', 'error')),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    error           TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_conversation_turns_conv_index UNIQUE (conversation_id, turn_index)
);

-- Relative path to this turn's context-log file (the exact payload sent to the
-- LLM). The heavy context lives on the dashboard's data volume, not in Postgres;
-- only this pointer is stored. See dashboard/lib/conversation-context-store.ts.
ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS context_file TEXT;

-- Ordered log/token/context events emitted during a turn.
-- Clients replay from seq=0 on connect; Last-Event-ID resumes from seq N.
CREATE TABLE IF NOT EXISTS turn_events (
    id              BIGSERIAL    PRIMARY KEY,
    turn_id         UUID         NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
    seq             INTEGER      NOT NULL,
    event_type      TEXT         NOT NULL,
    payload         JSONB        NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turn_events_turn_seq
    ON turn_events (turn_id, seq);


-- ============================================================
-- Indexes
-- ============================================================

-- Dashboard indexes
CREATE INDEX IF NOT EXISTS idx_dashboard_versions_dashboard_id ON dashboard_versions(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_dashboards_updated_at ON dashboards(updated_at);

-- (Backfill migration removed — chat_messages_* columns dropped above.
--  Conversation history lives exclusively in conversation_messages.)

-- Add logs column to persist streaming log lines alongside the assistant message.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS logs JSONB DEFAULT NULL;

-- Run-once destructive migrations need a marker so re-applying this file
-- (every container start) does not repeat them.
CREATE TABLE IF NOT EXISTS etl_one_time_migrations (
    id         TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill: Milanuncios photo URLs stored before PR #209 (issue #206) lack
-- the CDN's required `?rule=<preset>` query parameter (see D-020 — a bare
-- `images.milanuncios.com/api/v1/ma-ad-media-pro/images/<uuid>` URL 404s
-- "Rule parameter not Found"; `?rule=detail_640x480` returns HTTP 200).
-- #209 only fixed this at ingest (`MilanunciosConnector.normalize()`, via
-- `add_photo_rule_if_missing` in etl/connectors/milanuncios.py) — every URL
-- already sitting in `listing.photo_urls` before that deploy was untouched.
-- Issue #210, live-confirmed immediately after deploying #209: 0 of 795
-- stored Milanuncios photo URLs carried a query string, so the photo_hash
-- dedup signal contributed zero evidence for the entire existing corpus
-- (`photo_hash: 9/9 photo(s) failed to fetch/hash (source=milanuncios)`).
-- Waiting for a natural re-fetch does not fix this: Milanuncios blocks
-- `fetch_detail()` after ~5 successes per run (D-017) against ~60 stored
-- listings, and skip-if-seen (issue #143) deliberately never re-fetches an
-- unchanged listing at all.
--
-- Pure string transform on data already held — no network, no re-fetch.
-- Mirrors `add_photo_rule_if_missing(url)` (etl/connectors/milanuncios.py)
-- byte for byte: append `?rule=detail_640x480` (or `&rule=...` if the URL
-- ends in a bare `?`) only when the URL's query part — the substring after
-- its first `?`, if any — is empty. Every URL already in `listing.photo_urls`
-- predates the scheme-normalization split in that function (it was already
-- applied at ingest before #206), so this migration only needs to replicate
-- the rule-appending half, not the http(s):// scheme handling.
--
-- Deliberately NOT `... LIKE '%?%'` (the simpler check): a URL ending in a
-- bare `?` (no query content after it — none observed in this project's own
-- data, but not proven impossible on a portal CDN) would already contain a
-- literal `?` character, so a `LIKE '%?%'` guard would wrongly treat it as
-- "already has a rule" and skip it — silently diverging from
-- `add_photo_rule_if_missing`'s `urlsplit(url).query` check, which treats a
-- trailing bare `?` as "no query" and still appends the parameter. Kept in
-- sync by test_migration_sql_matches_add_photo_rule_if_missing
-- (etl/tests/test_connector_milanuncios.py, DB-backed): it runs this exact
-- UPDATE against a battery of representative URLs (including that trailing-
-- `?` edge case) and asserts the SQL's output equals the Python helper's
-- output for the same inputs. If `PHOTO_RULE`/`add_photo_rule_if_missing`
-- ever changes, that test fails until the literal below is updated to match
-- — the practical substitute, in a pure-SQL migration, for "the migration
-- calls the same helper the connector uses."
--
-- Idempotent by construction, not by the `etl_one_time_migrations` marker
-- table above: the WHERE/CASE below only touches rows that still have at
-- least one URL with an empty query part, so a row already fully backfilled
-- (including a Milanuncios listing ingested fresh, post-#209, which already
-- carries `?rule=...` from normalize() itself) is left alone on every
-- re-run of this file (every ETL container start) — same pattern as
-- `listing.last_fetched_at`'s backfill earlier in this file.
UPDATE listing
SET photo_urls = ARRAY(
    SELECT CASE
        WHEN position('?' IN u) = 0
            OR substring(u FROM position('?' IN u) + 1) = ''
        THEN u || (CASE WHEN u LIKE '%?' THEN '&' ELSE '?' END) || 'rule=detail_640x480'
        ELSE u
    END
    FROM unnest(photo_urls) AS u
)
WHERE source = 'milanuncios'
  AND EXISTS (
      SELECT 1 FROM unnest(photo_urls) AS u
      WHERE position('?' IN u) = 0
         OR substring(u FROM position('?' IN u) + 1) = ''
  );

-- ============================================================
-- ANALYZE (update planner statistics after initial load)
-- ============================================================

ANALYZE etl_watermarks;
ANALYZE dashboards;
ANALYZE dashboard_versions;
ANALYZE llm_usage;
ANALYZE etl_sync_runs;
ANALYZE etl_sync_run_tables;
ANALYZE etl_manual_trigger;
ANALYZE conversations;
ANALYZE conversation_messages;
ANALYZE property;
ANALYZE listing;
ANALYZE listing_price_history;
ANALYZE listing_status_event;
ANALYZE owner_identity;
ANALYZE listing_owner_identity;
ANALYZE search_profile;
ANALYZE profile_listing_state;
ANALYZE feedback_event;
ANALYZE profile_scoring_model;
ANALYZE ai_assessment;
ANALYZE property_merge_log;
ANALYZE suggested_merge;
ANALYZE extension_capture;
ANALYZE capture_worklist;
ANALYZE capture_worklist_seed_trigger;
ANALYZE capture_task_run;
ANALYZE search_url_example;
