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

-- unaccent powers the free-text search config (#470): "malaga" ≈ "málaga",
-- "atico" ≈ "ático" for portal descriptions. Guarded like pgcrypto above so a
-- role without CREATE EXTENSION privilege (or an image lacking contrib) falls
-- back with a notice; the es_unaccent config created later degrades to exact
-- accents in that case (see the Free-text search section below).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS unaccent;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unaccent not available — free-text search will degrade to exact accents';
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

-- Issue #643 (verificación de desfasados): when the stale-verification pass
-- last ATTEMPTED to re-read this listing at the source — regardless of what
-- the attempt concluded. Distinct from every other clock on this table, and
-- deliberately so:
--   * last_seen_at      = last confirmed present in a discover() sweep
--   * last_fetched_at   = last successful fetch_detail()+normalize()
--   * this column       = last time we ASKED the source about this listing
-- Written on every attempt, including the ones that proved nothing (a
-- soft block, a timeout, an indeterminate 200). That is exactly what makes
-- it useful: nomination orders by COALESCE(this, last_seen_at) ascending, so
-- a listing whose verification keeps failing rotates to the back of the queue
-- instead of consuming the whole per-run budget forever and starving every
-- other candidate — the same fairness argument as D-030's scope rotation.
-- It is NOT evidence of anything about the listing itself and nothing may
-- ever derive a status from it.
ALTER TABLE listing ADD COLUMN IF NOT EXISTS last_verification_attempt_at TIMESTAMPTZ;

-- Nomination runs once per connector per run: it filters on (source, status)
-- plus an age predicate, orders by the rotation clock and takes the first N
-- rows. The ORDER BY is an EXPRESSION — COALESCE(last_verification_attempt_at,
-- last_seen_at, first_seen_at) — so the index has to carry that expression to
-- serve the ordering; a plain trailing-column index only narrows the scan and
-- still sorts (PR #685 review, L1: the earlier comment here claimed otherwise).
-- Irrelevant at today's 13k rows either way, and stated so the next person
-- reading an EXPLAIN isn't misled.
CREATE INDEX IF NOT EXISTS idx_listing_stale_verification_queue
    ON listing (source, status,
                (COALESCE(last_verification_attempt_at, last_seen_at, first_seen_at)));

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

-- One-time (idempotent) backfill: adopt the most-recent observed price as
-- listing.current_price (issue #432, D-098). Historically current_price was
-- fetch-path-owned (D-070), so a discovery/capture-observed price drop could
-- leave the displayed/deal-math price stale until a confirming re-fetch caught
-- up (property 1739: header 157000 while history/graph/badge showed 146000).
-- The most-recent observed price is now authoritative everywhere (header/card,
-- below-market %, scoring), so this realigns the handful of listings that
-- diverged before the code change. Idempotent by construction: the phase-2
-- sanity band (adopt only a move inside [1%, 60%]) is re-evaluated on every
-- init.sql run, so a >60% suspect latest observation is never backfilled and a
-- sub-1% noise gap is left untouched — once a listing is realigned there is no
-- divergence left to act on, and a genuinely suspect one is blocked the same
-- way every run.
UPDATE listing l
   SET current_price = latest.price
  FROM (
        SELECT DISTINCT ON (h.listing_id)
               h.listing_id, h.price
          FROM listing_price_history h
         ORDER BY h.listing_id, h.observed_at DESC, h.id DESC
       ) AS latest
 WHERE l.id = latest.listing_id
   AND latest.price IS NOT NULL
   AND latest.price IS DISTINCT FROM l.current_price
   AND (
        l.current_price IS NULL OR l.current_price <= 0
        OR (
             abs(latest.price - l.current_price) / l.current_price >= 0.01
         AND abs(latest.price - l.current_price) / l.current_price <= 0.60
        )
   );

CREATE TABLE IF NOT EXISTS listing_status_event (
    id           BIGSERIAL    PRIMARY KEY,
    listing_id   BIGINT       NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
    observed_at  TIMESTAMPTZ  NOT NULL,
    status       TEXT         NOT NULL CHECK (status IN ('active','reserved','sold','withdrawn','expired'))
);

CREATE INDEX IF NOT EXISTS idx_listing_status_event_listing_observed
    ON listing_status_event (listing_id, observed_at);

-- Issue #643: WHAT we observed that justified this status transition, in
-- prose, at the moment we observed it. The design rule the whole withdrawal
-- family now follows is that a status only ever changes on evidence of
-- absence — never on elapsed time — so every row that claims a listing is
-- gone must be able to answer "evidence of what?" without anyone
-- reconstructing it from logs that have long rotated away. Populated by the
-- stale-verification pass (e.g. "HTTP 404 en <url>"); NULL on the rows
-- written by the older paths (_reconcile_missed_discoveries' N-consecutive-
-- misses reconciliation and the normalize()-reported status changes), whose
-- evidence is implicit in the mechanism that wrote them.
ALTER TABLE listing_status_event ADD COLUMN IF NOT EXISTS evidence TEXT;

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
-- (property_types requires >=1 element, OR the "all" sentinel -- issue
-- #659/D-147 below -- but never nothing at all). Every real write path
-- (createProfile) already supplies an explicit, validated scope, so the
-- column default was never anything but a trap reachable only via a manual
-- SQL insert, a seed script, or a future migration that forgets to set it --
-- dropping it forces exactly that mistake to surface immediately as a NOT
-- NULL violation at INSERT time, instead of silently persisting a row that
-- toSearchProfileRowSafe (lib/db/profiles.ts) can only detect after the fact.
-- See docs/decisions/D-013-search-profile-scope-no-default.md.
--
-- Issue #659/D-147 extends this: an unfiltered "novedades" profile does NOT
-- get there by making geography/property_types optional (that would
-- resurrect exactly the "no schema-valid empty scope" trap this comment
-- describes, via ANY(NULL::text[]) silently matching zero rows). It writes
-- an explicit, stated value instead -- `geography: {type: "everywhere"}` /
-- `property_types: "all"` -- so "no filter" is still something someone
-- typed, not something that was left out. See D-147.
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

-- Issue #416 (feed novelty, plan #415 §3.1). The novelty anchor: "new since I
-- last looked" cannot be anchored on last_viewed_at, because GET
-- /api/profiles/[id] stamps last_viewed_at = NOW() on arrival — so by the time
-- the feed query runs, last_viewed_at ≈ NOW() and nothing is ever new. This is
-- a two-slot anchor (same philosophy as D-094's deferred-removal on the
-- departure side, applied to arrival): touchProfileViewedAt SHIFTS the old
-- last_viewed_at into previous_viewed_at (with a session debounce) before
-- overwriting last_viewed_at, and the feed anchors novelty on
-- previous_viewed_at. The mark then survives the entire visit and expires on
-- the NEXT one. Nullable, no backfill — NULL is the real "never had a prior
-- visit" state, for which the feed falls back to created_at - interval '1 day'
-- (the exact fallback new_count already uses).
ALTER TABLE search_profile ADD COLUMN IF NOT EXISTS previous_viewed_at TIMESTAMPTZ;

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

-- Issue #428 (Feed phase 5): `kind` distinguishes the cadenced daily/weekly
-- digest ('digest') from the independent per-hour "En seguimiento" watchlist
-- pass ('seguimiento'). One watermark table, two independent series per
-- profile: each pass reads and advances ONLY its own kind's most-recent row,
-- so a price drop on a tracked property alerts at most once per channel.
-- Idempotent migration (append-a-column house style) — pre-#428 rows default
-- to 'digest', which is exactly what they were.
ALTER TABLE digest_run ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'digest';
ALTER TABLE digest_run DROP CONSTRAINT IF EXISTS digest_run_kind_check;
ALTER TABLE digest_run ADD CONSTRAINT digest_run_kind_check
    CHECK (kind IN ('digest', 'seguimiento'));

-- The scheduler's due-check reads the most recent digest_run per profile FOR A
-- GIVEN KIND (ORDER BY sent_at DESC LIMIT 1) — index the (profile_id, kind,
-- sent_at DESC) path. Supersedes the old (profile_id, sent_at DESC) index:
-- every read is now per-kind (listDigestProfiles + resolveDigestAnchor both
-- filter `kind = ...`), so the old index has no remaining consumer. Drop it on
-- an existing DB (init.sql re-runs idempotently) so no redundant index lingers.
CREATE INDEX IF NOT EXISTS idx_digest_run_profile_kind_sent
    ON digest_run (profile_id, kind, sent_at DESC);
DROP INDEX IF EXISTS idx_digest_run_profile_sent;

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
    feedback_type  TEXT         NOT NULL CHECK (feedback_type IN ('accept','reject','star','clear','note','correction')),
    value          JSONB,
    note           TEXT,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 'clear' (issue #379): an explicit "un-mark" event that resets the derived
-- accept/reject/star state back to neutral without deleting history (the table
-- stays append-only — see data-model.md). Needed so the candidate feed's
-- show-rejected toggle can un-reject a property. Existing databases created
-- before #379 carry the inline CHECK from the CREATE TABLE above, which
-- CREATE TABLE IF NOT EXISTS never revisits — drop it and re-add the widened
-- one so 'clear' is accepted everywhere (same pattern as ai_assessment above).
ALTER TABLE feedback_event DROP CONSTRAINT IF EXISTS feedback_event_feedback_type_check;
ALTER TABLE feedback_event ADD CONSTRAINT feedback_event_feedback_type_check
    CHECK (feedback_type IN ('accept','reject','star','clear','note','correction'));

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
    assessment_type TEXT         NOT NULL CHECK (assessment_type IN ('occupancy','condition','redflags','location','opportunity','extract','compare')),
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

-- The flow catalog gained `compare` in #24 (Phase 4.1), `location` in #388
-- (Fase 3 de #385) and `opportunity` in #398 (Fase 5 de #385). Re-stated as an
-- ALTER because the CREATE TABLE above is a no-op against a database that
-- already has ai_assessment — an inline edit alone would leave existing installs
-- (incl. the persistent demo DB) rejecting every 'opportunity' row at runtime.
-- Idempotent named DROP/ADD.
ALTER TABLE ai_assessment DROP CONSTRAINT IF EXISTS ai_assessment_assessment_type_check;
ALTER TABLE ai_assessment ADD CONSTRAINT ai_assessment_assessment_type_check
    CHECK (assessment_type IN ('occupancy','condition','redflags','location','opportunity','extract','compare'));

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

-- LLM cost control: the failure ledger that stops the assessment scheduler
-- paying for the same doomed call every 15 minutes, forever.
--
-- Before this table, a flow that failed for a non-budget reason (the model
-- returned unparseable JSON, an empty completion, a CLI error) wrote NOTHING
-- anywhere: `runAssessmentBatch` counted `errors += 1` and moved on, so the
-- property still satisfied the "missing a current-version verdict" selection
-- predicate and came back on the very next tick — and, because selection is
-- `created_at ASC`, it came back FIRST. One property whose text reliably
-- provokes bad output burned up to 96 paid retries per day per flow, with no
-- backoff, no cap, and no record anywhere that it was happening.
--
-- A row here means "this exact (property, flow, prompt version, input) has
-- failed `fail_count` times". `getOrCompute` refuses to call the LLM once
-- `fail_count` reaches `dashboard.assessment_max_failures` (default 3) and
-- raises `AssessmentParkedError` instead. The park is keyed on
-- `content_hash`, so it releases itself the moment the evidence changes (a
-- new/edited listing) — exactly like a cache miss — and a prompt-version bump
-- writes a different key, so a fixed prompt is retried without operator
-- action. A successful run deletes the row.
CREATE TABLE IF NOT EXISTS ai_assessment_failure (
    id              BIGSERIAL    PRIMARY KEY,
    property_id     BIGINT       NOT NULL REFERENCES property(id) ON DELETE CASCADE,
    -- Same vocabulary as ai_assessment.assessment_type (minus 'compare',
    -- which is never cached and so never parked) — a typo'd type must fail
    -- loudly here rather than silently accruing strikes nothing will read.
    assessment_type TEXT         NOT NULL
        CHECK (assessment_type IN ('occupancy','condition','redflags','location','opportunity','extract')),
    prompt_version  TEXT         NOT NULL,
    -- The `computeAssessmentContentHash` value the failing call was made with.
    -- Part of the key: new evidence must get a fresh chance.
    content_hash    TEXT         NOT NULL,
    fail_count      INTEGER      NOT NULL DEFAULT 1,
    first_failed_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_failed_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Truncated error message, for the operator to see WHY it is parked.
    last_error      TEXT,
    CONSTRAINT ai_assessment_failure_key
        UNIQUE (property_id, assessment_type, prompt_version, content_hash)
);

-- Parked-row lookups are per (property, flow); the unique constraint above
-- already covers that prefix, so no extra index is needed. This one supports
-- the operator-facing "what is parked?" listing, ordered by recency.
CREATE INDEX IF NOT EXISTS idx_ai_assessment_failure_last
    ON ai_assessment_failure (last_failed_at DESC);

-- #407: candidate_type slugs a human reviewed on /admin/candidatos and
-- explicitly DISMISSED (rejected as a real category). Two effects:
--   1. excluded from the promotion list (getPromotionCandidates) and the
--      prompt's "recent candidates" trending block (getTrendingCandidateTypes)
--      so a rejected slug stops resurfacing;
--   2. injected into the redflags prompt as "previously reviewed and rejected —
--      do NOT propose these again" so the model stops re-coining the concept.
-- `slug` is the normalized snake_case candidate_type (same shape
-- normalizeCandidateType produces). `reason` is the owner's optional one-line
-- note. Idempotent CREATE TABLE IF NOT EXISTS — safe to re-run.
CREATE TABLE IF NOT EXISTS dismissed_candidate_type (
    slug         TEXT PRIMARY KEY,
    reason       TEXT,
    dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- 'reject_pair' (issue #605 Part 2 revision, PR #611 review B1) was added
-- after this table's original CREATE TABLE — same idempotent-migration
-- reasoning as property_merge_log.match_basis above: inert on an
-- already-migrated database, but a live constraint needs its own ALTER or
-- a pre-existing database would reject every real 'reject_pair' insert.
ALTER TABLE suggested_merge_action DROP CONSTRAINT IF EXISTS suggested_merge_action_action_check;
ALTER TABLE suggested_merge_action ADD CONSTRAINT suggested_merge_action_action_check
    CHECK (action IN ('confirm','reject','reject_pair'));

-- ============================================================
-- Property-pair merge veto (issue #605 Part 2 revision — PR #611 review B1)
-- ============================================================
--
-- A permanent, PROPERTY-level "these are not the same property" record —
-- distinct from suggested_merge.status='rejected', which only binds the
-- exact LISTING pair it was filed against. The grouped review queue
-- (#605 Part 2) asks the human "is property A the same as property B?",
-- but the underlying comparisons are per-listing: property A with 2
-- listings and property B with 2 listings can produce up to 4 distinct
-- listing-pair rows, and a human rejecting only the ones the UI happened
-- to show left the untouched combinations free to be freshly suggested —
-- or auto-merged outright — on the very next run, reopening the identical
-- question the human just answered (reproduced live in PR #611's review,
-- including a case where the next run auto-merged the exact two
-- properties the human had just rejected).
--
-- `etl.dedup.engine.reject_property_pair` inserts one row here (canonical
-- lower-id-first order) whenever a human rejects a property-pair group in
-- the dashboard, and ALSO marks every currently-pending suggested_merge
-- row between the two properties as rejected. `engine._run`'s pairwise
-- loop consults this table BEFORE evaluate_pair for every candidate pair
-- whose two listings currently resolve to the two vetoed property ids —
-- so the veto binds every listing COMBINATION between those two ids,
-- including ones the engine hadn't compared yet, for both auto-merge and
-- suggestion-filing (never just re-suggestion); `engine.perform_merge`
-- refuses outright (raises) if ever asked to merge an exact vetoed pair,
-- as a last-line defense.
--
-- What this does NOT cover (PR #611's second review, issue #612): a
-- BRAND-NEW listing ingested after the veto starts life as its OWN new
-- property row (etl/orchestrator.py), not attached to either vetoed id.
-- It only becomes subject to the veto once it merges onto one of the two
-- vetoed ids, and nothing guarantees it picks the correct side —
-- `fetch_listing_records` has no ORDER BY, so that's insertion-order
-- dependent, and the #197 same-source skip can make the wrong side the
-- ONLY reachable partner. Closing that gap needs evidence-level keying,
-- not id-level keying — tracked in #612, deliberately not this table's
-- job.
--
-- Repointed, never orphaned, when either property loses a merge for an
-- unrelated reason: see `perform_merge`'s veto-repoint step, the same
-- reassignment discipline reconcile.reconcile_merge already applies to
-- listing/profile_listing_state/feedback_event.
CREATE TABLE IF NOT EXISTS property_merge_veto (
    id                     BIGSERIAL    PRIMARY KEY,
    -- RESTRICT (issue #605 Part 2 revision, PR #611 second review — low
    -- priority item), not CASCADE: matches the rest of this schema's
    -- intent (property_merge_log.property_id has no ON DELETE CASCADE
    -- either). A property is never actually deleted by this codebase
    -- (perform_merge only reassigns listing.property_id away from the
    -- losing side, see property_merge_log's own comment below) — CASCADE
    -- here would only ever fire on a FUTURE property-purge feature no one
    -- has written yet, and silently deleting a human's explicit veto
    -- alongside whatever it purged is exactly the kind of loss that goes
    -- unnoticed until it matters.
    property_lo_id         BIGINT       NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
    property_hi_id         BIGINT       NOT NULL REFERENCES property(id) ON DELETE RESTRICT,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Audit trail only (which suggested_merge row(s) this veto was raised
    -- from) — never read by engine logic, never assumed exhaustive.
    source_suggestion_ids  BIGINT[]     NOT NULL DEFAULT '{}',
    CONSTRAINT property_merge_veto_order CHECK (property_lo_id < property_hi_id),
    CONSTRAINT property_merge_veto_unique UNIQUE (property_lo_id, property_hi_id)
);

CREATE INDEX IF NOT EXISTS idx_property_merge_veto_lo ON property_merge_veto (property_lo_id);
CREATE INDEX IF NOT EXISTS idx_property_merge_veto_hi ON property_merge_veto (property_hi_id);

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

-- Issue #643: the stale-verification pass's per-source outcome, so Estado can
-- show "cuántos anuncios desfasados hemos comprobado y cuántos resultaron
-- retirados" per source per run without parsing error_msg.
--   verified_count      = listings actually re-read at the source this run
--                         (every attempt that produced a verdict, alive or
--                         gone) — NOT the nominations, and NOT the attempts
--                         that proved nothing.
--   verified_gone_count = the subset of those that the source positively
--                         declared removed and that were therefore marked
--                         withdrawn, each with its evidence recorded in
--                         listing_status_event.evidence.
-- Both stay 0 for every connector that does not opt into verification, which
-- is most of them, so a nonzero value always means real work happened.
ALTER TABLE connector_run_results ADD COLUMN IF NOT EXISTS verified_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connector_run_results ADD COLUMN IF NOT EXISTS verified_gone_count INTEGER NOT NULL DEFAULT 0;

-- Issue #643: set ONLY when the mass-withdrawal guard suppressed this run's
-- withdrawals, naming which of its checks tripped and by how much (e.g.
-- 'ratio 8/10 >= 80%', 'baseline 60% vs 0% histórico'). NULL whenever the
-- guard stayed quiet, so `WHERE verification_alarm IS NOT NULL` is the
-- "show me the suppressed runs" query.
--
-- It needs its own column because every other signal on this row reports an
-- action TAKEN, and this one reports an action WITHHELD: a guarded run stores
-- verified_count = 10, verified_gone_count = 0, which is byte-identical to a
-- run where all ten listings genuinely came back alive. Without this, the one
-- event an operator most needs to see — "we found ten listings gone and
-- deliberately withdrew none of them, because it looked like our own bug" —
-- exists only as a log line that rotates away.
ALTER TABLE connector_run_results ADD COLUMN IF NOT EXISTS verification_alarm TEXT;

-- Issue #143: listings this connector's run left unfetched under the
-- skip-if-seen policy ("known, still present per discover(), deliberately
-- not re-fetched this run" — etl.orchestrator._should_skip_fetch). NOT the
-- same concept as connectors_skipped above, which counts whole *connectors*
-- skipped via connector_config.enabled=false — this is a listing-level
-- count, always 0 for a connector that hasn't opted into
-- min_refetch_interval_seconds > 0 (today's default for every connector).
ALTER TABLE connector_run_results ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0;

-- Issue #435 (D-099): listings this run did NOT deep-capture because the
-- connector's list page already exposed the price and it was unchanged
-- (etl.orchestrator._should_skip_fetch's list-price capture optimization) —
-- "we already have the detail, and the list confirms the price is stable".
-- Distinct from skipped_count above (skip-if-seen staleness): this is the
-- Auto-continuous-mode saving of not re-opening unchanged detail pages every
-- cycle. Always 0 for a connector that exposes no list price (discovered_prices
-- == {}), which falls back to full capture. Reported alongside fetched_count
-- (deep-captured new/changed) as the "sin-cambio vs deep-capturados" counters.
ALTER TABLE connector_run_results ADD COLUMN IF NOT EXISTS skipped_unchanged_count INTEGER NOT NULL DEFAULT 0;

-- Issue #700: cumulative milliseconds of REAL per-listing work this run —
-- fetch_detail() + normalize() + upsert, summed over every successfully
-- fetched listing across every scope — with the rate limiter's own sleep
-- SUBTRACTED OUT (etl.connectors.rate_limit.RateLimiter.slept_seconds).
--
-- Paired with `fetched_count` (its natural denominator) this is the first
-- per-listing timing the pipeline has ever stored: "how long does one listing
-- take on this portal". The subtraction is the entire point — `throttle` is
-- `limiter.acquire` and connectors call it as fetch_detail's first action, so
-- an unsubtracted stopwatch would bill Fotocasa's ~20s/listing pacing interval
-- as work, reproducing exactly the misreading that made
-- `extension_capture.processed_at - created_at` worthless (see the note on
-- those columns below: measured flat-uniform over the 10s poll interval, i.e.
-- ~100% queue idle, yet read as processing cost for the column's whole
-- life).
--
-- Successful fetches only: an error path's duration describes a failure, not
-- throughput, and averaging the two hides both. 0 (not NULL) for a run that
-- fetched nothing, which is why fetched_count must be the divisor and a
-- fetched_count of 0 must render "—", never a division.
ALTER TABLE connector_run_results ADD COLUMN IF NOT EXISTS fetch_ms_total BIGINT NOT NULL DEFAULT 0;

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

-- Issue #602, D-137 (MAJOR review finding): DedupRunResult.photo_hash_auto_merged
-- was only ever printed by `ps dedup run` -- on the production path
-- (etl.orchestrator.run_dedup, the scheduler/connector-sweep trigger)
-- nothing persisted it anywhere, so an irreversible-in-practice merge
-- path's volume was invisible outside a manual CLI invocation. ALTER, not
-- a column in the CREATE TABLE above (same reasoning as
-- property_merge_log.losing_property_id) -- must stay safe to re-run
-- against an already-migrated database.
ALTER TABLE dedup_runs ADD COLUMN IF NOT EXISTS photo_hash_auto_merged INTEGER;

-- Issue #627, D-138 (review M2): same gap as photo_hash_auto_merged
-- immediately above, not repeated — DedupRunResult.price_gap_rejected
-- reached `ps dedup run`'s print and the orchestrator log line from the
-- start, but a log line is still invisible to anything that isn't
-- tailing it at the right moment. ALTER, not a column in the CREATE
-- TABLE above, for the same re-run-safety reason as
-- photo_hash_auto_merged.
ALTER TABLE dedup_runs ADD COLUMN IF NOT EXISTS price_gap_rejected INTEGER;

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
    -- Issue #478 (Validar filtros): the host suffix an owner-pinned search URL
    -- must fall under for this connector (NULL = does not accept a pinned URL:
    -- capture-only portals and the non-tunable sitemap/API connectors). Read by
    -- the dashboard's connector-filters PUT route to validate a pinned URL's
    -- host server-side. supports_search_override is whether discover() actually
    -- CONSUMES a pinned URL yet (false for all connectors in Phase 4 — the
    -- recall wiring lands per-connector in Phase 5).
    override_host_suffix      TEXT,
    supports_search_override  BOOLEAN      NOT NULL DEFAULT false,
    -- Issue #491: the connector's declarative search-URL grammar (build
    -- template + ECMAScript-canonical parse regex + per-param metadata), or
    -- NULL for a connector without one. Published verbatim by
    -- sync_connector_registry from Connector.search_url_grammar; the dashboard
    -- reads it to infer params from an owner-edited URL in the browser (one
    -- generic implementation, no per-connector TypeScript). parse_pattern is
    -- stored in ECMAScript form so the browser's RegExp consumes it directly.
    search_url_grammar        JSONB,
    -- Issue #515: the connector's public home/base page (e.g.
    -- https://www.pisos.com). The Validar-filtros ETL rows open this when a row
    -- has no derived/pinned search URL yet, so "Abrir" is never a dead button.
    -- NULL only for a connector that declares neither an override_host_suffix nor
    -- an explicit home_url (should be none in the fleet after #515). Published by
    -- sync_connector_registry from Connector.home_url.
    home_url                  TEXT,
    updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Idempotent columns for existing databases (the CREATE above only runs on a
-- fresh install). Issue #478.
ALTER TABLE connector_registry ADD COLUMN IF NOT EXISTS override_host_suffix TEXT;
ALTER TABLE connector_registry ADD COLUMN IF NOT EXISTS supports_search_override BOOLEAN NOT NULL DEFAULT false;
-- Issue #491.
ALTER TABLE connector_registry ADD COLUMN IF NOT EXISTS search_url_grammar JSONB;
-- Issue #515.
ALTER TABLE connector_registry ADD COLUMN IF NOT EXISTS home_url TEXT;

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
    -- 'blocked' (issue #692): the portal served an anti-bot CHALLENGE at the
    -- listing URL instead of the advert. Distinct from BOTH 'failed' (the
    -- capture is broken) and any retirement outcome (the advert is gone) —
    -- it means "the page was never served to us", so nothing was written to
    -- any listing and the capture_worklist row is left pending on purpose.
    -- 'withdrawn' (issue #690, D-159): the portal's own "anuncio retirado"
    -- notice, positively identified and corroborated against the stored
    -- listing. Neither 'failed' (nothing failed) nor 'done' (nothing was
    -- ingested) — see the ALTER pair below for the full reasoning.
    -- 'never_rendered' (issue #701): the extension opened the page, waited out
    -- the portal's whole render budget, and the page never rendered enough to
    -- capture. Written directly by the API route, never by the ETL poll —
    -- see the ALTER pair below.
    status           TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','listing','blocked','withdrawn','never_rendered')),
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

-- Migration (issues #292, #690 and #692): widen the status CHECK beyond the
-- original three values. A DB created before #292 carries the three-value
-- constraint under its default name (extension_capture_status_check); CREATE
-- TABLE IF NOT EXISTS above never alters an existing table, so drop-and-re-add
-- here. init.sql re-applies on every ETL boot, so this must be idempotent:
-- DROP IF EXISTS then ADD is a no-op-safe pair. No data rewrite — each added
-- value only widens the allowed set.
--
-- ONE drop/add pair, listing EVERY value, deliberately. Writing this as a
-- chain of per-issue pairs (add 'listing', then drop and add 'listing' +
-- 'blocked', then again with 'withdrawn') looks like tidier history but is a
-- real bug: the intermediate ADD applies the NARROWER constraint to a table
-- that may already hold rows with a newer value, so re-applying init.sql
-- against a live DB fails with a CheckViolation. init.sql re-applies on every
-- ETL boot and etl/tests/test_capture.py re-applies the schema per test, so
-- that is not hypothetical. Add future statuses to this list; never append a
-- new pair.
--
--   'listing'   (issue #292): the captured page was a SEARCH/results page,
--               not a detail page. Its detail links were harvested.
--   'blocked'   (issue #692): the portal served an anti-bot CHALLENGE at the
--               listing URL instead of the advert. Distinct from BOTH
--               'failed' (the capture is broken) and any retirement outcome
--               (the advert is gone) — it means "the page was never served
--               to us", so nothing was written to any listing and the
--               capture_worklist row is left pending on purpose.
--   'withdrawn' (issue #690, D-159): the captured page was POSITIVELY
--               identified as the portal's own "este anuncio ya no está
--               publicado" notice. Its own status rather than a reuse,
--               because none of the others tells the truth about it:
--               'done' would claim a listing was ingested (none was, and
--               counting it would drag the per-portal field-completeness
--               average down with a page that has no fields to complete);
--               'failed' would claim something went wrong (nothing did — the
--               capture worked and returned the most useful answer a
--               capture-only portal can give), would inflate failed_7d on the
--               data-health page, and via _correlate_worklist would mark the
--               worklist row 'failed' instead of 'stale'.
--   'never_rendered' (issue #701): the extension opened the page, waited out
--               that portal's entire render budget, and the page never
--               rendered enough to capture — so no HTML worth parsing was ever
--               produced and nothing was ingested. Its own status for the same
--               reason 'withdrawn' got one: none of the others is true.
--               'pending' would be a lie that costs real work — etl/capture.py
--               would pick the row up and attempt to parse a page we already
--               know has no advert on it. 'failed' would put "the page never
--               arrived" in the same bucket as "the parser broke", inflating
--               failed_7d with an outcome the parser was never given a chance
--               at, and that conflation is exactly what #700 found had made
--               "hipoges tarda mucho y falla" unanswerable for two reports
--               running. 'blocked' is the closest neighbour but asserts
--               something specific and unproven — that a WAF or challenge
--               intervened — when the honest claim is only that we ran out of
--               patience.
--
--               Written ONLY by POST /api/extension/capture with
--               `outcome: 'never_rendered'`; the row is terminal on insert
--               (processed_at set), so the pending poll never sees it and no
--               capture.py path produces or consumes it. Deliberately does NOT
--               correlate the capture_worklist row: like 'blocked', the URL
--               was never really served, so its queue slot stays pending for a
--               later retry rather than being consumed.
ALTER TABLE extension_capture DROP CONSTRAINT IF EXISTS extension_capture_status_check;
ALTER TABLE extension_capture ADD CONSTRAINT extension_capture_status_check
    CHECK (status IN ('pending','done','failed','listing','blocked','withdrawn','never_rendered'));

-- ── Per-listing timing (issue #700) ─────────────────────────────────────────
-- Why these two columns exist at all: before them the ONLY per-listing timing
-- in the whole pipeline was `processed_at - created_at`, and that number is
-- almost entirely IDLE. `run_capture_poll_loop` polls every 10s, so a capture
-- that arrives at a uniformly random moment waits U(0,10)s in the queue before
-- any work starts. Measured live on 3906 production Idealista captures, the
-- distribution of `processed_at - created_at` is FLAT across every 1s bucket
-- from 0 to 10 (327/387/382/416/377/398/376/399/380/370) — the exact signature
-- of poll-wait, not of work. Its ~5.8s mean is the poll interval's midpoint,
-- not a processing cost, which is why "hipoges tarda mucho por anuncio" could
-- not be answered from it: Hipoges' 5.3s mean and Idealista's 5.8s mean are
-- the SAME number (half of 10s) measured twice, and neither says anything at
-- all about how long a listing actually takes.
--
-- Both are nullable on purpose, and null means "not measured", never "zero":
--   * `processing_ms` — server-side wall time of _process_one() alone
--     (normalize + upsert + the status UPDATE), excluding queue wait. Null on
--     rows written before this column existed.
--   * `render_wait_ms` — how long the BROWSER EXTENSION waited for the page to
--     actually render before it snapshotted the DOM (content-script.js
--     `pollUntilReady` → `waitForQuiescenceThenFire`). This is where a
--     capture-only portal's real per-listing cost lives: Hipoges serves an
--     empty Angular shell whose readySelectors are the generic ["main","h1"],
--     so the loop either fires early on a shell (a fast, near-empty capture)
--     or never satisfies the body-text floor and burns the full MAX_WAIT_MS
--     (20s) before giving up silently. Null whenever the capture came from an
--     extension build that doesn't send it, or from a path that doesn't wait
--     (manual/forced capture) — an independently-deployed Chrome extension is
--     genuinely not upgradeable in lockstep with the server, so a missing
--     value is a normal state, not a defect.
ALTER TABLE extension_capture ADD COLUMN IF NOT EXISTS processing_ms   INTEGER;
ALTER TABLE extension_capture ADD COLUMN IF NOT EXISTS render_wait_ms  INTEGER;

-- Browser-extension presence heartbeat (issue #509). The dashboard origin can
-- NOT be injected into by the extension (its manifest host_permissions cover
-- only the three portal hosts), so presence is SERVER-MEDIATED: the extension
-- fire-and-forget POSTs /api/extension/heartbeat on worker spawn and on its
-- periodic watchdog tick, and every capture-dependent surface reads the last
-- seen timestamp to decide whether to show an "instalar/vincular la extensión"
-- CTA. A single row (id is pinned to 1) — we only care about the latest ping.
-- Idempotent CREATE TABLE IF NOT EXISTS — safe to re-run on every boot.
CREATE TABLE IF NOT EXISTS extension_heartbeat (
    id           SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_seen_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- The extension's manifest version at ping time (chrome.runtime.getManifest),
    -- shown next to the "vinculada" state. Nullable: an old build may not send it.
    version      TEXT
);

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

-- One-time (idempotent) cleanup (issue #454): capture_worklist is the browser
-- extension's queue, so only extension-capturable portals belong in it. cimenta2
-- was seeded here from its sitemap historically, but it is fetched over HTTP by
-- the ETL (aura), NOT by the extension — its ~3917 rows drained to nothing and
-- showed a misleading "0/N pending forever" on the guided-capture list. Delete
-- every row for a non-extension portal (cimenta2 and any other fetch-by-ETL
-- connector). Naturally idempotent: re-running deletes nothing new once the
-- seeding path is gated (etl/worklist_seed.py + the seed route). The extension
-- portal list mirrors etl.capture.EXTENSION_CAPTURE_PORTALS /
-- dashboard/lib/worklist.ts CAPTURE_PORTAL_NAMES — keep the FOUR in step (a
-- fourth list, historically absent, missed on the first Hipoges pass and
-- silently zeroed its worklist every ETL boot — PR #548 review B1 — hence
-- test_capture_worklist.py's test_delete_list_matches_capture_portal_lists,
-- which fails loudly the next time any of these four lists drifts).
DELETE FROM capture_worklist
 WHERE source_portal NOT IN ('idealista', 'aliseda', 'altamira', 'hipoges');

-- ── Re-capture requeue metadata (issue #677) ────────────────────────────────
-- A parser bug can leave a whole cohort of listings holding bad data (the case
-- that prompted this: every Idealista listing stored ≤3 photos because the
-- portal truncates its gallery preview server-side — #625, fixed by #654).
-- Those listings already have a worklist row, already `captured`, so the
-- existing extension batch driver (D-043) is the transport: flipping the row
-- back to 'pending' re-captures it. What that flip destroys, in place, is the
-- fact that the row already produced data once — so after an interrupted pass
-- a half-drained cohort would be indistinguishable from one that was never
-- captured at all.
--
-- These three columns carry that distinction OUTSIDE `status`, which stays a
-- single lifecycle value with its existing five members. A sixth status
-- ('requeued') was rejected: `status` is read by four independent consumers
-- (dashboard/lib/db/worklist.ts's list + pending queries, the worklist
-- roll-ups, etl/worklist_seed.py's 'stale' reconciliation, and
-- etl/capture.py's correlation) and — decisively — the extension filters
-- `r.status === 'pending'` client-side in background.js, so a new status
-- would sit in a state nothing drives: a queue that looks busy and never
-- drains. Orthogonal metadata needs no consumer to change.
--
--   never captured        → status='pending' AND requeued_at IS NULL
--   deliberately requeued → status='pending' AND requeued_at IS NOT NULL
--
-- `matched_capture_id` is deliberately NOT cleared on requeue: it stays
-- pointing at the capture that satisfied the row last time until a new
-- capture replaces it, so the prior evidence survives the requeue.
ALTER TABLE capture_worklist ADD COLUMN IF NOT EXISTS requeued_at    TIMESTAMPTZ;
ALTER TABLE capture_worklist ADD COLUMN IF NOT EXISTS requeue_reason TEXT;
-- Drain order within a requeued cohort, 1 = most valuable (see
-- dashboard/lib/db/recapture.ts). Frozen at requeue time rather than joined
-- live: the worklist ↔ listing correlation is `worklistMatchKey`, which exists
-- in exactly two places (TS + Python) kept byte-identical by a shared test
-- fixture, and a live ORDER BY join would need a third copy of it in SQL.
ALTER TABLE capture_worklist ADD COLUMN IF NOT EXISTS requeue_rank   INTEGER;

-- The drain queries order by
--   (CASE WHEN status = 'pending' THEN requeue_rank END) ASC NULLS FIRST,
--   created_at DESC, id DESC
-- NULLS FIRST so every row that was never requeued keeps exactly the position
-- it has today, and a requeued cohort drains after them in value order. The
-- rank is gated on `status = 'pending'` inside the ORDER BY rather than being
-- cleared when the row leaves 'pending': clearing it would need a write in
-- both etl/capture.py (which flips the row to 'captured' on correlation) and
-- every dashboard status writer, and the two would drift. Gating in the sort
-- needs no cleanup anywhere and keeps the rank as a record of what the row was
-- worth last time it was queued.
--
-- No index: `capture_worklist` is a few thousand rows per portal and the sort
-- is over a CASE expression that a plain column index could not serve anyway.

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

-- Issue #376 (zero-results regression monitor): the real harvested result count
-- the LAST time this (profile, task) capture was run. The dashboard task-run
-- POST records it when known; it is the extension-path counterpart to the
-- server connectors' per-scope `connector_run_results.geography_scope`
-- discovered_count. ADD COLUMN IF NOT EXISTS (a column inside the CREATE TABLE
-- above is a no-op against an already-created table), NULL for rows written
-- before the column existed and for runs that recorded no count.
ALTER TABLE capture_task_run ADD COLUMN IF NOT EXISTS last_result_count INTEGER;


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

-- Issue #376 (zero-results regression monitor): the real harvested result count
-- the last time the extension enumerated this (portal, search URL) — the count
-- `enumerateResultsPages()` (#362) computes as `seen.size` and, until now,
-- discarded. The extension re-POSTs to /api/extension/search-url-example at the
-- END of enumeration with `resultCount`, and the writer upserts it here. This
-- is the extension-side counterpart to the server connectors' per-scope
-- discovered_count; keyed by (portal, match_key) = (connector, resolved
-- scope/filter). ADD COLUMN IF NOT EXISTS (idempotent), NULL until an
-- enumeration reports a count.
ALTER TABLE search_url_example ADD COLUMN IF NOT EXISTS last_result_count INTEGER;


-- Captured Idealista search URLs (issue #475, part of #471).
--
-- The browser extension's "Capturar URL de búsqueda" action sends the RAW
-- results-page URL the owner is on — verbatim, including the `shape=` param
-- that "Dibuja tu zona" encodes the drawn polygon into. Unlike
-- search_url_example (which DECODES a URL into a reusable filter template and
-- drops anything it can't parse), this table keeps the URL exactly as captured
-- so #471 P1 can reverse-engineer Idealista's polygon encoding. The extension
-- is the safe channel: CDP/automation hits DataDome (403), but the owner's real
-- session in their own browser does not.
--
-- No dedupe/upsert: a re-draw of the same zone is a distinct capture worth
-- keeping (the encoding may differ), and the review surface is a plain
-- newest-first list. Idempotent CREATE TABLE IF NOT EXISTS — safe to re-run.
CREATE TABLE IF NOT EXISTS captured_search_urls (
    id           BIGSERIAL    PRIMARY KEY,
    -- Portal derived server-side from the URL host (never client-claimed).
    -- One of the capture portals: 'idealista' | 'aliseda' | 'altamira' | 'hipoges' (#510).
    portal       TEXT         NOT NULL,
    -- The search URL exactly as captured (shape= and all).
    url          TEXT         NOT NULL,
    -- The results page's document.title at capture time (may be empty).
    title        TEXT,
    captured_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Free-text operator annotation (unused by the extension path; reserved for
    -- the review surface).
    notes        TEXT
);

-- The review surface reads newest-first; a captured_at index keeps that cheap
-- as captures accumulate.
CREATE INDEX IF NOT EXISTS idx_captured_search_urls_recent
    ON captured_search_urls (captured_at DESC);


-- Passively-OBSERVED Idealista search URLs (issue #488, part of #471).
--
-- Distinct from captured_search_urls above: those are the owner's INTENTIONAL
-- captures ("Capturar URL de búsqueda"), while these are forwarded PASSIVELY by
-- the extension's observer as the owner browses Idealista search/results pages,
-- so the drawn-zone/filtering grammar can be analysed in bulk. Kept in its own
-- table so the passive noise never drowns the deliberate captures.
--
-- De-dup is by norm_key (host + path + sorted query, derived server-side): a
-- re-observation UPSERTs, bumping seen_count + last_seen rather than inserting a
-- duplicate. url is kept VERBATIM (shape= and all) — never decoded/normalised.
CREATE TABLE IF NOT EXISTS observed_search_urls (
    id           BIGSERIAL    PRIMARY KEY,
    -- Portal derived server-side from the URL host (never client-claimed).
    -- One of the capture portals: 'idealista' | 'aliseda' | 'altamira' | 'hipoges' (#510).
    portal       TEXT         NOT NULL,
    -- The search URL exactly as observed (shape= and all), latest sighting.
    url          TEXT         NOT NULL,
    -- Canonical de-dup key (host + path + sorted query). UNIQUE → UPSERT target.
    norm_key     TEXT         NOT NULL UNIQUE,
    -- The results page's document.title at observation time (may be empty).
    title        TEXT,
    -- How many times this distinct search was observed (across sessions).
    seen_count   INTEGER      NOT NULL DEFAULT 1,
    first_seen   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_seen    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- The review surface reads newest-sighting-first; a last_seen index keeps that
-- cheap as observations accumulate.
CREATE INDEX IF NOT EXISTS idx_observed_search_urls_recent
    ON observed_search_urls (last_seen DESC);


-- Owner-pinned search URL per (profile × connector × section) — issue #478 P1.
--
-- This is the FIXED search URL the owner chose for a connector on a specific
-- profile: it becomes that connector's RECALL SOURCE for that profile,
-- SUPERSEDING the derived URL (the TS builder for extension portals, or the
-- Python _search_url() for HTTP connectors). Stored VERBATIM — its numeric
-- values are NEVER re-substituted the way tier-1 learned templates are: the
-- owner tuned it by hand ("this will be the source"), and a `shape=` drawn-zone
-- URL may not even parse. Per D-090, URL building is code-driven; an
-- owner-pinned URL is the maximal "owner-confirmed" case and therefore beats
-- everything derived.
--
-- Precedence in the resolver (dashboard/lib/search-url/resolve.ts):
--   tier 0  THIS override (profile × portal × section)  → url verbatim, loosened []
--   tier 1  exact learned example (D-051)               → substitute in template
--   tier 2  same-area example ≤25 km, capped by #444    → reuse nearby template
--   tier 3  the hand-written builder                    → derived default
--
-- Keyed by `section_key` (the parser's categoryKey: section + sorted property
-- types), NOT by task_id. The task id is an FNV hash of the profile's filters
-- (dashboard/lib/search-url/task-id.ts) and would ORPHAN the moment the owner
-- edits the profile; section_key is stable across scope edits. Default '' applies
-- the override to every task of the connector (single-search / cover-all case).
--
-- FK ON DELETE CASCADE: archiving a profile is a soft delete (archived_at) so
-- the override survives an archive, but a hard profile delete drops its pinned
-- filters with it. Idempotent (CREATE ... IF NOT EXISTS + DROP TRIGGER IF
-- EXISTS) — applying this file twice is a no-op.
CREATE TABLE IF NOT EXISTS profile_connector_filter (
    id           BIGSERIAL    PRIMARY KEY,
    profile_id   BIGINT       NOT NULL REFERENCES search_profile(id) ON DELETE CASCADE,
    -- Connector/portal name ('idealista', 'aliseda', 'altamira', 'fotocasa', …).
    connector    TEXT         NOT NULL,
    -- The task section/category this replaces ('' = all / single-search connector).
    -- For extension portals it is the parser's categoryKey (section + sorted
    -- types); NEVER the task id (a hash of the filters — orphans on profile edit).
    section_key  TEXT         NOT NULL DEFAULT '',
    -- The pinned URL, verbatim (shape= intact); never re-substituted.
    url          TEXT         NOT NULL,
    source       TEXT         NOT NULL CHECK (source IN ('manual', 'extension')),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (profile_id, connector, section_key)
);

-- The resolver loads every override for a profile in one shot
-- (findOverridesForProfile → WHERE profile_id = $1); index that lookup.
CREATE INDEX IF NOT EXISTS idx_profile_connector_filter_profile
    ON profile_connector_filter (profile_id);

-- Reuse the generic set_updated_at() trigger (defined near the top of this file)
-- so updated_at tracks every upsert.
DROP TRIGGER IF EXISTS trg_profile_connector_filter_set_updated_at ON profile_connector_filter;
CREATE TRIGGER trg_profile_connector_filter_set_updated_at
    BEFORE UPDATE ON profile_connector_filter
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();


-- Issue #478 P4 (Validar filtros): per-(profile × connector) preview of what
-- the ETL's discover() will actually execute for a profile — the entry URL /
-- sitemap / endpoint plus an honest note for the non-tunable connectors. The
-- ETL computes these OFFLINE (pure geography resolution + the connector's own
-- _search_url()) and upserts them each scheduler cycle and after a profile
-- quick-refresh (etl.orchestrator.publish_search_previews); the "Validar
-- filtros" page reads them for its ETL-connectors section. `previews` is the
-- JSON-serialised list[SearchPreview] (label/url/kind/tunable/notes). Rows for
-- an archived/deleted profile are pruned by publish_search_previews (and
-- hard-deleted via the FK cascade), so a stale profile never lingers here.
CREATE TABLE IF NOT EXISTS connector_search_preview (
    profile_id   BIGINT      NOT NULL REFERENCES search_profile(id) ON DELETE CASCADE,
    connector    TEXT        NOT NULL,
    previews     JSONB       NOT NULL,
    computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, connector)
);

-- The page loads every preview for one profile in a single shot
-- (WHERE profile_id = $1) — the PK's leading column already serves that, so no
-- extra index is needed. ANALYZE so the planner has stats on a fresh install.
ANALYZE connector_search_preview;


-- ============================================================
-- Free-text search over the candidate feed (issue #470, Phase 1)
-- ============================================================
--
-- The feed's structured filters (source, occupancy, condition, gravamen,
-- alerta, playa, casco, VPO, descuento) can't answer "show me the ones whose
-- ad or evaluation mentions terraza / okupado / herencia / Calle Larios". That
-- text lives across THREE tables — listing.description/reference_code/
-- contact_raw, property.address/city/…/features, and the latest ai_assessment
-- row per axis — so an on-the-fly ILIKE across all of it would seq-scan every
-- feed request. Instead we materialize a per-property tsvector (property_search_doc)
-- kept fresh by triggers, and the feed composes it as one more filter in the
-- OUTER WHERE (see listCandidates in dashboard/lib/candidates.ts): the keyset
-- cursor on (novelty_tier, effective_score, property_id) is untouched — this is
-- a filter, not a re-sort (owner decision 1: FILTER, not rank). Relevance
-- ordering is a later optional phase.
--
-- Everything below is idempotent (CREATE ... IF NOT EXISTS / CREATE OR REPLACE /
-- DROP TRIGGER IF EXISTS + a WHERE NOT EXISTS backfill): re-running init.sql on
-- every ETL container startup is a no-op.

-- Spanish text-search config with unaccent folding. Guarded on pg_ts_config so
-- a re-run is a no-op. If the unaccent dictionary is unavailable (extension
-- failed to create above), the ALTER MAPPING degrades to spanish stemming only
-- (accents become exact) rather than aborting — the config still EXISTS, so the
-- refresh function's to_tsvector('es_unaccent', …) never errors at runtime.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'es_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION es_unaccent (COPY = spanish);
    BEGIN
      ALTER TEXT SEARCH CONFIGURATION es_unaccent
        ALTER MAPPING FOR hword, hword_part, word
        WITH unaccent, spanish_stem;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'unaccent dictionary unavailable — es_unaccent uses spanish stemming only (accents exact)';
    END;
  END IF;
END
$$;

-- The materialized search document — one tsvector per property. A separate
-- table, not a GENERATED column on property: the document crosses listing +
-- ai_assessment, which a STORED generated column may not reference. ON DELETE
-- CASCADE removes the doc when a property is deleted (e.g. an orphan dropped
-- after a dedup merge).
CREATE TABLE IF NOT EXISTS property_search_doc (
    property_id BIGINT       PRIMARY KEY REFERENCES property(id) ON DELETE CASCADE,
    doc         TSVECTOR     NOT NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_property_search_doc_gin
    ON property_search_doc USING GIN (doc);

-- Recompose the document for ONE property from property + its active listings +
-- the latest ai_assessment row per axis (same DISTINCT ON ... generated_at DESC
-- rule loadFlags/the ranked CTE use). Weighted:
--   A — location identity: address, city, province, postal_code, cadastral_ref,
--       and every listing reference_code.
--   B — the big text: description of each ACTIVE listing (any operation, all
--       sources — the doc is GLOBAL per property, not per profile; per-source
--       visibility stays governed by the feed's ranked CTE, D-055 nuance).
--   C — structured attributes (source, property_type, floor, features,
--       contact_raw) + assessment-derived codes AND their Spanish labels, so
--       both "nuda_propiedad"/"nuda propiedad" and English codes with their
--       card labels ("tenanted"→alquilado, "frontline"→primera línea de playa)
--       match. The CASE vocabulary mirrors the TS label maps (CAVEAT_LABELS /
--       REDFLAG_LABELS in lib/candidates.ts + lib/ai-assessment/redflags.ts,
--       BEACH_PROXIMITY_LABELS/HERITAGE_ZONE_LABEL in location-vocabulary.ts) —
--       keep them in sync (same closed-vocabulary discipline as WARN_CAVEAT_CODES).
-- Numbers (price/rooms/m²/bathrooms) are deliberately OUT — the profile's range
-- filters + the discount filter own them (owner decision 2). Evidence quotes are
-- out too (redundant with weight B). CREATE OR REPLACE so a re-run just updates.
CREATE OR REPLACE FUNCTION refresh_property_search_doc(p_property_id BIGINT)
RETURNS void AS $$
DECLARE
  v_prop      property%ROWTYPE;
  v_a_text    TEXT;
  v_b_text    TEXT;
  v_c_text    TEXT;
  v_ref       TEXT;
  v_sources   TEXT;
  v_contacts  TEXT;
  v_assess    TEXT;
BEGIN
  SELECT * INTO v_prop FROM property WHERE id = p_property_id;
  IF NOT FOUND THEN
    -- Property gone (deleted after a merge). ON DELETE CASCADE already removed
    -- the doc row, but delete defensively in case this is called mid-transaction.
    DELETE FROM property_search_doc WHERE property_id = p_property_id;
    RETURN;
  END IF;

  -- Weight A: property location identity + listing reference codes.
  SELECT string_agg(l.reference_code, ' ')
    INTO v_ref
    FROM listing l
   WHERE l.property_id = p_property_id AND l.reference_code IS NOT NULL;
  v_a_text := concat_ws(' ',
    v_prop.address, v_prop.city, v_prop.province, v_prop.postal_code,
    v_prop.cadastral_ref, v_ref);

  -- Weight B: descriptions of active listings (all sources, all operations).
  SELECT string_agg(l.description, ' ')
    INTO v_b_text
    FROM listing l
   WHERE l.property_id = p_property_id
     AND l.status = 'active'
     AND l.description IS NOT NULL;

  -- Weight C, part 1: active listings' source slugs + agency contact.
  SELECT string_agg(DISTINCT l.source, ' ')
    INTO v_sources
    FROM listing l
   WHERE l.property_id = p_property_id AND l.status = 'active';
  SELECT string_agg(l.contact_raw, ' ')
    INTO v_contacts
    FROM listing l
   WHERE l.property_id = p_property_id AND l.status = 'active'
     AND l.contact_raw IS NOT NULL;

  -- Weight C, part 2: assessment-derived codes + Spanish labels, from the
  -- latest row per axis. Codes already Spanish (nuda_propiedad, a_reformar) get
  -- replace('_',' '); English codes add their card label via a small CASE.
  WITH latest AS (
    SELECT DISTINCT ON (a.assessment_type) a.assessment_type, a.result
      FROM ai_assessment a
     WHERE a.property_id = p_property_id
       AND a.assessment_type IN ('occupancy','condition','redflags','location','opportunity')
     ORDER BY a.assessment_type, a.generated_at DESC NULLS LAST, a.id DESC
  )
  SELECT concat_ws(' ',
    -- occupancy caveats: raw code + label for the English ones.
    (SELECT string_agg(
              replace(cv, '_', ' ') ||
              CASE cv
                WHEN 'tenanted'           THEN ' alquilado'
                WHEN 'occupied_illegally' THEN ' ocupado okupado'
                ELSE '' END, ' ')
       FROM latest lo
       CROSS JOIN LATERAL jsonb_array_elements_text(lo.result->'caveats') cv
      WHERE lo.assessment_type = 'occupancy'
        AND jsonb_typeof(lo.result->'caveats') = 'array'),
    -- condition category + renovation depth (both flat text on the row).
    (SELECT concat_ws(' ',
              replace(lc.result->>'condition', '_', ' '),
              replace(lc.result->>'renovation_severity', '_', ' '),
              CASE lc.result->>'condition'
                WHEN 'a_reformar' THEN 'a reformar reformar'
                WHEN 'obra_nueva' THEN 'obra nueva'
                ELSE '' END)
       FROM latest lc WHERE lc.assessment_type = 'condition'),
    -- redflags: each flag's type + description + label, plus any proposed
    -- candidate_type + its definition. Evidence quotes excluded (weight B).
    (SELECT string_agg(concat_ws(' ',
              replace(rf.value->>'type', '_', ' '),
              rf.value->>'description',
              CASE rf.value->>'type'
                WHEN 'unfinished_construction' THEN 'obra inacabada obra sin terminar'
                WHEN 'structural_damage'       THEN 'dano estructural danos estructurales'
                ELSE '' END,
              replace(rf.value->>'candidate_type', '_', ' '),
              rf.value->>'candidate_definition'), ' ')
       FROM latest lr
       CROSS JOIN LATERAL jsonb_array_elements(lr.result->'flags') rf
      WHERE lr.assessment_type = 'redflags'
        AND jsonb_typeof(lr.result->'flags') = 'array'
        AND jsonb_typeof(rf.value) = 'object'
        AND rf.value->>'type' IS NOT NULL),
    -- location: beach proximity grade (code + label) + heritage zone.
    (SELECT concat_ws(' ',
              CASE ll.result->>'beach_proximity'
                WHEN 'frontline'  THEN 'frontline primera linea de playa'
                WHEN 'sea_view'   THEN 'sea_view vistas al mar'
                WHEN 'near_beach' THEN 'near_beach cerca de la playa'
                ELSE '' END,
              CASE WHEN ll.result->>'heritage_zone' = 'true'
                   THEN 'casco historico zona patrimonio' ELSE '' END)
       FROM latest ll WHERE ll.assessment_type = 'location'),
    -- opportunity: VPO + tourist licence flags → the labels the card shows.
    (SELECT concat_ws(' ',
              CASE WHEN lop.result->>'is_vpo' = 'true'
                   THEN 'vpo vivienda protegida' ELSE '' END,
              CASE WHEN lop.result->>'tourist_license' = 'true'
                   THEN 'licencia turistica vut' ELSE '' END)
       FROM latest lop WHERE lop.assessment_type = 'opportunity')
  ) INTO v_assess;

  v_c_text := concat_ws(' ',
    v_sources, v_prop.property_type, v_prop.floor,
    array_to_string(v_prop.features, ' '), v_contacts, v_assess);

  INSERT INTO property_search_doc (property_id, doc, updated_at)
  VALUES (
    p_property_id,
         setweight(to_tsvector('es_unaccent', coalesce(v_a_text, '')), 'A')
      || setweight(to_tsvector('es_unaccent', coalesce(v_b_text, '')), 'B')
      || setweight(to_tsvector('es_unaccent', coalesce(v_c_text, '')), 'C'),
    NOW()
  )
  ON CONFLICT (property_id) DO UPDATE
    SET doc = EXCLUDED.doc, updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Shared trigger function: recompute the affected property's doc AFTER any write
-- that could change searchable text. Heterogeneous writers (ETL connectors, the
-- browser-capture path, dashboard assessment saves, dedup merges) are ALL
-- covered without touching app code. RETURN NULL — these are AFTER triggers.
CREATE OR REPLACE FUNCTION trg_refresh_property_search_doc()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'property' THEN
    PERFORM refresh_property_search_doc(NEW.id);
  ELSIF TG_TABLE_NAME = 'listing' THEN
    -- A dedup merge reassigns listing.property_id: refresh BOTH the property
    -- the listing left (its text shrinks) and the one it joined.
    IF TG_OP = 'UPDATE' AND OLD.property_id IS DISTINCT FROM NEW.property_id THEN
      PERFORM refresh_property_search_doc(OLD.property_id);
    END IF;
    PERFORM refresh_property_search_doc(NEW.property_id);
  ELSIF TG_TABLE_NAME = 'ai_assessment' THEN
    PERFORM refresh_property_search_doc(NEW.property_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- property: refresh on insert, and on updates to any searchable column only —
-- an UPDATE OF list so unrelated column bumps don't fire a recompute.
DROP TRIGGER IF EXISTS trg_property_search_doc_ins ON property;
CREATE TRIGGER trg_property_search_doc_ins
    AFTER INSERT ON property
    FOR EACH ROW EXECUTE FUNCTION trg_refresh_property_search_doc();
DROP TRIGGER IF EXISTS trg_property_search_doc_upd ON property;
CREATE TRIGGER trg_property_search_doc_upd
    AFTER UPDATE OF address, city, province, postal_code, cadastral_ref,
                    property_type, floor, features
    ON property
    FOR EACH ROW EXECUTE FUNCTION trg_refresh_property_search_doc();

-- listing: the UPDATE OF list + WHEN guard is what stops the nightly last_seen_at
-- / missed_discovery_count sweep (a bulk UPDATE of those unrelated columns) from
-- firing a recompute for every active listing — only a real change to searchable
-- text (or a property_id reassignment) refreshes. INSERT has no WHEN (no OLD).
DROP TRIGGER IF EXISTS trg_listing_search_doc_ins ON listing;
CREATE TRIGGER trg_listing_search_doc_ins
    AFTER INSERT ON listing
    FOR EACH ROW EXECUTE FUNCTION trg_refresh_property_search_doc();
DROP TRIGGER IF EXISTS trg_listing_search_doc_upd ON listing;
CREATE TRIGGER trg_listing_search_doc_upd
    AFTER UPDATE OF description, property_id, status, source, reference_code, contact_raw
    ON listing
    FOR EACH ROW
    WHEN (
         OLD.description    IS DISTINCT FROM NEW.description
      OR OLD.property_id    IS DISTINCT FROM NEW.property_id
      OR OLD.status         IS DISTINCT FROM NEW.status
      OR OLD.source         IS DISTINCT FROM NEW.source
      OR OLD.reference_code IS DISTINCT FROM NEW.reference_code
      OR OLD.contact_raw    IS DISTINCT FROM NEW.contact_raw
    )
    EXECUTE FUNCTION trg_refresh_property_search_doc();

-- ai_assessment: low write frequency, so refresh unconditionally on insert/update.
DROP TRIGGER IF EXISTS trg_ai_assessment_search_doc ON ai_assessment;
CREATE TRIGGER trg_ai_assessment_search_doc
    AFTER INSERT OR UPDATE ON ai_assessment
    FOR EACH ROW EXECUTE FUNCTION trg_refresh_property_search_doc();

-- One-time migration: backfill the doc for every existing property that has none
-- yet. Idempotent via WHERE NOT EXISTS + reuse of refresh_property_search_doc, so
-- the backfill produces byte-identical docs to the triggers and re-running does
-- nothing once populated. The table is permanent — no post-backfill cleanup.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.id
      FROM property p
     WHERE NOT EXISTS (
             SELECT 1 FROM property_search_doc d WHERE d.property_id = p.id)
  LOOP
    PERFORM refresh_property_search_doc(r.id);
  END LOOP;
END
$$;


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

-- Subscription quota readings (D-107). A host-side poller runs
-- `claude -p "/usage"` — free, no model call — and pushes the parsed
-- percentages here so the dashboard can stop calling the LLM before the
-- account's session/weekly limit is reached.
--
-- Why a table and not an in-memory value: the reading comes from OUTSIDE the
-- dashboard process (only credential-file auth can see the quota view, which
-- the container does not have), it must survive a restart, and /etl/salud
-- wants to show it. One row per reading, newest wins; old rows are history.
CREATE TABLE IF NOT EXISTS llm_quota_reading (
    id                  BIGSERIAL   PRIMARY KEY,
    read_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 0-100 per window; NULL when that window was absent from the output.
    session_pct         INTEGER     CHECK (session_pct BETWEEN 0 AND 100),
    week_pct            INTEGER     CHECK (week_pct BETWEEN 0 AND 100),
    week_top_model_pct  INTEGER     CHECK (week_top_model_pct BETWEEN 0 AND 100),
    -- Raw reset strings, for display only ("Aug 21 at 12pm (Europe/Madrid)").
    session_resets_at   TEXT,
    week_resets_at      TEXT,
    week_top_model_resets_at TEXT,
    -- Where the reading came from, so a stale source is diagnosable.
    source              TEXT        NOT NULL DEFAULT 'host-poller'
);

CREATE INDEX IF NOT EXISTS idx_llm_quota_reading_read_at
    ON llm_quota_reading (read_at DESC);

-- Browser-extension block/challenge episodes (issue #634). The extension
-- (browser-extension/detect.js detectBlockSignals) detects a CAPTCHA/WAF
-- challenge page on a capture portal, pauses whatever batch/auto run is
-- active (D-043/D-112's pending queue survives untouched), and POSTs exactly
-- one row here per NEW episode via POST /api/extension/block-episode — the
-- same "server-mediated presence" pattern as extension_heartbeat, since the
-- extension can't inject into the dashboard origin. `signature` is the marker
-- id detect.js matched (e.g. 'captcha_wall', 'cloudflare_challenge') — NEVER
-- page content or the captured URL (public repo, no scraped listing data).
-- Read by /etl/salud (via getDataHealth) as an INFORMATIONAL notice, aligned
-- with D-047's "a soft-block/challenge stop is a clean outcome, not an
-- error" vocabulary — never rendered as a red/failed badge.
CREATE TABLE IF NOT EXISTS extension_block_episode (
    id           BIGSERIAL    PRIMARY KEY,
    portal       TEXT         NOT NULL,
    signature    TEXT         NOT NULL,
    -- When the extension detected the challenge (client clock); may lag
    -- reported_at slightly if the fire-and-forget POST was delayed/retried.
    detected_at  TIMESTAMPTZ  NOT NULL,
    reported_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_extension_block_episode_detected_at
    ON extension_block_episode (detected_at DESC);

-- "Forzar captura + diagnóstico" (issue #671) — a DIAGNOSTIC channel, NOT an
-- ingest path. Deliberately a table of its own, not a flag/status value
-- inside `extension_capture`: `extension_capture` is polled by
-- etl/capture.py (a 'pending' row there gets parsed and upserted into
-- `listing`/`property`) — this table is read by NOTHING that path or any
-- other processing job touches. No FK from capture_worklist, no trigger, no
-- poller. POST /api/extension/diagnostic (the only writer) inserts directly
-- here; the extension never calls /api/extension/capture for this flow.
--
-- Retention is the whole point of this feature (three real investigations
-- this week depended on page HTML surviving by accident — see the D-153
-- record for this table). It ALWAYS keeps the HTML, regardless of connector
-- calibration state or #670's `etl.retain_capture_html_for` config (which
-- only governs `extension_capture.html`, a completely different column on a
-- completely different table). Retention is nonetheless BOUNDED: see
-- purge_extension_diagnostics() below. Per-row manual deletion (the
-- /admin/diagnostics surface's delete button) remains the way to drop one
-- diagnostic on purpose; the purge function is the floor under the rest.
--
-- `detection` mirrors browser-extension/diagnostic.js's buildDiagnosticBlock
-- output verbatim (detailPortal/listingPortal/pageRole, the isRenderReady
-- verdict + WHICH selector satisfied it, anchor/extractDetailUrls counts,
-- the D-142 block-signal verdict, and whether auto-capture would have
-- fired) — read as opaque JSONB, never parsed by any Python/SQL job.
--
-- `network` is NULL unless the owner armed the opt-in network-capture reload
-- (issues #671, #684) — {entries:[{url,method,status,...}], droppedCount},
-- shaped and redacted in the BROWSER before the request that stores this row
-- (network-recorder.js summarizeEntry); this table is not a second place to
-- redact. Be precise about what "redacted" covers, because D-164 records that
-- it is narrower than PR #675's description claimed:
--   STRIPPED — credential-shaped request/response headers; credential-shaped
--   query params, PATH segments and FRAGMENT params; and, inside a body, a
--   JSON value under a credential-shaped key, a `Bearer …` literal, a bare JWT.
--   NOT STRIPPED — the response BODY itself. It is truncated at 20 KB and
--   scrubbed of those three shapes, and that is all: whatever the portal
--   returned, personal data included, lands here verbatim. Request bodies are
--   never captured at all.
--
-- Personal data note (AGENTS.md "no scraped personal data in committed
-- files"): `html`/`network` can carry owner names, phone numbers, and
-- contact-form markup off the captured page — `network` because a portal's own
-- API answers with exactly that. That's fine IN THE PRODUCTION
-- DB (not public) — it must never reach a committed file (a fixture built
-- from a row here needs its own scrubbing pass first).
CREATE TABLE IF NOT EXISTS extension_diagnostic (
    id                 BIGSERIAL    PRIMARY KEY,
    url                TEXT         NOT NULL,
    html               TEXT         NOT NULL,
    html_bytes         INTEGER      NOT NULL,
    title              TEXT,
    extension_version  TEXT,
    detection          JSONB,
    network            JSONB,
    network_dropped_count INTEGER,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_extension_diagnostic_created_at
    ON extension_diagnostic (created_at DESC);

-- Bounded retention for the diagnostic channel (PR #675 review, S4).
--
-- Every row here is a whole third-party page (~350 KB) captured from the
-- owner's own browser, and a rendered listing page routinely carries owner
-- names, phone numbers and contact-form markup. Storing that indefinitely
-- with no expiry — "pruning is manual" — makes an unbounded personal-data
-- store out of a debugging aid, which is the opposite of issue #1 §15's
-- GDPR-minimisation stance and of the retention posture the same schema
-- already takes for owner_identity.
--
-- Shaped exactly like purge_stale_owner_identities() (this file, above):
-- same `retention_days INT DEFAULT` signature, same RETURNS INT count of
-- what it removed, same plpgsql CTE, so the two are called and reasoned
-- about identically. The one deliberate difference is DELETE rather than
-- column-nulling: an owner_identity row survives its purge because
-- listing_owner_identity still references it, whereas nothing anywhere
-- references an extension_diagnostic row (that is the entire premise of the
-- table — see the comment above), so there is nothing left to keep once its
-- payload is gone.
--
-- 30 days, not owner_identity's 90: a diagnostic exists to unblock ONE
-- investigation that is, in practice, in progress the same week. It is also
-- ~350 KB against owner_identity's few hundred bytes. Anything worth keeping
-- past a month belongs in a scrubbed fixture, not in this table.
--
-- Like purge_stale_owner_identities, this ships the MECHANISM only —
-- scheduling the call is the orchestrator's business, and no caller is wired
-- up yet.
CREATE OR REPLACE FUNCTION purge_extension_diagnostics(retention_days INT DEFAULT 30)
RETURNS INT AS $$
DECLARE
    purged_count INT;
BEGIN
    WITH purged AS (
        DELETE FROM extension_diagnostic
        WHERE created_at < NOW() - make_interval(days => retention_days)
        RETURNING id
    )
    SELECT count(*)::INT INTO purged_count FROM purged;
    RETURN purged_count;
END;
$$ LANGUAGE plpgsql;

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
ANALYZE llm_quota_reading;
ANALYZE property_merge_log;
ANALYZE suggested_merge;
ANALYZE extension_capture;
ANALYZE capture_worklist;
ANALYZE capture_worklist_seed_trigger;
ANALYZE capture_task_run;
ANALYZE search_url_example;
ANALYZE captured_search_urls;
ANALYZE observed_search_urls;
ANALYZE profile_connector_filter;
ANALYZE property_search_doc;
ANALYZE extension_block_episode;
ANALYZE extension_diagnostic;
