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
-- Dropped in favour of a plain index (issue #140). The index still serves
-- the dedup engine's lookups; deduplication is the engine's job, enforced
-- by merging rows, not by rejecting inserts. DROP/CREATE rather than
-- editing the CREATE TABLE above, which is a no-op on an already-migrated
-- database — same reasoning as the other post-hoc migrations in this file.
ALTER TABLE property DROP CONSTRAINT IF EXISTS property_cadastral_ref_key;
CREATE INDEX IF NOT EXISTS idx_property_cadastral_ref ON property (cadastral_ref);

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
-- AI assessments (Phase 4 generates these; this task only creates
-- the table). listing_id is NOT NULL — an assessment is always about
-- a specific listing's published content (description/photos), even
-- though scoring/feedback elsewhere key on property_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_assessment (
    id              BIGSERIAL    PRIMARY KEY,
    listing_id      BIGINT       NOT NULL REFERENCES listing(id),
    assessment_type TEXT         NOT NULL CHECK (assessment_type IN ('occupancy','condition','redflags','extract','compare')),
    result          JSONB        NOT NULL,
    confidence      NUMERIC(4,3),
    model           TEXT,
    prompt_version  TEXT,
    generated_at    TIMESTAMPTZ,
    -- NULLS NOT DISTINCT (PG15+): without it, Postgres treats every NULL
    -- prompt_version as distinct, so this constraint would silently allow
    -- unlimited duplicate (listing_id, assessment_type, NULL) rows —
    -- defeating the point of the uniqueness check for any assessment
    -- generated before prompt_version tracking existed for that flow.
    UNIQUE NULLS NOT DISTINCT (listing_id, assessment_type, prompt_version)
);

-- The flow catalog gained `compare` in #24 (Phase 4.1). Re-stated as an
-- ALTER because the CREATE TABLE above is a no-op against a database that
-- already has ai_assessment — an inline edit alone would leave existing
-- installs rejecting every 'compare' row at runtime.
ALTER TABLE ai_assessment DROP CONSTRAINT IF EXISTS ai_assessment_assessment_type_check;
ALTER TABLE ai_assessment ADD CONSTRAINT ai_assessment_assessment_type_check
    CHECK (assessment_type IN ('occupancy','condition','redflags','extract','compare'));

-- ============================================================
-- Deduplication audit trail (Phase 2 task 2.2, issue #16, writes here)
-- ============================================================

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

CREATE INDEX IF NOT EXISTS idx_connector_run_results_run_id ON connector_run_results (run_id);
-- Recent-runs lookups (dashboards, `ps connector status`-style queries)
-- filter/sort on started_at; unindexed, that's a seq scan once this table
-- has any real history.
CREATE INDEX IF NOT EXISTS idx_connector_runs_started_at ON connector_runs (started_at DESC);

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
CREATE TABLE IF NOT EXISTS connector_config (
    connector_name      TEXT         PRIMARY KEY,
    enabled              BOOLEAN      NOT NULL DEFAULT true,
    geography_override   JSONB,
    filters              JSONB        NOT NULL DEFAULT '{}'::jsonb,
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

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
    status           TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
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
