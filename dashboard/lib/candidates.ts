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
import { readIntInRange } from "@/lib/notifications/config-read";
import {
  DISABLED_SOURCES_CTE,
  activeSourceClause,
} from "@/lib/db/source-active";
import { REDFLAG_LABELS } from "@/lib/ai-assessment/redflags";
import {
  BEACH_PROXIMITY_LABELS,
  HERITAGE_ZONE_LABEL,
} from "@/lib/ai-assessment/location";
import {
  IS_VPO_LABEL,
  TOURIST_LICENSE_LABEL,
} from "@/lib/ai-assessment/opportunity";
import type { StateFeedbackType } from "@/lib/db/feedback";
// #452: the investor-score boost weights/caps live in the pure, client-safe
// display module so the SQL sort key and the UI breakdown derive from ONE set of
// constants (D-059 derive-once). This file interpolates them into the ranked
// CTE; the card/detail import them from the same module.
import {
  BELOW_MARKET_DISCOUNT_CAP,
  BELOW_MARKET_WEIGHT,
  DISTRESS_MAX_UNITS,
  DISTRESS_UNIT_WEIGHT,
  BEACH_PROXIMITY_BOOST_UNITS,
  BEACH_UNIT_WEIGHT,
  TOURIST_LICENSE_BOOST,
  DOM_BOOST_WEIGHT,
  DOM_SATURATION_DAYS,
  PRICE_DROP_BOOST_WEIGHT,
  PRICE_DROP_SATURATION,
  TIMING_JOINT_CAP,
  NO_SCORE_SENTINEL,
} from "@/lib/display-score";

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
   * Novelty mark (#416, plan #415 §3.1): true when this property is NEW since
   * the profile's last visit — its earliest listing `first_seen_at` is after
   * the visit anchor (`search_profile.previous_viewed_at`, falling back to
   * `created_at - interval '1 day'` for a never-visited profile). Computed on
   * the SAME `first_seen_at` basis as the field above and as `new_count` in
   * profile-overview.ts, so the feed's NUEVO badge and the /perfiles
   * "N nuevos" strip can never disagree.
   *
   * Because the anchor is `previous_viewed_at` (shifted by
   * `touchProfileViewedAt` only when the prior visit was outside the session
   * debounce), this stays STABLE for the whole visit — a reload, filter
   * change, "Cargar más", or a detail-and-back all keep the same marks; they
   * expire on the NEXT visit. Phase 1 does NOT reorder on this — novelty is a
   * presentation mark only, never folded into `effective_score` or the sort
   * (fresh-first ordering is phase 3).
   */
  is_new: boolean;
  /**
   * Price-change signal (#420, plan #415 §3.2/§3.3): true when this property's
   * price MOVED since the profile's last visit AND the move clears the sanity
   * band (`|delta_pct|` within `[feed.price_change_min_pct, price_change_max_pct]`,
   * default 1%–60%). Same visit anchor as `is_new` (`previous_viewed_at`, with the
   * `created_at - 1 day` fallback), so "cambió desde mi última visita" and NUEVO
   * expire together on the next visit — this is a change SINCE the anchor, NOT the
   * cumulative-from-first-price drop `computePropertyScoringSignals` returns.
   *
   * A sub-1% move (noise) and a >60% move (a data artifact — the demo has a −96%
   * one) both leave this `false` while `price_delta_pct` still carries the raw
   * figure, so a data-health view can surface suspects without the feed badging
   * them. Presentation only — never folded into `effective_score` or the sort
   * (fresh-first ordering is phase 3). Direction lives in `price_direction`; the
   * signed `price_delta_pct` is the single source both derive from.
   */
  price_changed: boolean;
  /**
   * Signed change fraction of the latest price move since the visit anchor
   * (#420): negative = price fell (a BAJADA, good for a buyer), positive = rose
   * (SUBIDA). `(curr - prev) / prev` over the property's `listing_price_history`,
   * latest consecutive pair only. Null when no move happened since the anchor.
   * Carried raw (band NOT applied here) so `price_changed=false` suspects still
   * expose their delta for data-health; the card reads it only when
   * `price_changed` is true.
   */
  price_delta_pct: number | null;
  /**
   * Direction of a badge-worthy price move (#420): `"drop"` (BAJADA, `--up`
   * token) / `"up"` (SUBIDA, `--down` token) / null when nothing badge-worthy.
   * Derived from `sign(price_delta_pct)` and gated by the same sanity band as
   * `price_changed`, so it is non-null exactly when `price_changed` is true.
   */
  price_direction: "drop" | "up" | null;
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
   * #461: WHICH comparison base produced `below_market_pct` — `"segment"` when a
   * like-for-like segment (similar habitaciones / m² / floor class) had enough
   * priced comparables (≥ `MIN_POOL_SIZE`), `"pool"` when it fell back to the
   * whole-profile median, `null` when there was no comparison at all (no
   * price/m², or even the pool was too small). Lets the card chip and the detail
   * breakdown explain the number ("comparado con N similares" vs "mediana del
   * perfil") without recomputing anything.
   */
  below_market_base: "segment" | "pool" | null;
  /**
   * #461: the number of priced comparables backing `below_market_pct` — the
   * segment size when `below_market_base === "segment"`, the whole-pool count
   * when `"pool"`, `null` when there was no comparison. Includes the property
   * itself (the median is computed over a set that contains it, exactly as the
   * whole-pool median always has).
   */
  below_market_comparables: number | null;
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
  /**
   * The property's current accept/reject verdict for THIS profile
   * (#379/#422), derived latest-wins over accept/reject/star/clear with a trailing
   * `clear` collapsing to null. Embedded on the row so the card renders its
   * marked state (and the "Descartada" treatment for `reject`) immediately,
   * without FeedbackControls issuing a per-card GET. `null` when the property
   * has no active verdict. Rejected rows only appear here when the feed was
   * fetched with `includeRejected` (the show-rejected toggle) — the default
   * feed excludes them server-side.
   */
  feedback_state: StateFeedbackType | null;
}

export interface CandidatePage {
  items: CandidateRow[];
  /**
   * Opaque cursor string — pass back as `cursor` to fetch the next page; null
   * when this is the last page. Encodes the 3-column keyset key `novelty_tier`
   * + `effective_score` + `property_id` (#425), plus the session-fixed novelty
   * anchor and cold-start decision, not just an id — results are ordered
   * globally by (tier, score, id), so a shorter cursor can't resume the scan
   * correctly. Callers must not parse this themselves; treat it as opaque.
   */
  nextCursor: string | null;
  /**
   * #425 (plan #415 §3.2): the novelty tier was suppressed for this session —
   * the profile was never visited, or the tier would cover >60% of the matched
   * pool. Every row renders at tier 0 (no fresh-first reordering) and the UI
   * shows a single "Perfil nuevo: todo es reciente" line instead of highlighting
   * the whole feed. Stable across pages (folded into the cursor). Tracked
   * (accept) rows are exempt from the suppression regardless of this flag.
   */
  coldStart: boolean;
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

// ── Ranking blend (#309 / D-057, extended by #452) ──────────────────────────
//
// The default feed used to sort purely on the learned `score`, so a genuinely
// below-market or distressed listing showed its badge but never rose in the
// list — the investor still had to scan for it. #309 blends OPPORTUNITY signals
// into the sort key as additive, non-negative boosts on top of the learned
// score; #452 adds two TIMING boosts (days-on-market + net price-drop):
//
//   effective_score = COALESCE(score, -1)
//                   + below_market_boost   (0 … BELOW_MARKET_DISCOUNT_CAP·WEIGHT = 0.25)
//                   + distress_boost        (0 … DISTRESS_MAX_UNITS·UNIT_WEIGHT  = 0.15)
//                   + beach_boost           (0 … 3·BEACH_UNIT_WEIGHT            = 0.09, #392)
//                   + tourist_license_boost (0 … TOURIST_LICENSE_BOOST          = 0.04, #398)
//                   + timing_boost          (0 … TIMING_JOINT_CAP               = 0.11, #452)
//
// Because ALL boosts are ≥ 0, a candidate with no assessment and no discount
// keeps its base score EXACTLY (graceful degradation — it never sinks or
// errors), and a never-scored candidate (score NULL → −1 sentinel) still sorts
// last: even the maximum total boost (0.25 + 0.15 + 0.09 + 0.04 + 0.11 = 0.64,
// = MAX_TOTAL_BOOST in lib/display-score.ts) leaves it at −0.36, still below any
// real sigmoid score (which is in (0,1)). The learned model is augmented, never
// replaced, and adding the timing terms does NOT break the invariant.
//
// The weights/caps themselves live in lib/display-score.ts (imported above) so
// the SQL sort key here and the 0–100 display re-expression derive from ONE set
// of constants (D-059). The score is a monotone re-expression of this same
// effective_score — one number, one order — so it can never disagree with the
// feed sort or the #425 keyset cursor (which is unchanged: effective_score is
// still the single sort key; #452 only adds terms to its existing expression).

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

// ── Like-for-like below-market segmentation (#461) ──────────────────────────
//
// The below-market discount used to compare a property's €/m² against the
// median €/m² of the WHOLE profile pool (normalized by m² only). That over-
// or under-states the discount for anything atypical: a 4-bed penthouse
// compared against a pool dominated by 1-bed flats, or a ground-floor `bajo`
// (which the market prices lower) compared against upper floors. #461 makes
// the comparison LIKE-FOR-LIKE: each property's discount is measured against a
// SEGMENT of the pool with similar rooms, m² and floor position, falling back
// to the whole-pool median when that segment is too small to be trustworthy
// (so coverage is preserved rather than fabricating precision from 1–2 comps).
//
// The segment predicate (all three must hold, plus a priced comparable):
//   - habitaciones within ±SEG_ROOMS_TOLERANCE of the target (both non-null);
//   - m² built within ±SEG_M2_BAND of the target (a proportional band);
//   - the SAME ground-floor class — a `bajo`/`entresuelo` is only ever compared
//     against other ground-floor units, never against upper floors, because the
//     market discounts them (comparing the two ways round would manufacture a
//     phantom discount or premium).
// The segment INCLUDES the target itself (exactly as the whole-pool median
// does), so `MIN_POOL_SIZE` counts comparables the same way in both bases.

/** Rooms tolerance for the like-for-like segment: habitaciones within ±1. */
const SEG_ROOMS_TOLERANCE = 1;
/** m²-built band for the like-for-like segment: ±25% around the target's m². */
const SEG_M2_BAND = 0.25;

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
export const CONDITION_FILTERS = [
  "a_reformar",
  "reformado",
  "obra_nueva",
] as const;
export type ConditionFilter = (typeof CONDITION_FILTERS)[number];

/** Renovation-severity hard-filter values (#313). Only meaningful within `a_reformar`; a non-null value implies that category. */
export const RENOVATION_FILTERS = ["leve", "integral"] as const;
export type RenovationFilter = (typeof RENOVATION_FILTERS)[number];

/**
 * Caveat hard-filter values (#386, Fase 1 of #385). The ownership/transaction
 * caveats worth sourcing on directly — the closed subset of `CAVEAT_CODES`
 * (lib/ai-assessment/occupancy.ts) that answers "what do I actually get if I
 * buy this?". `venta_deuda` is the owner's explicit ask; the rest are the
 * partial-ownership terms of art already rendered as warn badges by
 * `CAVEAT_LABELS`. The physical-occupancy codes (`tenanted`,
 * `occupied_illegally`) are deliberately NOT here — they're covered by the
 * `occupancy` filter above, so exposing them again as a caveat would be a
 * second control for the same signal. Kept as a SQL param, never interpolated.
 */
export const CAVEAT_FILTERS = [
  "venta_deuda",
  "nuda_propiedad",
  "usufructo",
  "proindiviso",
  "derecho_superficie",
] as const;
export type CaveatFilter = (typeof CAVEAT_FILTERS)[number];

/**
 * Red-flag-type hard-filter values (#386). Mirrors the closed vocabulary of
 * `REDFLAG_LABELS` (lib/ai-assessment/redflags.ts) — every problem type that
 * earns a badge, so filtering can never target a type the card can't show.
 * `unfinished_construction` ("obra sin terminar") is the owner's explicit ask;
 * `other` (the long-tail catch-all with no scannable meaning) is excluded, the
 * same rule the badge renderer follows. Kept as a SQL param, never interpolated.
 */
export const REDFLAG_TYPE_FILTERS = [
  "embargo",
  "subasta_judicial",
  "herencia_yacente",
  "deuda_comunidad",
  "construccion_ilegal",
  "litigio",
  "sin_financiacion_hipotecaria",
  "cambio_uso_pendiente",
  "unfinished_construction",
  "structural_damage",
] as const;
export type RedflagTypeFilter = (typeof REDFLAG_TYPE_FILTERS)[number];

/**
 * Beach-proximity hard-filter values (#392, Fase 4 of #385). A MINIMUM-GRADE
 * filter, NOT an exact match: the token is the LEAST beach signal a candidate
 * must carry to survive, graded frontline > sea_view > near_beach:
 *   - `frontline`  → only primera línea de playa (the owner's explicit ask).
 *   - `sea_view`   → frontline OR sea_view ("al menos vistas al mar").
 *   - `near_beach` → any of the three (any beach signal at all).
 * `none` is deliberately not a filter target — it means "no signal", nothing to
 * source on (same rule the badge vocabulary follows). A subset of the axis's
 * `BEACH_PROXIMITIES`. Kept as a SQL param, never interpolated.
 */
export const BEACH_PROXIMITY_FILTERS = [
  "frontline",
  "sea_view",
  "near_beach",
] as const;
export type BeachProximityFilter = (typeof BEACH_PROXIMITY_FILTERS)[number];

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
  /**
   * #386: keep only candidates whose latest occupancy assessment derives this
   * caveat code (reads the `ranked.caveats` array the CTE builds from the SAME
   * `caveats[]` the distress boost counts — D-059). Covers `venta_deuda` and
   * the partial-ownership caveats. A candidate with no occupancy assessment
   * (null caveats) is EXCLUDED — "unknown", never a false pass. `null` = off.
   */
  caveat?: CaveatFilter | null;
  /**
   * #386: keep only candidates whose latest redflags assessment carries a flag
   * of this `type` (reads the `ranked.redflag_types` array the CTE builds from
   * the SAME `flags[]` the distress boost counts — D-059). Covers
   * `unfinished_construction`, `embargo`, etc. Null redflag_types (never
   * assessed) is EXCLUDED. `null` = off.
   */
  redflagType?: RedflagTypeFilter | null;
  /**
   * #392: minimum beach-proximity grade a candidate must reach (`frontline` =
   * only primera línea; `sea_view` = frontline OR sea_view; `near_beach` = any
   * of the three). Reads `ranked.beach_proximity`, derived from the SAME latest
   * `location` assessment row the beach boost reads (D-059). A null
   * beach_proximity (location never assessed) OR `none` (assessed, no signal) is
   * EXCLUDED — "unknown / no signal", never a false pass, matching #310/#387.
   * `null` = off.
   */
  beachProximity?: BeachProximityFilter | null;
  /**
   * #392: keep only casco-histórico candidates (`ranked.heritage_zone = true`).
   * A false (assessed, not heritage) OR null (location never assessed) value is
   * EXCLUDED, matching #310/#387. A UI toggle, so `false`/`null`/undefined all
   * mean "off". Reads the derived heritage_zone boolean, never a separate JOIN
   * (D-059).
   */
  heritageZone?: boolean | null;
  /**
   * #398: VPO / vivienda protegida HARD filter — BIDIRECTIONAL, unlike the
   * beach/heritage filters. `true` keeps ONLY VPO candidates (buscarla); `false`
   * keeps ONLY non-VPO candidates (excluirla); `null`/undefined = off. Reads the
   * derived `ranked.is_vpo` boolean off the SAME latest `opportunity` row the
   * badge reads (D-059), never a separate JOIN. A NULL is_vpo (opportunity never
   * assessed) is EXCLUDED in BOTH directions — "unknown, never a false pass":
   * keeping an unassessed property under `false` would assert "this is not VPO"
   * when we don't know. Same graceful-degradation-to-empty as the other
   * assessment filters until the LLM populates the axis. Note `tourist_license`
   * is deliberately NOT a filter (soft boost only — see TOURIST_LICENSE_BOOST).
   */
  isVpo?: boolean | null;
  /**
   * #466 "Con alertas" UNION filter — the owner's "muéstrame las que tienen
   * alertas" (2026-08-08): keep only candidates the operator sees a warn badge
   * on. `true` keeps candidates with ≥1 red flag (of ANY type) OR ≥1 warn-tone
   * occupancy caveat (the `WARN_CAVEAT_CODES` set); `false`/`null`/undefined =
   * off. A UNION of the #386 `redflagType`/`caveat` axes rather than a single
   * code, so it matches exactly the warn badges the card renders and the "N con
   * alertas" glance. Reads the SAME `ranked.redflag_types` / `ranked.caveats`
   * arrays those filters read (D-059, no new JOIN). A never-assessed property
   * (both arrays NULL) is EXCLUDED — "unknown", never a false pass, matching the
   * other assessment filters. Composes (AND) with `redflagType` and the rest.
   */
  hasAlerts?: boolean | null;
  /**
   * #470 free-text search — the owner's "search that includes the description
   * but also all the other fields". A non-empty `q` narrows the feed to
   * properties whose materialized search document (`property_search_doc.doc`,
   * built by triggers from address/refs + active-listing descriptions + the
   * latest per-axis assessment codes/labels — see etl/schema/init.sql) matches
   * `websearch_to_tsquery('es_unaccent', q)`: Spanish stemming + unaccent
   * ("malaga" ≈ "málaga"), quoted phrases / OR / -exclusion for free, and never
   * an error on arbitrary input. It is a FILTER, applied in the OUTER WHERE like
   * `source`/occupancy/etc. (owner decision 1) — the `(novelty_tier,
   * effective_score, property_id)` keyset key and cursor are UNTOUCHED, so the
   * best opportunities that mention the term still come first. Always bound as a
   * parameter, never interpolated. `null`/empty/whitespace = off. Relevance
   * ordering (`ts_rank_cd`) is a deliberately deferred optional phase.
   */
  q?: string | null;
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
/**
 * Placeholders the shared `ranked` CTE injects into its SQL. All are caller-
 * supplied because their `$N` position differs per call site (and two are not
 * `$N` at all in the resolve query — see `anchorParam`).
 *
 * `anchorParam` / `coldStartParam` are the load-bearing #425 threading: the
 * novelty anchor and the cold-start suppression decision are resolved ONCE per
 * paging session and passed in as bound values, never re-read per request, so
 * a mid-session anchor shift (a re-visit crossing the 30-min debounce) can't
 * re-tier rows and land the keyset cursor in the wrong partition (plan §3.2).
 * `anchorParam` is normally a `$N` placeholder, but the resolve query passes a
 * scalar sub-select (`(SELECT anchor_ts FROM sp)`) so it can compute the anchor
 * and the tier coverage in one round-trip.
 */
interface RankedCteParams {
  /** `$N` for the warn-caveat text[] (distress occupancy caveats). */
  warnParam: string;
  /** SQL expression yielding the visit anchor timestamp (a `$N` bound value, or a scalar sub-select in the resolve query). */
  anchorParam: string;
  /** `$N` for the price-change sanity-band MIN fraction (tier mirrors the badge). */
  bandMinParam: string;
  /** `$N` for the price-change sanity-band MAX fraction. */
  bandMaxParam: string;
  /** SQL boolean expression: when true, cold-start suppresses the novelty tier (except tracked rows). A `$N` bound value on the page/adjacency queries; the literal `false` on the resolve query so it measures the RAW tier coverage. */
  coldStartParam: string;
}

/**
 * #425 (plan #415 §3.2): the leading sort TIER. Fresh-first ordering puts new
 * and price-moved candidates above everything else, but as a SEPARATE key —
 * `effective_score` is NEVER touched, so the #309/D-057 non-negativity,
 * graceful-degradation and never-scored-floor invariants hold by construction
 * (clauses 1–3 are about an unchanged expression). The tier's `price_changed`
 * arm mirrors `classifyPriceChange`'s sanity band exactly (|delta| within
 * [min,max]) so a row tiers up iff it also badges. Cold-start suppression
 * (`coldStartParam`) zeroes the tier for everyone EXCEPT tracked (accept) rows,
 * which the owner's working set must never lose (#425 "seguimiento nunca
 * suprimido"). Injected into `ranked` so all THREE call sites (list ORDER BY,
 * keyset cursor, getAdjacentCandidates) inherit ONE definition (derive-once,
 * D-059) — the clause-4 constraint that makes prev/next agree with the feed.
 */
function noveltyTierExpr(p: RankedCteParams): string {
  return `CASE
           WHEN (${p.coldStartParam}) AND base.feedback_state IS DISTINCT FROM 'accept' THEN 0
           WHEN COALESCE(nov.is_new, false)
                OR (pm.delta_pct IS NOT NULL
                    AND ABS(pm.delta_pct) >= ${p.bandMinParam}::double precision
                    AND ABS(pm.delta_pct) <= ${p.bandMaxParam}::double precision)
             THEN 1
           ELSE 0
         END`;
}

function rankedCandidatesCte(params: RankedCteParams): string {
  const { warnParam } = params;
  // #392 graded beach boost, built from BEACH_PROXIMITY_BOOST_UNITS. Keys are
  // hardcoded enum values and values are numeric constants — never user input —
  // so interpolating them into the CASE is safe. `none`/NULL fall through to
  // ELSE 0 (no lift). frontline earns the top units (see the constant's doc for
  // why the hard-filter target is still boosted).
  const beachBoostCase = `CASE base.beach_proximity ${Object.entries(
    BEACH_PROXIMITY_BOOST_UNITS,
  )
    .map(([grade, units]) => `WHEN '${grade}' THEN ${units}`)
    .join(" ")} ELSE 0 END`;
  // #398 tourist-licence soft boost: a single boolean lift. base.tourist_license
  // is a derived boolean (TRUE only when the opportunity axis found a granted
  // licence); false/NULL add 0. TOURIST_LICENSE_BOOST is a numeric constant,
  // never user input.
  const touristBoostCase = `CASE WHEN base.tourist_license = true THEN ${TOURIST_LICENSE_BOOST} ELSE 0 END`;
  // #452 timing boosts, read off the `timing` CTE (LEFT JOINed as `tim`). Both
  // degrade to 0 when the signal is absent (tim.* NULL → the CASE ELSE 0), and
  // both are non-negative (GREATEST(x,0)), so they augment `effective_score`
  // without ever sinking a candidate or breaking the never-scored floor. The
  // weights/caps/saturation points are numeric constants from display-score.ts,
  // never user input, so interpolating them is safe (same pattern as the beach
  // and tourist boost CASEs above). `.0` forces float division in SQL.
  const domBoostSql = `CASE WHEN tim.days_on_market IS NOT NULL
        THEN LEAST(GREATEST(tim.days_on_market, 0) / ${DOM_SATURATION_DAYS}.0, 1) * ${DOM_BOOST_WEIGHT}
        ELSE 0 END`;
  const priceDropBoostSql = `CASE WHEN tim.price_drop_pct IS NOT NULL
        THEN LEAST(GREATEST(tim.price_drop_pct, 0) / ${PRICE_DROP_SATURATION}, 1) * ${PRICE_DROP_BOOST_WEIGHT}
        ELSE 0 END`;
  // Joint cap (Fable: 0.11): the two timing boosts together never exceed
  // TIMING_JOINT_CAP. LEAST over their sum, which is 0 when both signals are
  // absent — the degrade-to-0 case.
  const timingBoostSql = `LEAST((${domBoostSql}) + (${priceDropBoostSql}), ${TIMING_JOINT_CAP})`;
  // Terminal-status set for the days-on-market freeze (matches
  // market-signals.ts TERMINAL_STATUSES). Hardcoded constants → safe to inline
  // as a literal array, avoiding a new param threaded through all four callers.
  const terminalStatusesLiteral = `ARRAY['sold','withdrawn','expired']::text[]`;
  // #461 ground-floor class for the like-for-like segment. `floor` is free text
  // as the portals publish it ("Bajo", "Entreplanta", "1ª", "3", "Ático"), so a
  // ground-floor unit is detected by the market's own vocabulary rather than a
  // numeric parse. NULL/unknown floors collapse to `false` (treated as "not
  // ground floor") — the same class matches the same class, so two unknowns
  // still compare together, and a real `bajo` is never mixed with an upper floor.
  //
  // #474: "bajo cubierta"/"bajocubierta" is an ático UNDER THE ROOF — an UPPER
  // floor, not a `bajo` — but the substring `bajo` used to match it into the
  // ground-floor segment (which the market prices lower), manufacturing a phantom
  // discount/premium. Excluding any floor text containing `cubierta` up front
  // keeps that ático out of the ground-floor class while leaving a plain `bajo`
  // untouched — the minimal tidy the #473 review flagged.
  const isGroundFloorSql = `CASE
        WHEN p.floor IS NOT NULL
             AND lower(p.floor) !~ 'cubierta'
             AND (
                  lower(p.floor) ~ '(bajo|baja|entresuelo|entreplanta|planta baja|semisotano|semisótano)'
                  OR btrim(lower(p.floor)) IN ('0', 'pb', 'bj')
             ) THEN true ELSE false END`;
  return `${DISABLED_SOURCES_CTE},
     base AS (
       SELECT
         p.id AS property_id,
         p.address, p.lat, p.lon, p.property_type, p.m2_built, p.rooms, p.bathrooms, p.floor,
         -- #461: ground-floor class for the like-for-like below-market segment.
         ${isGroundFloorSql} AS is_ground_floor,
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
         dist.renovation_severity,
         -- #386 caveat/redflag-type hard filters. Same derive-once discipline:
         -- the FULL set of occupancy caveat codes and redflags flag types, read
         -- off the identical latest-per-axis rows that feed distress_level, so a
         -- caveat/type the filter keeps is exactly one that could have lifted the
         -- distress boost (D-059). NULL = that axis unassessed → excluded.
         dist.caveats,
         dist.redflag_types,
         -- #392 beach-proximity + heritage-zone hard filters and the soft beach
         -- boost. Same derive-once discipline (D-059): read off the identical
         -- latest-per-axis location row, never a separate JOIN. beach_proximity
         -- NULL = location never assessed (excluded by any beach filter, boost 0);
         -- heritage_zone NULL likewise excluded when the toggle is on.
         dist.beach_proximity,
         dist.heritage_zone,
         -- #398 opportunity axis: is_vpo (bidirectional hard filter) and
         -- tourist_license (soft boost). Same derive-once discipline (D-059):
         -- read off the identical latest-per-axis opportunity row, never a
         -- separate JOIN. NULL = opportunity never assessed (is_vpo excluded by
         -- either direction of the VPO filter; tourist_license adds no boost).
         dist.is_vpo,
         dist.tourist_license,
         -- Current accept/reject verdict for this profile (#379/#422),
         -- derived latest-wins over accept/reject/star/clear; a trailing
         -- clear OR a legacy star (#422, retired) collapses to NULL (neutral).
         -- Feeds the card's marked state ("en seguimiento" for accept), the
         -- default feed's reject exclusion, and the #422 seguimiento filter
         -- (all in the outer WHERE).
         CASE WHEN fb.feedback_type IN ('clear', 'star') THEN NULL ELSE fb.feedback_type END AS feedback_state
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
           max(la.result->>'renovation_severity') FILTER (WHERE la.assessment_type = 'condition') AS renovation_severity,
           -- #386: the FULL caveat-code and redflag-type sets as text[], for the
           -- caveat/redflagType hard filters. Only the single occupancy row
           -- produces a non-null caveats array and only the single redflags row a
           -- non-null types array (max() ignores the NULLs the other axes yield),
           -- so each aggregate collapses to that one row's value — the same
           -- latest-per-axis source distress_level reads. An empty array (assessed
           -- but no caveat/flag) stays non-null and simply matches no filter value;
           -- NULL means the axis was never assessed (excluded by any filter on it).
           max(
             CASE WHEN la.assessment_type = 'occupancy'
                       AND jsonb_typeof(la.result->'caveats') = 'array'
                  THEN ARRAY(SELECT jsonb_array_elements_text(la.result->'caveats'))
                  ELSE NULL END
           ) AS caveats,
           max(
             CASE WHEN la.assessment_type = 'redflags'
                       AND jsonb_typeof(la.result->'flags') = 'array'
                  THEN ARRAY(
                         SELECT rf.value->>'type'
                           FROM jsonb_array_elements(la.result->'flags') rf
                          WHERE jsonb_typeof(rf.value) = 'object'
                            AND rf.value->>'type' IS NOT NULL
                       )
                  ELSE NULL END
           ) AS redflag_types,
           -- #392 location axis: the graded beach_proximity enum and the
           -- heritage_zone boolean, read off the SAME latest location row.
           -- Only the single location row has these keys (max()/bool_or() ignore
           -- the NULLs the other axes yield), so each aggregate collapses to that
           -- one row's value. NULL means the location axis was never assessed —
           -- excluded by any beach/heritage filter, and the boost sees none.
           -- Location is NOT a distress axis, so nothing above counts it.
           max(la.result->>'beach_proximity')
             FILTER (WHERE la.assessment_type = 'location') AS beach_proximity,
           bool_or(la.result->>'heritage_zone' = 'true')
             FILTER (WHERE la.assessment_type = 'location') AS heritage_zone,
           -- #398 opportunity axis: is_vpo + tourist_license booleans, read off
           -- the SAME latest opportunity row. bool_or(... = 'true') FILTER on the
           -- single opportunity row collapses to that row's boolean; FILTER
           -- yields NULL when no opportunity row exists (never assessed) — the
           -- graceful-degradation case both the VPO filter (excluded in either
           -- direction) and the tourist boost (no lift) treat correctly. Neither
           -- is a distress axis, so nothing above counts them.
           bool_or(la.result->>'is_vpo' = 'true')
             FILTER (WHERE la.assessment_type = 'opportunity') AS is_vpo,
           bool_or(la.result->>'tourist_license' = 'true')
             FILTER (WHERE la.assessment_type = 'opportunity') AS tourist_license
         FROM (
           SELECT DISTINCT ON (a.assessment_type) a.assessment_type, a.result
             FROM ai_assessment a
            WHERE a.property_id = p.id
              AND a.assessment_type IN ('occupancy', 'condition', 'redflags', 'location', 'opportunity')
            ORDER BY a.assessment_type, a.generated_at DESC NULLS LAST, a.id DESC
         ) la
       ) dist ON true
       -- Latest state verdict for (profile, property) (#379/#422). accept/
       -- reject/star/clear only (note/correction never change the toggle);
       -- keeping the retired star in the IN list lets a legacy star still WIN
       -- the latest-wins ordering, then the outer CASE collapses star AND clear
       -- to NULL. Index-fed by idx_feedback_event_profile_property.
       LEFT JOIN LATERAL (
         SELECT fe.feedback_type
           FROM feedback_event fe
          WHERE fe.profile_id = $1 AND fe.property_id = p.id
            AND fe.feedback_type IN ('accept', 'reject', 'star', 'clear')
          ORDER BY fe.created_at DESC, fe.id DESC
          LIMIT 1
       ) fb ON true
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
     -- #416 novelty anchor (plan #415 §3.1): the timestamp the feed measures
     -- "new since I last looked" against. previous_viewed_at is the shifted
     -- two-slot anchor (see touchProfileViewedAt) — NOT last_viewed_at, which
     -- this same page GET stamps to NOW() on arrival. Fallback matches the
     -- exact expression new_count already uses in profile-overview.ts. One row.
     anchor AS (
       -- #425: the visit anchor is RESOLVED ONCE per paging session and passed
       -- in (anchorParam), never re-read from search_profile per request, so a
       -- mid-session shift of previous_viewed_at can't re-tier rows and misplace
       -- the keyset cursor (plan §3.2). The resolve query threads the shifted
       -- two-slot anchor (COALESCE(previous_viewed_at, created_at - 1 day) — the
       -- exact fallback new_count uses); page 2+ threads the value folded into
       -- the cursor. novelty/price_moves both read (SELECT ts FROM anchor).
       SELECT (${params.anchorParam})::timestamptz AS ts
     ),
     -- #416 pre-aggregated novelty signal: exactly ONE row per candidate
     -- property, bounded to base's property set (never a scan of the whole
     -- listing table, and never a correlated subquery inside base — the
     -- per-row-subquery cost D-057 explicitly rejects). is_new = the
     -- property's EARLIEST listing first_seen_at is after the visit anchor.
     -- The first_seen_at basis and activeSourceClause here match the outer
     -- SELECT's first_seen_at column verbatim, so the NUEVO badge and that
     -- timestamp can never disagree. Joined once into ranked below, so it also
     -- reaches getAdjacentCandidates' shared CTE — harmless there (that query
     -- selects only property_id/effective_score) and free of any ORDER BY
     -- impact (phase 1 does not tier on novelty; that is phase 3).
     novelty AS (
       SELECT b.property_id,
              MIN(l.first_seen_at) > (SELECT ts FROM anchor) AS is_new
         FROM base b
         JOIN listing l ON l.property_id = b.property_id
        WHERE ${activeSourceClause("l")}
        GROUP BY b.property_id
     ),
     -- #420 price-change signal (plan #415 §3.3): the property's LATEST
     -- consecutive price move, and its signed delta, when that move happened
     -- after the visit anchor. BOUNDED to base's property set via the JOIN —
     -- NEVER a LAG() over the whole listing_price_history (the digest.ts
     -- loadPriceDrops anti-pattern §3.3 calls out). Pre-aggregated to one row
     -- per property (rn=1 keeps only the most recent observation), joined once
     -- into ranked — mirroring novelty's shape, not a correlated subquery in
     -- base (the D-057 cost). PARTITION BY property_id per the plan: a
     -- deduplicated property has a single price stream at the card level.
     --
     -- Copies computePropertyScoringSignals' set-based SHAPE, not its predicate:
     -- that helper measures the cumulative drop from the FIRST-ever price; this
     -- measures the change since the visit anchor ("cambió desde mi última
     -- visita"). The sanity band (min/max %) is applied in TS (classifyPriceChange)
     -- so the raw delta stays available for a data-health surface; delta_pct is
     -- carried through ranked.* and read only by listCandidates (getAdjacentCandidates
     -- selects only property_id/effective_score, so this is harmless there — same
     -- as novelty). prev_price is guaranteed non-null, non-zero and distinct, so
     -- the division is safe.
     price_moves AS (
       SELECT property_id,
              (curr_price - prev_price) / prev_price AS delta_pct
         FROM (
           SELECT b.property_id,
                  h.price AS curr_price,
                  h.observed_at,
                  LAG(h.price) OVER (PARTITION BY b.property_id
                                     ORDER BY h.observed_at, h.id) AS prev_price,
                  ROW_NUMBER() OVER (PARTITION BY b.property_id
                                     ORDER BY h.observed_at DESC, h.id DESC) AS rn
             FROM listing_price_history h
             JOIN listing l ON l.id = h.listing_id
             JOIN base b ON b.property_id = l.property_id
         ) w
        WHERE rn = 1
          AND prev_price IS NOT NULL
          AND prev_price <> 0
          AND curr_price IS DISTINCT FROM prev_price
          AND observed_at > (SELECT ts FROM anchor)
     ),
     -- #452 timing signals: per-property days-on-market + net price-drop, the
     -- inputs to the two timing boosts. Mirrors computePropertyScoringSignals
     -- (lib/analytics/market-signals.ts) EXACTLY — one representative listing
     -- per property (active first, then most recently listed), days-on-market
     -- frozen at the terminal-status transition (EC-2), and the net drop as
     -- (first_price - last_price) / first_price over the rep's price history.
     -- BOUNDED to base's property set via the JOIN (never a scan of the whole
     -- listing table), pre-aggregated to one row per property, and joined once
     -- into ranked below — the same shape as novelty / price_moves, not a
     -- correlated subquery in base (the D-057 per-row cost). Selects only
     -- property_id + the two signals, so it is free of any ORDER BY impact and
     -- harmless in getAdjacentCandidates' shared CTE.
     timing AS (
       SELECT
         rep.property_id,
         FLOOR(
           EXTRACT(EPOCH FROM (
             CASE
               WHEN rep.status = 'active' THEN NOW()
               ELSE COALESCE(
                 (SELECT MIN(e.observed_at)
                    FROM listing_status_event e
                   WHERE e.listing_id = rep.listing_id
                     AND e.status = ANY(${terminalStatusesLiteral})),
                 NOW()
               )
             END - rep.first_seen_at
           )) / 86400.0
         ) AS days_on_market,
         (
           SELECT CASE
                    WHEN agg.cnt > 1 AND agg.first_price > 0
                    THEN (agg.first_price - agg.last_price) / agg.first_price
                    ELSE NULL
                  END
             FROM (
               SELECT COUNT(*) AS cnt,
                      (ARRAY_AGG(h.price ORDER BY h.observed_at ASC, h.id ASC))[1] AS first_price,
                      (ARRAY_AGG(h.price ORDER BY h.observed_at DESC, h.id DESC))[1] AS last_price
                 FROM listing_price_history h
                WHERE h.listing_id = rep.listing_id
             ) agg
         ) AS price_drop_pct
       FROM (
         SELECT DISTINCT ON (l.property_id)
           l.property_id, l.id AS listing_id, l.first_seen_at, l.status
           FROM listing l
           JOIN base b ON b.property_id = l.property_id
          WHERE l.first_seen_at IS NOT NULL
          ORDER BY l.property_id, (l.status = 'active') DESC, l.first_seen_at DESC, l.id DESC
       ) rep
     ),
     pool AS (
       SELECT
         percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2) AS median_ppm2,
         COUNT(ppm2) AS n
       FROM base
     ),
     -- #461 like-for-like below-market base: for EACH candidate, the median EUR/m2
     -- over the SEGMENT of the pool with similar rooms (+/-${SEG_ROOMS_TOLERANCE}),
     -- m2 (+/-${Math.round(SEG_M2_BAND * 100)}%) and the same ground-floor class,
     -- with a graceful fallback to the whole-pool median (the pool CTE above)
     -- when that segment has fewer than ${MIN_POOL_SIZE} priced comparables. The
     -- chosen median, its comparable count, and which base was used (segment vs
     -- pool) are resolved here ONCE per property so the ranked below-market
     -- field, the boost, and the detail/breakdown all derive from ONE decision
     -- (derive-once). The self-join over base is O(matched^2) per profile --
     -- acceptable at the current per-profile matched-set size, the same envelope
     -- the ORDER BY sort already accepts (see the CTE-chain doc above); if a
     -- profile's pool grows large enough for it to hurt, materialize the segment
     -- median in the scoring pass rather than move it into a per-row correlated
     -- scan of the whole listing table.
     segmented AS (
       SELECT
         b.property_id,
         seg.seg_n,
         -- Which base actually drove the discount, so the card chip and the
         -- detail breakdown can explain it ("comparado con N similares" vs
         -- "mediana del perfil"). NULL when neither base qualifies (no price/m²,
         -- or even the whole pool is below MIN_POOL_SIZE) — a genuine "no
         -- comparison", never a fabricated "at market".
         CASE
           WHEN b.ppm2 IS NOT NULL AND seg.seg_n >= ${MIN_POOL_SIZE}
                AND seg.seg_median_ppm2 IS NOT NULL AND seg.seg_median_ppm2 > 0
             THEN 'segment'
           WHEN b.ppm2 IS NOT NULL AND pool.n >= ${MIN_POOL_SIZE}
                AND pool.median_ppm2 IS NOT NULL AND pool.median_ppm2 > 0
             THEN 'pool'
           ELSE NULL
         END AS below_market_base,
         -- The comparable count backing the chosen base (segment size, or the
         -- whole-pool count) — surfaced so the chip can say "N similares".
         CASE
           WHEN b.ppm2 IS NOT NULL AND seg.seg_n >= ${MIN_POOL_SIZE}
                AND seg.seg_median_ppm2 IS NOT NULL AND seg.seg_median_ppm2 > 0
             THEN seg.seg_n
           WHEN b.ppm2 IS NOT NULL AND pool.n >= ${MIN_POOL_SIZE}
                AND pool.median_ppm2 IS NOT NULL AND pool.median_ppm2 > 0
             THEN pool.n
           ELSE NULL
         END AS comp_n,
         -- The chosen comparison median: the segment's when it qualifies, else
         -- the whole-pool's, else NULL. Both the below_market_pct field and the
         -- boost in ranked read THIS single value.
         CASE
           WHEN b.ppm2 IS NOT NULL AND seg.seg_n >= ${MIN_POOL_SIZE}
                AND seg.seg_median_ppm2 IS NOT NULL AND seg.seg_median_ppm2 > 0
             THEN seg.seg_median_ppm2
           WHEN b.ppm2 IS NOT NULL AND pool.n >= ${MIN_POOL_SIZE}
                AND pool.median_ppm2 IS NOT NULL AND pool.median_ppm2 > 0
             THEN pool.median_ppm2
           ELSE NULL
         END AS comp_median_ppm2
       FROM base b
       CROSS JOIN pool
       LEFT JOIN LATERAL (
         SELECT
           percentile_cont(0.5) WITHIN GROUP (ORDER BY s.ppm2) AS seg_median_ppm2,
           COUNT(s.ppm2) AS seg_n
         FROM base s
         WHERE s.ppm2 IS NOT NULL
           -- habitaciones ±${SEG_ROOMS_TOLERANCE} (both sides must know rooms).
           AND b.rooms IS NOT NULL AND s.rooms IS NOT NULL
           AND s.rooms BETWEEN b.rooms - ${SEG_ROOMS_TOLERANCE} AND b.rooms + ${SEG_ROOMS_TOLERANCE}
           -- m² band ±${Math.round(SEG_M2_BAND * 100)}% (both sides must know m²).
           AND b.m2_built IS NOT NULL AND b.m2_built > 0
           AND s.m2_built IS NOT NULL
           AND s.m2_built BETWEEN b.m2_built * ${1 - SEG_M2_BAND} AND b.m2_built * ${1 + SEG_M2_BAND}
           -- ground floor only ever compares against ground floor.
           AND s.is_ground_floor = b.is_ground_floor
       ) seg ON true
     ),
     ranked AS (
       SELECT
         base.*,
         -- #416: carried through ranked.* onto CandidateRow. LEFT JOIN + the
         -- COALESCE default means a property with no active-source listing row
         -- (shouldn't happen for a matched candidate, but degrade safely)
         -- reads as "not new" rather than NULL. Deliberately NOT part of
         -- effective_score or the ORDER BY — novelty is presentation only in
         -- phase 1 (fresh-first ordering is phase 3).
         COALESCE(nov.is_new, false) AS is_new,
         -- #420: the signed price-change fraction since the visit anchor, or NULL
         -- when the property's price did not move since then. Presentation only —
         -- deliberately NOT part of effective_score or the ORDER BY (fresh-first
         -- ordering is phase 3). The sanity band is applied downstream in TS.
         pm.delta_pct AS price_delta_pct,
         -- #425 (plan #415 §3.2): the LEADING sort tier. See noveltyTierExpr —
         -- effective_score is untouched, the tier is a separate key. Carried
         -- through ranked.* so all three call sites (list ORDER BY + cursor,
         -- getAdjacentCandidates) order on the SAME (novelty_tier, effective_
         -- score, property_id) key and prev/next can never desync from the feed.
         ${noveltyTierExpr(params)} AS novelty_tier,
         -- #452: per-property timing signals carried through ranked.* so the
         -- detail-page investor-score breakdown (getPropertyInvestorScore) can
         -- read them; the feed doesn't select these, but exposing them keeps the
         -- breakdown reading the SAME values that fed the boost (derive-once).
         tim.days_on_market,
         tim.price_drop_pct,
         -- #461: which comparison base drove the discount (segment vs pool), and
         -- the comparable count behind it — carried through ranked.* so the card
         -- chip tooltip and the detail breakdown can explain the number.
         seg.below_market_base,
         seg.comp_n AS below_market_comparables,
         -- #461: the signed discount vs the CHOSEN comparison median (the
         -- like-for-like segment's when it qualifies, else the whole-pool's —
         -- resolved once in segmented). Positive = cheaper than comparables.
         -- Uncapped/signed as before; the 50% cap (likely-m²-error guard) still
         -- lives in the boost below, unchanged.
         CASE
           WHEN base.ppm2 IS NOT NULL
                AND seg.comp_median_ppm2 IS NOT NULL AND seg.comp_median_ppm2 > 0
           THEN (seg.comp_median_ppm2 - base.ppm2) / seg.comp_median_ppm2
           ELSE NULL
         END AS below_market_pct,
         (
           COALESCE(base.score, ${NO_SCORE_SENTINEL})
           -- #461: below-market boost now reads the CHOSEN comparison median
           -- (segment or pool). The cap (${BELOW_MARKET_DISCOUNT_CAP}) and weight
           -- (${BELOW_MARKET_WEIGHT}) are UNCHANGED — only the underlying median
           -- improved, so MAX_TOTAL_BOOST and the never-scored floor still hold.
           + CASE
               WHEN base.ppm2 IS NOT NULL
                    AND seg.comp_median_ppm2 IS NOT NULL AND seg.comp_median_ppm2 > 0
               THEN LEAST(
                      GREATEST((seg.comp_median_ppm2 - base.ppm2) / seg.comp_median_ppm2, 0),
                      ${BELOW_MARKET_DISCOUNT_CAP}
                    ) * ${BELOW_MARKET_WEIGHT}
               ELSE 0
             END
           + LEAST(base.distress_level, ${DISTRESS_MAX_UNITS}) * ${DISTRESS_UNIT_WEIGHT}
           -- #392 soft beach boost (graded, non-negative → augments, never
           -- filters). frontline/sea_view/near_beach lift; none/NULL add 0.
           + (${beachBoostCase}) * ${BEACH_UNIT_WEIGHT}
           -- #398 soft tourist-licence boost (single boolean, non-negative →
           -- augments, never filters). A granted licence lifts; false/NULL add 0.
           + (${touristBoostCase})
           -- #452 timing boost (days-on-market + net price-drop, joint-capped at
           -- ${TIMING_JOINT_CAP}). Non-negative and degrades to 0 when both signals are
           -- absent, so the never-scored floor holds (see the ranking-blend note
           -- above for the recomputed ceiling).
           + (${timingBoostSql})
         ) AS effective_score
       -- pool is no longer joined here: the whole-pool median is now consumed
       -- only inside segmented (as the fallback base), which projects the
       -- chosen median/base/count per property. ranked reads that instead.
       FROM base
       LEFT JOIN segmented seg ON seg.property_id = base.property_id
       LEFT JOIN novelty nov ON nov.property_id = base.property_id
       LEFT JOIN price_moves pm ON pm.property_id = base.property_id
       LEFT JOIN timing tim ON tim.property_id = base.property_id
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
  beachProximity: string | null = null,
  touristLicense: boolean = false,
  daysOnMarket: number | null = null,
  priceDropPct: number | null = null,
): string | null {
  const parts: string[] = [];
  if (belowMarketPct !== null && belowMarketPct >= MIN_NOTABLE_DISCOUNT) {
    parts.push(
      `precio/m² ~${Math.round(belowMarketPct * 100)}% por debajo de la mediana de tus candidatos`,
    );
  }
  if (distressLevel > 0) {
    parts.push(
      "señales de oportunidad detectadas (ocupación / estado / cargas)",
    );
  }
  // #392: a positive beach grade lifts the ranking, so name it too (`none`/null
  // carries no boost, so it earns no mention — same "no reason on every card"
  // discipline as the signals above). Uses the axis's own Spanish badge label so
  // the reason and the card's badge read consistently.
  if (
    beachProximity !== null &&
    BEACH_PROXIMITY_LABELS[beachProximity] !== undefined
  ) {
    parts.push(
      `proximidad a la playa (${BEACH_PROXIMITY_LABELS[beachProximity].toLowerCase()})`,
    );
  }
  // #398: a granted tourist licence lifts the ranking, so name it too (its
  // absence carries no boost and earns no mention — same "no reason on every
  // card" discipline). is_vpo is a hard filter, not a boost, so it never
  // appears here.
  if (touristLicense) {
    parts.push("licencia turística concedida");
  }
  // #452: the two timing signals also lift the ranking, so name them when
  // notable. A short time on market or no drop carries a negligible boost and
  // earns no mention (same "no reason on every card" discipline as above).
  if (daysOnMarket !== null && daysOnMarket >= MIN_NOTABLE_DAYS_ON_MARKET) {
    parts.push(`lleva ~${Math.round(daysOnMarket)} días en el mercado`);
  }
  if (priceDropPct !== null && priceDropPct >= MIN_NOTABLE_DISCOUNT) {
    parts.push(
      `el precio ha bajado ~${Math.round(priceDropPct * 100)}% desde que se publicó`,
    );
  }
  if (parts.length === 0) return null;
  return `Destacado: ${parts.join("; ")}.`;
}

/** A time-on-market only worth NAMING in the explanation once it clears this — shorter reads as an ordinary fresh listing, not a motivated seller. */
const MIN_NOTABLE_DAYS_ON_MARKET = 60;

/**
 * The three price-change presentation fields the card renders, all derived from
 * one signed delta and the configured sanity band (#420, plan #415 §3.3).
 */
export interface PriceChangeSignal {
  /** Badge-worthy: a real move whose `|delta|` is within the sanity band. */
  price_changed: boolean;
  /** Signed change fraction, carried RAW (band not applied) so suspects keep it for data-health; null when no move since the anchor. */
  price_delta_pct: number | null;
  /** `"drop"` (BAJADA) / `"up"` (SUBIDA) / null — non-null exactly when `price_changed`. */
  price_direction: "drop" | "up" | null;
}

/**
 * Applies the mandatory sanity band (plan §3.3, grounded in §2.0a: 1 of 10 demo
 * changes is a −96% artifact, 1 is a −0,1% non-event) to a raw price-change
 * delta from the `price_moves` CTE. Pure and exported so the "just-under 1% /
 * just-over 60% / mid-range" behaviour is unit-testable directly (the SQL only
 * measures the move; this decides whether it badges).
 *
 * `minFrac`/`maxFrac` are FRACTIONS (0.01 / 0.60 for the 1%/60% defaults). A
 * move is badge-worthy when `|delta|` is within `[minFrac, maxFrac]` inclusive:
 * below `minFrac` is noise (no badge), above `maxFrac` is a suspect data
 * artifact (no badge, excluded from alerts too — phase 5). The raw `delta` is
 * always carried through so a data-health view can surface suspects instead of
 * dropping them silently. Direction is `sign(delta)`: negative = BAJADA (a drop,
 * good for a buyer), positive = SUBIDA.
 */
export function classifyPriceChange(
  delta: number | null,
  minFrac: number,
  maxFrac: number,
): PriceChangeSignal {
  if (delta === null || !Number.isFinite(delta)) {
    return {
      price_changed: false,
      price_delta_pct: null,
      price_direction: null,
    };
  }
  const abs = Math.abs(delta);
  const withinBand = abs >= minFrac && abs <= maxFrac;
  return {
    price_changed: withinBand,
    price_delta_pct: delta,
    price_direction: withinBand ? (delta < 0 ? "drop" : "up") : null,
  };
}

/**
 * Reads the feed price-change sanity band from config (env > config.yaml >
 * default), as FRACTIONS ready for {@link classifyPriceChange}. Defaults 1%/60%
 * (`feed.price_change_min_pct` / `feed.price_change_max_pct`).
 */
function readPriceChangeBand(): { minFrac: number; maxFrac: number } {
  const minPct = readIntInRange(
    "feed.price_change_min_pct",
    "FEED_PRICE_CHANGE_MIN_PCT",
    1,
    0,
    100,
  );
  const maxPct = readIntInRange(
    "feed.price_change_max_pct",
    "FEED_PRICE_CHANGE_MAX_PCT",
    60,
    1,
    100,
  );
  return { minFrac: minPct / 100, maxFrac: maxPct / 100 };
}

interface CandidateCursor {
  /** #425: leading sort tier (0/1), the FIRST keyset column. */
  tier: number;
  score: number;
  id: number;
  /**
   * #425: the visit anchor resolved on page 1, threaded so every later page
   * re-tiers against the SAME timestamp — a mid-session shift can't move the
   * cursor's partition (plan §3.2). ISO-8601 UTC string.
   */
  anchorTs: string;
  /**
   * #425: the cold-start suppression decision resolved on page 1, threaded so
   * it can't flip mid-pagination (which would re-tier rows and duplicate/skip
   * across the boundary).
   */
  coldStart: boolean;
}

/**
 * #425: the keyset cursor is now a THREE-column lexicographic key
 * `(novelty_tier, effective_score, property_id)` (was two: score, id), because
 * the feed's leading sort key is the novelty tier. It additionally carries the
 * session-fixed `anchorTs` + `coldStart` so page 2+ re-runs the ranking against
 * the exact same anchor and suppression decision page 1 used (plan §3.2 anchor
 * stability). A cursor from the old 2-element shape decodes to null (rejected as
 * invalid → 400), which is correct: the sort key changed, so an old cursor can't
 * resume the new scan (no back-compat needed per the single-deployment rule).
 */
function encodeCursor(
  tier: number,
  score: number | null,
  id: number,
  anchorTs: string,
  coldStart: boolean,
): string {
  const effectiveScore = score ?? NO_SCORE_SENTINEL;
  return Buffer.from(
    JSON.stringify([tier, effectiveScore, id, anchorTs, coldStart]),
  ).toString("base64url");
}

/** Returns null on any malformed input — callers should treat that as an invalid cursor (400), not silently fall back to page 1. */
export function decodeCursor(raw: string): CandidateCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 5 &&
      typeof parsed[0] === "number" &&
      Number.isInteger(parsed[0]) &&
      typeof parsed[1] === "number" &&
      Number.isFinite(parsed[1]) &&
      typeof parsed[2] === "number" &&
      Number.isInteger(parsed[2]) &&
      parsed[2] > 0 &&
      typeof parsed[3] === "string" &&
      !Number.isNaN(Date.parse(parsed[3])) &&
      typeof parsed[4] === "boolean"
    ) {
      return {
        tier: parsed[0],
        score: parsed[1],
        id: parsed[2],
        anchorTs: parsed[3],
        coldStart: parsed[4],
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * #425 (plan #415 §3.2): resolves the two session-fixed values the fresh-first
 * ordering needs — the visit anchor timestamp and the cold-start suppression
 * decision — in ONE round-trip. Resolved once per paging session (page 1 of
 * `listCandidates`, and every `getAdjacentCandidates` call) and then threaded
 * as bound values so the tier is stable across pages and the detail page's
 * prev/next tiers identically to the list it was paged from.
 *
 * Cold-start is on when the profile was NEVER visited (previous_viewed_at NULL)
 * OR the RAW novelty tier would cover more than `coverage_pct` of the matched
 * pool (default 60%) — the "brand-new profile where everything is new" flood the
 * plan (§2.0b) grounds in profile 347 marking 429/431 rows. The coverage count
 * runs the shared ranked CTE with the tier UN-suppressed (coldStartParam=false)
 * so it measures what the tier WOULD cover; the `sp` CTE feeds the anchor into
 * that same query via a scalar sub-select, avoiding a second round-trip.
 */
async function resolveNoveltyContext(
  profileId: number,
  minFrac: number,
  maxFrac: number,
): Promise<{ anchorTs: string; coldStart: boolean }> {
  const coveragePct = readIntInRange(
    "feed.cold_start_coverage_pct",
    "FEED_COLD_START_COVERAGE_PCT",
    60,
    1,
    100,
  );
  const rows = await sql<{
    anchor_ts: string;
    never_visited: boolean;
    total: number;
    fresh: number;
  }>(
    `WITH sp AS (
       SELECT COALESCE(previous_viewed_at, created_at - interval '1 day') AS anchor_ts,
              (previous_viewed_at IS NULL) AS never_visited
         FROM search_profile
        WHERE id = $1
     ),
     ${rankedCandidatesCte({
       warnParam: "$2",
       anchorParam: "(SELECT anchor_ts FROM sp)",
       bandMinParam: "$3",
       bandMaxParam: "$4",
       // Measure the RAW tier: no suppression, so `fresh` is what the tier WOULD
       // cover before this very decision is made.
       coldStartParam: "false",
     })}
     SELECT
       (SELECT anchor_ts FROM sp) AS anchor_ts,
       (SELECT never_visited FROM sp) AS never_visited,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE novelty_tier = 1)::int AS fresh
     FROM ranked`,
    [profileId, WARN_CAVEAT_CODES, minFrac, maxFrac],
  );
  // Profile missing (shouldn't happen — callers check first) → safe defaults:
  // anchor "now" (nothing new) and no suppression.
  if (rows.length === 0) {
    return { anchorTs: new Date().toISOString(), coldStart: false };
  }
  const { anchor_ts, never_visited, total, fresh } = rows[0];
  const coverage = total > 0 ? fresh / total : 0;
  const coldStart = never_visited === true || coverage > coveragePct / 100;
  return {
    anchorTs: new Date(anchor_ts).toISOString(),
    coldStart,
  };
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
  /** #416 novelty mark — boolean straight from the `ranked` CTE. */
  is_new: boolean;
  /** #425 leading sort tier (0/1) from the `ranked` CTE — the first keyset column, folded into the cursor. Not surfaced on `CandidateRow` (the card renders novelty from `is_new`/price fields); this is purely the pagination key. */
  novelty_tier: number;
  /** #420 raw signed price-change fraction since the visit anchor (NUMERIC → string); null when the price did not move since then. Sanity band applied in TS (classifyPriceChange). */
  price_delta_pct: string | null;
  listings: CandidateListingSummary[];
  score: string | null;
  rank_explanation: string | null;
  score_kind: "cold_start" | "trained" | null;
  /** Blended sort key (#309) — pg NUMERIC/double, arrives as a string. */
  effective_score: string | null;
  /** Signed discount fraction vs the CHOSEN comparison median price/m² (#309/#461), NUMERIC as a string; null when there was no comparison (no price/m², or even the pool too small). */
  below_market_pct: string | null;
  /** #461: which base produced below_market_pct — 'segment' / 'pool' / null. */
  below_market_base: "segment" | "pool" | null;
  /** #461: comparable count behind below_market_pct (segment size or pool count); a plain int, null when no comparison. */
  below_market_comparables: number | null;
  /** 0–3 distress axes flagged (#309); a plain int. */
  distress_level: number;
  /** #392: graded beach proximity from the latest `location` row; null when unassessed or `none`. Feeds the ranking-boost reason (the badge itself comes from loadFlags). */
  beach_proximity: string | null;
  /** #398: whether the latest `opportunity` row found a granted tourist licence; null when unassessed. Feeds the ranking-boost reason (the badge itself comes from loadFlags). */
  tourist_license: boolean | null;
  /** #452: frozen days-on-market for the property's representative listing (NUMERIC → string); null when unknown. Feeds the timing boost's ranking-boost reason. */
  days_on_market: string | null;
  /** #452: net price-drop fraction since first listed for that representative listing (NUMERIC → string); null when no drop data. Positive = price fell. */
  price_drop_pct: string | null;
  /** Current verdict (#379), already `clear`-collapsed-to-null in SQL; null when none. */
  feedback_state: StateFeedbackType | null;
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
export function flagsFromAssessments(
  rows: RawAssessmentRow[],
): CandidateFlag[] {
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
      if (label !== undefined)
        flags.push({ kind: `caveat:${code}`, label, tone: "warn" });
    }

    // #26's condition assessment (lib/ai-assessment/condition.ts) writes a
    // flat `result.condition` string (single axis — no nested `verdict`
    // object like occupancy's three). `reformado`/`unclear` are the
    // unremarkable/no-info defaults and intentionally have no label below,
    // same as occupancy's `pleno_dominio` getting no caveat badge.
    const condition =
      typeof result.condition === "string" ? result.condition : null;
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
          condition === "a_reformar"
            ? RENOVATION_SEVERITY_LABELS[String(result.renovation_severity)]
            : undefined;
        if (severity !== undefined) {
          flags.push({
            kind: `condition:a_reformar:${result.renovation_severity}`,
            label: `${label} (${severity})`,
            tone: "neutral",
          });
        } else {
          flags.push({
            kind: `condition:${condition}`,
            label,
            tone: "neutral",
          });
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
      const description =
        typeof o.description === "string" && o.description.trim() !== ""
          ? o.description
          : undefined;
      flags.push({ kind: `redflag:${type}`, label, tone: "warn", description });
    }

    // #388 location: two neutral-tone location signals derived from the advert
    // text (lib/ai-assessment/location.ts). `beach_proximity` is a graded enum
    // (`frontline`/`sea_view`/`near_beach`/`none`) — `none` carries no badge,
    // same "no badge on every card" rule as the axes above. `heritage_zone` is
    // a boolean → the "Casco histórico" badge only when true. Both are closed
    // vocabularies validated at the writer; an unmapped value is dropped, never
    // shown as raw text.
    const beachProximity =
      typeof result.beach_proximity === "string"
        ? result.beach_proximity
        : null;
    if (beachProximity !== null) {
      const label = BEACH_PROXIMITY_LABELS[beachProximity];
      if (label !== undefined) {
        flags.push({
          kind: `location:beach:${beachProximity}`,
          label,
          tone: "neutral",
        });
      }
    }
    if (result.heritage_zone === true) {
      flags.push({
        kind: "location:heritage_zone",
        label: HERITAGE_ZONE_LABEL,
        tone: "neutral",
      });
    }

    // #398 opportunity: two booleans derived from the advert text
    // (lib/ai-assessment/opportunity.ts). `is_vpo` is a MATERIAL restriction on
    // what you can buy and at what resale price → a warn-tone badge, like the
    // ownership/transaction caveats above. `tourist_license` is a positive fact
    // (the property can already operate as a VUT) → neutral. Both render only
    // when strictly true (evidence-guarded at the writer); anything else drops.
    if (result.is_vpo === true) {
      flags.push({
        kind: "opportunity:is_vpo",
        label: IS_VPO_LABEL,
        tone: "warn",
      });
    }
    if (result.tourist_license === true) {
      flags.push({
        kind: "opportunity:tourist_license",
        label: TOURIST_LICENSE_LABEL,
        tone: "neutral",
      });
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
async function loadFlags(
  propertyIds: number[],
): Promise<Map<number, CandidateFlag[]>> {
  const byProperty = new Map<number, CandidateFlag[]>();
  if (propertyIds.length === 0) return byProperty;

  let rows: RawAssessmentRow[];
  try {
    rows = await sql<RawAssessmentRow>(
      `SELECT DISTINCT ON (property_id, assessment_type)
              property_id, result
         FROM ai_assessment
        WHERE property_id = ANY($1::bigint[])
          AND assessment_type IN ('occupancy', 'condition', 'redflags', 'location', 'opportunity')
        ORDER BY property_id, assessment_type, generated_at DESC NULLS LAST, id DESC`,
      [propertyIds],
    );
  } catch (err) {
    console.warn(
      "[candidates] ai_assessment unavailable, rendering without flags:",
      err,
    );
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
 * Keyset (cursor) pagination on `(novelty_tier DESC, effective_score DESC,
 * property.id DESC)` (#425 fresh-first — the tier leads; #309 blended score
 * within a tier), not OFFSET — this table is expected to grow into the thousands (issue #19
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
    /**
     * #379: include candidates whose current verdict is `reject`. Default
     * false — the feed hides rejected properties, so a reject "removes" a card
     * only on the NEXT fetch, not on click. The show-rejected toggle passes
     * true to surface them (still marked, still un-rejectable).
     */
    includeRejected?: boolean;
    /**
     * #422: restrict the feed to a single verdict — the "En seguimiento"
     * working set. `"accept"` keeps ONLY tracked (accepted) properties; `null`
     * / omitted = no verdict filter (default feed). Mirrors the
     * `includeRejected` convention (a verdict-scoped view, opt-in from the UI).
     */
    state?: StateFeedbackType | null;
  } & CandidateFilters = {},
): Promise<CandidatePage> {
  const limit = Math.min(
    Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1),
    MAX_LIMIT,
  );
  const rawCursor = opts.cursor ?? null;
  const includeRejected = opts.includeRejected === true;
  // #422 "En seguimiento" working-set filter. Only 'accept' is a valid verdict
  // scope today (reject has its own includeRejected path); anything else
  // collapses to null ("off"), so an untouched call is byte-identical to before.
  const stateFilter: StateFeedbackType | null =
    opts.state === "accept" ? "accept" : null;

  // #310 hard filters (D-059). Each normalises to null ("no filter") when
  // unset, so an untouched call behaves exactly as before. Validation of the
  // enum membership happens at the API boundary; here we only guard the
  // below-market threshold against a non-finite/negative value (a silent
  // no-op filter would be worse than passing null through).
  const occupancy: OccupancyFilter | null = opts.occupancy ?? null;
  const condition: ConditionFilter | null = opts.condition ?? null;
  const renovation: RenovationFilter | null = opts.renovation ?? null;
  const minBelowMarketPct: number | null =
    typeof opts.minBelowMarketPct === "number" &&
    Number.isFinite(opts.minBelowMarketPct)
      ? opts.minBelowMarketPct
      : null;
  // #386 caveat / redflag-type filters. Closed-vocabulary tokens validated at
  // the API boundary; normalise to null ("off") here so an untouched call is
  // byte-identical to before.
  const caveat: CaveatFilter | null = opts.caveat ?? null;
  const redflagType: RedflagTypeFilter | null = opts.redflagType ?? null;
  // #392 beach/heritage filters. Closed-vocabulary token validated at the API
  // boundary; normalise to null ("off") here. heritageZone is a toggle — false/
  // undefined collapse to null so the "all filters off" param tail stays uniform
  // and the SQL `IS NOT TRUE` guard treats it as off.
  const beachProximity: BeachProximityFilter | null =
    opts.beachProximity ?? null;
  const heritageZone: true | null = opts.heritageZone === true ? true : null;
  // #398 VPO filter — BIDIRECTIONAL, so a strict boolean/null tri-state: true =
  // only VPO, false = exclude VPO, null = off. Only an explicit boolean turns it
  // on; undefined collapses to null so the "all filters off" tail stays uniform.
  const isVpo: boolean | null =
    typeof opts.isVpo === "boolean" ? opts.isVpo : null;
  // #466 "Con alertas" UNION toggle. Like heritageZone, only an explicit true
  // turns it on; false/undefined collapse to null ("off") so the SQL `IS NOT
  // TRUE` guard treats it as off and the param tail stays uniform.
  const hasAlerts: true | null = opts.hasAlerts === true ? true : null;
  // #470 free-text search term. Trimmed; empty/whitespace collapses to null
  // ("off") so an untouched call is byte-identical to before and the SQL guard
  // ($25 IS NULL) skips the FTS EXISTS entirely. Length is bounded at the API
  // boundary (>200 → 400); here we only normalise. The value is always bound as
  // a parameter to websearch_to_tsquery, never interpolated.
  const q: string | null =
    typeof opts.q === "string" && opts.q.trim() !== "" ? opts.q.trim() : null;
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
  const source =
    sourceRaw !== null && sourceRaw.trim() !== "" ? sourceRaw.trim() : null;

  // #420/#425 price-change sanity band, read once (env > config.yaml > default
  // 1%/60%). Feeds BOTH the TS classifier (per-row badge) and the SQL tier's
  // price_changed arm, so a row tiers up exactly when it also badges.
  const priceBand = readPriceChangeBand();

  // #425 keyset key is now (novelty_tier, effective_score, property_id). The
  // cursor also carries the session-fixed anchor + cold-start decision (plan
  // §3.2): resolved ONCE on page 1 and threaded, so a mid-session anchor shift
  // can't re-tier rows and land the cursor in the wrong partition.
  let cursorTier: number | null = null;
  let cursorScore: number | null = null;
  let cursorId: number | null = null;
  let anchorTs: string;
  let coldStart: boolean;
  if (rawCursor !== null) {
    const decoded = decodeCursor(rawCursor);
    if (decoded === null) {
      throw new Error("Cursor no válido.");
    }
    cursorTier = decoded.tier;
    cursorScore = decoded.score;
    cursorId = decoded.id;
    // Page 2+: reuse the anchor + suppression decision page 1 resolved.
    anchorTs = decoded.anchorTs;
    coldStart = decoded.coldStart;
  } else {
    // Page 1: resolve the anchor + cold-start decision once for this session.
    const ctx = await resolveNoveltyContext(
      profileId,
      priceBand.minFrac,
      priceBand.maxFrac,
    );
    anchorTs = ctx.anchorTs;
    coldStart = ctx.coldStart;
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
    `WITH ${rankedCandidatesCte({
      warnParam: "$6",
      anchorParam: "$20",
      bandMinParam: "$21",
      bandMaxParam: "$22",
      coldStartParam: "$23::boolean",
    })}
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
       -- #416 novelty mark, derived in the ranked CTE against the visit anchor
       -- (same first_seen_at basis as the column just above). Projected here so
       -- the card can render its NUEVO badge from the row directly.
       ranked.is_new,
       -- #425 leading sort tier — projected so the cursor can carry the last
       -- row's tier for the 3-column keyset resume (not rendered on the card).
       ranked.novelty_tier,
       -- #420 raw price-change delta since the visit anchor, derived in the
       -- price_moves CTE (same anchor as is_new). The sanity band that decides
       -- whether it badges is applied in TS below (classifyPriceChange).
       ranked.price_delta_pct,
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
       -- #461: the like-for-like comparison base + comparable count, so the
       -- card's price chip can explain "comparado con N similares" vs "mediana
       -- del perfil" without re-querying.
       ranked.below_market_base,
       ranked.below_market_comparables,
       ranked.distress_level,
       ranked.beach_proximity,
       -- #452 timing signals derived in the timing CTE — carried onto the row
       -- so the card's ranking_boost_reason can name a long time on market / a
       -- cumulative price drop (the boost itself is already folded into
       -- effective_score above).
       ranked.days_on_market,
       ranked.price_drop_pct,
       -- Current accept/reject verdict (#379/#422), derived in the base CTE
       -- (clear already collapsed to NULL). Projected here so the card renders
       -- its marked state (accept pressed, or the "Descartada" treatment for
       -- reject) after a reload/fetch. Without this the row omits the column,
       -- r.feedback_state is undefined, and every card reads as unmarked even
       -- though the reject-exclusion WHERE below reads the same value correctly.
       ranked.feedback_state,
       ranked.tourist_license,
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
     -- #425 THREE-column keyset resume on (novelty_tier, effective_score,
     -- property_id) — the same key the ORDER BY sorts on and the cursor carries.
     -- $19 (tier) NULL = page 1 (no cursor). Lexicographic: a strictly-lower
     -- tier, or equal tier + lower score, or equal tier+score + lower id.
     WHERE (
         $19::int IS NULL
         OR ranked.novelty_tier < $19::int
         OR (ranked.novelty_tier = $19::int AND ranked.effective_score < $2::double precision)
         OR (
              ranked.novelty_tier = $19::int
              AND ranked.effective_score = $2::double precision
              AND ranked.property_id < $3::bigint
            )
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
       -- Reject exclusion (#379). $12 = false (default): a candidate whose
       -- current verdict is 'reject' drops out of the feed — so the card the
       -- user just rejected disappears on the NEXT fetch, not on click. $12 =
       -- true (show-rejected toggle): rejected candidates stay in, rendered
       -- marked. A NULL/accept feedback_state always survives.
       AND ($12::boolean = true OR ranked.feedback_state IS DISTINCT FROM 'reject')
       -- #422 "En seguimiento" working-set filter ($18). NULL = off (default
       -- feed, all verdicts). 'accept' = keep ONLY tracked (accepted)
       -- properties — the follow/track working set. Reads the same
       -- ranked.feedback_state the reject exclusion above uses (star/clear
       -- already collapsed to NULL in the base CTE), so a legacy-starred or
       -- cleared property is correctly excluded from the seguimiento view.
       AND ($18::text IS NULL OR ranked.feedback_state = $18::text)
       -- #386 caveat filter ($13). Keep only candidates whose derived occupancy
       -- caveats include this code. NULL caveats (occupancy never assessed) makes
       -- the ANY comparison evaluate to NULL, so the row is excluded (unknown,
       -- never a false pass) — the same graceful degradation the occupancy/
       -- condition filters give today.
       AND ($13::text IS NULL OR $13 = ANY(ranked.caveats))
       -- #386 redflag-type filter ($14). Keep only candidates carrying a redflag
       -- of this type. NULL redflag_types (redflags never assessed) → excluded.
       AND ($14::text IS NULL OR $14 = ANY(ranked.redflag_types))
       -- #392 beach-proximity MINIMUM-GRADE hard filter ($15). frontline → only
       -- primera línea; sea_view → frontline OR sea_view; near_beach → any of the
       -- three. Reads ranked.beach_proximity (the CTE's per-axis column from the
       -- latest location row — D-059, never a separate JOIN). NULL (location
       -- unassessed) and 'none' (assessed, no signal) match nothing → excluded,
       -- never a false pass — same graceful degradation as the other assessment
       -- filters until the LLM populates the axis in this deployment.
       AND (
         $15::text IS NULL
         OR ($15 = 'frontline' AND ranked.beach_proximity = 'frontline')
         OR ($15 = 'sea_view' AND ranked.beach_proximity IN ('frontline', 'sea_view'))
         OR ($15 = 'near_beach' AND ranked.beach_proximity IN ('frontline', 'sea_view', 'near_beach'))
       )
       -- #392 heritage-zone hard filter ($16). true → keep only casco-histórico
       -- candidates. IS NOT TRUE passes when the filter is off (NULL/false); when
       -- on, a NULL heritage_zone (location unassessed) or false is excluded
       -- (unknown, never a false pass).
       AND ($16::boolean IS NOT TRUE OR ranked.heritage_zone = true)
       -- #398 VPO hard filter ($17) — BIDIRECTIONAL. NULL param = off. true →
       -- keep only VPO (ranked.is_vpo = true); false → keep only non-VPO
       -- (ranked.is_vpo = false). A NULL is_vpo (opportunity unassessed) yields
       -- NULL from the equality in EITHER direction, so it is excluded (unknown,
       -- never a false pass) — the same graceful degradation the other
       -- assessment filters give until the LLM populates the axis.
       AND ($17::boolean IS NULL OR ranked.is_vpo = $17::boolean)
       -- #466 "Con alertas" UNION hard filter ($24). Keep only candidates the
       -- operator sees a warn badge on: ≥1 red flag (of ANY type) OR ≥1 warn-tone
       -- occupancy caveat. Reads the SAME per-axis arrays the #386 caveat/
       -- redflagType filters read (D-059, no new JOIN); the warn-caveat set reuses
       -- the $6 array the distress boost already reads, so the two can't drift.
       -- IS NOT TRUE passes when the toggle is off (NULL). When on, a never-
       -- assessed property (both arrays NULL) is EXCLUDED: cardinality(COALESCE(
       -- redflag_types,'{}'))=0 is false and the NULL-array overlap is NULL, so
       -- the OR is false/NULL and the row is excluded, never a false pass (same
       -- graceful degradation as the other assessment filters, coherent with
       -- #310/#386). Composes (AND) with redflagType and every other filter.
       AND (
         $24::boolean IS NOT TRUE
         OR cardinality(COALESCE(ranked.redflag_types, '{}')) > 0
         OR ranked.caveats && $6::text[]
       )
       -- #470 free-text search ($25). NULL = off (default feed, byte-identical to
       -- before). When set, keep only candidates whose materialized search
       -- document matches the query. Applied in the OUTER query (like source/#310
       -- filters — never inside pool, so it can't move the below-market median);
       -- the (novelty_tier, effective_score, property_id) keyset key and cursor
       -- are untouched — this is a FILTER, not a re-sort (owner decision 1). The
       -- term is bound to websearch_to_tsquery, NEVER interpolated (it digests any
       -- input without error); the GIN index on property_search_doc serves the
       -- @@ probe. The doc is GLOBAL per property (all active listings, all
       -- sources); per-source visibility stays governed by the ranked CTE (D-055).
       AND (
         $25::text IS NULL
         OR EXISTS (
           SELECT 1
             FROM property_search_doc psd
            WHERE psd.property_id = ranked.property_id
              AND psd.doc @@ websearch_to_tsquery('es_unaccent', $25::text)
         )
       )
     -- #425 fresh-first: novelty tier leads, then the #309 blended score, then
     -- id as the deterministic tiebreak. MUST match the keyset WHERE above AND
     -- getAdjacentCandidates' ordering, or prev/next silently desyncs (D-057 cl.4).
     ORDER BY ranked.novelty_tier DESC, ranked.effective_score DESC, ranked.property_id DESC
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
      includeRejected,
      caveat,
      redflagType,
      beachProximity,
      heritageZone,
      isVpo,
      stateFilter,
      // #425 keyset tier ($19) + the session-fixed threading: anchor ($20),
      // sanity band ($21/$22 — same fractions the TS classifier uses), and the
      // cold-start suppression decision ($23). All resolved once (page 1) and
      // carried in the cursor thereafter.
      cursorTier,
      anchorTs,
      priceBand.minFrac,
      priceBand.maxFrac,
      coldStart,
      // #466 "Con alertas" UNION toggle ($24). Reuses the $6 WARN_CAVEAT_CODES
      // array in its predicate — only this boolean is new.
      hasAlerts,
      // #470 free-text search term ($25). NULL = off; otherwise bound verbatim
      // to websearch_to_tsquery in the OUTER WHERE's FTS EXISTS (never interpolated).
      q,
    ],
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const flagsByProperty = await loadFlags(pageRows.map((r) => r.property_id));

  const items: CandidateRow[] = pageRows.map((r) => {
    // #425 cold-start: when the tier is suppressed (profile never visited, or
    // >60% of the pool would tier as new), don't highlight the whole feed —
    // suppress the per-card NUEVO / BAJADA-SUBIDA marks too and let the
    // "Perfil nuevo: todo es reciente" note stand in (plan §1.1 / §3.2). Tracked
    // (accept) properties are exempt, exactly as they are from the tier itself.
    const suppressNovelty = coldStart && r.feedback_state !== "accept";
    return {
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
      is_new: !suppressNovelty && r.is_new === true,
      // #420 price-change signal + BAJADA/SUBIDA direction, sanity band applied
      // (suppressed under cold-start alongside is_new, above).
      ...classifyPriceChange(
        suppressNovelty
          ? null
          : r.price_delta_pct != null
            ? Number(r.price_delta_pct)
            : null,
        priceBand.minFrac,
        priceBand.maxFrac,
      ),
      listings: r.listings,
      score: r.score !== null ? Number(r.score) : null,
      rank_explanation: r.rank_explanation,
      score_kind: r.score_kind ?? null,
      effective_score:
        r.effective_score != null ? Number(r.effective_score) : null,
      below_market_pct:
        r.below_market_pct != null ? Number(r.below_market_pct) : null,
      below_market_base: r.below_market_base ?? null,
      below_market_comparables: r.below_market_comparables ?? null,
      distress_level: r.distress_level ?? 0,
      ranking_boost_reason: describeRankingBoost(
        r.below_market_pct != null ? Number(r.below_market_pct) : null,
        r.distress_level ?? 0,
        r.beach_proximity ?? null,
        r.tourist_license === true,
        r.days_on_market != null ? Number(r.days_on_market) : null,
        r.price_drop_pct != null ? Number(r.price_drop_pct) : null,
      ),
      feedback_state: r.feedback_state ?? null,
    };
  });

  // Cursor is derived from the *last row of the SQL result*, which is already
  // in final (effective_score, id) DESC order (#309) — there is no separate
  // client-side re-sort of `pageRows` to accidentally derive it from afterward
  // (that was the bug: a previous version sorted `pageRows` by score for
  // display *after* the cursor should have been captured from the id-ordered
  // fetch, corrupting the keyset scan). The keyset key is now the blended
  // `effective_score`, matching the ORDER BY above.
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore
    ? encodeCursor(
        // #425: the last row's tier + score + id (the 3-column keyset key), plus
        // the session-fixed anchor + cold-start decision so the next page tiers
        // against the exact same values (plan §3.2 anchor stability).
        lastRow.novelty_tier,
        lastRow.effective_score != null
          ? Number(lastRow.effective_score)
          : null,
        lastRow.property_id,
        anchorTs,
        coldStart,
      )
    : null;

  return { items, nextCursor, coldStart };
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
export async function listCandidateSources(
  profileId: number,
): Promise<string[]> {
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
 *   - It reuses the exact `(novelty_tier DESC, effective_score DESC, id DESC)` ordering (the same
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
 *
 * **Content filters (incl. #470 `q`) are NOT threaded here.** prev/next already
 * ignores every content filter the feed applies — `source`, occupancy,
 * condition, playa, the #386/#392/#398 assessment filters — and honours only
 * `includeRejected`; a user who filters the list and opens a card navigates the
 * GLOBAL ordering. The #470 free-text `q` follows that exact precedent and is
 * deliberately not applied to the adjacency. If this ever grates in practice,
 * the correct fix is a follow-up that threads ALL filters through the adjacency
 * uniformly (owner decision 5), not `q` in isolation.
 */
export async function getAdjacentCandidates(
  profileId: number,
  propertyId: number,
  // #417: mirrors the feed's "Mostrar descartadas" toggle. Default false hides
  // rejected neighbours (so prev/next matches the default feed). true keeps
  // them, so prev/next steps through rejected cards in the SAME order as the
  // show-rejected list the user is paging through — no desync.
  includeRejected = false,
): Promise<AdjacentCandidates> {
  // #425 (D-057 clause 4 — the call site "most likely to be forgotten"):
  // prev/next MUST order on the SAME 3-column key the feed does
  // (novelty_tier, effective_score, property_id), or the detail page steps
  // through candidates in a different order than the list — a SILENT desync.
  // So the novelty context (anchor + cold-start) is resolved live here exactly
  // as listCandidates resolves it on page 1; within a browse session
  // previous_viewed_at is debounce-stable and the coverage doesn't move, so
  // this yields the same tiering the list used. This is the same "recomputed
  // live, not snapshotted" contract this function already documents for
  // effective_score (a retrain can move scores mid-browse either way).
  const priceBand = readPriceChangeBand();
  const { anchorTs, coldStart } = await resolveNoveltyContext(
    profileId,
    priceBand.minFrac,
    priceBand.maxFrac,
  );

  // The anchor's own tier + blended effective_score, read from the same CTE the
  // neighbours use — so the comparison key is byte-identical to the list's.
  const anchor = await sql<{
    novelty_tier: number;
    effective_score: string | null;
  }>(
    `WITH ${rankedCandidatesCte({
      warnParam: "$3",
      anchorParam: "$4",
      bandMinParam: "$5",
      bandMaxParam: "$6",
      coldStartParam: "$7::boolean",
    })}
     SELECT novelty_tier, effective_score FROM ranked WHERE property_id = $2`,
    [
      profileId,
      propertyId,
      WARN_CAVEAT_CODES,
      anchorTs,
      priceBand.minFrac,
      priceBand.maxFrac,
      coldStart,
    ],
  );
  if (anchor.length === 0) {
    return { prevPropertyId: null, nextPropertyId: null };
  }
  const anchorTier = anchor[0].novelty_tier;
  const anchorScore =
    anchor[0].effective_score != null
      ? Number(anchor[0].effective_score)
      : NO_SCORE_SENTINEL;

  // "next" = ranked after the anchor under the list's DESC ordering; "prev"
  // reverses both the comparison and the sort, then takes the nearest row. Both
  // use the 3-column lexicographic key ($6=anchorTier, $2=anchorScore,
  // $3=propertyId) and share one param array; the CTE params ($7 anchorTs,
  // $8/$9 band, $10 coldStart) thread the same tiering the anchor query used.
  const cteParams = {
    warnParam: "$4",
    anchorParam: "$7",
    bandMinParam: "$8",
    bandMaxParam: "$9",
    coldStartParam: "$10::boolean",
  };
  const adjacencyParams = [
    profileId,
    anchorScore,
    propertyId,
    WARN_CAVEAT_CODES,
    includeRejected,
    anchorTier,
    anchorTs,
    priceBand.minFrac,
    priceBand.maxFrac,
    coldStart,
  ];
  const [nextRows, prevRows] = await Promise.all([
    sql<{ property_id: number }>(
      `WITH ${rankedCandidatesCte(cteParams)}
       SELECT property_id
         FROM ranked
        WHERE (novelty_tier < $6::int
               OR (novelty_tier = $6::int AND effective_score < $2::double precision)
               OR (novelty_tier = $6::int AND effective_score = $2::double precision
                   AND property_id < $3::bigint))
          -- Skip rejected neighbours by default (#379) so prev/next matches the
          -- default feed the user paged through — never step onto a hidden card.
          -- $5 = true (show-rejected, #417) keeps them, so prev/next honours the
          -- same escape hatch as the feed and the two never desync.
          AND ($5::boolean = true OR feedback_state IS DISTINCT FROM 'reject')
        ORDER BY novelty_tier DESC, effective_score DESC, property_id DESC
        LIMIT 1`,
      adjacencyParams,
    ),
    sql<{ property_id: number }>(
      `WITH ${rankedCandidatesCte(cteParams)}
       SELECT property_id
         FROM ranked
        WHERE (novelty_tier > $6::int
               OR (novelty_tier = $6::int AND effective_score > $2::double precision)
               OR (novelty_tier = $6::int AND effective_score = $2::double precision
                   AND property_id > $3::bigint))
          AND ($5::boolean = true OR feedback_state IS DISTINCT FROM 'reject')
        ORDER BY novelty_tier ASC, effective_score ASC, property_id ASC
        LIMIT 1`,
      adjacencyParams,
    ),
  ]);

  return {
    nextPropertyId: nextRows.length > 0 ? nextRows[0].property_id : null,
    prevPropertyId: prevRows.length > 0 ? prevRows[0].property_id : null,
  };
}

/**
 * #448 F — the profile-scoped price signals the property DETAIL page shows next
 * to its header price: the below-market RATING (`below_market_pct`) and the
 * BAJADA/SUBIDA move since the visit anchor. Both are relative to THIS profile's
 * candidate pool / visit anchor, so they can't be computed by the
 * profile-agnostic `getPropertyDetail`; the detail API route calls this and
 * merges the result into the response.
 *
 * Reuses the shared `rankedCandidatesCte` verbatim (so the detail page's rating
 * can never disagree with the feed card's for the same property) and resolves
 * the visit anchor inline via the same `sp` sub-select pattern
 * `resolveNoveltyContext` uses — one round-trip. `coldStartParam:"false"`
 * because the detail page never tiers (it reads a single row's raw signals).
 * The sanity band is applied in TS by `classifyPriceChange`, exactly as
 * `listCandidates` does for the card.
 *
 * Returns null when the property isn't a ranked candidate of the profile (the
 * route already 404s that case, but this stays null-safe). Callers should treat
 * a throw as "no signals" — these are an enhancement, never worth failing the
 * detail page over.
 */
export interface PropertyMarketSignals {
  below_market_pct: number | null;
  /** #461: which base produced below_market_pct — 'segment' / 'pool' / null. */
  below_market_base: "segment" | "pool" | null;
  /** #461: comparable count behind below_market_pct (segment size or pool count); null when no comparison. */
  below_market_comparables: number | null;
  price_changed: boolean;
  price_delta_pct: number | null;
  price_direction: "drop" | "up" | null;
}

export async function getPropertyMarketSignals(
  profileId: number,
  propertyId: number,
): Promise<PropertyMarketSignals | null> {
  const { minFrac, maxFrac } = readPriceChangeBand();
  const rows = await sql<{
    below_market_pct: string | null;
    below_market_base: "segment" | "pool" | null;
    below_market_comparables: number | null;
    price_delta_pct: string | null;
  }>(
    `WITH sp AS (
       SELECT COALESCE(previous_viewed_at, created_at - interval '1 day') AS anchor_ts
         FROM search_profile
        WHERE id = $1
     ),
     ${rankedCandidatesCte({
       warnParam: "$2",
       anchorParam: "(SELECT anchor_ts FROM sp)",
       bandMinParam: "$3",
       bandMaxParam: "$4",
       coldStartParam: "false",
     })}
     SELECT below_market_pct, below_market_base, below_market_comparables, price_delta_pct
       FROM ranked
      WHERE property_id = $5::bigint`,
    [profileId, WARN_CAVEAT_CODES, minFrac, maxFrac, propertyId],
  );
  if (rows.length === 0) return null;
  const belowMarket =
    rows[0].below_market_pct !== null ? Number(rows[0].below_market_pct) : null;
  const rawDelta =
    rows[0].price_delta_pct !== null ? Number(rows[0].price_delta_pct) : null;
  const change = classifyPriceChange(rawDelta, minFrac, maxFrac);
  return {
    below_market_pct: belowMarket,
    below_market_base: rows[0].below_market_base ?? null,
    below_market_comparables: rows[0].below_market_comparables ?? null,
    price_changed: change.price_changed,
    price_delta_pct: change.price_delta_pct,
    price_direction: change.price_direction,
  };
}

/**
 * #452 — the raw inputs the property DETAIL page's "Puntuación inversora"
 * section needs to render the 0–100 score, its band/confidence, and the per-term
 * breakdown. Reuses `rankedCandidatesCte` verbatim (so the detail score can
 * never disagree with the feed card's for the same property) and reads the SAME
 * `effective_score` and per-signal columns the sort key is built from — the
 * authoritative total, with each signal's raw value alongside so the pure
 * display module (lib/display-score.ts) can reconstruct the contributions that
 * sum to it. The 0–100 re-expression and band all live in display-score.ts;
 * this only fetches the inputs.
 *
 * `risk_flags` are the warn-tone assessment flags (caveats + red flags + VPO)
 * rendered as informational CHIPS in the breakdown — per the owner's decision
 * they are NEVER subtracted from the score (a distressed listing is the
 * opportunity for a value buyer; the distress boost already ADDS for it).
 *
 * Returns null when the property isn't a ranked candidate of the profile.
 * Callers should treat a throw as "no score" — this is an enhancement, never
 * worth failing the detail page over.
 */
export interface PropertyInvestorScore {
  base_score: number | null;
  effective_score: number | null;
  below_market_pct: number | null;
  /** #461: which base produced below_market_pct — 'segment' / 'pool' / null (explained in the breakdown). */
  below_market_base: "segment" | "pool" | null;
  /** #461: comparable count behind below_market_pct; null when no comparison. */
  below_market_comparables: number | null;
  distress_level: number;
  beach_proximity: string | null;
  tourist_license: boolean;
  days_on_market: number | null;
  price_drop_pct: number | null;
  /** Warn-tone flags shown as chips (never subtracted). `{ label, kind }` only. */
  risk_flags: { label: string; kind: string }[];
}

export async function getPropertyInvestorScore(
  profileId: number,
  propertyId: number,
): Promise<PropertyInvestorScore | null> {
  const { minFrac, maxFrac } = readPriceChangeBand();
  const rows = await sql<{
    base_score: string | null;
    effective_score: string | null;
    below_market_pct: string | null;
    below_market_base: "segment" | "pool" | null;
    below_market_comparables: number | null;
    distress_level: number;
    beach_proximity: string | null;
    tourist_license: boolean | null;
    days_on_market: string | null;
    price_drop_pct: string | null;
  }>(
    `WITH sp AS (
       SELECT COALESCE(previous_viewed_at, created_at - interval '1 day') AS anchor_ts
         FROM search_profile
        WHERE id = $1
     ),
     ${rankedCandidatesCte({
       warnParam: "$2",
       anchorParam: "(SELECT anchor_ts FROM sp)",
       bandMinParam: "$3",
       bandMaxParam: "$4",
       coldStartParam: "false",
     })}
     SELECT
       score AS base_score,
       effective_score,
       below_market_pct,
       below_market_base,
       below_market_comparables,
       distress_level,
       beach_proximity,
       tourist_license,
       days_on_market,
       price_drop_pct
       FROM ranked
      WHERE property_id = $5::bigint`,
    [profileId, WARN_CAVEAT_CODES, minFrac, maxFrac, propertyId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];

  // Risk chips: reuse the same latest-per-axis assessment rows + flag mapping
  // the card uses (flagsFromAssessments), then keep only the warn-tone flags —
  // exactly the "red flags" the owner wants shown as chips, never subtracted.
  const flagsByProperty = await loadFlags([propertyId]);
  const risk_flags = (flagsByProperty.get(propertyId) ?? [])
    .filter((f) => f.tone === "warn")
    .map((f) => ({ label: f.label, kind: f.kind }));

  return {
    base_score: r.base_score !== null ? Number(r.base_score) : null,
    effective_score:
      r.effective_score !== null ? Number(r.effective_score) : null,
    below_market_pct:
      r.below_market_pct !== null ? Number(r.below_market_pct) : null,
    below_market_base: r.below_market_base ?? null,
    below_market_comparables: r.below_market_comparables ?? null,
    distress_level: r.distress_level ?? 0,
    beach_proximity: r.beach_proximity ?? null,
    tourist_license: r.tourist_license === true,
    days_on_market: r.days_on_market !== null ? Number(r.days_on_market) : null,
    price_drop_pct: r.price_drop_pct !== null ? Number(r.price_drop_pct) : null,
    risk_flags,
  };
}
