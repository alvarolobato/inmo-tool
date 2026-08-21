/**
 * Candidate-feed filter state and its URL round-trip (#465, Feed UX F2).
 *
 * The candidate feed's filters live in the page URL (query params on
 * `/profiles/[id]`) rather than in component `useState`, so the feed supports
 * deep-links, browser back/forward, and the Fase-4 click-through. This module
 * is the single source of truth for that state shape and its serialization —
 * kept pure (no React, no `window`) so it round-trips deterministically and is
 * unit-testable.
 *
 * URL param names are 1:1 with the plan (§1.2). Most match the API param they
 * ultimately drive; three are shortened (`cond`/`redflag`/`beach`/`heritage`/
 * `vpo`) and the two mutually-exclusive feed presets collapse into one `view`
 * param (`seguimiento` / `descartadas`; absent = Todas). #466 wires the primary-
 * row "⚠ Con alertas" toggle to the `alerts=1` param (drives the API's
 * `hasAlerts=true`).
 *
 * Invariant: an absent param always maps to the filter's default, and a default
 * value never emits a param — so the URL stays minimal and
 * `parse(toSearch(f)) === f`.
 *
 * #593: the alerts filter is TRI-STATE — off / "con alertas" / "sin
 * alertas" — not the #466 boolean toggle it started as. `alerts=1` keeps its
 * original meaning ("con alertas", so old links/bookmarks still work);
 * `alerts=0` is the new negative; an absent param still means "no filter" (an
 * absent param never gained a new meaning). See `lib/candidates.ts` for how
 * the negative is derived from the SAME predicate as the positive, and
 * `CandidateFilterBar.tsx` for the unassessed-candidates decision (excluded
 * from BOTH values, consistent with D-059).
 */

/** The 3 reachable states of the (formerly two mutually-exclusive) presets. */
export type CandidateView = "all" | "seguimiento" | "descartadas";

export interface CandidateFilters {
  /**
   * #470 free-text search across the ad description AND every other searchable
   * field (address, references, AI-assessment labels — the materialized
   * `property_search_doc`). `""` = no search. Param: `q` (the same name the API
   * accepts, P1). Lives in the always-visible primary row, not the popover.
   */
  q: string;
  /** #265 portal filter. `null` = all sources. Param: `source`. */
  source: string | null;
  /** #310 occupancy (occupied/free). Param: `occupancy`. */
  occupancy: string;
  /**
   * #310 composite condition token ("" | "a_reformar" | "a_reformar:leve" |
   * "a_reformar:integral" | "reformado" | "obra_nueva"). Param: `cond`.
   */
  conditionSel: string;
  /** #310 below-market threshold percent. Param: `minDiscount`. */
  minDiscount: string;
  /** #386 occupancy caveat (venta_deuda etc.). Param: `caveat`. */
  caveat: string;
  /** #386 redflags problem type. Param: `redflag`. */
  redflagType: string;
  /** #392 beach proximity min grade. Param: `beach`. */
  beachProximity: string;
  /** #392 casco-histórico toggle. Param: `heritage` ("true"). */
  heritageZone: boolean;
  /** #398 VPO bidirectional ("" | "true" | "false"). Param: `vpo`. */
  isVpo: string;
  /**
   * #593 tri-state alerts filter (was #466's boolean "Con alertas" toggle):
   * `""` = off, `"1"` = "con alertas" (≥1 red flag OR ≥1 warn occupancy
   * caveat — the warn badges the card shows), `"0"` = "sin alertas", the true
   * complement of `"1"` (see lib/candidates.ts — same predicate, negated, not
   * a second one). Param: `alerts` (`"1"` | `"0"`); drives the API's
   * `hasAlerts=true`/`hasAlerts=false`.
   */
  alerts: "" | "1" | "0";
  /** #422/#379 preset. Param: `view` (`seguimiento`/`descartadas`; absent = Todas). */
  view: CandidateView;
  /**
   * Issue #667 ("Ver novedades"): keep only candidates that are effectively
   * new right now — the SAME predicate `lib/candidates.ts`'s `ranked.is_new`
   * (and `lib/db/profile-overview.ts`'s `new_count`) already compute: the
   * earliest active-source listing's `first_seen_at` is after this profile's
   * `previous_viewed_at` (fallback `created_at - 1 day`). Deliberately the
   * RAW predicate, not the cold-start-suppressed value the NUEVO badge
   * sometimes hides, so the Perfiles row's "N nuevos" count and this
   * filter's result count agree by construction (extends the #447
   * count⇔feed invariant). `false` = off. Param: `onlyNew` (`"true"`).
   */
  onlyNew: boolean;
}

export const DEFAULT_CANDIDATE_FILTERS: CandidateFilters = {
  q: "",
  source: null,
  occupancy: "",
  conditionSel: "",
  minDiscount: "",
  caveat: "",
  redflagType: "",
  beachProximity: "",
  heritageZone: false,
  isVpo: "",
  alerts: "",
  view: "all",
  onlyNew: false,
};

/** `trackedOnly` (sends `state=accept`) is derived from the segmented view. */
export function trackedOnlyFromView(view: CandidateView): boolean {
  return view === "seguimiento";
}

/** `showRejected` (sends `includeRejected=true`) is derived from the view. */
export function showRejectedFromView(view: CandidateView): boolean {
  return view === "descartadas";
}

/**
 * The 7 AI-gated filters grouped in the "Más filtros" popover. Their active
 * count backs the popover button badge.
 */
export function moreFiltersActiveCount(f: CandidateFilters): number {
  let n = 0;
  if (f.occupancy !== "") n++;
  if (f.conditionSel !== "") n++;
  if (f.caveat !== "") n++;
  if (f.redflagType !== "") n++;
  if (f.beachProximity !== "") n++;
  if (f.heritageZone) n++;
  if (f.isVpo !== "") n++;
  return n;
}

/**
 * Any filter differs from its default — drives the "Limpiar todo" affordance
 * (shown only when ≥1 filter is active). Includes the primary-row filters and
 * the segmented view, not just the popover group.
 */
export function hasActiveFilters(f: CandidateFilters): boolean {
  return (
    f.q !== "" ||
    f.source !== null ||
    f.minDiscount !== "" ||
    f.alerts !== "" ||
    f.view !== "all" ||
    f.onlyNew ||
    moreFiltersActiveCount(f) > 0
  );
}

/** Parse the feed filters out of a URL query string ("?a=b" or "a=b"). */
export function parseCandidateFilters(search: string): CandidateFilters {
  const p = new URLSearchParams(search);
  const view = p.get("view");
  return {
    q: p.get("q") ?? "",
    source: p.get("source"),
    occupancy: p.get("occupancy") ?? "",
    conditionSel: p.get("cond") ?? "",
    minDiscount: p.get("minDiscount") ?? "",
    caveat: p.get("caveat") ?? "",
    redflagType: p.get("redflag") ?? "",
    beachProximity: p.get("beach") ?? "",
    heritageZone: p.get("heritage") === "true",
    isVpo: p.get("vpo") ?? "",
    // #593: only the two recognised tokens turn the filter on; anything else
    // (a typo'd param, a stray value) degrades to "off" rather than silently
    // narrowing the feed in an unintended direction.
    alerts: p.get("alerts") === "1" || p.get("alerts") === "0" ? (p.get("alerts") as "1" | "0") : "",
    view: view === "seguimiento" || view === "descartadas" ? view : "all",
    // Issue #667: only the exact string "true" turns the filter on — same
    // strict-parse discipline as `heritageZone` just above.
    onlyNew: p.get("onlyNew") === "true",
  };
}

/**
 * Serialize the feed filters to URLSearchParams. Defaults emit nothing, so the
 * param order is fixed and the output is deterministic (round-trip safe).
 */
export function candidateFiltersToParams(f: CandidateFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q !== "") p.set("q", f.q);
  if (f.source !== null) p.set("source", f.source);
  if (f.occupancy !== "") p.set("occupancy", f.occupancy);
  if (f.conditionSel !== "") p.set("cond", f.conditionSel);
  if (f.minDiscount !== "") p.set("minDiscount", f.minDiscount);
  if (f.caveat !== "") p.set("caveat", f.caveat);
  if (f.redflagType !== "") p.set("redflag", f.redflagType);
  if (f.beachProximity !== "") p.set("beach", f.beachProximity);
  if (f.heritageZone) p.set("heritage", "true");
  if (f.isVpo !== "") p.set("vpo", f.isVpo);
  if (f.alerts !== "") p.set("alerts", f.alerts);
  if (f.view !== "all") p.set("view", f.view);
  if (f.onlyNew) p.set("onlyNew", "true");
  return p;
}

/** Feed filters as a URL query string, with leading "?" (or "" when default). */
export function candidateFiltersToSearch(f: CandidateFilters): string {
  const s = candidateFiltersToParams(f).toString();
  return s === "" ? "" : `?${s}`;
}
