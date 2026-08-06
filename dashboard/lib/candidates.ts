/**
 * Reads the materialized candidate set for a search profile (task 2.4,
 * `profile_listing_state.matched = true`) grouped at the `property` level.
 *
 * Server-only: imports lib/db-write (the `pg` client) — same reasoning as
 * lib/db/profiles.ts, never import this from a client component.
 *
 * One row out = one deduplicated property (issue #19: "one card per
 * property_id, not per listing" — a property with 2+ linked listings after
 * task 2.2's dedup engine merges cross-site duplicates must render as a
 * single candidate with multiple source badges, never as separate cards).
 */

import { sql } from "@/lib/db-write";
import { DISABLED_SOURCES_CTE, activeSourceClause } from "@/lib/db/source-active";
import { REDFLAG_LABELS } from "@/lib/ai-assessment/redflags";

export interface CandidateListingSummary {
  id: number;
  source: string;
  url: string | null;
  current_price: number | null;
}

/**
 * A qualitative flag rendered as a compact badge on the card (#152).
 *
 * `tone` drives colour only — `neutral` for descriptive facts, `warn` for
 * things that materially change what you're buying (occupied, debt sale,
 * partial ownership). Deliberately not derived from the label text so a
 * future flag can't accidentally inherit the wrong urgency.
 */
export interface CandidateFlag {
  kind: string;
  label: string;
  tone: "neutral" | "warn";
  /**
   * Optional longer explanation for a hover/expand tooltip (#361). Set for
   * problem flags (redflags), where the model's own one-line `description`
   * ("comprobar si la obra tiene licencia y cuánto falta por terminar") adds
   * real context the short badge label can't. Occupancy/condition flags leave
   * this undefined — their label already says everything.
   */
  description?: string;
}

export interface CandidateRow {
  property_id: number;
  address: string | null;
  lat: number | null;
  lon: number | null;
  property_type: string | null;
  m2_built: number | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: string | null;
  /**
   * Capped, de-duplicated union of `photo_urls` across the property's
   * *active* listings, grouped by listing in `source` order (alphabetical),
   * then by within-listing position — the same status filter and the same
   * order the detail page's gallery uses (`getPropertyDetail` in
   * lib/property-detail.ts, which filters to active listings and reads them
   * `ORDER BY source`), and the same de-dup-by-URL rule (first occurrence in
   * that order wins). Powers the card's photo-first lead image (#152) and
   * its in-place photo ticker (#167): `photos[0]` is genuinely the same lead
   * image the detail page's hero shows, and flicking through the ticker
   * walks a prefix of the same sequence the lightbox does — not an
   * independently-ordered subset (a real, reproduced bug prior to #167's
   * review must-fix 1: this query used to filter `active` but order by
   * `listing.id`, while the detail page didn't filter status at all and
   * ordered by `source` — different lead image, different order, different
   * set, including a withdrawn listing's photos able to lead the detail
   * gallery). The card's primary visual is `photos[0]`; empty means no
   * active listing has photos (the card falls back to a placeholder).
   *
   * Capped at `MAX_CARD_PHOTOS`, unlike the detail gallery (uncapped by
   * design — a user who has drilled into one property should see
   * everything). A list page renders up to `DEFAULT_LIMIT` cards at once;
   * fetching every photo of every card would make an already-nontrivial
   * page query far more expensive for a control most users only nudge a
   * couple of times per card.
   *
   * #167 removed the separate `thumbnail_url` field this replaced — it was
   * always exactly `photos[0] ?? null`, a redundant derived value once the
   * full array exists (this project's "no dual representations of the same
   * fact" default; see AGENTS.md's backwards-compatibility policy). Read
   * `photos[0]` directly.
   */
  photos: string[];
  /**
   * AI-derived qualitative flags (#25 occupancy/debt-sale/partial-sale, #26
   * condition). Always present, empty until an assessment exists — the card
   * renders nothing rather than a placeholder, so this degrades cleanly both
   * before #25 lands and for properties it hasn't assessed yet.
   */
  flags: CandidateFlag[];
  /** MIN(listing.current_price) across the property's *active* listings — same convention as task 2.4's price-band filter (see data-model.md). Null if no active listing has a price. */
  min_price: number | null;
  /** Earliest first_seen_at across all of the property's listings. */
  first_seen_at: string | null;
  /**
   * FRESHEST `last_seen_at` across the property's *active* sale listings —
   * "last time discover() re-confirmed this property is still live" (issue
   * #243, roadmap §6.1). MAX, not MIN: a deduplicated property is only as
   * stale as its most-recently-confirmed listing (if any linked listing was
   * seen recently, the property isn't stale). Active-sale-only, matching
   * `min_price`/`listings`/`photos` above — a withdrawn sibling's frozen
   * timestamp must neither rescue nor is re-confirmed by discover(). Null when
   * no active sale listing has a `last_seen_at` (unknown, not fresh). The card
   * renders `StalenessBadge` from this; see lib/staleness.ts for why
   * `last_seen_at` and not `last_fetched_at`.
   */
  last_seen_at: string | null;
  listings: CandidateListingSummary[];
  /** Task 3.2 (#21): null until this profile has a trained model, or the property hasn't been rescored since one was trained. */
  score: number | null;
  /** Task 3.3 (#22): human-readable, model-grounded explanation of `score` — a cold-start message when `score` is null because no model exists yet, not because this specific property hasn't been rescored. */
  rank_explanation: string | null;
  /**
   * Durable marker for whether `score`/`rank_explanation` came from the
   * cold-start heuristic or a real trained model (task 3.4, #23) — null
   * until the property has been scored at all. The client should switch on
   * this, not on comparing `rank_explanation` against the cold-start
   * sentence: that string is *persisted* at scoring time
   * (lib/scoring/cold-start.ts), so a purely cosmetic copy edit to the
   * constant would silently stop matching every already-written row and
   * un-suppress the old sentence on every card (#152 review).
   */
  score_kind: "cold_start" | "trained" | null;
  /**
   * The blended ranking score the feed actually sorts on (#309, D-057) — the
   * learned/cold-start `score` AUGMENTED with an opportunity boost so a
   * below-market or distressed listing surfaces near the top for the
   * "glance and act" persona, WITHOUT discarding the learned score. See
   * `RANKED_CTE`'s `effective_score` for the exact formula. Boosts are
   * additive and non-negative, so a candidate with no assessment and no
   * below-market discount keeps its base score exactly (never sinks); a
   * never-scored candidate still sorts last (its −1 sentinel dominates the
   * small boost). Always a real number when a row exists.
   */
  effective_score: number | null;
  /**
   * How far this property's price/m² sits below the MEDIAN price/m² of THIS
   * profile's current candidate pool, as a signed fraction (positive =
   * cheaper than the pool median = a discount, e.g. `0.2` = "20% below").
   * The below-market signal that drives the ranking boost (#309). Null when
   * the pool is too small to have a stable median (< `MIN_POOL_SIZE` priced
   * candidates) or this property has no price/m² — a genuine "no comparison"
   * rather than a fabricated "at market" (mirrors area-price.ts's own
   * silence-not-zero rule). This is a cheap, globally-orderable proxy for the
   * geographic zone-median discount (area-price.ts / #184); see D-057 for why
   * the pool median is used here rather than the per-property zone median.
   */
  below_market_pct: number | null;
  /**
   * Count of distinct distress axes the latest AI assessments flag for this
   * property (0–3): a warn-tone occupancy caveat, any red flag, and/or an
   * `a_reformar` condition (#308 populates these; empty in this deployment
   * until the LLM is wired, #316 — hence `0` for every candidate today, and
   * the ranking degrades to the below-market/base signal alone). Feeds the
   * distress half of the ranking boost.
   */
  distress_level: number;
  /**
   * Short Spanish explanation of WHY this candidate was boosted up the
   * ranking (below-market discount and/or distress), or null when no boost
   * applied — so the card can answer "why is this near the top" (#309 EC-3).
   * Distinct from `rank_explanation`, which explains the learned `score`.
   */
  ranking_boost_reason: string | null;
}

export interface CandidatePage {
  items: CandidateRow[];
  /**
   * Opaque cursor string — pass back as `cursor` to fetch the next page; null
   * when this is the last page. Encodes both `score` and `property_id` (a
   * compound keyset key), not just an id, because results are ordered
   * globally by score (see `listCandidates`) — a single-id cursor can't
   * resume a score-ordered scan correctly. Callers must not parse this
   * themselves; treat it as opaque.
   */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * Cap on `CandidateRow.photos` per property (#167). A list page renders up
 * to `DEFAULT_LIMIT` cards; an uncapped union (the detail gallery's rule)
 * would let one heavily-photographed property drag the whole page's photo
 * payload up unpredictably. 8 is comfortably more than the ticker gets
 * clicked through in practice.
 *
 * This constant also bounds the per-*listing* LATERAL LIMIT inside
 * `listCandidates`'s SQL, not just the final output length — see that
 * query's comment. (An earlier version of this comment claimed the query
 * had a cheap per-row LIMIT; it didn't — the cap was only applied *after* a
 * full unnest + sort of every photo of every active listing, O(total
 * photos) not O(cap). Re-measured on PG16: +70% latency over the old
 * single-thumbnail query on a normal page, ~4x on a property with one
 * heavily-photographed listing. Fixed by #167's review must-fix 2 — see
 * the PR body for before/after EXPLAIN ANALYZE numbers.)
 */
const MAX_CARD_PHOTOS = 8;

/**
 * `score` is a sigmoid output, always in (0, 1) when set (task 3.2) — -1 is
 * a safe sentinel for "no score yet" that still sorts correctly last under
 * `ORDER BY effective_score DESC`, letting the keyset comparison stay a
 * plain numeric compound compare instead of needing NULL-aware branching.
 */
const NO_SCORE_SENTINEL = -1;

// ── Ranking blend (#309 / D-057) ────────────────────────────────────────────
//
// The default feed used to sort purely on the learned `score`, so a genuinely
// below-market or distressed listing showed its badge but never rose in the
// list — the investor still had to scan for it. #309 blends two OPPORTUNITY
// signals into the sort key as an additive, non-negative boost on top of the
// learned score:
//
//   effective_score = COALESCE(score, -1)
//                   + below_market_boost   (0 … BELOW_MARKET_DISCOUNT_CAP·WEIGHT)
//                   + distress_boost        (0 … DISTRESS_MAX_UNITS·UNIT_WEIGHT)
//
// Because both boosts are ≥ 0, a candidate with no assessment and no discount
// keeps its base score EXACTLY (graceful degradation — it never sinks or
// errors), and a never-scored candidate (score NULL → −1 sentinel) still sorts
// last: even the maximum boost (0.25 + 0.15 = 0.40) leaves it at −0.6, below
// any real sigmoid score. The learned model is augmented, never replaced.

/** Below-market discount is capped at 50% below the pool median — beyond that is almost always a data error (wrong m²) or a different asset class, not a real deal worth over-weighting. */
const BELOW_MARKET_DISCOUNT_CAP = 0.5;
/** Weight on the (capped) discount fraction. 0.5 → a property 50% below the pool median gets the maximum +0.25 boost, enough to overtake a meaningful learned-score gap without swamping it. */
const BELOW_MARKET_WEIGHT = 0.5;
/** Distress axes counted (occupancy warn caveat / red flag / a_reformar); capped so all three present is +0.15, kept smaller than the max discount boost (price is the harder signal). */
const DISTRESS_MAX_UNITS = 3;
const DISTRESS_UNIT_WEIGHT = 0.05;
/**
 * Minimum number of priced candidates in the pool before a below-market
 * discount is trusted for ranking — a "median" of one or two listings is
 * noise, the same reasoning behind area-price.ts's `MIN_SAMPLE_SIZE` gate.
 * Below this, `below_market_pct` and its boost are null/0 (no fabricated
 * discount), and candidates fall back to base score + distress.
 */
const MIN_POOL_SIZE = 3;
/** A discount only worth NAMING in the explanation once it clears this — smaller than this reads as noise, not a "deal". */
const MIN_NOTABLE_DISCOUNT = 0.05;

/**
 * Occupancy caveat codes that count as a distress/opportunity signal for
 * ranking — exactly the warn-tone set `CAVEAT_LABELS` renders as a badge
 * (kept in sync deliberately: a caveat worth a warn badge is a caveat worth a
 * ranking nudge). Passed as a SQL parameter, not interpolated, so the list
 * can't drift into an injection surface.
 */
export const WARN_CAVEAT_CODES: string[] = [
  "tenanted",
  "occupied_illegally",
  "venta_deuda",
  "nuda_propiedad",
  "usufructo",
  "proindiviso",
  "derecho_superficie",
];

// ── Hard filters (#310 / D-059) ──────────────────────────────────────────────
//
// The candidate feed can hard-filter (not just rank) on the same distress /
// below-market signals #309 already computes — the "show me ONLY occupied /
// needs-integral-reform / ≥N% below market" glance-and-act view. Each filter
// reads the exact per-axis column the `ranked` CTE derives, so a filtered feed
// and its ranking never disagree about what a signal means. All filters are
// applied in the OUTER query (like the #265 source filter), never inside
// `pool` — so narrowing the feed never shifts the pool median that DEFINES the
// below-market discount (a below-market filter must not move its own goalposts).
//
// Graceful degradation (the current deployment reality until #316 wires the
// LLM): the occupancy/condition/renovation filters read `ai_assessment`, which
// is empty today, so they correctly return an EMPTY feed (every candidate's
// axis is NULL → excluded), never an error. The below-market filter is computed
// from price/m² and works today. The UI must signal "needs assessment data"
// rather than showing empty-as-broken — see CandidateList.

/** Occupancy hard-filter values. `occupied` = tenanted or illegally occupied; `free` = vacant. Anything else (unknown / unassessed) matches neither. */
export const OCCUPANCY_FILTERS = ["occupied", "free"] as const;
export type OccupancyFilter = (typeof OCCUPANCY_FILTERS)[number];

/** Condition hard-filter values — the `ConditionCategory` set worth sourcing on (`unclear` is not a filter target). */
export const CONDITION_FILTERS = ["a_reformar", "reformado", "obra_nueva"] as const;
export type ConditionFilter = (typeof CONDITION_FILTERS)[number];

/** Renovation-severity hard-filter values (#313). Only meaningful within `a_reformar`; a non-null value implies that category. */
export const RENOVATION_FILTERS = ["leve", "integral"] as const;
export type RenovationFilter = (typeof RENOVATION_FILTERS)[number];

/** The two physical-occupancy statuses that count as "occupied" (kept as a SQL param, never interpolated). Exported for the route test's param-shape assertion. */
export const OCCUPIED_STATUSES: string[] = ["tenanted", "occupied_illegally"];

export interface CandidateFilters {
  /** #310: keep only occupied / only free candidates. `null` = no occupancy filter. */
  occupancy?: OccupancyFilter | null;
  /** #310: keep only candidates whose latest condition assessment is this category. `null` = no condition filter. */
  condition?: ConditionFilter | null;
  /** #310: keep only `a_reformar` candidates of this renovation depth (#313). `null` = no severity filter. */
  renovation?: RenovationFilter | null;
  /**
   * #310: keep only candidates priced at least this fraction below the pool
   * median price/m² (`below_market_pct >= minBelowMarketPct`), e.g. `0.15` for
   * "≥15% below market". A candidate with a null `below_market_pct` (pool too
   * small, or no price/m²) is EXCLUDED — treated as "unknown", never a false
   * pass. `null`/undefined = no below-market filter.
   */
  minBelowMarketPct?: number | null;
}

/**
 * The shared `disabled_sources → base → pool → ranked` CTE chain that
 * materializes `effective_score` (and `below_market_pct`) for EVERY matched,
 * source-visible candidate of a profile. Both `listCandidates` and
 * `getAdjacentCandidates` build on it verbatim so the feed order and the
 * detail page's prev/next can never diverge (the same invariant the file's
 * `getAdjacentCandidates` doc already insists on for the old score ordering).
 *
 * `$1` is the profile id in every caller; `warnParam` is the placeholder for
 * the warn-caveat text[] (its position differs per caller, so it's injected).
 * No other parameters are referenced, keeping the fragment caller-agnostic.
 *
 * Cost: `base` is one lightweight row per matched candidate (a MIN-price
 * LATERAL + a tiny latest-per-axis `ai_assessment` aggregate, both index-fed);
 * the heavy photo/listing aggregation stays in the outer SELECT, applied only
 * to the LIMITed page. The pool median is a single pass over `base`. The new
 * sort key (`effective_score`) is not covered by
 * `idx_profile_listing_state_profile_ranked`, so ordering now sorts the
 * matched set rather than walking that index — acceptable at the current
 * per-profile matched-set size; if a profile's pool grows large enough for
 * that sort to hurt, the follow-up is to materialize `effective_score` in the
 * scoring pass (see D-057), not to move the Haversine zone-median into this
 * per-row expression.
 */
function rankedCandidatesCte(warnParam: string): string {
  return `${DISABLED_SOURCES_CTE},
     base AS (
       SELECT
         p.id AS property_id,
         p.address, p.lat, p.lon, p.property_type, p.m2_built, p.rooms, p.bathrooms, p.floor,
         pls.score, pls.rank_explanation, pls.score_kind,
         mp.min_price,
         CASE WHEN p.m2_built IS NOT NULL AND p.m2_built > 0 AND mp.min_price IS NOT NULL
              THEN mp.min_price / p.m2_built ELSE NULL END AS ppm2,
         dist.distress_level,
         -- Per-axis raw signals for the #310 hard filters (D-059). Carried
         -- through ranked.* so the outer query can WHERE on them; NULL =
         -- that axis unassessed (excluded by any filter on it, never matched).
         dist.occupancy_status,
         dist.condition_category,
         dist.renovation_severity
       FROM profile_listing_state pls
       JOIN property p ON p.id = pls.property_id
       -- MIN active-sale price across ENABLED sources only (#322/D-055): the
       -- below-market signal must never be computed from a hidden source's
       -- price, exactly like the badge/min_price the card shows.
       CROSS JOIN LATERAL (
         SELECT MIN(l2.current_price) AS min_price
           FROM listing l2
          WHERE l2.property_id = p.id AND l2.status = 'active' AND l2.operation = 'sale'
            AND ${activeSourceClause("l2")}
       ) mp
       -- Distress level from the LATEST assessment per axis (DISTINCT ON, same
       -- rule loadFlags uses so a stale prompt-version row can't double-count):
       -- +1 for a warn-tone occupancy caveat, +1 for any red flag, +1 for an
       -- a_reformar condition. jsonb_typeof guards keep a non-array caveats/
       -- flags value from throwing mid-scan.
       --
       -- The same subquery also surfaces the three PER-AXIS raw signals the
       -- #310 hard filters gate on (occupancy status, condition category,
       -- renovation severity). Deriving them here — from the identical
       -- DISTINCT-ON-latest-per-axis rows that feed distress_level — is what
       -- keeps the FILTER and the RANK in agreement by construction (D-059): a
       -- candidate the "occupied"/"a_reformar" filter keeps is exactly one the
       -- distress boost lifted. max(...) FILTER picks the single latest row's
       -- value per axis (la holds at most one row per assessment_type, so the
       -- aggregate is really just "the one non-null value"); NULL means that
       -- axis was never assessed — the graceful-degradation case the filters
       -- treat as "unknown, excluded", never "matched".
       LEFT JOIN LATERAL (
         SELECT
             (COALESCE(bool_or(
                la.assessment_type = 'occupancy'
                AND jsonb_typeof(la.result->'caveats') = 'array'
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(la.result->'caveats') cv
                   WHERE cv = ANY(${warnParam}::text[])
                )), false))::int
           + (COALESCE(bool_or(
                la.assessment_type = 'redflags'
                AND jsonb_typeof(la.result->'flags') = 'array'
                AND jsonb_array_length(la.result->'flags') > 0), false))::int
           + (COALESCE(bool_or(
                la.assessment_type = 'condition'
                AND la.result->>'condition' = 'a_reformar'), false))::int
             AS distress_level,
           -- occupancy is a NESTED Verdict ({ value, confidence, … }), so the
           -- physical status is result->'occupancy'->>'value' (#25/#145); the
           -- condition axis is flat (result->>'condition'), as is #313's
           -- renovation_severity.
           max(la.result->'occupancy'->>'value') FILTER (WHERE la.assessment_type = 'occupancy') AS occupancy_status,
           max(la.result->>'condition')          FILTER (WHERE la.assessment_type = 'condition') AS condition_category,
           max(la.result->>'renovation_severity') FILTER (WHERE la.assessment_type = 'condition') AS renovation_severity
         FROM (
           SELECT DISTINCT ON (a.assessment_type) a.assessment_type, a.result
             FROM ai_assessment a
            WHERE a.property_id = p.id
              AND a.assessment_type IN ('occupancy', 'condition', 'redflags')
            ORDER BY a.assessment_type, a.generated_at DESC NULLS LAST, a.id DESC
         ) la
       ) dist ON true
       WHERE pls.profile_id = $1
         AND pls.matched = true
         -- Same disabled-source visibility gate as the feed (#319/D-055): a
         -- property whose only active-sale listings are all from disabled
         -- sources drops out here too, so it neither ranks nor skews the pool.
         AND (
           NOT EXISTS (
             SELECT 1 FROM listing ld
              WHERE ld.property_id = p.id AND ld.status = 'active' AND ld.operation = 'sale'
           )
           OR EXISTS (
             SELECT 1 FROM listing lv
              WHERE lv.property_id = p.id AND lv.status = 'active' AND lv.operation = 'sale'
                AND ${activeSourceClause("lv")}
           )
         )
     ),
     pool AS (
       SELECT
         percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2) AS median_ppm2,
         COUNT(ppm2) AS n
       FROM base
     ),
     ranked AS (
       SELECT
         base.*,
         CASE
           WHEN base.ppm2 IS NOT NULL AND pool.n >= ${MIN_POOL_SIZE}
                AND pool.median_ppm2 IS NOT NULL AND pool.median_ppm2 > 0
           THEN (pool.median_ppm2 - base.ppm2) / pool.median_ppm2
           ELSE NULL
         END AS below_market_pct,
         (
           COALESCE(base.score, ${NO_SCORE_SENTINEL})
           + CASE
               WHEN base.ppm2 IS NOT NULL AND pool.n >= ${MIN_POOL_SIZE}
                    AND pool.median_ppm2 IS NOT NULL AND pool.median_ppm2 > 0
               THEN LEAST(
                      GREATEST((pool.median_ppm2 - base.ppm2) / pool.median_ppm2, 0),
                      ${BELOW_MARKET_DISCOUNT_CAP}
                    ) * ${BELOW_MARKET_WEIGHT}
               ELSE 0
             END
           + LEAST(base.distress_level, ${DISTRESS_MAX_UNITS}) * ${DISTRESS_UNIT_WEIGHT}
         ) AS effective_score
       FROM base CROSS JOIN pool
     )`;
}

/**
 * Pure, dependency-free copy generator for `CandidateRow.ranking_boost_reason`
 * (#309 EC-3). Returns null when neither signal is notable, so the caller can
 * render nothing rather than a placeholder — the same "no badge on every card"
 * discipline `flagsFromAssessments` follows. Exported for direct unit testing.
 */
export function describeRankingBoost(
  belowMarketPct: number | null,
  distressLevel: number,
): string | null {
  const parts: string[] = [];
  if (belowMarketPct !== null && belowMarketPct >= MIN_NOTABLE_DISCOUNT) {
    parts.push(
      `precio/m² ~${Math.round(belowMarketPct * 100)}% por debajo de la mediana de tus candidatos`,
    );
  }
  if (distressLevel > 0) {
    parts.push("señales de oportunidad detectadas (ocupación / estado / cargas)");
  }
  if (parts.length === 0) return null;
  return `Destacado: ${parts.join("; ")}.`;
}

interface CandidateCursor {
  score: number;
  id: number;
}

function encodeCursor(score: number | null, id: number): string {
  const effectiveScore = score ?? NO_SCORE_SENTINEL;
  return Buffer.from(JSON.stringify([effectiveScore, id])).toString("base64url");
}

/** Returns null on any malformed input — callers should treat that as an invalid cursor (400), not silently fall back to page 1. */
export function decodeCursor(raw: string): CandidateCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "number" &&
      Number.isFinite(parsed[0]) &&
      typeof parsed[1] === "number" &&
      Number.isInteger(parsed[1]) &&
      parsed[1] > 0
    ) {
      return { score: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

interface RawCandidateRow {
  property_id: number;
  address: string | null;
  lat: string | null;
  lon: string | null;
  property_type: string | null;
  m2_built: string | null;
  rooms: number | null;
  bathrooms: number | null;
  floor: string | null;
  photos: string[];
  min_price: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  listings: CandidateListingSummary[];
  score: string | null;
  rank_explanation: string | null;
  score_kind: "cold_start" | "trained" | null;
  /** Blended sort key (#309) — pg NUMERIC/double, arrives as a string. */
  effective_score: string | null;
  /** Signed discount fraction vs the pool median price/m² (#309), NUMERIC as a string; null when the pool is too small or price/m² is unknown. */
  below_market_pct: string | null;
  /** 0–3 distress axes flagged (#309); a plain int. */
  distress_level: number;
}

/**
 * Maps a property's `ai_assessment` rows to the badges the card shows.
 *
 * Only surfaces verdicts that change the investment decision — a standard
 * "compraventa" of "pleno dominio" on a vacant property is the unremarkable
 * default and gets no badge, because a badge on every card carries no
 * information. Unrecognised codes are dropped rather than rendered as raw
 * text (#152 review, must-fix 3): both vocabularies below are closed
 * enumerations validated where the row is written (see `deriveCaveats` in
 * `lib/ai-assessment/occupancy.ts` and `CONDITION_CATEGORIES` in
 * `lib/ai-assessment/condition.ts`), so anything not in the label maps is
 * either the standard "nothing to report" value or evidence of drift between
 * this file and the writer's vocabulary — never scraped free text that could
 * grow the card.
 *
 * Exported for direct unit testing: this is the pure function findings #1
 * and #3 in the #152 review trace back to, and it is cheap to test in
 * isolation without a mocked `pg` pool.
 *
 * De-duplicated by `kind` as a second line of defence — the real fix for
 * "two verdicts on one axis" is `loadFlags`'s `DISTINCT ON`, which ensures
 * `rows` here holds at most one row per `assessment_type` per property. This
 * dedup keeps `flagsFromAssessments` safe to call with un-deduplicated input
 * too (e.g. from a future caller), rather than depending on that invariant.
 */
export function flagsFromAssessments(rows: RawAssessmentRow[]): CandidateFlag[] {
  const flags: CandidateFlag[] = [];
  for (const row of rows) {
    const result = row.result ?? {};

    // #156's three-axis occupancy assessment (occupancy/transaction/
    // ownership verdicts) derives `caveats` once, server-side, from those
    // three verdicts — see `deriveCaveats` in lib/ai-assessment/occupancy.ts.
    // Reading it here instead of re-parsing the raw verdict objects keeps
    // this file and that one from ever disagreeing about which combinations
    // are noteworthy (the same "single computation" rule explainScore()
    // follows for rank_explanation).
    const caveats = Array.isArray(result.caveats) ? result.caveats : [];
    for (const code of caveats) {
      if (typeof code !== "string") continue;
      const label = CAVEAT_LABELS[code];
      if (label !== undefined) flags.push({ kind: `caveat:${code}`, label, tone: "warn" });
    }

    // #26's condition assessment (lib/ai-assessment/condition.ts) writes a
    // flat `result.condition` string (single axis — no nested `verdict`
    // object like occupancy's three). `reformado`/`unclear` are the
    // unremarkable/no-info defaults and intentionally have no label below,
    // same as occupancy's `pleno_dominio` getting no caveat badge.
    const condition = typeof result.condition === "string" ? result.condition : null;
    if (condition !== null) {
      const label = CONDITION_LABELS[condition];
      if (label !== undefined) {
        // #313: when the condition is `a_reformar`, refine the badge with the
        // renovation-severity sub-axis (leve/integral) so a glance tells light
        // from heavy reform — the light-vs-heavy distinction #45 keys its cost
        // bands off. `unknown`/`null`/absent severity keeps the plain
        // "A reformar" badge (and stable `condition:a_reformar` kind), so a
        // pre-#313 row with no severity field is unchanged.
        const severity =
          condition === "a_reformar" ? RENOVATION_SEVERITY_LABELS[String(result.renovation_severity)] : undefined;
        if (severity !== undefined) {
          flags.push({
            kind: `condition:a_reformar:${result.renovation_severity}`,
            label: `${label} (${severity})`,
            tone: "neutral",
          });
        } else {
          flags.push({ kind: `condition:${condition}`, label, tone: "neutral" });
        }
      }
    }

    // #27/#361 redflags: a generic problem axis. `result.flags` is an array
    // of `{ type, description, evidence, … }` (lib/ai-assessment/redflags.ts).
    // Each evidenced flag becomes a warn-tone badge — a problem (legal,
    // financial or physical) is always something that changes the buy. The
    // model's own one-line `description` rides along as the badge's tooltip.
    // Only closed-vocabulary types with a label below render; `other` (the
    // long-tail catch-all) and any unmapped drift are dropped rather than
    // shown as raw text, the same rule occupancy/condition follow above.
    const redFlags = Array.isArray(result.flags) ? result.flags : [];
    for (const rf of redFlags) {
      if (typeof rf !== "object" || rf === null) continue;
      const o = rf as Record<string, unknown>;
      const type = typeof o.type === "string" ? o.type : null;
      if (type === null) continue;
      const label = REDFLAG_LABELS[type];
      if (label === undefined) continue;
      const description = typeof o.description === "string" && o.description.trim() !== "" ? o.description : undefined;
      flags.push({ kind: `redflag:${type}`, label, tone: "warn", description });
    }
  }
  const byKind = new Map<string, CandidateFlag>();
  for (const flag of flags) {
    if (!byKind.has(flag.kind)) byKind.set(flag.kind, flag);
  }
  return [...byKind.values()];
}

/**
 * Every non-default value of `OccupancyResult.caveats` (#25 + #145) worth a
 * badge — see `CAVEAT_CODES` in lib/ai-assessment/occupancy.ts for the
 * closed vocabulary this mirrors. Spanish for market terms of art that lose
 * meaning in translation (`nuda propiedad`), English for generic system
 * state where no better Spanish term reads as naturally short.
 */
const CAVEAT_LABELS: Record<string, string> = {
  tenanted: "Alquilado",
  occupied_illegally: "Ocupado",
  venta_deuda: "Venta de deuda",
  nuda_propiedad: "Nuda propiedad",
  usufructo: "Usufructo",
  proindiviso: "Proindiviso",
  derecho_superficie: "Derecho de superficie",
};

/**
 * Every `ConditionCategory` (#26, `lib/ai-assessment/condition.ts`) worth a
 * badge. `reformado` (the unremarkable default, like occupancy's
 * `pleno_dominio`) and `unclear` (no information, not a finding) are
 * deliberately absent — a badge on every card carries no information.
 */
const CONDITION_LABELS: Record<string, string> = {
  a_reformar: "A reformar",
  obra_nueva: "Obra nueva",
};

/**
 * Renovation-severity refinement of the `a_reformar` badge (#313, D-056).
 * Only `leve`/`integral` earn a refined badge — `unknown` (needs work, depth
 * ungraded) and `null` (axis N/A) carry no extra information, so they fall
 * through to the plain "A reformar" badge. Closed set, validated at the writer
 * (`RENOVATION_SEVERITIES` in `lib/ai-assessment/condition.ts`) — same drop-
 * unrecognised discipline as `CONDITION_LABELS` above.
 */
const RENOVATION_SEVERITY_LABELS: Record<string, string> = {
  leve: "leve",
  integral: "integral",
};

export interface RawAssessmentRow {
  property_id: number;
  result: Record<string, unknown> | null;
}

/**
 * Best-effort: returns no flags rather than propagating if `ai_assessment`
 * can't be read. The badges are an enhancement — not something worth
 * failing the whole candidate feed over.
 *
 * `ai_assessment` allows multiple rows per `(property_id, assessment_type)`
 * — one per `prompt_version` (see the `ai_assessment_property_key` unique
 * constraint in etl/schema/init.sql) — so a prompt-version bump leaves the
 * *old* verdict's row in place alongside the new one. `DISTINCT ON
 * (property_id, assessment_type)`, ordered by `generated_at DESC` (most
 * recent first), picks exactly the current verdict per axis; without it,
 * `flagsFromAssessments`'s dedup-by-`kind` cannot help, because two
 * different verdicts on the same axis produce two different `kind` strings
 * (e.g. `occupancy:tenanted` and `occupancy:occupied_illegally` reported
 * simultaneously) — the exact bug the #152 review reproduced (#152 review,
 * must-fix 1).
 */
async function loadFlags(propertyIds: number[]): Promise<Map<number, CandidateFlag[]>> {
  const byProperty = new Map<number, CandidateFlag[]>();
  if (propertyIds.length === 0) return byProperty;

  let rows: RawAssessmentRow[];
  try {
    rows = await sql<RawAssessmentRow>(
      `SELECT DISTINCT ON (property_id, assessment_type)
              property_id, result
         FROM ai_assessment
        WHERE property_id = ANY($1::bigint[])
          AND assessment_type IN ('occupancy', 'condition', 'redflags')
        ORDER BY property_id, assessment_type, generated_at DESC NULLS LAST, id DESC`,
      [propertyIds],
    );
  } catch (err) {
    console.warn("[candidates] ai_assessment unavailable, rendering without flags:", err);
    return byProperty;
  }

  const grouped = new Map<number, RawAssessmentRow[]>();
  for (const row of rows) {
    const id = row.property_id;
    const list = grouped.get(id) ?? [];
    list.push(row);
    grouped.set(id, list);
  }
  for (const [id, group] of grouped) {
    byProperty.set(id, flagsFromAssessments(group));
  }
  return byProperty;
}

/**
 * Keyset (cursor) pagination on `(effective_score DESC, property.id DESC)`,
 * not OFFSET — this table is expected to grow into the thousands (issue #19
 * Technical approach #3: "don't fetch-all-and-filter-client-side"), and
 * OFFSET pagination degrades linearly with page depth while keyset
 * pagination stays O(limit) regardless of how deep the caller pages.
 *
 * Task 3.4 (#23), EC-1: ordering is global (by score, best first), not just
 * within a page — an earlier version of this function sorted only the
 * already-fetched page client-side, which meant a high-scoring candidate on
 * page 2 could render below a low-scoring one on page 1 (a real bug, not a
 * documented tradeoff: "Cargar más" appends pages, so per-page sorting
 * actively defeated the point of scoring for any profile with more matched
 * candidates than one page). The compound `(score, id)` keyset below fixes
 * this: `p.id` alone is no longer sufficient to resume the scan once the
 * primary sort key is `score`, so the cursor must carry both.
 */
export async function listCandidates(
  profileId: number,
  opts: {
    cursor?: string | null;
    limit?: number;
    source?: string | null;
  } & CandidateFilters = {},
): Promise<CandidatePage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const rawCursor = opts.cursor ?? null;

  // #310 hard filters (D-059). Each normalises to null ("no filter") when
  // unset, so an untouched call behaves exactly as before. Validation of the
  // enum membership happens at the API boundary; here we only guard the
  // below-market threshold against a non-finite/negative value (a silent
  // no-op filter would be worse than passing null through).
  const occupancy: OccupancyFilter | null = opts.occupancy ?? null;
  const condition: ConditionFilter | null = opts.condition ?? null;
  const renovation: RenovationFilter | null = opts.renovation ?? null;
  const minBelowMarketPct: number | null =
    typeof opts.minBelowMarketPct === "number" && Number.isFinite(opts.minBelowMarketPct)
      ? opts.minBelowMarketPct
      : null;
  // Source (portal) filter (#265): isolate one connector's results so the
  // owner can debug a single portal's data quality. A candidate is a
  // deduplicated PROPERTY that may span several listings from different
  // sources; it matches when ANY of its *active sale* listings — the exact
  // set whose source badges the card renders (see the `listings` subquery
  // below and CandidateCard's badge row) — comes from the selected source.
  // Filtering on that same set keeps the UI honest: every card left standing
  // after the filter genuinely carries a badge for the chosen source, rather
  // than surviving on a withdrawn or rent sibling the card never shows.
  // null/empty means "all sources" (no filter). Trimmed so a stray blank
  // can't become a source that matches nothing.
  const sourceRaw = opts.source ?? null;
  const source = sourceRaw !== null && sourceRaw.trim() !== "" ? sourceRaw.trim() : null;

  let cursorScore: number | null = null;
  let cursorId: number | null = null;
  if (rawCursor !== null) {
    const decoded = decodeCursor(rawCursor);
    if (decoded === null) {
      throw new Error("Cursor no válido.");
    }
    cursorScore = decoded.score;
    cursorId = decoded.id;
  }

  // Fetch one extra row so we can tell whether a next page truly exists
  // instead of assuming it does whenever a page is exactly full (that
  // false-positive was showing a dead "Cargar más" on the last page).
  const rows = await sql<RawCandidateRow>(
    // #309 / D-057: the default order is now the BLENDED `effective_score`
    // (learned score + below-market + distress boost), materialized by the
    // shared `ranked` CTE (see rankedCandidatesCte). Issue #319 / D-055 still
    // holds — the CTE hides disabled-source data and every listing subquery
    // below filters against `disabled_sources`, so a disabled source
    // contributes no card, badge, price, photo, staleness, or ranking weight,
    // and a property whose only active-sale listings are all from disabled
    // sources drops out entirely (inside the CTE's `base` WHERE). The heavy
    // photo/listing aggregation stays here in the outer SELECT so it runs only
    // for the LIMITed page, not for every matched row the CTE ranks.
    `WITH ${rankedCandidatesCte("$6")}
     SELECT
       ranked.property_id,
       ranked.address,
       ranked.lat,
       ranked.lon,
       ranked.property_type,
       ranked.m2_built,
       ranked.rooms,
       ranked.bathrooms,
       ranked.floor,
       -- Capped, de-duplicated union of photo_urls across this property's
       -- active listings (#167), ordered to match the detail page's gallery
       -- exactly (getPropertyDetail in lib/property-detail.ts, which also
       -- filters to active listings and reads them ORDER BY source): grouped
       -- by listing in 'source' order, then within-listing position — so
       -- photos[0] here is genuinely the same lead image the detail page's
       -- hero uses. See CandidateRow.photos's docstring for the bug this
       -- alignment fixes (#167 review must-fix 1).
       --
       -- Cost is bounded per LISTING, not per photo (must-fix 2): the inner
       -- LATERAL unnests l4.photo_urls WITH ORDINALITY and LIMITs to
       -- MAX_CARD_PHOTOS with NO ORDER BY inside that LATERAL. unnest() is
       -- evaluated lazily (value-per-call) and WITH ORDINALITY is always
       -- emitted in increasing/array order, so a bare LIMIT stops the
       -- generator after the first MAX_CARD_PHOTOS elements instead of
       -- materializing (and sorting) every photo of every active listing
       -- before truncating — the previous shape, which only capped via the
       -- outer WHERE rn <= N *after* that full unnest+sort, measured +70%
       -- over the old single-thumbnail query on a normal page and ~4x on one
       -- heavily-photographed listing (see PR body for numbers). Adding an
       -- ORDER BY inside the LATERAL would silently reintroduce that cost —
       -- Postgres can't avoid materializing a Sort's input just because a
       -- LIMIT sits above it — so this deliberately leans on unnest's
       -- already-ordered output instead of re-deriving it.
       --
       -- array_remove(l4.photo_urls, NULL) drops NULL array elements before
       -- unnesting — an unguarded NULL survives into 'photos', is counted by
       -- the client's 'photos.length > 1' ticker gate, and renders the
       -- placeholder mid-cycle when the ticker lands on that index.
       --
       -- DISTINCT ON (photo_url) dedupes by URL (a listing can repeat a
       -- photo, and two sources can share one after dedup), keeping each
       -- photo's first (source, ord) occurrence; row_number() over that same
       -- (source, ord) order re-establishes visual order (DISTINCT ON's own
       -- ORDER BY has to sort by photo_url first, which scrambles it); the
       -- outer WHERE re-caps to MAX_CARD_PHOTOS before json_agg (needed
       -- because up to listing_count * MAX_CARD_PHOTOS rows can reach this
       -- point once multiple listings each contribute their own capped
       -- share), and json_agg's own ORDER BY rn guarantees the final array
       -- reflects that order (aggregates don't otherwise guarantee input
       -- order).
       COALESCE(
         (SELECT json_agg(photo_url ORDER BY rn)
            FROM (
              SELECT photo_url, row_number() OVER (ORDER BY listing_source, ord) AS rn
                FROM (
                  SELECT DISTINCT ON (photo_url)
                         photo_url, listing_source, ord
                    FROM (
                      SELECT l4.source AS listing_source, u.photo_url, u.ord
                        FROM listing l4
                        CROSS JOIN LATERAL (
                          SELECT uu.photo_url, uu.ord
                            FROM unnest(array_remove(l4.photo_urls, NULL))
                                 WITH ORDINALITY AS uu(photo_url, ord)
                           LIMIT ${MAX_CARD_PHOTOS}
                        ) u
                       WHERE l4.property_id = ranked.property_id
                         AND l4.status = 'active'
                         AND l4.operation = 'sale'
                         AND ${activeSourceClause("l4")}
                         AND l4.photo_urls IS NOT NULL
                    ) per_listing
                   ORDER BY photo_url, listing_source, ord
                ) deduped
            ) numbered
           WHERE numbered.rn <= ${MAX_CARD_PHOTOS}
         ),
         '[]'
       ) AS photos,
       -- AND l2.operation = 'sale' (issue #31): every property reaching
       -- this query already came through profile_listing_state, which
       -- scope-query.ts now gates on an active SALE listing existing at
       -- all — so a rent-only property can't reach here today. Kept
       -- explicit anyway (docs/architecture/data-model.md flagged this
       -- exact subquery by name as a "cross-cutting landmine for #31,
       -- not yet fixed") rather than relying solely on that upstream
       -- invariant holding forever: a candidate card showing a monthly
       -- rent figure labelled as a sale price would be a severe,
       -- silent bug if it ever did leak through.
       -- min_price already computed once inside the ranked CTE (it also feeds
       -- the below-market signal) — surface it directly rather than re-running
       -- the MIN subquery.
       ranked.min_price,
       (SELECT MIN(l3.first_seen_at)
          FROM listing l3
         WHERE l3.property_id = ranked.property_id
           AND ${activeSourceClause("l3")}) AS first_seen_at,
       -- FRESHEST last_seen_at across active SALE listings (issue #243): the
       -- staleness age the card renders. MAX, not MIN — the property is only
       -- as stale as its most-recently-re-confirmed listing. Same
       -- active + operation='sale' filter as min_price/listings/photos, so a
       -- withdrawn listing's frozen last_seen_at can neither make the property
       -- look fresher than its live listings nor be treated as a live
       -- re-confirmation. NULL when no active sale listing has been seen.
       (SELECT MAX(l6.last_seen_at)
          FROM listing l6
         WHERE l6.property_id = ranked.property_id AND l6.status = 'active' AND l6.operation = 'sale'
           AND ${activeSourceClause("l6")}) AS last_seen_at,
       ranked.score,
       ranked.rank_explanation,
       ranked.score_kind,
       ranked.effective_score,
       ranked.below_market_pct,
       ranked.distress_level,
       COALESCE(
         (SELECT json_agg(
                   json_build_object(
                     'id', l.id,
                     'source', l.source,
                     'url', l.url,
                     'current_price', l.current_price
                   )
                   ORDER BY l.source
                 )
            FROM listing l
           WHERE l.property_id = ranked.property_id AND l.status = 'active' AND l.operation = 'sale'
             AND ${activeSourceClause("l")}),
         '[]'
       ) AS listings
     FROM ranked
     WHERE (
         $2::double precision IS NULL
         OR ranked.effective_score < $2::double precision
         OR (ranked.effective_score = $2::double precision AND ranked.property_id < $3::bigint)
       )
       -- Source (portal) filter (#265). $5 NULL = all sources. Uses the
       -- idx_listing_source_status index; the same active+sale predicate as
       -- the badge/min_price/listings subqueries so the filter matches
       -- exactly what the card shows. Applied in the OUTER query (not the pool)
       -- so the pool median still reflects the profile's whole candidate set,
       -- not a single portal's slice.
       AND (
         $5::text IS NULL
         OR EXISTS (
           SELECT 1
             FROM listing lf
            WHERE lf.property_id = ranked.property_id
              AND lf.source = $5::text
              AND lf.status = 'active'
              AND lf.operation = 'sale'
              AND ${activeSourceClause("lf")}
         )
       )
       -- #310 hard filters (D-059). All applied in the OUTER query, on the
       -- per-axis signals ranked already carries — so the below-market
       -- filter can't shift its own pool median, and the assessment filters
       -- agree with the ranking's distress boost by construction. NULL param =
       -- filter off. A NULL axis value (never assessed) fails every equality
       -- below, so an assessment filter with no data yet yields an EMPTY feed
       -- (correct graceful degradation), not an error.
       --
       -- occupancy ($7): 'occupied' -> tenanted/occupied_illegally; 'free' ->
       -- vacant; the OCCUPIED_STATUSES list is a param ($8), never interpolated.
       AND (
         $7::text IS NULL
         OR ($7 = 'occupied' AND ranked.occupancy_status = ANY($8::text[]))
         OR ($7 = 'free' AND ranked.occupancy_status = 'vacant')
       )
       -- $9 condition category (a_reformar / reformado / obra_nueva).
       AND ($9::text IS NULL OR ranked.condition_category = $9::text)
       -- $10 renovation severity (#313) — only a_reformar rows carry a
       -- non-null severity, so this implicitly narrows to a_reformar too.
       AND ($10::text IS NULL OR ranked.renovation_severity = $10::text)
       -- $11 below-market: keep only ≥ N% below the pool median price/m². A
       -- null below_market_pct (pool too small / no price/m²) is excluded as
       -- "unknown", never a false pass.
       AND (
         $11::double precision IS NULL
         OR (ranked.below_market_pct IS NOT NULL AND ranked.below_market_pct >= $11::double precision)
       )
     ORDER BY ranked.effective_score DESC, ranked.property_id DESC
     LIMIT $4`,
    [
      profileId,
      cursorScore,
      cursorId,
      limit + 1,
      source,
      WARN_CAVEAT_CODES,
      occupancy,
      OCCUPIED_STATUSES,
      condition,
      renovation,
      minBelowMarketPct,
    ],
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const flagsByProperty = await loadFlags(pageRows.map((r) => r.property_id));

  const items: CandidateRow[] = pageRows.map((r) => ({
    // property_id (bigint) arrives as a real JS number via the driver-level
    // int8 type parser (db-shared.ts, #155) — no per-site Number() needed.
    // lat/lon/m2_built/min_price/score below are NUMERIC, a different OID
    // with a genuine precision rationale — those coercions stay.
    property_id: r.property_id,
    address: r.address,
    lat: r.lat !== null ? Number(r.lat) : null,
    lon: r.lon !== null ? Number(r.lon) : null,
    property_type: r.property_type,
    m2_built: r.m2_built !== null ? Number(r.m2_built) : null,
    rooms: r.rooms,
    bathrooms: r.bathrooms,
    floor: r.floor,
    photos: r.photos ?? [],
    flags: flagsByProperty.get(r.property_id) ?? [],
    min_price: r.min_price !== null ? Number(r.min_price) : null,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    listings: r.listings,
    score: r.score !== null ? Number(r.score) : null,
    rank_explanation: r.rank_explanation,
    score_kind: r.score_kind ?? null,
    effective_score: r.effective_score != null ? Number(r.effective_score) : null,
    below_market_pct: r.below_market_pct != null ? Number(r.below_market_pct) : null,
    distress_level: r.distress_level ?? 0,
    ranking_boost_reason: describeRankingBoost(
      r.below_market_pct != null ? Number(r.below_market_pct) : null,
      r.distress_level ?? 0,
    ),
  }));

  // Cursor is derived from the *last row of the SQL result*, which is already
  // in final (effective_score, id) DESC order (#309) — there is no separate
  // client-side re-sort of `pageRows` to accidentally derive it from afterward
  // (that was the bug: a previous version sorted `pageRows` by score for
  // display *after* the cursor should have been captured from the id-ordered
  // fetch, corrupting the keyset scan). The keyset key is now the blended
  // `effective_score`, matching the ORDER BY above.
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore
    ? encodeCursor(lastRow.effective_score != null ? Number(lastRow.effective_score) : null, lastRow.property_id)
    : null;

  return { items, nextCursor };
}

/**
 * Distinct source portals present among this profile's candidates (#265) —
 * the options the list page's source filter offers.
 *
 * Derived from live data, not a hardcoded portal list: it returns only the
 * sources that actually produced a *visible* candidate badge for this
 * profile (active sale listings on `matched = true` properties — the exact
 * set `listCandidates`'s badge/`listings` subquery and the source filter
 * both use). So the dropdown never offers a portal that would narrow the
 * list to nothing, and it automatically picks up a new connector the moment
 * one contributes a candidate — no stale enum to maintain here or in the
 * connector registry.
 *
 * Alphabetical, matching the card's own `sources.sort()` badge order.
 */
export async function listCandidateSources(profileId: number): Promise<string[]> {
  const rows = await sql<{ source: string }>(
    // Issue #319 / D-055: exclude sources whose connector is OFF — a disabled
    // source produces no visible candidate, so it must not be offered as a
    // filter option either (it would narrow the list to nothing).
    `WITH ${DISABLED_SOURCES_CTE}
     SELECT DISTINCT l.source
       FROM profile_listing_state pls
       JOIN listing l ON l.property_id = pls.property_id
      WHERE pls.profile_id = $1
        AND pls.matched = true
        AND l.status = 'active'
        AND l.operation = 'sale'
        AND ${activeSourceClause("l")}
      ORDER BY l.source`,
    [profileId],
  );
  return rows.map((r) => r.source);
}

export interface AdjacentCandidates {
  /** The property ranked immediately better than this one, or null if it's first. */
  prevPropertyId: number | null;
  /** The property ranked immediately worse than this one, or null if it's last. */
  nextPropertyId: number | null;
}

/**
 * Neighbours of `propertyId` in this profile's candidate ordering (#152/#146),
 * so the detail page can offer prev/next without going back to the list.
 *
 * **Recomputed live, not snapshotted.** Both are defensible; this picks live
 * deliberately:
 *
 *   - It reuses the exact `(effective_score DESC, id DESC)` ordering (the same
 *     `rankedCandidatesCte` blend `listCandidates` sorts on, #309) and keyset
 *     comparison, so the sequence can't silently diverge from the list the
 *     user is paging through. A snapshot would need
 *     that ordering duplicated in a second place and kept in sync — the class
 *     of drift that produced #23's cursor bug, where the cursor was derived
 *     from a different ordering than the display sort.
 *   - It stays stateless: no session storage, no cursor list to carry through
 *     navigation, nothing to invalidate.
 *
 * The cost is real and worth naming: giving feedback triggers a retrain, so
 * scores can move under you mid-browse, and "next" may then differ from what
 * the list showed when you opened it — you might revisit one property or skip
 * past one. That is bounded (a re-rank shuffles neighbours, it doesn't hide
 * candidates) and it always reflects the model's current belief, which for a
 * tool whose whole point is learning your preferences is the more honest
 * behaviour. A snapshot would page you through a ranking the model has
 * already moved on from.
 */
export async function getAdjacentCandidates(
  profileId: number,
  propertyId: number,
): Promise<AdjacentCandidates> {
  // #309: neighbours are computed under the SAME blended `effective_score`
  // ordering the list uses (rankedCandidatesCte), not the raw `score` — so the
  // detail page's prev/next never diverges from the feed the user is paging
  // through. The anchor's own effective_score is read from the same CTE.
  const anchor = await sql<{ effective_score: string | null }>(
    `WITH ${rankedCandidatesCte("$3")}
     SELECT effective_score FROM ranked WHERE property_id = $2`,
    [profileId, propertyId, WARN_CAVEAT_CODES],
  );
  if (anchor.length === 0) {
    return { prevPropertyId: null, nextPropertyId: null };
  }
  const anchorScore =
    anchor[0].effective_score != null ? Number(anchor[0].effective_score) : NO_SCORE_SENTINEL;

  // "next" = ranked after the anchor under the list's DESC ordering; "prev"
  // reverses both the comparison and the sort, then takes the nearest row.
  const [nextRows, prevRows] = await Promise.all([
    sql<{ property_id: number }>(
      `WITH ${rankedCandidatesCte("$4")}
       SELECT property_id
         FROM ranked
        WHERE (effective_score < $2::double precision
               OR (effective_score = $2::double precision AND property_id < $3::bigint))
        ORDER BY effective_score DESC, property_id DESC
        LIMIT 1`,
      [profileId, anchorScore, propertyId, WARN_CAVEAT_CODES],
    ),
    sql<{ property_id: number }>(
      `WITH ${rankedCandidatesCte("$4")}
       SELECT property_id
         FROM ranked
        WHERE (effective_score > $2::double precision
               OR (effective_score = $2::double precision AND property_id > $3::bigint))
        ORDER BY effective_score ASC, property_id ASC
        LIMIT 1`,
      [profileId, anchorScore, propertyId, WARN_CAVEAT_CODES],
    ),
  ]);

  return {
    nextPropertyId: nextRows.length > 0 ? nextRows[0].property_id : null,
    prevPropertyId: prevRows.length > 0 ? prevRows[0].property_id : null,
  };
}
