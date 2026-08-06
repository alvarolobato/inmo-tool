/**
 * Daily "what's new" digest — content builder (issue #35, Phase 5.5 v1).
 *
 * The persona (issue #307): a busy investor who wants a daily assessment of
 * what NEW opportunities appeared across his profiles, so he can glance and
 * act without trawling portals. This module assembles that per-profile digest;
 * `email.ts` renders/sends it and `scheduler.ts` decides who is due.
 *
 * ## What "new" means — REUSES #195's definition, does not diverge
 *
 * The Perfiles "novedades" strip (#195) defines a profile's `new_count` as
 * *matched* properties first-seen since an anchor (`last_viewed_at`, falling
 * back to `created_at - 1 day` for a never-visited profile) — see
 * `lib/db/profile-overview.ts`'s `new_count` LATERAL. The digest reuses that
 * exact predicate shape (`profile_listing_state.matched = true` AND
 * `property.created_at >= anchor`); the ONLY difference is the anchor: the
 * digest measures "new since the last digest", so the anchor is the previous
 * `digest_run.sent_at`, falling back to `now() - 1 day` on the very first run
 * (the same 24h fallback the strip uses). So the digest and the strip can
 * never disagree about *what* is new — only about the window's lower bound,
 * which is the whole point of a digest vs. a live glance.
 *
 * ## v1 scope (Fable pass, #307)
 *
 * v1 ships WITHOUT #34 (market-signals / days-on-market). It carries three
 * DISTINCT item types (the investor should tell at a glance which kind of
 * thing happened, per the issue's technical approach §1):
 *   (a) new matched candidates since the last digest, ranked by opportunity
 *       signal where available (below-market discount, distress red-flags),
 *       with the key facts + the AI-assessment badges (#308) when present;
 *   (b) ordinary price drops on the profile's matched properties;
 *   (c) sold/withdrawn status changes on the same set.
 * The `relisted_lower` cross-listing item type (issue #35 EC-4) and the
 * separate instant watchlist alert (EC-3) genuinely need #34's computation /
 * a watchlist mechanism and are deferred to v2 — see the PR body.
 *
 * Server-only: imports `lib/db-write` (the `pg` client). Never import from a
 * client component.
 */

import { sql } from "@/lib/db-write";
import { flagsFromAssessments, type CandidateFlag, type RawAssessmentRow } from "@/lib/candidates";
import { computeAreaPriceComparison } from "@/lib/analytics/area-price";
import { REDFLAG_TYPES, REDFLAG_LABELS, type RedFlagType } from "@/lib/ai-assessment/redflags";

// Spanish labels for the distress problem types (#27 + #361) surfaced in the
// digest come from the shared `REDFLAG_LABELS` map (lib/ai-assessment/
// redflags.ts) — the single home for the vocabulary's display labels, so the
// digest picks up new problem types (e.g. #361's physical `unfinished_
// construction`/`structural_damage`) automatically. `other` is absent from
// that map — an un-typed flag carries no glanceable meaning in a one-line
// digest entry — so it drops out here the same way it does on the card.

/** One "new matched candidate" item — the primary, ranked section. */
export interface DigestNewCandidate {
  propertyId: number;
  /** Locality string (`property.address`) — the closest thing to a "zone" the schema carries. */
  zone: string | null;
  propertyType: string | null;
  /** MIN(active sale listing price) — same convention as the candidate feed. */
  price: number | null;
  m2: number | null;
  /** `price / m2` when both are present, else null. */
  pricePerM2: number | null;
  /** Distinct sources (portals) the property is listed on, alphabetical. */
  sources: string[];
  /** A representative listing URL (first active sale listing by source) so the investor can open it. */
  url: string | null;
  score: number | null;
  scoreKind: "cold_start" | "trained" | null;
  /** Occupancy/condition badges (#25/#26) — reuses the candidate-card vocabulary verbatim. */
  flags: CandidateFlag[];
  /** Distress red-flag labels (#27), empty when none/absent. */
  redFlags: string[];
  /**
   * Below-market discount as a POSITIVE fraction (0.23 = "23% below the zone
   * median €/m²"), or null when at/above market or when there aren't enough
   * comparables (`area-price.ts`'s MIN_SAMPLE_SIZE). Degrades gracefully — a
   * failed comparison never fails the digest.
   */
  belowMarketPct: number | null;
}

/** One ordinary price-drop item (item type b). */
export interface DigestPriceDrop {
  propertyId: number;
  zone: string | null;
  source: string;
  url: string | null;
  oldPrice: number;
  newPrice: number;
  /** Positive fraction: (old - new) / old. */
  dropPct: number;
  observedAt: string;
}

/** One sold/withdrawn status-change item (item type c). */
export interface DigestStatusChange {
  propertyId: number;
  zone: string | null;
  source: string;
  url: string | null;
  status: "sold" | "withdrawn";
  observedAt: string;
}

export interface DigestContent {
  profileId: number;
  profileName: string;
  /** ISO anchor — the lower bound of "what's new" (previous digest, or 24h ago). */
  since: string;
  generatedAt: string;
  newCandidates: DigestNewCandidate[];
  priceDrops: DigestPriceDrop[];
  statusChanges: DigestStatusChange[];
}

/**
 * Total distinct items across all three sections — the number persisted as
 * `digest_run.candidate_count` and the value `isDigestEmpty` keys on.
 */
export function digestItemCount(content: DigestContent): number {
  return content.newCandidates.length + content.priceDrops.length + content.statusChanges.length;
}

/**
 * An empty digest carries nothing across ALL three item types. The scheduler
 * skips sending an empty digest (issue #35 EC-2 / technical approach §4) but
 * still advances the watermark, so a content-free email is never sent.
 */
export function isDigestEmpty(content: DigestContent): boolean {
  return digestItemCount(content) === 0;
}

/**
 * Rank new candidates by OPPORTUNITY SIGNAL, not by rebuilding scoring
 * (AGENTS-level rule: "do not rebuild scoring"). Ordering, most-actionable
 * first:
 *   1. below-market discount, larger first (nulls last — "where available");
 *   2. number of distress red-flags, more first (a motivated-seller tell);
 *   3. the existing trained/cold-start `score`, higher first;
 *   4. `propertyId` descending, purely to make the order deterministic.
 * Every signal here is already computed elsewhere; this only orders them.
 * Pure and total — safe to unit-test without a DB.
 */
export function rankNewCandidates(items: DigestNewCandidate[]): DigestNewCandidate[] {
  const belowMarket = (c: DigestNewCandidate) => (c.belowMarketPct == null ? -Infinity : c.belowMarketPct);
  const score = (c: DigestNewCandidate) => (c.score == null ? -Infinity : c.score);
  return [...items].sort(
    (a, b) =>
      belowMarket(b) - belowMarket(a) ||
      b.redFlags.length - a.redFlags.length ||
      score(b) - score(a) ||
      b.propertyId - a.propertyId,
  );
}

interface RawNewCandidateRow {
  property_id: number;
  address: string | null;
  property_type: string | null;
  min_price: string | null;
  m2_built: string | null;
  sources: string[] | null;
  url: string | null;
  score: string | null;
  score_kind: "cold_start" | "trained" | null;
}

interface RawRedFlagRow {
  property_id: number;
  result: { flags?: Array<{ type?: string }> } | null;
}

/**
 * Resolve the "since" anchor for a profile's digest: the most recent
 * `digest_run.sent_at`, or `now() - 1 day` on the first ever run (the same
 * 24h fallback the novedades strip uses for a never-visited profile). Returns
 * an ISO string.
 */
export async function resolveDigestAnchor(profileId: number): Promise<string> {
  const rows = await sql<{ anchor: string }>(
    `SELECT COALESCE(
              (SELECT sent_at FROM digest_run
                WHERE profile_id = $1
                ORDER BY sent_at DESC
                LIMIT 1),
              NOW() - INTERVAL '1 day'
            ) AS anchor`,
    [profileId],
  );
  return rows[0].anchor;
}

/**
 * Load distress red-flag labels per property from the `redflags` assessment
 * (#27). Best-effort: on any read error (or absence — #308 may not have run
 * yet) returns an empty map, so the digest degrades to no-red-flags rather
 * than failing. Mirrors `loadFlags` in lib/candidates.ts: DISTINCT ON picks
 * the current prompt-version verdict per property.
 */
async function loadRedFlags(propertyIds: number[]): Promise<Map<number, string[]>> {
  const byProperty = new Map<number, string[]>();
  if (propertyIds.length === 0) return byProperty;
  let rows: RawRedFlagRow[];
  try {
    rows = await sql<RawRedFlagRow>(
      `SELECT DISTINCT ON (property_id)
              property_id, result
         FROM ai_assessment
        WHERE property_id = ANY($1::bigint[])
          AND assessment_type = 'redflags'
        ORDER BY property_id, generated_at DESC NULLS LAST, id DESC`,
      [propertyIds],
    );
  } catch (err) {
    console.warn("[digest] redflags unavailable, rendering without them:", err);
    return byProperty;
  }
  for (const row of rows) {
    const flags = Array.isArray(row.result?.flags) ? row.result!.flags : [];
    const labels: string[] = [];
    for (const f of flags) {
      const t = typeof f?.type === "string" ? f.type : "other";
      if ((REDFLAG_TYPES as readonly string[]).includes(t)) {
        const label = REDFLAG_LABELS[t as RedFlagType];
        if (label && !labels.includes(label)) labels.push(label);
      }
    }
    if (labels.length > 0) byProperty.set(row.property_id, labels);
  }
  return byProperty;
}

/** Best-effort below-market discount per property (positive fraction, else null). */
async function loadBelowMarket(propertyId: number): Promise<number | null> {
  try {
    const cmp = await computeAreaPriceComparison(propertyId);
    const pct = cmp?.pct_vs_average ?? null;
    // pct_vs_average is a signed fraction; negative = below market. Surface
    // only the below-market case as a positive discount (at/above market is
    // not an opportunity signal — same narrowing as price-signal.ts).
    return pct != null && pct < 0 ? -pct : null;
  } catch (err) {
    console.warn(`[digest] area-price comparison failed for property ${propertyId}:`, err);
    return null;
  }
}

/**
 * Load the profile's NEW matched candidates since `since` (item type a),
 * enriched with AI-assessment badges and below-market discount, ranked.
 * Bounded by `limit` (a digest is a glance, not a full feed).
 */
async function loadNewCandidates(
  profileId: number,
  since: string,
  limit: number,
): Promise<DigestNewCandidate[]> {
  const rows = await sql<RawNewCandidateRow>(
    // The "new" predicate: matched = true AND property first-seen since the
    // anchor — identical in shape to profile-overview.ts's new_count LATERAL,
    // only the anchor differs (last digest vs. last visit). min_price/sources/
    // url all read the property's ACTIVE SALE listings, the exact set the
    // candidate card renders (status='active' AND operation='sale').
    `SELECT
       p.id AS property_id,
       p.address,
       p.property_type,
       p.m2_built,
       (SELECT MIN(l.current_price) FROM listing l
         WHERE l.property_id = p.id AND l.status = 'active' AND l.operation = 'sale') AS min_price,
       (SELECT array_agg(DISTINCT l.source ORDER BY l.source) FROM listing l
         WHERE l.property_id = p.id AND l.status = 'active' AND l.operation = 'sale') AS sources,
       (SELECT l.url FROM listing l
         WHERE l.property_id = p.id AND l.status = 'active' AND l.operation = 'sale' AND l.url IS NOT NULL
         ORDER BY l.source LIMIT 1) AS url,
       pls.score,
       pls.score_kind
     FROM profile_listing_state pls
     JOIN property p ON p.id = pls.property_id
     WHERE pls.profile_id = $1
       AND pls.matched = true
       AND p.created_at >= $2::timestamptz
     ORDER BY COALESCE(pls.score, -1) DESC, p.id DESC
     LIMIT $3`,
    [profileId, since, limit],
  );

  const propertyIds = rows.map((r) => r.property_id);
  const [flagsByProperty, redFlagsByProperty] = await Promise.all([
    loadFlagsForProperties(propertyIds),
    loadRedFlags(propertyIds),
  ]);
  const belowMarket = await Promise.all(rows.map((r) => loadBelowMarket(r.property_id)));

  const items: DigestNewCandidate[] = rows.map((r, i) => {
    const price = r.min_price != null ? Number(r.min_price) : null;
    const m2 = r.m2_built != null ? Number(r.m2_built) : null;
    return {
      propertyId: r.property_id,
      zone: r.address,
      propertyType: r.property_type,
      price,
      m2,
      pricePerM2: price != null && m2 != null && m2 > 0 ? price / m2 : null,
      sources: r.sources ?? [],
      url: r.url,
      score: r.score != null ? Number(r.score) : null,
      scoreKind: r.score_kind,
      flags: flagsByProperty.get(r.property_id) ?? [],
      redFlags: redFlagsByProperty.get(r.property_id) ?? [],
      belowMarketPct: belowMarket[i],
    };
  });

  return rankNewCandidates(items);
}

/**
 * Occupancy/condition badges per property — reuses `flagsFromAssessments`
 * (the candidate card's exact vocabulary) so the digest and the feed never
 * disagree about which badges a property carries. Best-effort like `loadRedFlags`.
 */
async function loadFlagsForProperties(propertyIds: number[]): Promise<Map<number, CandidateFlag[]>> {
  const byProperty = new Map<number, CandidateFlag[]>();
  if (propertyIds.length === 0) return byProperty;
  let rows: RawAssessmentRow[];
  try {
    rows = await sql<RawAssessmentRow>(
      `SELECT DISTINCT ON (property_id, assessment_type)
              property_id, result
         FROM ai_assessment
        WHERE property_id = ANY($1::bigint[])
          AND assessment_type IN ('occupancy', 'condition')
        ORDER BY property_id, assessment_type, generated_at DESC NULLS LAST, id DESC`,
      [propertyIds],
    );
  } catch (err) {
    console.warn("[digest] ai_assessment unavailable, rendering without flags:", err);
    return byProperty;
  }
  const grouped = new Map<number, RawAssessmentRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.property_id) ?? [];
    list.push(row);
    grouped.set(row.property_id, list);
  }
  for (const [id, group] of grouped) byProperty.set(id, flagsFromAssessments(group));
  return byProperty;
}

interface RawPriceDropRow {
  property_id: number;
  address: string | null;
  source: string;
  url: string | null;
  old_price: string;
  new_price: string;
  observed_at: string;
}

/**
 * Price drops on the profile's matched properties since `since` (item type b).
 * A "drop" is a `listing_price_history` observation strictly below the
 * immediately-preceding observation for the same listing. Raw price drops only
 * — the `relisted_lower` withdrawal-then-relist pattern (EC-4) is v2 (#34).
 */
async function loadPriceDrops(profileId: number, since: string, limit: number): Promise<DigestPriceDrop[]> {
  const rows = await sql<RawPriceDropRow>(
    `WITH drops AS (
       SELECT h.listing_id,
              h.observed_at,
              h.price AS new_price,
              LAG(h.price) OVER (PARTITION BY h.listing_id ORDER BY h.observed_at) AS prev_price
         FROM listing_price_history h
     )
     SELECT p.id AS property_id, p.address, l.source, l.url,
            d.prev_price AS old_price, d.new_price, d.observed_at
       FROM drops d
       JOIN listing l ON l.id = d.listing_id
       JOIN property p ON p.id = l.property_id
       JOIN profile_listing_state pls
         ON pls.property_id = p.id AND pls.profile_id = $1 AND pls.matched = true
      WHERE d.prev_price IS NOT NULL
        AND d.new_price < d.prev_price
        AND d.observed_at >= $2::timestamptz
      ORDER BY d.observed_at DESC
      LIMIT $3`,
    [profileId, since, limit],
  );
  return rows.map((r) => {
    const oldPrice = Number(r.old_price);
    const newPrice = Number(r.new_price);
    return {
      propertyId: r.property_id,
      zone: r.address,
      source: r.source,
      url: r.url,
      oldPrice,
      newPrice,
      dropPct: oldPrice > 0 ? (oldPrice - newPrice) / oldPrice : 0,
      observedAt: r.observed_at,
    };
  });
}

interface RawStatusChangeRow {
  property_id: number;
  address: string | null;
  source: string;
  url: string | null;
  status: "sold" | "withdrawn";
  observed_at: string;
}

/**
 * Sold/withdrawn status changes on the profile's matched properties since
 * `since` (item type c).
 */
async function loadStatusChanges(profileId: number, since: string, limit: number): Promise<DigestStatusChange[]> {
  const rows = await sql<RawStatusChangeRow>(
    `SELECT p.id AS property_id, p.address, l.source, l.url, e.status, e.observed_at
       FROM listing_status_event e
       JOIN listing l ON l.id = e.listing_id
       JOIN property p ON p.id = l.property_id
       JOIN profile_listing_state pls
         ON pls.property_id = p.id AND pls.profile_id = $1 AND pls.matched = true
      WHERE e.status IN ('sold', 'withdrawn')
        AND e.observed_at >= $2::timestamptz
      ORDER BY e.observed_at DESC
      LIMIT $3`,
    [profileId, since, limit],
  );
  return rows.map((r) => ({
    propertyId: r.property_id,
    zone: r.address,
    source: r.source,
    url: r.url,
    status: r.status,
    observedAt: r.observed_at,
  }));
}

/** How many items of each type a single digest carries at most (a glance, not a feed). */
export const DIGEST_SECTION_LIMIT = 25;

export interface BuildDigestOptions {
  /** Explicit anchor override (tests / re-runs). Defaults to `resolveDigestAnchor`. */
  since?: string;
  /** Per-section cap. Defaults to `DIGEST_SECTION_LIMIT`. */
  sectionLimit?: number;
}

/**
 * Assemble the full digest for one profile. Resolves the "since" anchor,
 * loads all three item types, ranks the new candidates, and returns the
 * `DigestContent`. Does NOT decide whether to send (that's the scheduler,
 * via `isDigestEmpty`) and does NOT write `digest_run`.
 */
export async function buildDigestForProfile(
  profile: { id: number; name: string },
  opts: BuildDigestOptions = {},
): Promise<DigestContent> {
  const since = opts.since ?? (await resolveDigestAnchor(profile.id));
  const limit = opts.sectionLimit ?? DIGEST_SECTION_LIMIT;
  const [newCandidates, priceDrops, statusChanges] = await Promise.all([
    loadNewCandidates(profile.id, since, limit),
    loadPriceDrops(profile.id, since, limit),
    loadStatusChanges(profile.id, since, limit),
  ]);
  return {
    profileId: profile.id,
    profileName: profile.name,
    since,
    generatedAt: new Date().toISOString(),
    newCandidates,
    priceDrops,
    statusChanges,
  };
}
