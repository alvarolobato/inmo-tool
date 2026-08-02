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
    cadastral_ref  TEXT         UNIQUE,
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

-- ============================================================
-- AI assessments (Phase 4 generates these; this task only creates
-- the table). listing_id is NOT NULL — an assessment is always about
-- a specific listing's published content (description/photos), even
-- though scoring/feedback elsewhere key on property_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_assessment (
    id              BIGSERIAL    PRIMARY KEY,
    listing_id      BIGINT       NOT NULL REFERENCES listing(id),
    assessment_type TEXT         NOT NULL CHECK (assessment_type IN ('occupancy','condition','redflags','extract')),
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

-- ============================================================
-- Deduplication audit trail (Phase 2 task 2.2, issue #16, writes here)
-- ============================================================

CREATE TABLE IF NOT EXISTS property_merge_log (
    id                  BIGSERIAL    PRIMARY KEY,
    property_id         BIGINT       REFERENCES property(id),
    merged_listing_ids  BIGINT[],
    match_basis         TEXT         CHECK (match_basis IN ('cadastral','address_coords','phone','photo_hash','fuzzy')),
    confidence          NUMERIC(4,3),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    reverted_at         TIMESTAMPTZ
);

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
    match_basis   TEXT         NOT NULL CHECK (match_basis IN ('cadastral','address_coords','phone','photo_hash','fuzzy')),
    confidence    NUMERIC(4,3),
    status        TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','conflict')),
    detail        JSONB        NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    resolved_at   TIMESTAMPTZ,
    CHECK (listing_id_a <> listing_id_b)
);

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

CREATE INDEX IF NOT EXISTS idx_connector_run_results_run_id ON connector_run_results (run_id);
-- Recent-runs lookups (dashboards, `ps connector status`-style queries)
-- filter/sort on started_at; unindexed, that's a seq scan once this table
-- has any real history.
CREATE INDEX IF NOT EXISTS idx_connector_runs_started_at ON connector_runs (started_at DESC);


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
ANALYZE ai_assessment;
ANALYZE property_merge_log;
ANALYZE suggested_merge;
